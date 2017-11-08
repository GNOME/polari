const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Polari = imports.gi.Polari;
const Tp = imports.gi.TelepathyGLib;

const {AccountsMonitor} = imports.accountsMonitor;
const {RoomManager} = imports.roomManager;
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

class SASLAuthHandler {
    constructor(channel) {
        this._channel = channel;
        this._proxy = new SASLAuthProxy(Gio.DBus.session,
                                        channel.bus_name,
                                        channel.object_path,
                                        this._onProxyReady.bind(this));
    }

    _onProxyReady(proxy) {
        this._proxy.connectSignal('SASLStatusChanged',
                                  this._onSASLStatusChanged.bind(this));

        let account = this._channel.connection.get_account();
        Utils.lookupAccountPassword(account, this._onPasswordReady.bind(this));
    }

    _onPasswordReady(password) {
        if (password)
            this._proxy.StartMechanismWithDataRemote('X-TELEPATHY-PASSWORD',
                                                     password);
        else
            this._proxy.AbortSASLRemote(SASLAbortReason.USER_ABORT,
                                        'Password not available',
                                        this._resetPrompt.bind(this));
    }

    _onSASLStatusChanged(proxy, sender, [status]) {
        let name = this._channel.connection.get_account().display_name;
        let statusString = (Object.keys(SASLStatus))[status];
        debug('Auth status for server "%s": %s'.format(name, statusString));

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
    }

    _resetPrompt() {
        let account = this._channel.connection.get_account();
        let prompt = new GLib.Variant('b', false);
        let params = new GLib.Variant('a{sv}', { 'password-prompt': prompt });
        account.update_parameters_vardict_async(params, [], (a, res) => {
            a.update_parameters_vardict_finish(res);
            account.request_presence_async(Tp.ConnectionPresenceType.AVAILABLE,
                                           'available', '', null);
        });
    }
};

