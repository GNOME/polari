const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Polari = imports.gi.Polari;
const Tp = imports.gi.TelepathyGLib;

const AccountsMonitor = imports.accountsMonitor;
const Lang = imports.lang;
const RoomManager = imports.roomManager;
const Signals = imports.signals;
const Utils = imports.utils;

const SASLAuthenticationIface = '<node> \
<interface name="org.freedesktop.Telepathy.Channel.Interface.SASLAuthentication"> \
<method name="StartMechanismWithData"> \
    <arg type="s" direction="in" name="mechanism" /> \
    <arg type="ay" direction="in" name="data" /> \
</method> \
<method name="AcceptSASL"/> \
<method name="AbortSASL"> \
    <arg type="u" direction="in" name="reason"/> \
    <arg type="s" direction="in" name="debug-message"/> \
</method> \
<signal name="SASLStatusChanged"> \
    <arg name="status" type="u" /> \
    <arg name="reason" type="s" /> \
    <arg name="details" type="a{sv}" /> \
</signal> \
</interface> \
</node>';
let SASLAuthProxy = Gio.DBusProxy.makeProxyWrapper(SASLAuthenticationIface);

const SASLStatus = {
    NOT_STARTED: 0,
    IN_PROGRESS: 1,
    SERVER_SUCCEEDED: 2,
    CLIENT_ACCEPTED: 3,
    SUCCEEDED: 4,
    SERVER_FAILED: 5,
    CLIENT_FAILED: 6
};

const SASLAbortReason = {
    INVALID_CHALLENGE: 0,
    USER_ABORT: 1
};

const SASLAuthHandler = new Lang.Class({
    Name: 'SASLAuthHandler',

    _init: function(channel) {
        this._channel = channel;
        this._proxy = new SASLAuthProxy(Gio.DBus.session,
                                        channel.bus_name,
                                        channel.object_path,
                                        Lang.bind(this, this._onProxyReady));
    },

    _onProxyReady: function(proxy) {
        this._proxy.connectSignal('SASLStatusChanged',
                                  Lang.bind(this, this._onSASLStatusChanged));

        let account = this._channel.connection.get_account();
        Utils.lookupAccountPassword(account,
                                    Lang.bind(this, this._onPasswordReady));
    },

    _onPasswordReady: function(password) {
        if (password)
            this._proxy.StartMechanismWithDataRemote('X-TELEPATHY-PASSWORD',
                                                     password);
        else
            this._proxy.AbortSASLRemote(SASLAbortReason.USER_ABORT,
                                        'Password not available',
                                        Lang.bind(this, this._resetPrompt));
    },

    _onSASLStatusChanged: function(proxy, sender, [status]) {
        let name = this._channel.connection.get_account().display_name;
        let statusString = (Object.keys(SASLStatus))[status];
        Utils.debug('Auth status for server "%s": %s'.format(name, statusString));

        switch(status) {
            case SASLStatus.NOT_STARTED:
            case SASLStatus.IN_PROGRESS:
            case SASLStatus.CLIENT_ACCEPTED:
                break;

            case SASLStatus.SERVER_SUCCEEDED:
                this._proxy.AcceptSASLRemote();
                break;

            case SASLStatus.SUCCEEDED:
            case SASLStatus.SERVER_FAILED:
            case SASLStatus.CLIENT_FAILED:
                this._channel.close_async(null);
                break;
        }
    },

    _resetPrompt: function() {
        let account = this._channel.connection.get_account();
        let prompt = new GLib.Variant('b', false);
        let params = new GLib.Variant('a{sv}', { 'password-prompt': prompt });
        account.update_parameters_vardict_async(params, [], Lang.bind(this,
            function(a, res) {
                a.update_parameters_vardict_finish(res);
                account.request_presence_async(Tp.ConnectionPresenceType.AVAILABLE,
                                               'available', '', null);
            }));
    }
});

