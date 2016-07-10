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
    },

    _init: function(account) {
        this.parent();
        this._referenceRoomSignals = [
            { name: 'notify::channel',
              handler: Lang.bind(this, this._onChannelChanged) },
            { name: 'member-renamed',
              handler: Lang.bind(this, this._onMemberRenamed) },
            { name: 'member-disconnected',
              handler: Lang.bind(this, this._onMemberDisconnected) },
            { name: 'member-kicked',
              handler: Lang.bind(this, this._onMemberKicked) },
            { name: 'member-banned',
              handler: Lang.bind(this, this._onMemberBanned) },
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

        this._clearUsersFromRoom(this._globalContactMapping, room);
        this._clearUsersFromRoom(this._roomMapping.get(room)._contactMapping, room);
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
            if (!this._roomMapping.get(emittingRoom)._contactMapping)
                this._roomMapping.get(emittingRoom)._contactMapping = new Map();

            /*if there is no map keeping track of the local status change handlers*/
            this._ensureHandlerMappingForRoom(emittingRoom);

            /*keep track of initial members in the emittingRoom, both locally and
            globally*/
            members.forEach(m => {
                m._room = emittingRoom;
                this._trackMember(this._roomMapping.get(emittingRoom)._contactMapping, m, emittingRoom);
                this._trackMember(this._globalContactMapping, m, emittingRoom);
            });
        } else {
            /*handle the absence of a channel for the global case*/
            this._clearUsersFromRoom(this._globalContactMapping, emittingRoom);
            /*handle the absence of a channel for the local case*/
            this._clearUsersFromRoom(this._roomMapping.get(emittingRoom)._contactMapping, emittingRoom);

            /*since we have no channel, all users must be locally marked offline. so call the callbacks*/
            for ([handlerID, handlerInfo] of this._roomMapping.get(emittingRoom)._handlerMapping) {
                if (handlerInfo.nickName)
                    handlerInfo.handler(handlerInfo.nickName, Tp.ConnectionPresenceType.OFFLINE);
            }
        }
    },

    _clearUsersFromRoom: function(mapping, room) {
        for ([baseNick, basenickContacts] of mapping) {
            basenickContacts.forEach(Lang.bind(this, function(member) {
                if (member._room == room)
                    /*safe to delete while iterating?*/
                    this._untrackMember(mapping, member, room);
            }));

            mapping.delete(baseNick);
        }
    },

    _ensureRoomMappingForRoom: function(room) {
        if (!this._roomMapping.has(room))
            this._roomMapping.set(room, {});
    },

    _ensureHandlerMappingForRoom: function(room) {
        /*if there is no map keeping track of the local status change handlers*/
        if (!this._roomMapping.get(room)._handlerMapping) {
            this._roomMapping.get(room)._handlerMapping = new Map();
            this._handlerCounter = 0;
        }
    },

    _onMemberRenamed: function(room, oldMember, newMember) {
        oldMember._room = room;
        newMember._room = room;

        this._untrackMember(this._roomMapping.get(room)._contactMapping, oldMember, room);
        this._untrackMember(this._globalContactMapping, oldMember, room);
        this._trackMember(this._roomMapping.get(room)._contactMapping, newMember, room);
        this._trackMember(this._globalContactMapping, newMember, room);

        /*TODO: is this needed here?*/
        if (this.isUserWatched(newMember.alias, newMember.get_account().get_display_name()))
            this.emitWatchedUserNotification(room, newMember);
    },

    _onMemberDisconnected: function(room, member, message) {
        member._room = room;

        this._untrackMember(this._roomMapping.get(room)._contactMapping, member, room);
        this._untrackMember(this._globalContactMapping, member, room);
    },

    _onMemberKicked: function(room, member, actor) {
        member._room = room;

        this._untrackMember(this._roomMapping.get(room)._contactMapping, member, room);
        this._untrackMember(this._globalContactMapping, member, room);
    },

    _onMemberBanned: function(room, member, actor) {
        member._room = room;

        this._untrackMember(this._roomMapping.get(room)._contactMapping, member, room);
        this._untrackMember(this._globalContactMapping, member, room);
    },

    _onMemberJoined: function(room, member) {
        member._room = room;

        this._trackMember(this._roomMapping.get(room)._contactMapping, member, room);
        this._trackMember(this._globalContactMapping, member, room);

        if (this.isUserWatched(member.alias, member.get_account().get_display_name()))
            this.emitWatchedUserNotification(room, member);
    },

    _onMemberLeft: function(room, member, message) {
        member._room = room;

        this._untrackMember(this._roomMapping.get(room)._contactMapping, member, room);
        this._untrackMember(this._globalContactMapping, member, room);
    },

    _trackMember: function(map, member, room) {
        let baseNick = Polari.util_get_basenick(member.alias);

        if (map.has(baseNick))
            map.get(baseNick).push(member);
        else
            map.set(baseNick, [member]);

        if (map.get(baseNick).length == 1)
            if (map == this._globalContactMapping) {
                this.emit("status-changed::" + baseNick, member.alias, Tp.ConnectionPresenceType.AVAILABLE);
                //log("[global status] user " + member.alias + " is globally online");
            }
            else
                //log("[Local UserTracker] User " + member.alias + " is now available in room " + member._room.channelName + " on " + this._account.get_display_name());
                for ([handlerID, handlerInfo] of this._roomMapping.get(room)._handlerMapping)
                    if (handlerInfo.nickName == member.alias)
                        handlerInfo.handler(handlerInfo.nickName, Tp.ConnectionPresenceType.AVAILABLE);
                    else if (!handlerInfo.nickName)
                        handlerInfo.handler(member.alias, Tp.ConnectionPresenceType.AVAILABLE);
    },

    _untrackMember: function(map, member, room) {
        let baseNick = Polari.util_get_basenick(member.alias);

        let contacts = map.get(baseNick) || [];
        /*i really don't like this search. maybe use a for loop?*/
        let indexToDelete = contacts.map(c => c.alias + "|" + c._room.channelName).indexOf(member.alias + "|" + member._room.channelName);

        if (indexToDelete > -1) {
            let removedMember = contacts.splice(indexToDelete, 1)[0];

            if (contacts.length == 0)
                if (map == this._globalContactMapping) {
                    this.emit("status-changed::" + baseNick, member.alias, Tp.ConnectionPresenceType.OFFLINE);
                    //log("[global status] user " + member.alias + " is globally offline");
                }
                else
                    //log("[Local UserTracker] User " + member.alias + " is now offline in room " + member._room.channelName + " on " + this._account.get_display_name());
                    for ([handlerID, handlerInfo] of this._roomMapping.get(room)._handlerMapping)
                        if (handlerInfo.nickName == member.alias)
                            handlerInfo.handler(handlerInfo.nickName, Tp.ConnectionPresenceType.OFFLINE);
                        else if (!handlerInfo.nickName)
                            handlerInfo.handler(member.alias, Tp.ConnectionPresenceType.OFFLINE);
        }
    },

    getNickStatus: function(nickName) {
        let baseNick = Polari.util_get_basenick(nickName);

        let contacts = this._globalContactMapping.get(baseNick) || [];
        return contacts.length == 0 ? Tp.ConnectionPresenceType.OFFLINE
                                    : Tp.ConnectionPresenceType.AVAILABLE;
    },

    getBestMatchingContactInRoom: function(room, nickName) {
        let baseNick = Polari.util_get_basenick(nickName);
        let contacts = this._roomMapping.get(room)._contactMapping.get(baseNick) || [];

        /*TODO: even possible?*/
        if (contacts.length == 0)
            return null;

        for (let i = 0; i < contacts.length; i++)
            if (contacts[i].alias == nickName)
                return contacts[i];

        return contacts[0];
    },

    getNickRoomStatus: function(nickName, room) {
        let baseNick = Polari.util_get_basenick(nickName);

        let contacts = this._roomMapping.get(room)._contactMapping.get(baseNick) || [];
        return contacts.length == 0 ? Tp.ConnectionPresenceType.OFFLINE
                                    : Tp.ConnectionPresenceType.AVAILABLE;
    },

    watchUser: function(room, nick, callback) {
        this._ensureRoomMappingForRoom(room);
        this._ensureHandlerMappingForRoom(room);

        this._roomMapping.get(room)._handlerMapping.set(this._handlerCounter, {
            nickName: nick,
            handler: callback
        });

        this._handlerCounter++;

        return this._handlerCounter - 1;
    },

    unwatchUser: function(room, nick, handlerID) {
        /*TODO: it wouldn't make sense to call _ensure() here, right?*/

        /*TODO: rewrite into a single conditional?*/
        if (!this._roomMapping)
            return;

        if (!this._roomMapping.has(room))
            return;

        if (!this._roomMapping.get(room)._handlerMapping)
            return;

        this._roomMapping.get(room)._handlerMapping.delete(handlerID);
    },

    addToWatchlist: function(user, network) {
        this._watchlist.push([user, network]);
    },

    isUserWatched: function (user, network) {
        for (var i = 0; i < this._watchlist.length; i++) {
            if (this._watchlist[i][0] == user && this._watchlist[i][1] == network) {
                return true;
            }
        }

        return false;
    },

    popUserFromWatchlist: function (user, network) {
        let indexToDelete = -1;
        for (var i = 0; i < this._watchlist.length; i++) {
            if (this._watchlist[i][0] == user && this._watchlist[i][1] == network) {
                indexToDelete = i;
            }
        }

        if (indexToDelete != -1)
            this._watchlist.splice(indexToDelete, 1);
    },

    emitWatchedUserNotification: function (room, member) {
        let notification = new Gio.Notification();
        notification.set_title("User is online");
        notification.set_body("User " + member.alias + " is online.");

        let param = GLib.Variant.new('(ssu)',
                                     [ this._account.get_object_path(),
                                       room.channel_name,
                                       Utils.getTpEventTime() ]);
        notification.set_default_action_and_target('app.join-room', param);

        this._app.send_notification('watched-user-notification', notification);

        this.popUserFromWatchlist(member.alias, member.get_account().get_display_name());
    }
});
