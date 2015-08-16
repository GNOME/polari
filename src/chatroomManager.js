const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Polari = imports.gi.Polari;
const Tp = imports.gi.TelepathyGLib;

const AccountsMonitor = imports.accountsMonitor;
const Lang = imports.lang;
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

let _singleton = null;

function getDefault() {
    if (_singleton == null)
        _singleton = new _ChatroomManager();
    return _singleton;
}

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

const Client = new Lang.Class({
    Name: 'Client',
    GTypeName: 'PolariTpClient',
    Extends: Tp.BaseClient,

    _init: function(am, manager) {
        this.parent({ account_manager: am,
                      name: 'Polari',
                      uniquify_name: false });
        this.set_handler_bypass_approval(false);
        this.set_observer_recover(true);

        this._manager = manager;
    },

    vfunc_observe_channels: function() {
        this._manager.observeChannels.apply(this._manager, arguments);
    },

    vfunc_handle_channels: function() {
        this._manager.handleChannels.apply(this._manager, arguments);
    }
});

const _ChatroomManager = new Lang.Class({
    Name: '_ChatroomManager',

    _init: function() {
        this._rooms = {};
        this._activeRoom = null;

        this._app = Gio.Application.get_default();

        this._networkMonitor = Gio.NetworkMonitor.get_default();
        this._accountsMonitor = AccountsMonitor.getDefault();
        this._accountsMonitor.connect('account-manager-prepared',
                                      Lang.bind(this, this._onPrepared));
        this._amIsPrepared = false;
    },

    _onPrepared: function(mon, am) {
        let joinAction = this._app.lookup_action('join-room');
        joinAction.connect('activate', Lang.bind(this, this._onJoinActivated));

        let queryAction = this._app.lookup_action('message-user');
        queryAction.connect('activate', Lang.bind(this, this._onQueryActivated));

        let leaveAction = this._app.lookup_action('leave-room');
        leaveAction.connect('activate', Lang.bind(this, this._onLeaveActivated));

        let reconnectAction = this._app.lookup_action('reconnect-account');
        reconnectAction.connect('activate', Lang.bind(this, this._onReconnectAccountActivated));

        this._client = new Client(am, this);

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

        filters.forEach(Lang.bind(this,
            function(f) {
                this._client.add_handler_filter(f);
                this._client.add_observer_filter(f);
            }));
        this._client.register();

        this._amIsPrepared = true;
        this.lateInit();
    },

    lateInit: function() {
        let am = this._accountsMonitor.accountManager;
        let ready = this._amIsPrepared &&
            this._app.get_active_window() != null;
        if (!ready)
            return;

        am.connect('account-enabled',
                   Lang.bind(this, this._onAccountEnabled));
        am.connect('account-disabled',
                   Lang.bind(this, this._onAccountDisabled));
        am.connect('account-removed',
                   Lang.bind(this, this._onAccountDisabled));
        this._accountsMonitor.connect('account-status-changed', Lang.bind(this, function(monitor, account) {
            if (account.connection_status == Tp.ConnectionStatus.CONNECTED)
                this._restoreSavedChannels(account);
        }));
        this._restoreSavedChannels(null);

        this._networkMonitor.connect('notify::network-available', Lang.bind(this,
            function() {
                if (this._networkMonitor.network_available)
                    this._restoreSavedChannels(null);
            }));
    },

    _onAccountEnabled: function(am, account) {
        this._restoreSavedChannels(account);
    },

    _onAccountDisabled: function(am, account) {
        for (let id in this._rooms) {
            let room = this._rooms[id];
            if (room.account == account)
                this._removeRoom(room);
        }
    },

    _restoreSavedChannels: function(account) {
        let settings = new Gio.Settings({ schema_id: 'org.gnome.Polari' });
        let savedChannels = settings.get_value('saved-channel-list').deep_unpack();
        for (let i = 0; i < savedChannels.length; i++) {
            let serializedChannel = savedChannels[i];
            for (let prop in serializedChannel)
                serializedChannel[prop] = serializedChannel[prop].deep_unpack();

            if (account == null || serializedChannel.account == account.object_path)
                this._restoreChannel(serializedChannel);
        }
    },

    _restoreChannel: function(serializedChannel) {
        let action = this._app.lookup_action('join-room');
        let parameter = GLib.Variant.new('(ssu)',
                                        [serializedChannel.account,
                                         serializedChannel.channel,
                                         0]);
        action.activate(parameter);
    },

    _onReconnectAccountActivated: function(action, parameter) {
        let accountPath = parameter.deep_unpack();
        let factory = Tp.AccountManager.dup().get_factory();
        let account = factory.ensure_account(accountPath, []);
        this._restoreSavedChannels(account);
    },

    _onJoinActivated: function(action, parameter) {
        let [accountPath, channelName, time] = parameter.deep_unpack();
        let factory = Tp.AccountManager.dup().get_factory();
        let account = factory.ensure_account(accountPath, []);

        if (!account.enabled)
            return;

        let room = this._ensureRoom(account, channelName, Tp.HandleType.ROOM);
        let [present, ] = Tp.user_action_time_should_present(time);
        if (present)
            this.setActiveRoom(room);
    },

    _onQueryActivated: function(action, parameter) {
        let [accountPath, channelName, message, time] = parameter.deep_unpack();
        let factory = Tp.AccountManager.dup().get_factory();
        let account = factory.ensure_account(accountPath, []);

        if (!account.enabled)
            return;

        let room = this._ensureRoom(account, channelName, Tp.HandleType.CONTACT);
        let [present, ] = Tp.user_action_time_should_present(time);
        if (present)
            this.setActiveRoom(room);
    },

    _onLeaveActivated: function(action, parameter) {
        let [id, ] = parameter.deep_unpack();
        let room = this._rooms[id];
        this._removeRoom(room);
    },

    _ensureRoom: function(account, channelName, type) {
        let room = this._rooms[Polari.create_room_id(account, channelName, type)];
        if (room)
            return room;

        let room = new Polari.Room({ account: account,
                                     channel_name: channelName,
                                     type: type });
        this._addRoom(room);

        return room;
    },

    _ensureRoomForChannel: function(channel) {
        let account = channel.connection.get_account();
        let targetContact = channel.target_contact;
        let channelName = targetContact ? targetContact.alias
                                        : channel.identifier;
        let room = this._ensureRoom(account, channelName, channel.handle_type);
        room.channel = channel;
        return room;
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

    observeChannels: function() {
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

                let room = this._ensureRoomForChannel(channel);
                if (this.roomCount == 1)
                    this.setActiveRoom(room);
            }));
    },

    handleChannels: function() {
        let [account, connection,
             channels, satisfied, userTime, context] = arguments;

        let [present, time] = Tp.user_action_time_should_present(userTime);

        this._processRequest(context, connection, channels, Lang.bind(this,
            function(channel) {
                if (this._isAuthChannel(channel)) {
                    let authHandler = new SASLAuthHandler(channel);
                    return;
                }

                if (!this._app.get_active_window())
                    this._app.activate();

                let room = this._ensureRoomForChannel(channel);
                //channel.join_async('', null);

                if (present || this.roomCount == 1)
                    this.setActiveRoom(room);

                if (present)
                    this._app.get_active_window().present_with_time(time);
            }));
    },

    _addRoom: function(room) {
        if (this._rooms[room.id])
            return;

        room._channelChangedId = room.connect('notify::channel', Lang.bind(this,
            function(room) {
                if (room == this._activeRoom)
                    this.emit('active-state-changed');
            }));

        this._rooms[room.id] = room;
        this.emit('room-added', room);

        if (this.roomCount == 1)
            this.setActiveRoom(room);
    },

    _removeRoom: function(room) {
        if (!this._rooms[room.id])
            return;
        room.disconnect(room._channelChangedId);
        delete room._channelChangedId;
        delete this._rooms[room.id];
        this.emit('room-removed', room);
    },

    setActiveRoom: function(room) {
        if (room == this._activeRoom)
            return;

        this._activeRoom = room;
        this.emit('active-changed', room);
        this.emit('active-state-changed');
    },

    getActiveRoom: function() {
        return this._activeRoom;
    },

    getRoomByName: function(name) {
        for (let id in this._rooms)
            if (this._rooms[id].channel.identifier == name)
                return this._rooms[id];
        return null;
    },

    getRoomById: function(id) {
        return this._rooms[id];
    },

    get roomCount() {
        return Object.keys(this._rooms).length;
    }
});
Signals.addSignalMethods(_ChatroomManager.prototype);
