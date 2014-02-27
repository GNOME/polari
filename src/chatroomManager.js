const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Polari = imports.gi.Polari;
const Tp = imports.gi.TelepathyGLib;

const Lang = imports.lang;
const Signals = imports.signals;

let _singleton = null;

function getDefault() {
    if (_singleton == null)
        _singleton = new _ChatroomManager();
    return _singleton;
}

const _ChatroomManager = new Lang.Class({
    Name: '_ChatroomManager',

    _init: function() {
        this._rooms = {};
        this._activeRoom = null;

        this._app = Gio.Application.get_default();

        this._accountManager = Tp.AccountManager.dup();
        this._networkMonitor = Gio.NetworkMonitor.get_default();

        let factory = this._accountManager.get_factory();
        factory.add_channel_features([Tp.Channel.get_feature_quark_group()]);
        factory.add_channel_features([Tp.Channel.get_feature_quark_contacts()]);
        factory.add_contact_features([Tp.ContactFeature.ALIAS]);

        this._accountManager.prepare_async(null,
                                           Lang.bind(this, this._onPrepared));
    },

    _onPrepared: function(am, res) {
        try {
            am.prepare_finish(res);
        } catch(e) {
            this._app.release(); // no point in carrying on
        }

        let joinAction = this._app.lookup_action('join-room');
        joinAction.connect('activate', Lang.bind(this, this._onJoinActivated));

        let queryAction = this._app.lookup_action('message-user');
        queryAction.connect('activate', Lang.bind(this, this._onQueryActivated));

        let leaveAction = this._app.lookup_action('leave-room');
        leaveAction.connect('activate', Lang.bind(this, this._onLeaveActivated));

        this._observer = Tp.SimpleObserver.new_with_am(am, true,
            'Polari', true, Lang.bind(this, this._observeChannels));

        this._handler = Tp.SimpleHandler.new_with_am(am, false,
            false, 'Polari', false, Lang.bind(this, this._handleChannels));

        let filters = [];

        let roomFilter = {};
        roomFilter[Tp.PROP_CHANNEL_CHANNEL_TYPE] = Tp.IFACE_CHANNEL_TYPE_TEXT;
        roomFilter[Tp.PROP_CHANNEL_TARGET_HANDLE_TYPE] = Tp.HandleType.ROOM;
        filters.push(roomFilter);

        let contactFilter = {};
        contactFilter[Tp.PROP_CHANNEL_CHANNEL_TYPE] = Tp.IFACE_CHANNEL_TYPE_TEXT;
        contactFilter[Tp.PROP_CHANNEL_TARGET_HANDLE_TYPE] = Tp.HandleType.CONTACT;
        filters.push(contactFilter);

        filters.forEach(Lang.bind(this,
            function(f) {
                this._handler.add_handler_filter(f);
                this._observer.add_observer_filter(f);
            }));
        this._handler.register();
        this._observer.register();

        am.connect('account-enabled',
                   Lang.bind(this, this._restoreSavedChannels));
        am.connect('account-disabled',
                   Lang.bind(this, this._onAccountDisabled));
        am.connect('account-removed',
                   Lang.bind(this, this._onAccountDisabled));
        this._restoreSavedChannels();

        this._networkMonitor.connect('notify::network-available', Lang.bind(this,
            function() {
                if (this._networkMonitor.network_available)
                    this._restoreSavedChannels();
            }));
    },

    _onAccountDisabled: function(am, account) {
        for (let id in this._rooms) {
            let room = this._rooms[id];
            if (room.account == account)
                this._removeRoom(room);
        }
    },

    _restoreSavedChannels: function() {
        let settings = new Gio.Settings({ schema: 'org.gnome.polari' });
        let savedChannels = settings.get_value('saved-channel-list').deep_unpack();
        for (let i = 0; i < savedChannels.length; i++) {
            let serializedChannel = savedChannels[i];
            for (let prop in serializedChannel)
                serializedChannel[prop] = serializedChannel[prop].deep_unpack();

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

    _onJoinActivated: function(action, parameter) {
        let [accountPath, channelName, ] = parameter.deep_unpack();
        let factory = Tp.AccountManager.dup().get_factory();
        let account = factory.ensure_account(accountPath, []);

        if (!account.enabled)
            return;

        this._ensureRoom(account, channelName, Tp.HandleType.ROOM);
    },

    _onQueryActivated: function(action, parameter) {
        let [accountPath, channelName, ] = parameter.deep_unpack();
        let factory = Tp.AccountManager.dup().get_factory();
        let account = factory.ensure_account(accountPath, []);

        if (!account.enabled)
            return;

        this._ensureRoom(account, channelName, Tp.HandleType.CONTACT);
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
        let channelName = channel.identifier;
        let room = this._ensureRoom(account, channelName, channel.handle_type);
        room.channel = channel;
        return room;
    },

    _processRequest: function(context, connection, channels, processChannel) {
        if (connection.protocol_name != 'irc') {
            let message = 'Not implementing non-IRC protocols';
            context.fail(new Tp.Error({ code: Tp.Error.NOT_IMPLEMENTED,
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

    _observeChannels: function() {
        let [observer, account, connection,
             channels, op, requests, context] = arguments;

        this._processRequest(context, connection, channels, Lang.bind(this,
            function(channel) {
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

    _handleChannels: function() {
        let [handler, account, connection,
             channels, satisfied, userTime, context] = arguments;

        let [present, time] = Tp.user_action_time_should_present(userTime);

        this._processRequest(context, connection, channels, Lang.bind(this,
            function(channel) {
                let room = this._ensureRoomForChannel(channel);
                //channel.join_async('', null);

                if (present || this.roomCount == 1)
                    this.setActiveRoom(room);
            }));
        if (present)
            this._app.get_active_window().present_with_time(time);
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

    getActiveRoom: function(room) {
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