const TelepathyClient = new Lang.Class({
    Name: 'TelepathyClient',
    Extends: Tp.BaseClient,

    _init: function(params) {
        this._app = Gio.Application.get_default();
        this._app.connect('prepare-shutdown', () => {
            [...this._pendingRequests.values()].forEach(r => { r.cancel(); });
        });

        this._pendingBotPasswords = new Map();
        this._pendingRequests = new Map();

        this.parent(params);

        this.set_handler_bypass_approval(false);
        this.set_observer_recover(true);

        this._networkMonitor = Gio.NetworkMonitor.get_default();
        this._roomManager = RoomManager.getDefault();
        this._roomManager.connect('room-added', (mgr, room) => {
            if (room.account.connection)
                this._connectRoom(room);
            room.connect('identify-sent', Lang.bind(this, this._onIdentifySent));
        });
        this._accountsMonitor = AccountsMonitor.getDefault();
        this._accountsMonitor.prepare(Lang.bind(this, this._onPrepared));
    },

    _onPrepared: function() {
        let actions = [
            { name: 'message-user',
              handler: Lang.bind(this, this._onQueryActivated) },
            { name: 'leave-room',
              handler: Lang.bind(this, this._onLeaveActivated) },
            { name: 'connect-account',
              handler: Lang.bind(this, this._onConnectAccountActivated) },
            { name: 'reconnect-account',
              handler: Lang.bind(this, this._onReconnectAccountActivated) },
            { name: 'authenticate-account',
              handler: Lang.bind(this, this._onAuthenticateAccountActivated) },
        ];
        actions.forEach(a => {
            this._app.lookup_action(a.name).connect('activate', a.handler);
        });

        let filters = [];

        let roomFilter = {};
        roomFilter[Tp.PROP_CHANNEL_CHANNEL_TYPE] = Tp.IFACE_CHANNEL_TYPE_TEXT;
        roomFilter[Tp.PROP_CHANNEL_TARGET_HANDLE_TYPE] = Tp.HandleType.ROOM;
        filters.push(roomFilter);

        let contactFilter = {};
        contactFilter[Tp.PROP_CHANNEL_CHANNEL_TYPE] = Tp.IFACE_CHANNEL_TYPE_TEXT;
        contactFilter[Tp.PROP_CHANNEL_TARGET_HANDLE_TYPE] = Tp.HandleType.CONTACT;
        filters.push(contactFilter);

        let authFilter = {};
        authFilter[Tp.PROP_CHANNEL_CHANNEL_TYPE] = Tp.IFACE_CHANNEL_TYPE_SERVER_AUTHENTICATION;
        authFilter[Tp.PROP_CHANNEL_TYPE_SERVER_AUTHENTICATION_AUTHENTICATION_METHOD] = Tp.IFACE_CHANNEL_INTERFACE_SASL_AUTHENTICATION;
        filters.push(authFilter);

        filters.forEach(f => {
            this.add_handler_filter(f);
            this.add_observer_filter(f);
        });
        this.register();

        this._accountsMonitor.connect('account-status-changed', Lang.bind(this, function(monitor, account) {
            if (account.connection_status == Tp.ConnectionStatus.CONNECTED)
                this._connectRooms(account);
        }));
        this._accountsMonitor.connect('account-added', (mon, account) => {
            this._connectAccount(account);
        });
        this._accountsMonitor.connect('account-enabled', (mon, account) => {
            this._connectAccount(account);
        });
        this._accountsMonitor.enabledAccounts.forEach(a => {
            if (a.connection)
                this._connectRooms(a);
            else
                this._connectAccount(a);
        });

        this._networkMonitor.connect('notify::network-available', () => {
            if (!this._networkMonitor.network_available)
                return;

            this._accountsMonitor.enabledAccounts.forEach(this._connectAccount);
        });
    },

    _connectAccount: function(account) {
        let presence = Tp.ConnectionPresenceType.AVAILABLE;
        let msg = account.requested_status_message;
        account.request_presence_async(presence, 'available', msg, (o, res) => {
            try {
                account.request_presence_finish(res);
            } catch(e) {
                log('Connection failed: ' + e.message);
            }
        });
    },

    _connectRooms: function(account) {
        this._roomManager.rooms.forEach(room => {
            if (account == null || room.account == account)
                this._connectRoom(room);
        });
    },

    _connectRoom: function(room) {
        this._requestChannel(room.account, room.type, room.channel_name, null);
    },

    _requestChannel: function(account, targetType, targetId, callback) {
        if (!account || !account.enabled)
            return;

        let roomId = Polari.create_room_id(account,  targetId, targetType);

        let cancellable = new Gio.Cancellable();
        this._pendingRequests.set(roomId, cancellable);

        // Always use a timestamp of 0 for channels we request - rooms that
        // the users requests are focused when handling the corresponding
        // action, so presenting the room after the requests completes has
        // no effect at best, but could steal the focus when the user switched
        // to a different room in the meantime
        let req = Tp.AccountChannelRequest.new_text(account, 0);
        req.set_target_id(targetType, targetId);
        req.set_delegate_to_preferred_handler(true);

        let preferredHandler = Tp.CLIENT_BUS_NAME_BASE + 'Polari';
        req.ensure_and_observe_channel_async(preferredHandler, cancellable,
            (o, res) => {
                let channel = null;
                try {
                    channel = req.ensure_and_observe_channel_finish(res);
                } catch(e) {
                    Utils.debug('Failed to ensure channel: ' + e.message);
                }

                if (callback)
                    callback(channel);
                this._pendingRequests.delete(roomId);
            });
    },

    _sendMessage: function(channel, message) {
        if (!message || !channel)
            return;

        let type = Tp.ChannelTextMessageType.NORMAL;
        channel.send_message_async(Tp.ClientMessage.new_text(type, message), 0,
            (c, res) => {
                try {
                    c.send_message_finish(res);
                } catch(e) {
                    log('Failed to send message: ' + e.message);
                }
            });
    },

    _onConnectAccountActivated: function(action, parameter) {
        let accountPath = parameter.deep_unpack();
        let account = this._accountsMonitor.lookupAccount(accountPath);
        this._connectAccount(account);
    },

    _onReconnectAccountActivated: function(action, parameter) {
        let accountPath = parameter.deep_unpack();
        let account = this._accountsMonitor.lookupAccount(accountPath);
        account.reconnect_async((a, res) => { a.reconnect_finish(res); });
    },

    _onAuthenticateAccountActivated: function(action, parameter) {
        let [accountPath, password] = parameter.deep_unpack();
        let account = this._accountsMonitor.lookupAccount(accountPath);

        let prompt = new GLib.Variant('b', password.length > 0);
        let params = GLib.Variant.new('a{sv}', { 'password-prompt': prompt });
        account.update_parameters_vardict_async(params, [],
            Lang.bind(this, function(a, res) {
                a.update_parameters_vardict_finish(res);
                Utils.storeAccountPassword(a, password, Lang.bind(this,
                    function() {
                        a.reconnect_async(null);
                    }));
            }));
    },

    _onQueryActivated: function(action, parameter) {
        let [accountPath, channelName, message, time] = parameter.deep_unpack();
        let account = this._accountsMonitor.lookupAccount(accountPath);

        if (!account || !account.enabled)
            return;

        this._requestChannel(account, Tp.HandleType.CONTACT, channelName,
                             Lang.bind(this, this._sendMessage, message));
    },

    _onLeaveActivated: function(action, parameter) {
        let [id, message] = parameter.deep_unpack();

        let request = this._pendingRequests.get(id);
        if (request)
            request.cancel();

        let room = this._roomManager.lookupRoom(id);
        if (!room.channel)
            return;

        let reason = Tp.ChannelGroupChangeReason.NONE;
        message = message || _("Good Bye");
        room.channel.leave_async(reason, message, (c, res) => {
            try {
                c.leave_finish(res);
            } catch(e) {
                log('Failed to leave channel: ' + e.message);
            }
        });
    },

    _isAuthChannel: function(channel) {
        return channel.channel_type == Tp.IFACE_CHANNEL_TYPE_SERVER_AUTHENTICATION;
    },

    _processRequest: function(context, connection, channels, processChannel) {
        if (connection.protocol_name != 'irc') {
            let message = 'Not implementing non-IRC protocols';
            context.fail(new Tp.Error({ code: Tp.Error.NOT_IMPLEMENTED,
                                        message: message }));
            return;
        }

        if (this._isAuthChannel(channels[0]) && channels.length > 1) {
            let message = 'Only one authentication channel per connection allowed';
            context.fail(new Tp.Error({ code: Tp.Error.INVALID_ARGUMENT,
                                        message: message }));
            return;
        }

        for (let i = 0; i < channels.length; i++) {
            if (channels[i].get_invalidated())
                continue;
            processChannel.call(this, channels[i]);
        }
        context.accept();
    },

    vfunc_observe_channels: function() {
        let [account, connection,
             channels, op, requests, context] = arguments;

        this._processRequest(context, connection, channels, Lang.bind(this,
            function(channel) {
                if (this._isAuthChannel(channel))
                    return;

                if (channel.has_interface(Tp.IFACE_CHANNEL_INTERFACE_GROUP)) {
                    let [invited, , , ,] = channel.group_get_local_pending_contact_info(channel.group_self_contact);
                    if (invited)
                      // this is an invitation - only add it in handleChannel
                      // if accepted
                      return;
                }

                channel.connect('message-received',
                                Lang.bind(this, this._onMessageReceived));
                channel.connect('pending-message-removed',
                                Lang.bind(this, this._onPendingMessageRemoved));

                this._roomManager.ensureRoomForChannel(channel, 0);
            }));
    },

    vfunc_handle_channels: function() {
        let [account, connection,
             channels, satisfied, userTime, context] = arguments;

        let [present, ] = Tp.user_action_time_should_present(userTime);

        this._processRequest(context, connection, channels, Lang.bind(this,
            function(channel) {
                if (this._isAuthChannel(channel)) {
                    let authHandler = new SASLAuthHandler(channel);
                    return;
                }

                if (present)
                    this._app.activate();

                this._roomManager.ensureRoomForChannel(channel, userTime);
                //channel.join_async('', null);
            }));
    },

    _getPendingNotificationID: function(room, id) {
        return 'pending-message-%s-%d'.format(room.id, id);
    },

    _createNotification: function(room, summary, body) {
        let notification = new Gio.Notification();
        notification.set_title(summary);
        notification.set_body(body);

        let param = GLib.Variant.new('(ssu)',
                                     [ room.account.object_path,
                                       room.channel_name,
                                       Utils.getTpEventTime() ]);
        notification.set_default_action_and_target('app.join-room', param);
        return notification;
    },

    _onIdentifySent: function(room, username, password) {
        let accountPath = room.account.object_path;

        let data = {
            botname: room.channel.target_contact.alias,
            username: username || room.channel.connection.self_contact.alias,
            password: password
        };
        this._pendingBotPasswords.set(accountPath, data);
    },

    _onMessageReceived: function(channel, msg) {
        let [id, ] = msg.get_pending_message_id();
        let room = this._roomManager.lookupRoomByChannel(channel);

        // Rooms are removed instantly when the user requests it, but closing
        // the corresponding channel may take a bit; it would be surprising
        // to get notifications for a "closed" room, so just bail out
        if (!room || this._app.isRoomFocused(room))
            return;

        let [text, ] = msg.to_text();
        let nick = msg.sender.alias;
        if (!room.should_highlight_message(nick, text))
            return;

        let summary = '%s %s'.format(room.display_name, nick);
        let notification = this._createNotification(room, summary, text);
        this._app.send_notification(this._getPendingNotificationID(room, id), notification);
    },

    _onPendingMessageRemoved: function(channel, msg) {
        let [id, valid] = msg.get_pending_message_id();
        if (!valid)
            return;

        let room = this._roomManager.lookupRoomByChannel(channel);
        this._app.withdraw_notification(this._getPendingNotificationID(room, id));
    }
});
