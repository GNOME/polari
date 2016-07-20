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
        /* Typo: maping
         * Though I'd just call it this._userTrackers */
        this._userTrackersMaping = new Map();
        this._accountsMonitor = AccountsMonitor.getDefault();

        this._accountsMonitor.connect('account-added', Lang.bind(this, this._onAccountAdded));
        this._accountsMonitor.connect('account-removed', Lang.bind(this, this._onAccountRemoved));
    },

    _onAccountAdded: function(accountsMonitor, account) {
        if (this._userTrackersMaping.has(account))
            return;

        this._userTrackersMaping.set(account, new UserTracker(account));
    },

    _onAccountRemoved: function(accountsMonitor, account) {
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
        /* By convention, detailed signals should also pass whatever
         * its detail is in the params (we're stretching it a bit
         * by using the baseNick in details but passing the actual
         * nick) */
        'contacts-changed': {
            flags: GObject.SignalFlags.DETAILED
        }
    },

    _init: function(account) {
        this.parent();

        /* not sure what "reference" in the name refers to, but it's weird
         * to have that as a property if it's just used in one place
         * somewhere else */
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

        /* 'mapping' doesn't really add much if it's unclear what the
         * map actually is (the name is just the 'value' part of the
         * key => value nature of maps).
         * Maybe this._baseNickContacts? */
        this._globalContactMapping = new Map();
        /* This one's trickier, as the content is a bit random, and
         * _roomStuff isn't a great name :-)
         * IMHO we need to figure something out though, as the current
         * code is very hard to comprehend. Maybe the best we can do
         * is call this _roomData, then have some methods we use to
         * access the content elsewhere:

           _getRoomContacts(room) { return this._roomData.get(room).contacts; },
           _getRoomHandlers(room) { return this._roomData.get(room).handlers; },
           _getRoomSignals(room) { return this._roomData.get(room).signals; },

         */
        this._roomMapping = new Map();
        this._handlerCounter = 0;
        this._app = Gio.Application.get_default();

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

    /* personally I find over-specific variable names like "emittingRoom"
     * more distracting than helpful - "oh, it's not just called 'room',
     * what is special about it?". Calling it roomThatEmittedNotifyChannelSignal
     * would clarify that, but meh ... */
    _onChannelChanged: function(emittingRoom) {
        /* You can save one level of indentation by doing:

        if (!room.channel) {
            this._clearUsersFromRoom(room);
            return;
        }
        */

        if (emittingRoom.channel) {
            let members;
            if (emittingRoom.type == Tp.HandleType.ROOM)
                members = emittingRoom.channel.group_dup_members_contacts();
            else
                members = [emittingRoom.channel.connection.self_contact, emittingRoom.channel.target_contact];

            /*TODO: is this needed here?*/
            this._ensureRoomMappingForRoom(emittingRoom);

            /*keep track of initial members in the emittingRoom, both locally and
            globally*/
            members.forEach(m => { this._trackMember(m, emittingRoom); });
        } else {
            this._clearUsersFromRoom(emittingRoom);
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
            this._roomMapping.set(room, { _contactMapping: new Map(),
                                          _handlerMapping: new Map() });
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
        for ([id, info] of this._roomMapping.get(room)._handlerMapping)
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

    /* Nit: It would make sense to move that up right below getNickStatus() */
    getNickRoomStatus: function(nickName, room) {
        let baseNick = Polari.util_get_basenick(nickName);

        this._ensureRoomMappingForRoom(room);

        let contacts = this._roomMapping.get(room)._contactMapping.get(baseNick) || [];
        return contacts.length == 0 ? Tp.ConnectionPresenceType.OFFLINE
                                    : Tp.ConnectionPresenceType.AVAILABLE;
    },

    /* Not sure about that name, it sounds a bit googley/big brother;
     * maybe watchUserStatus()? But then, the user is optional and the
     * room is not afaics, so maybe use watchRoomStatus() instead?
     * (Side note: If a method is called watchUser(), I'd expect the
     *  user parameter to be the first one) */
    watchUser: function(room, nick, callback) {
        this._ensureRoomMappingForRoom(room);

        this._roomMapping.get(room)._handlerMapping.set(this._handlerCounter, {
            nickName: nick ? Polari.util_get_basenick(nick) : undefined,
            handler: callback
        });

        this._handlerCounter++;

        /* it would be good to follow gsignal semantics and not use 0 as
         * a valid handler ID - see the pattern of
               if (this._someSignalId > 0)
                   this._someObject.disconnect(this._someSignalId);
               this._someSignalId = 0;
         * used all over the place */
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

    /* overly long name again, should at the very least be private */
    emitWatchedUserNotification: function (room, member) {
        let notification = new Gio.Notification();
        notification.set_title(_("User is online"));
        notification.set_body(_("User %s is now online.").format(member.alias));

        let param = GLib.Variant.new('(ssu)',
                                     [ this._account.get_object_path(),
                                       room.channel_name,
                                       Utils.getTpEventTime() ]);
        notification.set_default_action_and_target('app.join-room', param);

        /* Passing an ID of null would be better than a common one:
         * If two watched users come online roughly at the same time, the
         * first notification is dismissed and replaced by the second.
         *
         * But then maybe it makes sense to withdraw a notification if a
         * watched user disconnects again? In that case, using something
         * unique similar to getNotifyActionName() should work (maybe just
         * split out a private _getNotifyActionName() that is shared between
         * the public method and the notification ID, i.e. the name part
         * only without the side-effect of creating an action */
        this._app.send_notification('watched-user-notification', notification);

        let baseNick = Polari.util_get_basenick(member.alias);
    },

    getNotifyActionName: function(nickName) {
        let name = 'notify-user-' +
                   this._account.get_path_suffix() + '-' +
                   Polari.util_get_basenick(nickName);

        if (!this._app.lookup_action(name)) {
            let state = new GLib.Variant('b', false);
            let action = new Gio.SimpleAction({ name: name, state: state });
            this._app.add_action(action);
        }

        return name;
    }
});
