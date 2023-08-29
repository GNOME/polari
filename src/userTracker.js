// SPDX-FileCopyrightText: 2016 raresv <rares.visalom@gmail.com>
// SPDX-FileCopyrightText: 2016 Florian Müllner <fmuellner@gnome.org>
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Polari from 'gi://Polari';
import Tp from 'gi://TelepathyGLib';

import AccountsMonitor from './accountsMonitor.js';
import RoomManager from './roomManager.js';

export default class UserStatusMonitor {
    static getDefault() {
        if (!this._singleton)
            this._singleton = new UserStatusMonitor();
        return this._singleton;
    }

    constructor() {
        this._userTrackers = new Map();
        this._accountsMonitor = AccountsMonitor.getDefault();

        this._app = Gio.Application.get_default();

        let action;
        action = this._app.lookup_action('mute-nick');
        action.connect('activate', (a, params) => {
            const [accountPath, nick] = params.deep_unpack();
            const account = this._accountsMonitor.lookupAccount(accountPath);
            this._userTrackers.get(account).muteNick(nick);
        });

        action = this._app.lookup_action('unmute-nick');
        action.connect('activate', (a, params) => {
            const [accountPath, nick] = params.deep_unpack();
            const account = this._accountsMonitor.lookupAccount(accountPath);
            this._userTrackers.get(account).unmuteNick(nick);
        });

        this._accountsMonitor.connect('account-added',
            this._onAccountAdded.bind(this));
        this._accountsMonitor.connect('account-removed',
            this._onAccountRemoved.bind(this));

        this._accountsMonitor.accounts.forEach(a => {
            this._onAccountAdded(this._accountsMonitor, a);
        });
    }

    _onAccountAdded(accountsMonitor, account) {
        if (this._userTrackers.has(account))
            return;

        this._userTrackers.set(account, new UserTracker(account));
    }

    _onAccountRemoved(accountsMonitor, account) {
        this._userTrackers.delete(account);
    }

    getUserTrackerForAccount(account) {
        return this._userTrackers.get(account);
    }
}


