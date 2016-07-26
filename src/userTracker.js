const Polari = imports.gi.Polari;
const Lang = imports.lang;
const Tp = imports.gi.TelepathyGLib;
const Signals = imports.signals;
const GObject = imports.gi.GObject;
const Utils = imports.utils;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;

const AccountsMonitor = imports.accountsMonitor;
const ChatroomManager = imports.chatroomManager;

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

        this._accountsMonitor.connect('account-added', Lang.bind(this, this._onAccountAdded));
        this._accountsMonitor.connect('account-removed', Lang.bind(this, this._onAccountRemoved));
    },

    _onAccountAdded: function(accountsMonitor, account) {
        if (this._userTrackers.has(account))
            return;

        this._userTrackers.set(account, new UserTracker(account));
    },

    _onAccountRemoved: function(accountsMonitor, account) {
        if (!this._userTrackers.has(account))
            return;

        this._userTrackers.delete(account);
    },

    getUserTrackerForAccount: function(account) {
        if (this._userTrackers.has(account))
            return this._userTrackers.get(account);
        return null;
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

        this._chatroomManager = ChatroomManager.getDefault();
        this._chatroomManager.connect('room-added', Lang.bind(this, this._onRoomAdded));
        this._chatroomManager.connect('room-removed', Lang.bind(this, this._onRoomRemoved));
    },

    _getRoomContacts: function(room) {
        return this._roomData.get(room)._contactMapping;
    },

    _getRoomHandlers: function(room) {
        return this._roomData.get(room)._handlerMapping;
    },

    _getRoomSignals: function(room) {
        return this._roomData.get(room)._roomSignals;
    },

    _insertRoomData: function(room, data) {
        this._roomData.set(room, data);
    },

    _deleteRoomData: function(room) {
        if (this._roomData.has(room))
            this._roomData.delete(room);
    },

    _deleteRoomDataHandler: function(room, handlerID) {
        if (!this._isRoomData(room))
            return;

        if (!this._getRoomHandlers(room))
            return;

        this._getRoomHandlers(room).delete(handlerID);
    },

    _isRoomData: function(room) {
        return this._roomData.has(room);
    },

    _onRoomAdded: function(roomManager, room) {
        if (room.account == this._account)
            this._connectRoomSignalsForRoom(room);
    },

    _onRoomRemoved: function(roomManager, room) {
        if (room.account != this._account)
            return;

        this._disconnectRoomSignalsForRoom(room);
        this._clearUsersFromRoom(room);
        this._deleteRoomData(room);
    },

    _connectRoomSignalsForRoom: function(room) {
        this._ensureRoomMappingForRoom(room);

        let currentRoomSignals = this._getRoomSignals(room);

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

        roomSignals.forEach(Lang.bind(this, function(signal) {
            currentRoomSignals.push(room.connect(signal.name, signal.handler));
        }));
    },

    _disconnectRoomSignalsForRoom: function(room) {
        let currentRoomSignals = this._getRoomSignals(room);

        for (let i = 0; i < currentRoomSignals.length; i++) {
            room.disconnect(currentRoomSignals[i]);
        }
        currentRoomSignals = [];
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

        this._ensureRoomMappingForRoom(room);

        /*keep track of initial members in the room, both locally and
        globally*/
        members.forEach(m => { this._trackMember(m, room); });
    },

    _clearUsersFromRoom: function(room) {
        let map = this._getRoomContacts(room);
        for ([baseNick, contacts] of map)
            while (contacts.length > 0)
                this._untrackMember(contacts[0], room);
    },

    _ensureRoomMappingForRoom: function(room) {
        if (!this._isRoomData(room))
            this._insertRoomData(room, { _contactMapping: new Map(),
                                         _handlerMapping: new Map(),
                                         _roomSignals: [] });
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
        for ([id, info] of roomHandlers)
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

        let map = this._baseNickContacts;
        if (this._pushMember(map, baseNick, member) == 1) {
            this.emit("status-changed::" + baseNick, baseNick, status);

            if (this._shouldNotifyNick(member.alias))
                this._emitNotification(room, member);

            this._setNotifyActionEnabled(member.alias, false);
        }

        let roomMap = this._getRoomContacts(room);
        if (this._pushMember(roomMap, baseNick, member) == 1)
            this._runHandlers(room, member, status);

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

        let map = this._baseNickContacts;
        let [found, nContacts] = this._popMember(map, baseNick, member);
        if (found) {
            if (nContacts == 0) {
                this.emit("status-changed::" + baseNick, member.alias, status);
                this._setNotifyActionEnabled(member.alias, true);
            }
            this.emit("contacts-changed::" + baseNick, member.alias);
        }

        let roomMap = this._getRoomContacts(room);
        [found, nContacts] = this._popMember(roomMap, baseNick, member);
        if (found && nContacts == 0)
            this._runHandlers(room, member, status);
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

        if (contacts.length == 0)
            return null;

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
        this._deleteRoomDataHandler(room, handlerID);
    },

    _emitNotification: function (room, member) {
        let notification = new Gio.Notification();
        notification.set_title(_("User is online"));
        notification.set_body(_("User %s is now online.").format(member.alias));

        let param = GLib.Variant.new('(ssu)',
                                     [ this._account.get_object_path(),
                                       room.channel_name,
                                       Utils.getTpEventTime() ]);
        notification.set_default_action_and_target('app.join-room', param);

        this._app.send_notification(this._getNotifyActionName(member.alias), notification);

        let baseNick = Polari.util_get_basenick(member.alias);
    },

    _shouldNotifyNick: function(nickName) {
        let actionName = this._getNotifyActionName(nickName);
        let state = this._app.get_action_state(actionName);
        return state ? state.get_boolean()
                     : false;
    },

    _setNotifyActionEnabled: function(nickName, enabled) {
        let name = this._getNotifyActionName(nickName);
        let action = this._app.lookup_action(name);
        if (action)
            action.enabled = enabled;
    },

    _getNotifyActionName: function(nickName) {
        return 'notify-user-' +
               this._account.get_path_suffix() + '-' +
               Polari.util_get_basenick(nickName);
    },

    getNotifyActionName: function(nickName) {
        let name = this._getNotifyActionName(nickName);

        if (!this._app.lookup_action(name)) {
            let status = this.getNickStatus(nickName);
            let enabled = status == Tp.ConnectionPresenceType.OFFLINE;

            let state = new GLib.Variant('b', false);
            let action = new Gio.SimpleAction({ name: name,
                                                enabled: enabled,
                                                state: state });

            action.connect('notify::enabled', () => {
                if (!action.enabled)
                    action.change_state(GLib.Variant.new('b', false));
            });

            this._app.add_action(action);
        }

        return 'app.' + name;
    }
});
