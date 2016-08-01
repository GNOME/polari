const Polari = imports.gi.Polari;
const Lang = imports.lang;
const Tp = imports.gi.TelepathyGLib;
const Signals = imports.signals;
const GObject = imports.gi.GObject;
const Utils = imports.utils;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;

const AccountsMonitor = imports.accountsMonitor;
const RoomManager = imports.roomManager;

let _singleton = null;

function getUserStatusMonitor() {
    if (_singleton == null)
        _singleton = new UserStatusMonitor();
    return _singleton;
}

const UserStatusMonitor = new Lang.Class({
    Name: 'UserStatusMonitor',

    _init: function() {
        this._userTrackers = new Map();
        this._accountsMonitor = AccountsMonitor.getDefault();

        this._accountsMonitor.connect('account-added',
                                      Lang.bind(this, this._onAccountAdded));
        this._accountsMonitor.connect('account-removed',
                                      Lang.bind(this, this._onAccountRemoved));

        this._accountsMonitor.accounts.forEach(
                    a => { this._onAccountAdded(this._accountsMonitor, a); });
    },

    _onAccountAdded: function(accountsMonitor, account) {
        if (this._userTrackers.has(account))
            return;

        this._userTrackers.set(account, new UserTracker(account));
    },

    _onAccountRemoved: function(accountsMonitor, account) {
        this._userTrackers.delete(account);
    },

    getUserTrackerForAccount: function(account) {
            return this._userTrackers.get(account);
    }
});