var TelepathyClient = GObject.registerClass(
class TelepathyClient extends Tp.BaseClient {
    _init(params) {
        this._app = Gio.Application.get_default();
        this._app.connect('prepare-shutdown', () => {
            [...this._pendingRequests.values()].forEach(r => { r.cancel(); });
            [...this._pendingBotPasswords.keys()].forEach(a => { this._discardIdentifyPassword(a); });
            this._app.release();
        });
        this._app.hold();

        this._pendingBotPasswords = new Map();
        this._pendingRequests = new Map();

        super._init(params);

        this.set_handler_bypass_approval(false);
        this.set_observer_recover(true);

        this._networkMonitor = Gio.NetworkMonitor.get_default();
        this._roomManager = RoomManager.getDefault();
        this._roomManager.connect('room-added', (mgr, room) => {
            if (room.account.connection)
                this._connectRoom(room);
            room.connect('identify-sent', this._onIdentifySent.bind(this));
        });
        this._accountsMonitor = AccountsMonitor.getDefault();
        this._accountsMonitor.prepare(this._onPrepared.bind(this));
    }

    _onPrepared() {
        let actions = [
            { name: 'message-user',
              handler: this._onQueryActivated.bind(this) },
            { name: 'leave-room',
              handler: this._onLeaveActivated.bind(this) },
            { name: 'connect-account',
              handler: this._onConnectAccountActivated.bind(this) },
            { name: 'disconnect-account',
              handler: this._onDisconnectAccountActivated.bind(this) },
            { name: 'reconnect-account',
              handler: this._onReconnectAccountActivated.bind(this) },
            { name: 'authenticate-account',
              handler: this._onAuthenticateAccountActivated.bind(this) },
            { name: 'save-identify-password',
              handler: this._onSaveIdentifyPasswordActivated.bind(this) },
            { name: 'discard-identify-password',
              handler: this._onDiscardIdentifyPasswordActivated.bind(this) }
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

        this._accountsMonitor.connect('account-status-changed',
                                      this._onAccountStatusChanged.bind(this));
        this._accountsMonitor.connect('account-added', (mon, account) => {
            this._connectAccount(account);
        });
        this._accountsMonitor.connect('account-shown', (mon, account) => {
            this._connectAccount(account);
        });
        this._accountsMonitor.visibleAccounts.forEach(a => {
            this._onAccountStatusChanged(this._accountsMonitor, a);
        });

        this._networkMonitor.connect('network-changed',
                                     this._onNetworkChanged.bind(this));
        this._onNetworkChanged(this._networkMonitor,
                               this._networkMonitor.network_available);
    }

    _onNetworkChanged(mon, connected) {
        let presence = connected ? Tp.ConnectionPresenceType.AVAILABLE
                                 : Tp.ConnectionPresenceType.OFFLINE;
        debug('Network changed to %s'.format(connected ? 'available'
                                                       : 'unavailable'));

        this._accountsMonitor.visibleAccounts.forEach(a => {
            this._setAccountPresence(a, presence);
        });
    }

    _onAccountStatusChanged(mon, account) {
        if (account.connection_status != Tp.ConnectionStatus.CONNECTED)
            return;

        Utils.lookupIdentifyPassword(account, (password) => {
            if (password)
                this._sendIdentify(account, password);
            else
                this._connectRooms(account);
        });
    }

    _connectAccount(account) {
        this._setAccountPresence(account, Tp.ConnectionPresenceType.AVAILABLE);
    }

    _setAccountPresence(account, presence) {
        if (!account.enabled)
            return;

        let statuses = Object.keys(Tp.ConnectionPresenceType).map(s =>
            s.replace(/_/g, '-').toLowerCase()
        );
        let status = statuses[presence];
        let msg = account.requested_status_message;
        let accountName = account.display_name;

        debug('Setting presence of account "%s" to %s'.format(accountName,
                                                              status));
        account.request_presence_async(presence, status, msg, (o, res) => {
            try {
                account.request_presence_finish(res);
            } catch(e) {
                log('Connection failed: ' + e.message);
            }
        });
    }

    _connectRooms(account) {
        this._roomManager.rooms.forEach(room => {
            if (account == null || room.account == account)
                this._connectRoom(room);
        });
    }

    _connectRoom(room) {
        this._requestChannel(room.account, room.type, room.channel_name, null);
    }

    _requestChannel(account, targetType, targetId, callback) {
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
                    debug('Failed to ensure channel: ' + e.message);
                }

                if (callback)
                    callback(channel);
                this._pendingRequests.delete(roomId);
            });
    }

    _sendIdentify(account, password) {
        let settings = this._accountsMonitor.getAccountSettings(account);

        let params = account.dup_parameters_vardict().deep_unpack();
        let username = settings.get_string('identify-username') ||
                       params.username.deep_unpack();
        let alwaysSendUsername = settings.get_boolean('identify-username-supported');
        let contactName = settings.get_string('identify-botname');
        let command = settings.get_string('identify-command');
        this._requestChannel(account, Tp.HandleType.CONTACT, contactName,
            (channel) => {
                if (!channel)
                    return;

                let room = this._roomManager.lookupRoomByChannel(channel);
                let activeNick = room.channel.connection.self_contact.alias;
                // Omit username parameter when it matches the default, to
                // support NickServ bots that don't support the parameter at all
                if (!alwaysSendUsername && activeNick == username)
                    username = null;
                room.send_identify_message_async(command, username, password, (r, res) => {
                    try {
                        r.send_identify_message_finish(res);
                    } catch(e) {
                        log('Failed to send identify message: ' + e.message);
                    }
                    this._connectRooms(account);
                });
            });
    }

    _sendMessage(channel, message) {
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
    }

    _onConnectAccountActivated(action, parameter) {
        let accountPath = parameter.deep_unpack();
        let account = this._accountsMonitor.lookupAccount(accountPath);
        if (account.enabled)
            this._connectAccount(account);
        else
            account.set_enabled_async(true, () => {});
    }

    _onDisconnectAccountActivated(action, parameter) {
        let accountPath = parameter.deep_unpack();
        let account = this._accountsMonitor.lookupAccount(accountPath);
        account.set_enabled_async(false, () => {
            this._setAccountPresence(account, Tp.ConnectionPresenceType.OFFLINE);
        });
    }

    _onReconnectAccountActivated(action, parameter) {
        let accountPath = parameter.deep_unpack();
        let account = this._accountsMonitor.lookupAccount(accountPath);
        account.reconnect_async((a, res) => { a.reconnect_finish(res); });
    }

    _onAuthenticateAccountActivated(action, parameter) {
        let [accountPath, password] = parameter.deep_unpack();
        let account = this._accountsMonitor.lookupAccount(accountPath);

        let prompt = new GLib.Variant('b', password.length > 0);
        let params = GLib.Variant.new('a{sv}', { 'password-prompt': prompt });
        account.update_parameters_vardict_async(params, [], (a, res) => {
            a.update_parameters_vardict_finish(res);
            Utils.storeAccountPassword(a, password, () => {
                a.reconnect_async(null);
            });
        });
    }

    _onQueryActivated(action, parameter) {
        let [accountPath, channelName, message, time] = parameter.deep_unpack();
        let account = this._accountsMonitor.lookupAccount(accountPath);

        if (!account || !account.enabled)
            return;

        this._requestChannel(account, Tp.HandleType.CONTACT, channelName, c => {
            this._sendMessage(c, message);
        });
    }

    _onLeaveActivated(action, parameter) {
        let [id, message] = parameter.deep_unpack();

        let request = this._pendingRequests.get(id);
        if (request)
            request.cancel();

        let room = this._roomManager.lookupRoom(id);
        if (!room.channel)
            return;

        // This is a user action, so acknowledge messages to prevent
        // mission-control from popping up the channel again
        room.channel.dup_pending_messages().forEach(m => {
            // The room is about to be removed and will gone when the
            // ::pending-message-removed signal is emitted, so just
            // withdraw pending notifications now
            this._onPendingMessageRemoved(room.channel, m);
            room.channel.ack_message_async(m, null);
        });

        let reason = Tp.ChannelGroupChangeReason.NONE;
        message = message || _("Good Bye");
        room.channel.leave_async(reason, message, (c, res) => {
            try {
                c.leave_finish(res);
            } catch(e) {
                log('Failed to leave channel: ' + e.message);
            }
        });
    }

    _onSaveIdentifyPasswordActivated(action, parameter) {
        let accountPath = parameter.deep_unpack();
        let account = this._accountsMonitor.lookupAccount(accountPath);
        if (!account)
            return;

        let data = this._pendingBotPasswords.get(account.object_path);
        if (!data)
            return;

        Utils.storeIdentifyPassword(account, data.password, (res) => {
            if (res)
                this._saveIdentifySettings(account, data);

            this._pendingBotPasswords.delete(account.object_path);
        });
    }

    _saveIdentifySettings(account, data) {
        let settings = this._accountsMonitor.getAccountSettings(account);

        if (data.botname == 'NickServ')
            settings.reset('identify-botname');
        else
            settings.set_string('identify-botname', data.botname);

        if (data.command == 'identify')
            settings.reset('identify-command');
        else
            settings.set_string('identify-command', data.command);

        settings.set_string('identify-username', data.username);
        settings.set_boolean('identify-username-supported', data.usernameSupported);
    }

    _onDiscardIdentifyPasswordActivated(action, parameter) {
        let accountPath = parameter.deep_unpack();
        this._discardIdentifyPassword(accountPath);
    }

    _discardIdentifyPassword(accountPath) {
        this._pendingBotPasswords.delete(accountPath);
        this._app.withdraw_notification(this._getIdentifyNotificationID(accountPath));
    }

    _isAuthChannel(channel) {
        return channel.channel_type == Tp.IFACE_CHANNEL_TYPE_SERVER_AUTHENTICATION;
    }

    _processRequest(context, connection, channels, processChannel) {
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
    }

    vfunc_observe_channels(account, connection, channels,
                                     op, requests, context) {
        this._processRequest(context, connection, channels, channel => {
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
                            this._onMessageReceived.bind(this));
            channel.connect('pending-message-removed',
                            this._onPendingMessageRemoved.bind(this));

            this._roomManager.ensureRoomForChannel(channel, 0);
        });
    }

    vfunc_handle_channels(account, connection, channels,
                                    satisfied, userTime, context) {
        let [present, ] = Tp.user_action_time_should_present(userTime);

        this._processRequest(context, connection, channels, channel => {
            if (this._isAuthChannel(channel)) {
                let authHandler = new SASLAuthHandler(channel);
                return;
            }

            if (present)
                this._app.activate();

            this._roomManager.ensureRoomForChannel(channel, userTime);
            //channel.join_async('', null);
        });
    }

    _getPendingNotificationID(room, id) {
        return 'pending-message-%s-%d'.format(room.id, id);
    }

    _getIdentifyNotificationID(accountPath) {
        return 'identify-password-%s'.format(accountPath);
    }

    _createNotification(room, summary, body) {
        let notification = new Gio.Notification();
        notification.set_title(summary);
        notification.set_body(body);

        let params = [room.account.object_path,
                      room.channel_name,
                      Utils.getTpEventTime()];

        let actionName, paramFormat;
        if (room.type == Tp.HandleType.ROOM) {
            actionName = 'app.join-room';
            paramFormat = '(ssu)';
        } else {
            actionName = 'app.message-user';
            paramFormat = '(sssu)';
            params.splice(2, 0, '');
        }

        let param = GLib.Variant.new(paramFormat, params);
        notification.set_default_action_and_target(actionName, param);
        return notification;
    }

    _onIdentifySent(room, command, username, password) {
        let accountPath = room.account.object_path;

        let data = {
            botname: room.channel.target_contact.alias,
            command: command,
            username: username || room.channel.connection.self_contact.alias,
            usernameSupported: username != null,
            password: password
        };
        this._pendingBotPasswords.set(accountPath, data);

        if (this._app.isRoomFocused(room))
            return;

        let accountName = room.account.display_name;
        /* Translators: Those are a botname and an accountName, e.g.
           "Save NickServ password for GNOME" */
        let summary = _("Save %s password for %s?").format(data.botname, accountName);
        let text = _("Identification will happen automatically the next time you connect to %s").format(accountName);
        let notification = this._createNotification(room, summary, text);

        notification.add_button_with_target(_("Save"), 'app.save-identify-password',
                                            new GLib.Variant('o', accountPath));

        this._app.send_notification(this._getIdentifyNotificationID(accountPath), notification);
    }

    _onMessageReceived(channel, msg) {
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

        /* Translators: This is the title of the notification announcing a newly
	   received message, in the form "user-nickname in room-display-name" */
        let summary = _('%s in %s').format(nick, room.display_name);
        let notification = this._createNotification(room, summary, text);
        this._app.send_notification(this._getPendingNotificationID(room, id), notification);
    }

    _onPendingMessageRemoved(channel, msg) {
        let [id, valid] = msg.get_pending_message_id();
        if (!valid)
            return;

        let room = this._roomManager.lookupRoomByChannel(channel);
        if (!room)
            return;

        this._app.withdraw_notification(this._getPendingNotificationID(room, id));
    }
});
