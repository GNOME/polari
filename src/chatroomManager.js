const Gio = imports.gi.Gio;
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

        this._accountManager = Tp.AccountManager.dup();

        let factory = this._accountManager.get_factory();
        factory.add_account_features([Tp.Account.get_feature_quark_connection()]);
        factory.add_connection_features([Tp.Connection.get_feature_quark_capabilities()]);
        factory.add_channel_features([Tp.Channel.get_feature_quark_group()]);

        this._accountManager.prepare_async(null,
                                           Lang.bind(this, this._onPrepared));
    },

    _onPrepared: function(am, res) {
        try {
            am.prepare_finish(res);
        } catch(e) {
            let app = Gio.Application.get_default();
            app.release(); // no point in carrying on
        }

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
    },

    _observeChannels: function(observer, account, conn, channels, op, requests, context) {
        if (conn.protocol_name != 'irc') {
            let message = 'Not implementing non-IRC protocols';
            context.fail(new Tp.Error({ code: Tp.Error.NOT_IMPLEMENTED,
                                        message: message }));
            return;
        }

        for (let i = 0; i < channels.length; i++) {
            if (channels[i].get_invalidated())
                continue;

            // this is an invitation - only add it in handleChannel if accepted
            if (channels[i].has_interface(Tp.IFACE_CHANNEL_INTERFACE_GROUP) &&
                channels[i].group_self_contact != null)
                continue;

            let room = new Polari.Room({ channel: channels[i] });
            room.channel.connect('invalidated', Lang.bind(this,
                function() {
                    this._removeRoom(room);
                }));
            this._addRoom(room);
        }
        context.accept();
    },

    _handleChannels: function(handler, account, conn, channels, satisfied, user_time, context) {
        if (conn.protocol_name != 'irc') {
            let message = 'Not implementing non-IRC protocols';
            context.fail(new Tp.Error({ code: Tp.Error.NOT_IMPLEMENTED,
                                        message: message }));
            return;
        }

        for (let i = 0; i < channels.length; i++) {
            if (channels[i].get_invalidated())
                continue;

            let room = this._rooms[channels[i].get_object_path()];
            if (room)
                continue; // already added from observer

            room = new Polari.Room({ channel: channels[i] });
            room.channel.connect('invalidated', Lang.bind(this,
                function() {
                    this._removeRoom(room);
                }));
            this._addRoom(room);
            channels[i].join_async('', null);
        }
        context.accept();
    },

    _addRoom: function(room) {
        if (this._rooms[room.id])
            return;
        this._rooms[room.id] = room;
        this.emit('room-added', room);
    },

    _removeRoom: function(room) {
        if (!this._rooms[room.id])
            return;
        delete this._rooms[room.id];
        this.emit('room-removed', room);
    },

    setActiveRoom: function(room) {
        if (room == this._activeRoom)
            return;

        this._activeRoom = room;
        this.emit('active-changed', room);
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

    get roomCount() {
        return Object.keys(this._rooms).length;
    }
});
Signals.addSignalMethods(_ChatroomManager.prototype);
