// SPDX-FileCopyrightText: 2016 Florian Müllner <fmuellner@gnome.org>
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Polari from 'gi://Polari';
import Tp from 'gi://TelepathyGLib';

const Signals = imports.signals;

import AccountsMonitor from './accountsMonitor.js';

export default class RoomManager {
    static getDefault() {
        if (!this._singleton)
            this._singleton = new RoomManager();
        return this._singleton;
    }

    constructor() {
        this._rooms = new Map();
        this._settings = new Gio.Settings({schema_id: 'org.gnome.Polari'});

        this._accountsMonitor = AccountsMonitor.getDefault();

        this._app = Gio.Application.get_default();
        const actions = [{
            name: 'join-room',
            handler: this._onJoinActivated.bind(this),
        }, {
            name: 'message-user',
            handler: this._onQueryActivated.bind(this),
        }, {
            name: 'leave-room',
            after: true,
            handler: this._onLeaveActivated.bind(this),
        }];
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
        this._accountsMonitor.prepare(() => this._restoreRooms());
    }

    lookupRoom(id) {
        return this._rooms.get(id);
    }

    lookupRoomByName(name, account) {
        return [...this._rooms.values()].find(room => {
            return room.channel_name === name && room.account === account;
        });
    }

    lookupRoomByChannel(channel) {
        const account = channel.connection.get_account();
        const channelName = channel.identifier;
        const [, handleType] = channel.get_handle();
        const id = Polari.create_room_id(account, channelName, handleType);
        return this._rooms.get(id);
    }

    get roomCount() {
        return this._rooms.size;
    }

    get rooms() {
        return [...this._rooms.values()];
    }

    _onJoinActivated(action, parameter) {
        const [accountPath, channelName, present] = parameter.deep_unpack();
        this._addSavedChannel(accountPath, channelName);

        this._accountsMonitor.prepare(() => {
            this._ensureRoom(accountPath, channelName, Tp.HandleType.ROOM, present);
        });
    }

    _onQueryActivated(action, parameter) {
        const [accountPath, channelName, , present] = parameter.deep_unpack();

        this._accountsMonitor.prepare(() => {
            this._ensureRoom(accountPath, channelName, Tp.HandleType.CONTACT, present);
        });
    }

    _onLeaveActivated(action, parameter) {
        const [id] = parameter.deep_unpack();
        const room = this._rooms.get(id);

        this._removeSavedChannel(room.account.object_path, room.channel_name);
        this._removeRoom(room);
    }

    _restoreRooms(accountPath) {
        this._settings.get_value('saved-channel-list').deep_unpack().forEach(c => {
            for (const prop in c)
                c[prop] = c[prop].deep_unpack();
            if (!accountPath || c.account === accountPath)
                this._ensureRoom(c.account, c.channel, Tp.HandleType.ROOM, false);
        });
        this.emit('rooms-loaded');
    }

    _removeRooms(accountPath) {
        for (const room of this._rooms.values()) {
            if (!accountPath || room.account.object_path === accountPath)
                this._removeRoom(room);
        }
    }

    _findChannelIndex(channels, accountPath, channelName) {
        const matchName = channelName.toLowerCase();
        return channels.findIndex(c => {
            return c.account.deep_unpack() === accountPath &&
                   c.channel.deep_unpack().toLowerCase() === matchName;
        });
    }

    _addSavedChannel(accountPath, channelName) {
        const channels = this._settings.get_value('saved-channel-list').deep_unpack();
        if (this._findChannelIndex(channels, accountPath, channelName) !== -1)
            return;
        channels.push({
            account: new GLib.Variant('s', accountPath),
            channel: new GLib.Variant('s', channelName),
        });
        this._settings.set_value('saved-channel-list',
            new GLib.Variant('aa{sv}', channels));
    }

    _removeSavedChannel(accountPath, channelName) {
        const channels = this._settings.get_value('saved-channel-list').deep_unpack();
        const pos = this._findChannelIndex(channels, accountPath, channelName);
        if (pos < 0)
            return;
        channels.splice(pos, 1);
        this._settings.set_value('saved-channel-list',
            new GLib.Variant('aa{sv}', channels));
    }

    _removeSavedChannelsForAccount(accountPath) {
        let channels = this._settings.get_value('saved-channel-list').deep_unpack();
        const account = new GLib.Variant('s', accountPath);

        channels = channels.filter(c => !c.account.equal(account));
        this._settings.set_value('saved-channel-list',
            new GLib.Variant('aa{sv}', channels));
    }

    _ensureRoom(accountPath, channelName, type, present) {
        const account = this._accountsMonitor.lookupAccount(accountPath);

        if (!account) {
            this._removeSavedChannelsForAccount(accountPath);
            return null;
        }

        if (!account.visible)
            return null;

        const id = Polari.create_room_id(account, channelName, type);
        let room = this._rooms.get(id);
        if (!room) {
            room = new Polari.Room({
                account,
                channel_name: channelName,
                type,
            });
            this._rooms.set(room.id, room);
            this.emit('room-added', room);
        }

        if (present && this._app.active_window)
            this._app.active_window.active_room = room;

        return room;
    }

    ensureRoomForChannel(channel, present) {
        const accountPath = channel.connection.get_account().object_path;
        const targetContact = channel.target_contact;
        const channelName = targetContact
            ? targetContact.alias : channel.identifier;
        const [, handleType] = channel.get_handle();
        const room = this._ensureRoom(accountPath, channelName, handleType, present);
        room.channel = channel;
    }

    _removeRoom(room) {
        if (this._rooms.delete(room.id))
            this.emit('room-removed', room);
    }
}
Signals.addSignalMethods(RoomManager.prototype);
