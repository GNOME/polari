// SPDX-FileCopyrightText: 2016 Florian Müllner <fmuellner@gnome.org>
// SPDX-FileCopyrightText: 2016 Isabella Ribeiro <belinhacbr@gmail.com>
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';
import Tp from 'gi://TelepathyGLib';

const Signals = imports.signals;

import AccountsMonitor from './accountsMonitor.js';
import RoomManager from './roomManager.js';
import * as Utils from './utils.js';

Gio._promisify(Tp.RoomList.prototype, 'init_async', 'init_finish');

const MS_PER_IDLE = 10; // max time spend in idle
const MS_PER_FILTER_IDLE = 5; // max time spend in idle while filtering

export default class ServerRoomManager {
    static getDefault() {
        if (!this._singleton)
            this._singleton = new ServerRoomManager();
        return this._singleton;
    }

    constructor() {
        this._roomLists = new Map();

        this._accountsMonitor = AccountsMonitor.getDefault();
        this._accountsMonitor.connect('account-status-changed',
            this._onAccountStatusChanged.bind(this));
        this._accountsMonitor.connect('account-removed',
            this._onAccountRemoved.bind(this));
        this._accountsMonitor.prepare(() => {
            this._accountsMonitor.visibleAccounts.forEach(a => {
                this._onAccountStatusChanged(this._accountsMonitor, a);
            });
        });
    }

    getRoomInfos(account) {
        let roomList = this._roomLists.get(account);
        if (!roomList || roomList.list.listing)
            return [];
        return roomList.rooms.slice();
    }

    isLoading(account) {
        let roomList = this._roomLists.get(account);
        if (!roomList)
            return account.connection_status === Tp.ConnectionStatus.CONNECTING;
        return roomList.list.listing;
    }

    async _onAccountStatusChanged(mon, account) {
        if (account.connection_status === Tp.ConnectionStatus.CONNECTING)
            this.emit('loading-changed', account);

        if (account.connection_status !== Tp.ConnectionStatus.CONNECTED)
            return;

        if (this._roomLists.has(account))
            return;

        let roomList = new Tp.RoomList({account});
        roomList.connect('got-room', this._onGotRoom.bind(this));
        roomList.connect('notify::listing', this._onListingChanged.bind(this));
        this._roomLists.set(account, {list: roomList, rooms: []});

        try {
            await roomList.init_async(GLib.PRIORITY_DEFAULT, null);
            roomList.start();
        } catch {
            this._roomLists.delete(account);
        }
    }

    _onAccountRemoved(mon, account) {
        let roomList = this._roomLists.get(account);
        if (!roomList)
            return;

        roomList.list.run_dispose();
        this._roomLists.delete(account);
    }

    _onGotRoom(list, roomInfo) {
        let roomList = this._roomLists.get(list.account);
        if (!roomList)
            return;
        roomList.rooms.push(roomInfo);
    }

    _onListingChanged(list) {
        this.emit('loading-changed', list.account);
    }
}
Signals.addSignalMethods(ServerRoomManager.prototype);


const RoomListColumn = {
    CHECKED: 0,
    NAME: 1,
    COUNT: 2,
    SENSITIVE: 3,
};

function _strBaseEqual(str1, str2) {
    return str1.localeCompare(str2, {}, {sensitivity: 'base'}) === 0;
}

