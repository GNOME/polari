const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Polari = imports.gi.Polari;
const Signals = imports.signals;
const Tp = imports.gi.TelepathyGLib;

const {AccountsMonitor} = imports.accountsMonitor;

var RoomManager = class {
    static getDefault() {
        if (!this._singleton)
            this._singleton = new RoomManager();
        return this._singleton;
    }

    constructor() {
        this._rooms = new Map();
        this._settings = new Gio.Settings({ schema_id: 'org.gnome.Polari' })

        this._accountsMonitor = AccountsMonitor.getDefault();

        this._app = Gio.Application.get_default();
        let actions = [
            { name: 'join-room',
              handler: this._onJoinActivated.bind(this) },
            { name: 'message-user',
              handler: this._onQueryActivated.bind(this) },
            { name: 'leave-room',
              after: true,
              handler: this._onLeaveActivated.bind(this) }
        ];
        actions.forEach(a => {
            if (a.after)
                this._app.lookup_action(a.name).connect_after('activate', a.handler);
            else
                this._app.lookup_action(a.name).connect('activate', a.handler);
        });

        this._accountsMonitor.connect('account-shown', (mon, account) => {
            this._restoreRooms(account.object_path);
        });
        this._accountsMonitor.connect('account-hidden', (mon, account) => {
            this._removeRooms(account.object_path);
        });
        this._accountsMonitor.connect('account-removed', (mon, account) => {
            this._removeRooms(account.object_path);
            this._removeSavedChannelsForAccount(account.object_path);
        });
        this._accountsMonitor.prepare(() => { this._restoreRooms(); });
    }

    lookupRoom(id) {
        return this._rooms.get(id);
    }

    lookupRoomByName(name, account) {
        for (let room of this._rooms.values())
            if (room.channel_name == name && room.account == account)
                return room;
        return null;
    }

    lookupRoomByChannel(channel) {
        let account = channel.connection.get_account();
        let channelName = channel.identifier;
        let id = Polari.create_room_id(account, channelName, channel.handle_type);
        return this._rooms.get(id);
    }

    get roomCount() {
        return this._rooms.size;
    }

    get rooms() {
        return [...this._rooms.values()];
    }

    _onJoinActivated(action, parameter) {
        let [accountPath, channelName, time] = parameter.deep_unpack();
        this._addSavedChannel(accountPath, channelName);

        this._accountsMonitor.prepare(() => {
            this._ensureRoom(accountPath, channelName, Tp.HandleType.ROOM, time);
        });
    }

    _onQueryActivated(action, parameter) {
        let [accountPath, channelName, , time] = parameter.deep_unpack();

        this._accountsMonitor.prepare(() => {
            this._ensureRoom(accountPath, channelName, Tp.HandleType.CONTACT, time);
        });
    }

    _onLeaveActivated(action, parameter) {
        let [id, ] = parameter.deep_unpack();
        let room = this._rooms.get(id);

        this._removeSavedChannel(room.account.object_path, room.channel_name);
        this._removeRoom(room);
    }

    _restoreRooms(accountPath) {
        this._settings.get_value('saved-channel-list').deep_unpack().forEach(c => {
            for (let prop in c)
                c[prop] = c[prop].deep_unpack();
            if (accountPath == null || c.account == accountPath)
                this._ensureRoom(c.account, c.channel, Tp.HandleType.ROOM, 0)
        });
        this.emit('rooms-loaded');
    }

    _removeRooms(accountPath) {
        for (let room of this._rooms.values())
            if (accountPath == null || room.account.object_path == accountPath)
                this._removeRoom(room);
    }

    _findChannelIndex(channels, accountPath, channelName) {
        let matchName = channelName.toLowerCase();
        for (let i = 0; i < channels.length; i++)
            if (channels[i].account.deep_unpack() == accountPath &&
                channels[i].channel.deep_unpack().toLowerCase() == matchName)
            return i;
        return -1;
    }

    _addSavedChannel(accountPath, channelName) {
        let channels = this._settings.get_value('saved-channel-list').deep_unpack();
        if (this._findChannelIndex(channels, accountPath, channelName) != -1)
            return;
        channels.push({
            account: new GLib.Variant('s', accountPath),
            channel: new GLib.Variant('s', channelName)
        });
        this._settings.set_value('saved-channel-list',
                                 new GLib.Variant('aa{sv}', channels));
    }

    _removeSavedChannel(accountPath, channelName) {
        let channels = this._settings.get_value('saved-channel-list').deep_unpack();
        let pos = this._findChannelIndex(channels, accountPath, channelName);
        if (pos < 0)
            return;
        channels.splice(pos, 1);
        this._settings.set_value('saved-channel-list',
                                 new GLib.Variant('aa{sv}', channels));
    }

    _removeSavedChannelsForAccount(accountPath) {
        let channels = this._settings.get_value('saved-channel-list').deep_unpack();
        let account = new GLib.Variant('s', accountPath);

        channels = channels.filter(c => !c.account.equal(account));
        this._settings.set_value('saved-channel-list',
                                 new GLib.Variant('aa{sv}', channels));
    }

    _ensureRoom(accountPath, channelName, type, time) {
        let account = this._accountsMonitor.lookupAccount(accountPath);

        if (!account) {
            this._removeSavedChannelsForAccount(accountPath);
            return null;
        }

        if (!account.visible)
            return null;

        let id = Polari.create_room_id(account, channelName, type);
        let room = this._rooms.get(id);
        if (!room) {
            room = new Polari.Room({ account: account,
                                     channel_name: channelName,
                                     type: type });
            this._rooms.set(room.id, room);
            this.emit('room-added', room);
        }

        let [present, ] = Tp.user_action_time_should_present(time);
        if (present && this._app.active_window)
            this._app.active_window.active_room = room;

        return room;
    }

    ensureRoomForChannel(channel, time) {
        let accountPath = channel.connection.get_account().object_path;
        let targetContact = channel.target_contact;
        let channelName = targetContact ? targetContact.alias
                                        : channel.identifier;
        let room = this._ensureRoom(accountPath, channelName, channel.handle_type, time);
        room.channel = channel;
    }

    _removeRoom(room) {
        if (this._rooms.delete(room.id))
            this.emit('room-removed', room);
    }
};
Signals.addSignalMethods(RoomManager.prototype);
