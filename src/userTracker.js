const Polari = imports.gi.Polari;
const Lang = imports.lang;
const Tp = imports.gi.TelepathyGLib;
const Signals = imports.signals;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;


const UserTracker = new Lang.Class({
    Name: 'UserTracker',

    _init: function(params) {
        this._contactMapping = new Map();
        if (params.room) {
            this._room = params.room;
            this._room.connect('notify::channel', Lang.bind(this, this._onChannelChanged));

            this._onChannelChanged();
        }
        else {
            //TODO: global user tracker
        }
    },

    _onChannelChanged: function() {
        if (this._room.channel) {
            if (this._room.type == Tp.HandleType.ROOM) {
                let members = this._room.channel.group_dup_members_contacts();

                //this._contactMapping = this._buildMapping(members);

                for (var i = 0; i < members.length; i++)
                    this._trackMember(members[i]);

                this._room.connect('member-renamed', Lang.bind(this, this._onMemberRenamed));
                this._room.connect('member-disconnected', Lang.bind(this, this._onMemberDisconnected));
                this._room.connect('member-kicked', Lang.bind(this, this._onMemberKicked));
                this._room.connect('member-banned', Lang.bind(this, this._onMemberBanned));
                this._room.connect('member-joined', Lang.bind(this, this._onMemberJoined));
                this._room.connect('member-left', Lang.bind(this, this._onMemberLeft));
            } else {
                let members = [this._room.channel.connection.self_contact, this._room.channel.target_contact];
                this._buildMapping(members);
            }
        } else {
            if(this._contactMapping) {
                this._contactMapping.clear();

                //this._room.disconnect('member-joined');
            }
        }
    },

    _buildMapping: function(members) {
        let map = new Map();

        for (var i = 0; i < members.length; i++) {
            let currentBasenick = Polari.util_get_basenick(members[i].alias);
            if (map.has(currentBasenick))
                map.get(currentBasenick).push(members[i]);
            else
                map.set(currentBasenick, [members[i]]);
        }

        //log(map.get("raresv").length);

        return map;
    },

    _onMemberRenamed: function(room, oldMember, newMember) {
        log("rename " + oldMember.alias + " to " + newMember.alias);
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

        if (this._contactMapping.has(baseNick)) {
            this._contactMapping.get(baseNick).push(member);
        } else {
            this._contactMapping.set(baseNick, [member]);
        }

        this._updateStatus(member);
    },

    _untrackMember: function(member) {
        let baseNick = Polari.util_get_basenick(member.alias);

        if (this._contactMapping.has(baseNick)) {
            let indexToDelete = this._contactMapping.get(baseNick).map(c => c.alias).indexOf(member.alias);

            if (indexToDelete > -1) {
                this._contactMapping.get(baseNick).splice(indexToDelete, 1);

                this._updateStatus(member);
            }
        }
    },

    _updateStatus: function(member) {
        let baseNick = Polari.util_get_basenick(member.alias);

        if (this._contactMapping.has(baseNick)) {
            if (this._contactMapping.get(baseNick).length == 0) {
                this.emit('status-changed', member.alias, this._room, Tp.ConnectionPresenceType.OFFLINE);
            } else {
                this.emit('status-changed', member.alias, this._room, Tp.ConnectionPresenceType.AVAILABLE);
            }
        }
    },

    getNickStatus: function(nickName) {
        let baseNick = Polari.util_get_basenick(nickName);

        if (this._contactMapping.has(baseNick)) {
            if (this._contactMapping.get(baseNick).length == 0) {
                return Tp.ConnectionPresenceType.OFFLINE;
            } else {
                return Tp.ConnectionPresenceType.AVAILABLE;
            }
        } else {
            return Tp.ConnectionPresenceType.OFFLINE;
        }
    },

    resetTracker: function() {
        if (this._contactMapping) {
            this._contactMapping.forEach(function(value, key, map){
                let basenickContacts = value;

                basenickContacts.forEach(function(member){
                    this._untrackMember(member);
                });
            });

            this._contactMapping.clear();

        }
    },

    resetBasenickMembers: function(basenick) {
        if (this._contactMapping.has(basenick)) {
            let basenickContacts = this._contactMapping.get(basenick);

            basenickContacts.forEach(function(member){
                    this._untrackMember(member);
            });
        }
    }
});
Signals.addSignalMethods(UserTracker.prototype);
