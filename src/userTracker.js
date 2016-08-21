const Polari = imports.gi.Polari;
const Lang = imports.lang;
const Tp = imports.gi.TelepathyGLib;
const Signals = imports.signals;
const GObject = imports.gi.GObject;
const Utils = imports.utils;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;

const UserTracker = new Lang.Class({
    Name: 'UserTracker',
    Extends: GObject.Object,

    Signals: {
        'status-changed': {
            flags: GObject.SignalFlags.DETAILED,
            param_types: [GObject.TYPE_STRING, GObject.TYPE_INT]
        }
    },

    _init: function(room) {
        this.parent();

        this._baseNickContacts = new Map();

        this._room = room;

        this._onRoomAdded(this._room);
        this._onChannelChanged(this._room);
    },

    _onRoomAdded: function(room) {
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
            room.connect(signal.name, signal.handler);
        }));
    }

    _onChannelChanged: function(room) {
        if (!room.channel) {
            this._clearUsers();
            return;
        }

        let members;
        if (room.type == Tp.HandleType.ROOM)
            members = room.channel.group_dup_members_contacts();
        else
            members = [room.channel.connection.self_contact, room.channel.target_contact];

        members.forEach(m => { this._trackMember(m); });
    },

    _clearUsers: function() {
        for (let [baseNick, contacts] of this._baseNickContacts)
            contacts.slice().forEach((m) => { this._untrackMember(m); });
    },

    _onMemberRenamed: function(room, oldMember, newMember) {
        this._untrackMember(oldMember);
        this._trackMember(newMember);
    },

    _onMemberJoined: function(room, member) {
        this._trackMember(member);
    },

    _onMemberLeft: function(room, member) {
        this._untrackMember(member);
    },

    _pushMember: function(baseNick, member) {
        if (!this._baseNickContacts.has(baseNick))
            this._baseNickContacts.set(baseNick, []);
        let contacts = this._baseNickContacts.get(baseNick);
        return contacts.push(member);
    },

    _trackMember: function(member) {
        let baseNick = Polari.util_get_basenick(member.alias);
        let status = Tp.ConnectionPresenceType.AVAILABLE;

        if (this._pushMember(baseNick, member) == 1)
            this.emit("status-changed::" + baseNick, baseNick, status);
    },

    _popMember: function(baseNick, member) {
        let contacts = this._baseNickContacts.get(baseNick) || [];
        let index = contacts.map(c => c.alias).indexOf(member.alias);
        if (index < 0)
            return [false, contacts.length];
        contacts.splice(index, 1);
        return [true, contacts.length];
    },

    _untrackMember: function(member) {
        let baseNick = Polari.util_get_basenick(member.alias);
        let status = Tp.ConnectionPresenceType.OFFLINE;

        let [found, nContacts] = this._popMember(baseNick, member);
        if (found)
            if (nContacts == 0)
                this.emit("status-changed::" + baseNick, member.alias, status);
    },

    getNickStatus: function(nickName) {
        let baseNick = Polari.util_get_basenick(nickName);

        let contacts = this._baseNickContacts.get(baseNick) || [];
        return contacts.length == 0 ? Tp.ConnectionPresenceType.OFFLINE
                                    : Tp.ConnectionPresenceType.AVAILABLE;
    }
});