export const ServerRoomList = GObject.registerClass(
class ServerRoomList extends Gtk.Box {
    static [Gtk.template] = 'resource:///org/gnome/Polari/ui/server-room-list.ui';
    static [Gtk.internalChildren] = [
        'filterEntry',
        'list',
        'spinner',
        'store',
        'toggleRenderer',
    ];

    static [GObject.properties] = {
        'can-join': GObject.ParamSpec.boolean(
            'can-join', null, null,
            GObject.ParamFlags.READABLE,
            false),
    };

    _account = null;
    _pendingInfos = [];
    _filterTerms = [];

    constructor(params) {
        super(params);

        this._list.model.set_visible_func((model, iter) => {
            let name = model.get_value(iter, RoomListColumn.NAME);
            if (!name)
                return false;

            if (this._isCustomRoomItem(iter))
                return true;

            return this._filterTerms.every(term => name.includes(term));
        });

        [, this._customRoomItem] = this._store.get_iter_first();
        this._list.model.refilter();

        this._filterEntry.connect('changed', () => {
            this._updateCustomRoomName();
            this._updateSelection();
        });
        this._filterEntry.connect('search-changed', () => {
            if (!Utils.updateTerms(this._filterTerms, this._filterEntry.text))
                return;

            this._list.model.refilter();
            this._updateSelection();
        });
        this._filterEntry.connect('stop-search', () => {
            if (this._filterEntry.get_text().length > 0)
                this._filterEntry.set_text('');
            else
                this.get_root().closeJoinDialog();
        });
        this._filterEntry.connect('activate', () => {
            if (this._filterEntry.text.trim().length === 0)
                return;

            let [selected, model_, iter] = this._list.get_selection().get_selected();
            if (selected)
                this._toggleChecked(this._list.model.get_path(iter));
        });

        this._list.connect('row-activated', (view, path, _column) => {
            this._toggleChecked(path);
        });

        this._toggleRenderer.connect('toggled', (cell, pathStr) => {
            // For pointer devices, ::row-activated is emitted as well
            let dev = Gtk.get_current_event_device();
            if (dev && dev.input_source === Gdk.InputSource.KEYBOARD)
                this._toggleChecked(Gtk.TreePath.new_from_string(pathStr));
        });

        this._manager = ServerRoomManager.getDefault();
        let loadingChangedId =
            this._manager.connect('loading-changed',
                this._onLoadingChanged.bind(this));

        this.connect('destroy', () => {
            this.setAccount(null);

            this._manager.disconnect(loadingChangedId);
        });
    }

    get can_join() {
        let canJoin = false;
        this._store.foreach((model, path, iter) => {
            canJoin = model.get_value(iter, RoomListColumn.SENSITIVE) &&
                      model.get_value(iter, RoomListColumn.CHECKED);
            return canJoin;
        });
        return canJoin;
    }

    get selectedRooms() {
        let rooms = [];
        let [valid, iter] = this._store.get_iter_first();
        for (; valid; valid = this._store.iter_next(iter)) {
            if (!this._store.get_value(iter, RoomListColumn.SENSITIVE) ||
                !this._store.get_value(iter, RoomListColumn.CHECKED))
                continue;
            rooms.push(this._store.get_value(iter, RoomListColumn.NAME));
        }
        return rooms;
    }

    setAccount(account) {
        if (this._account === account)
            return;

        this._account = account;
        this._pendingInfos = [];
        this._clearList();
        this._filterEntry.set_text('');
        this._onLoadingChanged(this._manager, account);
    }

    focusEntry() {
        this._filterEntry.grab_focus();
    }

    _isCustomRoomItem(iter) {
        let path = this._store.get_path(iter);
        let customPath = this._store.get_path(this._customRoomItem);
        return path.compare(customPath) === 0;
    }

    _updateCustomRoomName() {
        let newName = this._filterEntry.text.trim();
        if (newName.search(/\s/) !== -1)
            newName = '';

        if (newName) {
            let exactMatch = false;
            this._store.foreach((model, path, iter) => {
                if (this._isCustomRoomItem(iter))
                    return false;

                let name = model.get_value(iter, RoomListColumn.NAME);
                return (exactMatch = _strBaseEqual(newName, name));
            });

            if (exactMatch)
                newName = '';
        }

        this._store.set_value(this._customRoomItem, RoomListColumn.NAME, newName);
    }

    _updateSelection() {
        if (this._filterEntry.text.trim().length === 0)
            return;

        let {model} = this._list;
        let [valid, iter] = model.get_iter_first();
        if (!valid)
            return;

        this._list.get_selection().select_iter(iter);
        this._list.scroll_to_cell(model.get_path(iter), null, true, 0.0, 0.0);
    }

    _clearList() {
        let [valid_, iter] = this._store.get_iter_first();
        if (this._isCustomRoomItem(iter))
            return;
        this._store.move_before(this._customRoomItem, iter);
        while (this._store.remove(iter))
            ;
    }

    _onLoadingChanged(mgr, account) {
        if (account !== this._account)
            return;

        this._checkSpinner();

        if (this.loading)
            return;

        this._clearList();

        if (this._idleId)
            GLib.source_remove(this._idleId);

        if (!account)
            return;

        let roomInfos = this._manager.getRoomInfos(account);
        roomInfos.sort((info1, info2) => {
            let count1 = info1.get_members_count(null);
            let count2 = info2.get_members_count(null);
            if (count1 !== count2)
                return count2 - count1;
            return info1.get_name().localeCompare(info2.get_name());
        });
        this._pendingInfos = roomInfos;

        this._checkSpinner();

        let roomManager = RoomManager.getDefault();

        this._idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            let customName = this._store.get_value(
                this._customRoomItem,
                RoomListColumn.NAME);
            let store = this._store;
            let startTime = GLib.get_monotonic_time();
            while (this._pendingInfos.length > 0) {
                let roomInfo = this._pendingInfos.shift();

                let name = roomInfo.get_name();
                if (name[0] === '#')
                    name = name.substr(1, name.length);

                if (_strBaseEqual(name, customName)) {
                    store.set_value(this._customRoomItem,
                        RoomListColumn.NAME, customName = '');
                }

                let room = roomManager.lookupRoomByName(roomInfo.get_name(), this._account);
                let sensitive = !room;
                let checked = !sensitive;
                let count = `${roomInfo.get_members_count(null)}`;

                let {CHECKED, NAME, COUNT, SENSITIVE} = RoomListColumn;
                let iter = store.insert_with_values(-1,
                    [CHECKED, NAME, COUNT, SENSITIVE],
                    [checked, name, count, sensitive]);
                store.move_before(iter, this._customRoomItem);

                let maxTime = this._filterTerms.length > 0
                    ? MS_PER_FILTER_IDLE : MS_PER_IDLE;
                // Limit time spent in idle to leave room for drawing etc.
                if (GLib.get_monotonic_time() - startTime > 1000 * maxTime)
                    return GLib.SOURCE_CONTINUE;
            }

            this._idleId = 0;
            this._checkSpinner();
            return GLib.SOURCE_REMOVE;
        });
    }

    _checkSpinner() {
        let loading = this._pendingInfos.length ||
                      this._account && this._manager.isLoading(this._account);
        this._spinner.visible = loading;
    }

    _toggleChecked(path) {
        let childPath = this._list.model.convert_path_to_child_path(path);
        let [valid_, iter] = this._store.get_iter(childPath);
        if (!this._store.get_value(iter, RoomListColumn.SENSITIVE))
            return;
        let checked = this._store.get_value(iter, RoomListColumn.CHECKED);
        this._store.set_value(iter, RoomListColumn.CHECKED, !checked);

        this.notify('can-join');
    }
});
