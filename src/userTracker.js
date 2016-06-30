const Polari = imports.gi.Polari;
const Lang = imports.lang;
const Tp = imports.gi.TelepathyGLib;
const Signals = imports.signals;
const ChatroomManager = imports.chatroomManager;


const UserTracker = new Lang.Class({
    Name: 'UserTracker',

    _init: function(room) {
        /*is this 'split' ok?*/
        if (room == null) {
            //throw new Error('UserTracker instance has no specified room!');
            //global case
            log("global user tracker created");
            this._contactMapping = new Map();
            this._chatroomManager = ChatroomManager.getDefault();

            /*room-removed was not yet implemented*/
            this._chatroomManager.connect('room-added', Lang.bind(this, this._onRoomAdded));
        } else {
            this._contactMapping = new Map();
            this._room = room;

            this._room.connect('notify::channel', Lang.bind(this, this._onChannelChanged));
            this._room.connect('member-renamed', Lang.bind(this, this._onMemberRenamed));
            this._room.connect('member-disconnected', Lang.bind(this, this._onMemberDisconnected));
            this._room.connect('member-kicked', Lang.bind(this, this._onMemberKicked));
            this._room.connect('member-banned', Lang.bind(this, this._onMemberBanned));
            this._room.connect('member-joined', Lang.bind(this, this._onMemberJoined));
            this._room.connect('member-left', Lang.bind(this, this._onMemberLeft));

            this._onChannelChanged();
        }
    },

    _onRoomAdded: function(roomManager , room) {
        log("[UserTracker] global room added signal handled for room " + room.channelName);

        room.connect('notify::channel', Lang.bind(this, function(){
            log("[UserTracker] globally tracked room channel changed for room " + room.channelName);

            /*different handler for the notify::channel signal*/
            room.connect('notify::channel', Lang.bind(this, function(){
                log("[UserTracker] channel changed for globally tracker room " + room.channelName);
            }));

            /*here we use the same handlers for both local and global UserTracker
            is it safe?*/
            room.connect('member-renamed', Lang.bind(this, this._onMemberRenamed));
            room.connect('member-disconnected', Lang.bind(this, this._onMemberDisconnected));
            room.connect('member-kicked', Lang.bind(this, this._onMemberKicked));
            room.connect('member-banned', Lang.bind(this, this._onMemberBanned));
            room.connect('member-joined', Lang.bind(this, this._onMemberJoined));
            room.connect('member-left', Lang.bind(this, this._onMemberLeft));
        }));
    },

    _onChannelChanged: function() {
        if (this._room.channel) {
            let members;
            if (this._room.type == Tp.HandleType.ROOM)
                members = this._room.channel.group_dup_members_contacts();
            else
                members = [this._room.channel.connection.self_contact, this._room.channel.target_contact];

            members.forEach(m => { this._trackMember(m); });
        } else {
            for ([, basenickContacts] of this._contactMapping) {
                basenickContacts.forEach(Lang.bind(this, function(member) {
                    this._untrackMember(member);
                }));
            }

            this._contactMapping.clear();
        }
    },

    _onMemberRenamed: function(room, oldMember, newMember) {
        this._untrackMember(oldMember);
        this._trackMember(newMember);
    },

    _onMemberDisconnected: function(room, member, message) {
        this._untrackMember(member);
    },

    _onMemberKicked: function(room, member, actor) {
        this._untrackMember(member);
    },

    _onMemberBanned: function(room, member, actor) {
        this._untrackMember(member);
    },

    _onMemberJoined: function(room, member) {
        this._trackMember(member);
    },

    _onMemberLeft: function(room, member, message) {
        this._untrackMember(member);
    },

    _trackMember: function(member) {
        let baseNick = Polari.util_get_basenick(member.alias);

        if (this._contactMapping.has(baseNick))
            this._contactMapping.get(baseNick).push(member);
        else
            this._contactMapping.set(baseNick, [member]);

        if (this._contactMapping.get(baseNick).length == 1)
            this.emit('status-changed', member.alias, Tp.ConnectionPresenceType.AVAILABLE);
    },

    _untrackMember: function(member) {
        let baseNick = Polari.util_get_basenick(member.alias);

        let contacts = this._contactMapping.get(baseNick) || [];
        let indexToDelete = contacts.map(c => c.alias).indexOf(member.alias);

        if (indexToDelete > -1) {
            contacts.splice(indexToDelete, 1);

            if (contacts.length == 0)
                this.emit('status-changed', member.alias, Tp.ConnectionPresenceType.OFFLINE);
        }
    },

    getNickStatus: function(nickName) {
        let baseNick = Polari.util_get_basenick(nickName);

        let contacts = this._contactMapping.get(baseNick) || [];
        return contacts.length == 0 ? Tp.ConnectionPresenceType.OFFLINE
                                    : Tp.ConnectionPresenceType.AVAILABLE;
    },
});
Signals.addSignalMethods(UserTracker.prototype);