const UserTracker = new Lang.Class({
    Name: 'UserTracker',
    Extends: GObject.Object,

    Signals: {
        'status-changed': {
            flags: GObject.SignalFlags.DETAILED,
            param_types: [GObject.TYPE_STRING, GObject.TYPE_INT]
        },
        'contacts-changed': {
            flags: GObject.SignalFlags.DETAILED,
            param_types: [GObject.TYPE_STRING]
        }
    },

    _init: function(account) {
        this.parent();

        this._account = account;

        this._baseNickContacts = new Map();
        this._roomData = new Map();
        this._handlerCounter = 0;
        this._app = Gio.Application.get_default();

        this._app.connect('prepare-shutdown', Lang.bind(this, this._onShutdown));

        this._roomManager = RoomManager.getDefault();
        this._roomManager.connect('room-added', Lang.bind(this, this._onRoomAdded));
        this._roomManager.connect('room-removed', Lang.bind(this, this._onRoomRemoved));
    },

    _onShutdown: function() {
        for (let room of this._roomData.keys())
            this._onRoomRemoved(this._roomManager, room);
    },

    _getRoomContacts: function(room) {
        return this._roomData.get(room).contactMapping;
    },

    _getRoomHandlers: function(room) {
        return this._roomData.get(room).handlerMapping;
    },

    _getRoomSignals: function(room) {
        return this._roomData.get(room).roomSignals;
    },

    _onRoomAdded: function(roomManager, room) {
        if (room.account != this._account)
            return;

        this._ensureRoomMappingForRoom(room);

        let roomSignals = [
            { name: 'notify::channel',
              handler: Lang.bind(this, this._onChannelChanged) },
            { name: 'member-renamed',
              handler: Lang.bind(this, this._onMemberRenamed) },
            { name: 'member-disconnected',
              handler: Lang.bind(this, this._onMemberLeft) },
            { name: 'member-kicked',
              handler: Lang.bind(this, this._onMemberLeft) },
            { name: 'member-banned',
              handler: Lang.bind(this, this._onMemberLeft) },
            { name: 'member-joined',
              handler: Lang.bind(this, this._onMemberJoined) },
            { name: 'member-left',
              handler: Lang.bind(this, this._onMemberLeft) }
        ];

        let signalIds = this._getRoomSignals(room);
        roomSignals.forEach(signal => {
            signalIds.push(room.connect(signal.name, signal.handler));
        });
    },

    _onRoomRemoved: function(roomManager, room) {
        if (!this._roomData.has(room))
            return;

        this._getRoomSignals(room).forEach(id => { room.disconnect(id); });
        this._clearUsersFromRoom(room);
        this._roomData.delete(room);
    },

    _onChannelChanged: function(room) {
        if (!room.channel) {
            this._clearUsersFromRoom(room);
            return;
        }

        let members;
        if (room.type == Tp.HandleType.ROOM)
            members = room.channel.group_dup_members_contacts();
        else
            members = [room.channel.connection.self_contact, room.channel.target_contact];

        /*keep track of initial members in the room, both locally and
        globally*/
        members.forEach(m => { this._trackMember(m, room); });
    },

    _clearUsersFromRoom: function(room) {
        let map = this._getRoomContacts(room);
        for (let [baseNick, contacts] of map)
            contacts.slice().forEach((m) => { this._untrackMember(m, room); });
    },

    _ensureRoomMappingForRoom: function(room) {
        if (this._roomData.has(room))
            return;
        this._roomData.set(room, { contactMapping: new Map(),
                                   handlerMapping: new Map(),
                                   roomSignals: [] });
    },

    _onMemberRenamed: function(room, oldMember, newMember) {
        this._untrackMember(oldMember, room);
        this._trackMember(newMember, room);
    },

    _onMemberJoined: function(room, member) {
        this._trackMember(member, room);
    },

    _onMemberLeft: function(room, member) {
        this._untrackMember(member, room);
    },

    _runHandlers: function(room, member, status) {
        let baseNick = Polari.util_get_basenick(member.alias);
        let roomHandlers = this._getRoomHandlers(room);
        for (let [id, info] of roomHandlers)
            if (!info.nickName || info.nickName == baseNick)
                info.handler(baseNick, status);
    },

    _pushMember: function(map, baseNick, member) {
        if (!map.has(baseNick))
            map.set(baseNick, []);
        let contacts = map.get(baseNick);
        return contacts.push(member);
    },

    _trackMember: function(member, room) {
        let baseNick = Polari.util_get_basenick(member.alias);
        let status = Tp.ConnectionPresenceType.AVAILABLE;

        let roomMap = this._getRoomContacts(room);
        if (this._pushMember(roomMap, baseNick, member) == 1)
            this._runHandlers(room, member, status);

        let map = this._baseNickContacts;
        if (this._pushMember(map, baseNick, member) == 1)
            this.emit("status-changed::" + baseNick, baseNick, status);

        this.emit("contacts-changed::" + baseNick, member.alias);
    },

    _popMember: function(map, baseNick, member) {
        let contacts = map.get(baseNick) || [];
        let index = contacts.map(c => c.alias).indexOf(member.alias);
        if (index < 0)
            return [false, contacts.length];
        contacts.splice(index, 1);
        return [true, contacts.length];
    },

    _untrackMember: function(member, room) {
        let baseNick = Polari.util_get_basenick(member.alias);
        let status = Tp.ConnectionPresenceType.OFFLINE;

        let roomMap = this._getRoomContacts(room);
        [found, nContacts] = this._popMember(roomMap, baseNick, member);
        if (found && nContacts == 0)
            this._runHandlers(room, member, status);

        let map = this._baseNickContacts;
        let [found, nContacts] = this._popMember(map, baseNick, member);
        if (found) {
            if (nContacts == 0)
                this.emit("status-changed::" + baseNick, member.alias, status);
            this.emit("contacts-changed::" + baseNick, member.alias);
        }
    },

    getNickStatus: function(nickName) {
        let baseNick = Polari.util_get_basenick(nickName);

        let contacts = this._baseNickContacts.get(baseNick) || [];
        return contacts.length == 0 ? Tp.ConnectionPresenceType.OFFLINE
                                    : Tp.ConnectionPresenceType.AVAILABLE;
    },

    getNickRoomStatus: function(nickName, room) {
        let baseNick = Polari.util_get_basenick(nickName);

        this._ensureRoomMappingForRoom(room);

        let contacts = this._getRoomContacts(room).get(baseNick) || [];
        return contacts.length == 0 ? Tp.ConnectionPresenceType.OFFLINE
                                    : Tp.ConnectionPresenceType.AVAILABLE;
    },

    lookupContact: function(nickName) {
        let baseNick = Polari.util_get_basenick(nickName);

        let contacts = this._baseNickContacts.get(baseNick) || [];

        for (let i = 0; i < contacts.length; i++)
            if (contacts[i].alias == nickName)
                return contacts[i];

        return contacts[0];
    },

    watchRoomStatus: function(room, baseNick, callback) {
        this._ensureRoomMappingForRoom(room);

        this._getRoomHandlers(room).set(++this._handlerCounter, {
            nickName: baseNick,
            handler: callback
        });

        return this._handlerCounter;
    },

    unwatchRoomStatus: function(room, handlerID) {
        if (!this._roomData.has(room))
            return;
        this._getRoomHandlers(room).delete(handlerID);
    }
});