const UserTracker = GObject.registerClass(
class UserTracker extends GObject.Object {
    static [GObject.signals] = {
        'status-changed': {
            flags: GObject.SignalFlags.DETAILED,
            param_types: [GObject.TYPE_STRING, GObject.TYPE_INT],
        },
        'muted-changed': {
            flags: GObject.SignalFlags.DETAILED,
            param_types: [GObject.TYPE_STRING, GObject.TYPE_BOOLEAN],
        },
        'contacts-changed': {
            flags: GObject.SignalFlags.DETAILED,
            param_types: [GObject.TYPE_STRING],
        },
    };

    constructor(account) {
        super();

        this._account = account;

        this._baseNickContacts = new Map();
        this._roomData = new Map();
        this._handlerCounter = 0;
        this._app = Gio.Application.get_default();

        const {settings} = account;
        this._mutedUsers = settings.get_strv('muted-usernames');
        settings.connect('changed::muted-usernames', () => {
            const muted = settings.get_strv('muted-usernames');
            const newlyMuted = muted.filter(s => !this._mutedUsers.includes(s));
            const newlyUnmuted = this._mutedUsers.filter(s => !muted.includes(s));

            this._mutedUsers = muted;

            newlyMuted.forEach(s => this.emit(`muted-changed::${s}`, s, true));
            newlyUnmuted.forEach(s => this.emit(`muted-changed::${s}`, s, false));
        });

        this._app.connect('prepare-shutdown', this._onShutdown.bind(this));

        this._roomManager = RoomManager.getDefault();
        this._roomManager.connect('room-added', this._onRoomAdded.bind(this));
        this._roomManager.connect('room-removed', this._onRoomRemoved.bind(this));
    }

    _onShutdown() {
        for (let room of this._roomData.keys())
            this._onRoomRemoved(this._roomManager, room);
    }

    _getRoomContacts(room) {
        return this._roomData.get(room).contactMapping;
    }

    _getRoomHandlers(room) {
        return this._roomData.get(room).handlerMapping;
    }

    _getRoomSignals(room) {
        return this._roomData.get(room).roomSignals;
    }

    _onRoomAdded(roomManager, room) {
        if (room.account !== this._account)
            return;

        this._ensureRoomMappingForRoom(room);

        let roomSignals = [{
            name: 'notify::channel',
            handler: this._onChannelChanged.bind(this),
        }, {
            name: 'member-renamed',
            handler: this._onMemberRenamed.bind(this),
        }, {
            name: 'member-disconnected',
            handler: this._onMemberLeft.bind(this),
        }, {
            name: 'member-kicked',
            handler: this._onMemberLeft.bind(this),
        }, {
            name: 'member-banned',
            handler: this._onMemberLeft.bind(this),
        }, {
            name: 'member-joined',
            handler: this._onMemberJoined.bind(this),
        }, {
            name: 'member-left',
            handler: this._onMemberLeft.bind(this),
        }];

        let signalIds = this._getRoomSignals(room);
        roomSignals.forEach(signal => {
            signalIds.push(room.connect(signal.name, signal.handler));
        });
    }

    _onRoomRemoved(roomManager, room) {
        if (!this._roomData.has(room))
            return;

        this._getRoomSignals(room).forEach(id => room.disconnect(id));
        this._clearUsersFromRoom(room);
        this._roomData.delete(room);
    }

    _onChannelChanged(room) {
        if (!room.channel) {
            this._clearUsersFromRoom(room);
            return;
        }

        let members;
        if (room.type === Tp.HandleType.ROOM)
            members = room.channel.group_dup_members_contacts();
        else
            members = [room.channel.connection.self_contact, room.channel.target_contact];

        /* keep track of initial members in the room, both locally and
        globally*/
        members.forEach(m => this._trackMember(m, room));
    }

    _clearUsersFromRoom(room) {
        let map = this._getRoomContacts(room);
        for (let [, contacts] of map)
            contacts.slice().forEach(m => this._untrackMember(m, room));
    }

    _ensureRoomMappingForRoom(room) {
        if (this._roomData.has(room))
            return;
        this._roomData.set(room, {
            contactMapping: new Map(),
            handlerMapping: new Map(),
            roomSignals: [],
        });
    }

    _onMemberRenamed(room, oldMember, newMember) {
        this._untrackMember(oldMember, room);
        this._trackMember(newMember, room);
    }

    _onMemberJoined(room, member) {
        this._trackMember(member, room);
    }

    _onMemberLeft(room, member) {
        this._untrackMember(member, room);
    }

    _runHandlers(room, member, status) {
        let baseNick = Polari.util_get_basenick(member.alias);
        let roomHandlers = this._getRoomHandlers(room);
        for (let [, info] of roomHandlers) {
            if (!info.nickName || info.nickName === baseNick)
                info.handler(baseNick, status);
        }
    }

    _pushMember(map, baseNick, member) {
        if (!map.has(baseNick))
            map.set(baseNick, []);
        let contacts = map.get(baseNick);
        return contacts.push(member);
    }

    _trackMember(member, room) {
        let baseNick = Polari.util_get_basenick(member.alias);
        let status = Tp.ConnectionPresenceType.AVAILABLE;

        let roomMap = this._getRoomContacts(room);
        if (this._pushMember(roomMap, baseNick, member) === 1)
            this._runHandlers(room, member, status);

        // HACK: Telepathy doesn't notify on member changes for private chats,
        //       so approximate the online status in this case by not adding
        //       the contact to the global map, and removing it from the room
        //       map when the global count drops to 0 (see _untrackMember)
        if (room.type === Tp.HandleType.ROOM) {
            let map = this._baseNickContacts;
            if (this._pushMember(map, baseNick, member) === 1) {
                this.emit(`status-changed::${baseNick}`, baseNick, status);

                if (this._shouldNotifyNick(member.alias))
                    this._notifyNickAvailable(member, room);

                this._setNotifyActionEnabled(member.alias, false);
            }
        }

        this.emit(`contacts-changed::${baseNick}`, member.alias);
    }

    _popMember(map, baseNick, member) {
        let contacts = map.get(baseNick) || [];
        let index = contacts.map(c => c.alias).indexOf(member.alias);
        if (index < 0)
            return [false, contacts.length];
        contacts.splice(index, 1);
        return [true, contacts.length];
    }

    _untrackMember(member, room) {
        let baseNick = Polari.util_get_basenick(member.alias);
        let status = Tp.ConnectionPresenceType.OFFLINE;

        let roomMap = this._getRoomContacts(room);
        let [found, nContacts] = this._popMember(roomMap, baseNick, member);
        if (found && nContacts === 0)
            this._runHandlers(room, member, status);

        let map = this._baseNickContacts;
        [found, nContacts] = this._popMember(map, baseNick, member);
        if (found) {
            if (nContacts === 0) {
                this.emit(`status-changed::${baseNick}`, member.alias, status);
                this._setNotifyActionEnabled(member.alias, true);

                this._app.withdraw_notification(this._getNotifyActionNameInternal(member.alias));

                // HACK: The member is no longer joined any public rooms, so
                //       assume they disconnected and remove them from all
                //       private chats as well
                for (let r of this._roomData.keys())
                    this._untrackMember(member, r);
            }
            this.emit(`contacts-changed::${baseNick}`, member.alias);
        }
    }

    getNickStatus(nickName) {
        let baseNick = Polari.util_get_basenick(nickName);

        let contacts = this._baseNickContacts.get(baseNick) || [];
        return contacts.length === 0
            ? Tp.ConnectionPresenceType.OFFLINE
            : Tp.ConnectionPresenceType.AVAILABLE;
    }

    getNickRoomStatus(nickName, room) {
        let baseNick = Polari.util_get_basenick(nickName);

        this._ensureRoomMappingForRoom(room);

        let contacts = this._getRoomContacts(room).get(baseNick) || [];
        return contacts.length === 0
            ? Tp.ConnectionPresenceType.OFFLINE
            : Tp.ConnectionPresenceType.AVAILABLE;
    }

    isMuted(nickName) {
        return this._mutedUsers.includes(nickName.toLowerCase());
    }

    muteNick(nickName) {
        if (this.isMuted(nickName))
            return;

        let settings = this._account.settings;
        settings.set_strv('muted-usernames',
            [...this._mutedUsers, nickName.toLowerCase()]);
    }

    unmuteNick(nickName) {
        if (!this.isMuted(nickName))
            return;

        let nick = nickName.toLowerCase();
        let settings = this._account.settings;
        settings.set_strv('muted-usernames',
            this._mutedUsers.filter(s => s !== nick));
    }

    lookupContact(nickName) {
        let baseNick = Polari.util_get_basenick(nickName);

        let contacts = this._baseNickContacts.get(baseNick) || [];
        if (!contacts.length)
            return null;

        return contacts.find(c => c.alias === nickName) || contacts[0];
    }

    watchRoomStatus(room, baseNick, callback) {
        this._ensureRoomMappingForRoom(room);

        this._getRoomHandlers(room).set(++this._handlerCounter, {
            nickName: baseNick,
            handler: callback,
        });

        return this._handlerCounter;
    }

    unwatchRoomStatus(room, handlerID) {
        if (!this._roomData.has(room))
            return;
        this._getRoomHandlers(room).delete(handlerID);
    }

    _notifyNickAvailable(member, room) {
        let notification = new Gio.Notification();
        notification.set_title(_('User is online'));
        notification.set_body(vprintf(_('User %s is now online.'), member.alias));

        let param = GLib.Variant.new('(ssb)', [
            this._account.get_object_path(),
            room.channel_name,
            true,
        ]);
        notification.set_default_action_and_target('app.join-room', param);

        this._app.send_notification(this._getNotifyActionNameInternal(member.alias), notification);
    }

    _shouldNotifyNick(nickName) {
        let actionName = this._getNotifyActionNameInternal(nickName);
        let state = this._app.get_action_state(actionName);
        return state ? state.get_boolean() : false;
    }

    _setNotifyActionEnabled(nickName, enabled) {
        let name = this._getNotifyActionNameInternal(nickName);
        let action = this._app.lookup_action(name);
        if (action)
            action.enabled = enabled;
    }

    _getNotifyActionNameInternal(nickName) {
        let pathSuffix = this._account.get_path_suffix();
        let baseNick = Polari.util_get_basenick(nickName);
        return `notify-user-${pathSuffix}-${baseNick}`;
    }

    getNotifyActionName(nickName) {
        let name = this._getNotifyActionNameInternal(nickName);

        if (!this._app.lookup_action(name)) {
            let status = this.getNickStatus(nickName);
            let enabled = status === Tp.ConnectionPresenceType.OFFLINE;

            let state = new GLib.Variant('b', false);
            let action = new Gio.SimpleAction({
                name,
                enabled,
                state,
            });

            action.connect('notify::enabled', () => {
                if (!action.enabled)
                    action.change_state(GLib.Variant.new('b', false));
            });

            this._app.add_action(action);
        }

        return `app.${name}`;
    }
});
