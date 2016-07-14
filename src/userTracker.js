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
        this._userTrackersMaping = new Map();
        this._accountsMonitor = AccountsMonitor.getDefault();

        this._accountsMonitor.connect('account-added', Lang.bind(this, this._onAccountAdded));
        this._accountsMonitor.connect('account-removed', Lang.bind(this, this._onAccountRemoved));
    },

    _onAccountAdded: function(accountsMonitor, account) {
        this._addUserTrackerForAccount(account);
    },

    _onAccountRemoved: function(accountsMonitor, account) {
        this._removeUserTrackerForAccount(account);
    },

    _addUserTrackerForAccount: function(account) {
        if (this._userTrackersMaping.has(account))
            return;

        this._userTrackersMaping.set(account, new UserTracker(account));
    },

    _removeUserTrackerForAccount: function(account) {
        if (!this._userTrackersMaping.has(account))
            return;

        this._userTrackersMaping.delete(account);
    },

    getUserTrackerForAccount: function(account) {
        if (this._userTrackersMaping.has(account))
            return this._userTrackersMaping.get(account);
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
            flags: GObject.SignalFlags.DETAILED
        }
    },

    _init: function(account) {
        this.parent();
        this._referenceRoomSignals = [
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

        this._account = account;

        this._globalContactMapping = new Map();
        this._roomMapping = new Map();
        this._handlerCounter = 0;
        this._app = Gio.Application.get_default();

        this._userStatusMonitor = getUserStatusMonitor();

        this._watchlist = [];

        this._chatroomManager = ChatroomManager.getDefault();
        this._chatroomManager.connect('room-added', Lang.bind(this, this._onRoomAdded));
        this._chatroomManager.connect('room-removed', Lang.bind(this, this._onRoomRemoved));
    },

    _onRoomAdded: function(roomManager, room) {
        if (room.account == this._account)
            this._connectRoomSignalsForRoom(room);
    },

    _onRoomRemoved: function(roomManager, room) {
        if (room.account == this._account)
            this._disconnectRoomSignalsForRoom(room);

        this._clearUsersFromRoom(room);
    },

    _connectRoomSignalsForRoom: function(room) {
        this._ensureRoomMappingForRoom(room);

        let roomData = this._roomMapping.get(room);

        roomData._roomSignals = [];
        this._referenceRoomSignals.forEach(Lang.bind(this, function(signal) {
            roomData._roomSignals.push(room.connect(signal.name, signal.handler));
        }));
    },

    _disconnectRoomSignalsForRoom: function(room) {
        let roomData = this._roomMapping.get(room);

        for (let i = 0; i < roomData._roomSignals.length; i++) {
            room.disconnect(roomData._roomSignals[i]);
        }
        roomData._roomSignals = [];
    },

    _onChannelChanged: function(emittingRoom) {
        if (emittingRoom.channel) {
            let members;
            if (emittingRoom.type == Tp.HandleType.ROOM)
                members = emittingRoom.channel.group_dup_members_contacts();
            else
                members = [emittingRoom.channel.connection.self_contact, emittingRoom.channel.target_contact];

            /*TODO: is this needed here?*/
            this._ensureRoomMappingForRoom(emittingRoom);

            /*if there is no map keeping track of the users in the emittingRoom
            create it*/
            this._ensureContactMappingForRoom(emittingRoom);

            /*if there is no map keeping track of the local status change handlers*/
            this._ensureHandlerMappingForRoom(emittingRoom);

            /*keep track of initial members in the emittingRoom, both locally and
            globally*/
            members.forEach(m => { this._trackMember(m, emittingRoom); });
        } else {
            this._clearUsersFromRoom(emittingRoom);

            /*since we have no channel, all users must be locally marked offline. so call the callbacks*/
            for ([handlerID, handlerInfo] of this._roomMapping.get(emittingRoom)._handlerMapping) {
                if (handlerInfo.nickName)
                    handlerInfo.handler(handlerInfo.nickName, Tp.ConnectionPresenceType.OFFLINE);
            }
        }
    },

    _clearUsersFromRoom: function(room) {
        let map = this._roomMapping.get(room)._contactMapping;
        for ([baseNick, contacts] of map)
            contacts.forEach((m) => { this._untrackMember(m, room); });
        this._roomMapping.delete(room);
    },

    _ensureRoomMappingForRoom: function(room) {
        if (!this._roomMapping.has(room))
            this._roomMapping.set(room, {});
    },

    _ensureContactMappingForRoom: function(room) {
        if (!this._roomMapping.get(room)._contactMapping)
            this._roomMapping.get(room)._contactMapping = new Map();
    },

    _ensureHandlerMappingForRoom: function(room) {
        /*if there is no map keeping track of the local status change handlers*/
        if (!this._roomMapping.get(room)._handlerMapping) {
            this._roomMapping.get(room)._handlerMapping = new Map();
            this._handlerCounter = 0;
        }
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
        for ([id, info] of this._roomMapping.get(room)._contactMapping)
            if (!info.nickName || info.nickName == baseNick)
                info.handler(member.alias, status);
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

        let map = this._globalContactMapping;
        if (this._pushMember(map, baseNick, member) == 1) {
            this.emit("status-changed::" + baseNick, member.alias, status);

            let notifyActionName = this.getNotifyActionName(member.alias);
            let notifyAction = this._app.lookup_action(notifyActionName);

            if (notifyAction.get_state().get_boolean()) {
                this.emitWatchedUserNotification(room, member);
                /*change state so that the button is not pressed if it reappears again*/
                notifyAction.change_state(GLib.Variant.new('b', false));
            }

            notifyAction.enabled = false;
        }

        let roomMap = this._roomMapping.get(room)._contactMapping;
        if (this._pushMember(roomMap, baseNick, member) == 1)
            this._runHandlers(room, member, status);

        this.emit("contacts-changed::" + baseNick);
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

        let map = this._globalContactMapping;
        let [found, nContacts] = this._popMember(map, baseNick, member);
        if (found) {
            if (nContacts == 0) {
                this.emit("status-changed::" + baseNick, member.alias, status);
            }
            this.emit("contacts-changed::" + baseNick);

            let notifyActionName = this.getNotifyActionName(member.alias);
            let notifyAction = this._app.lookup_action(notifyActionName);

            notifyAction.enabled = true;
        }

        let roomMap = this._roomMapping.get(room)._contactMapping;
        [found, nContacts] = this._popMember(roomMap, baseNick, member);
        if (found && nContacts == 0)
            this._runHandlers(room, member, status);
    },

    getNickStatus: function(nickName) {
        let baseNick = Polari.util_get_basenick(nickName);

        let contacts = this._globalContactMapping.get(baseNick) || [];
        return contacts.length == 0 ? Tp.ConnectionPresenceType.OFFLINE
                                    : Tp.ConnectionPresenceType.AVAILABLE;
    },

    lookupContact: function(nickName) {
        let baseNick = Polari.util_get_basenick(nickName);

        let contacts = this._globalContactMapping.get(baseNick) || [];

        if (contacts.length == 0)
            return null;

        for (let i = 0; i < contacts.length; i++)
            if (contacts[i].alias == nickName)
                return contacts[i];

        return contacts[0];
    },

    getNickRoomStatus: function(nickName, room) {
        let baseNick = Polari.util_get_basenick(nickName);

        this._ensureContactMappingForRoom(room);

        let contacts = this._roomMapping.get(room)._contactMapping.get(baseNick) || [];
        return contacts.length == 0 ? Tp.ConnectionPresenceType.OFFLINE
                                    : Tp.ConnectionPresenceType.AVAILABLE;
    },

    watchUser: function(room, nick, callback) {
        this._ensureRoomMappingForRoom(room);
        this._ensureHandlerMappingForRoom(room);

        this._roomMapping.get(room)._handlerMapping.set(this._handlerCounter, {
            nickName: Polari.util_get_basenick(nick),
            handler: callback
        });

        this._handlerCounter++;

        return this._handlerCounter - 1;
    },

    unwatchUser: function(room, handlerID) {
        /*TODO: rewrite into a single conditional?*/
        if (!this._roomMapping)
            return;

        if (!this._roomMapping.has(room))
            return;

        if (!this._roomMapping.get(room)._handlerMapping)
            return;

        this._roomMapping.get(room)._handlerMapping.delete(handlerID);
    },

    emitWatchedUserNotification: function (room, member) {
        let notification = new Gio.Notification();
        notification.set_title(_("User is online"));
        notification.set_body(_("User %s is now online.").format(member.alias));

        let param = GLib.Variant.new('(ssu)',
                                     [ this._account.get_object_path(),
                                       room.channel_name,
                                       Utils.getTpEventTime() ]);
        notification.set_default_action_and_target('app.join-room', param);

        this._app.send_notification('watched-user-notification', notification);

        let baseNick = Polari.util_get_basenick(member.alias);
    },

    getNotifyActionName: function(nickName) {
        let notifyActionName = 'notify-user-' + this._account.get_path_suffix() + '-' + Polari.util_get_basenick(nickName);

        let isUserGloballyOnline = this.getNickStatus(nickName) == Tp.ConnectionPresenceType.AVAILABLE;

        if (!this._app.lookup_action(notifyActionName)) {
            let newNotifyActionProps = {
                name: notifyActionName,
                state: GLib.Variant.new('b', false)
            };

            let newNotifyAction = new Gio.SimpleAction(newNotifyActionProps);

            this._app.add_action(newNotifyAction);
        }

        return notifyActionName;
    }
});
