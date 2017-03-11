const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;
const Pango = imports.gi.Pango;
const Tp = imports.gi.TelepathyGLib;

const AccountsMonitor = imports.accountsMonitor;
const Lang = imports.lang;
const Mainloop = imports.mainloop;
const RoomManager = imports.roomManager;
const Signals = imports.signals;

const LIST_CHUNK_SIZE = 100;

let _singleton = null;

function getDefault() {
    if (_singleton == null)
        _singleton = new _ServerRoomManager();
    return _singleton;
}

const _ServerRoomManager = new Lang.Class({
    Name: '_ServerRoomManager',

    _init: function() {
        this._roomLists = new Map();

        this._accountsMonitor = AccountsMonitor.getDefault();
        this._accountsMonitor.connect('account-status-changed',
                                      Lang.bind(this, this._onAccountStatusChanged));
        this._accountsMonitor.connect('account-removed',
                                      Lang.bind(this, this._onAccountRemoved));
        this._accountsMonitor.prepare(() => {
            this._accountsMonitor.enabledAccounts.forEach(a => {
                this._onAccountStatusChanged(this._accountsMonitor, a);
            });
        });
    },

    getRoomInfos: function(account) {
        let roomList = this._roomLists.get(account);
        if (!roomList || roomList.list.listing)
            return [];
        return roomList.rooms.slice();
    },

    isLoading: function(account) {
        let roomList = this._roomLists.get(account);
        if (!roomList)
            return account.connection_status == Tp.ConnectionStatus.CONNECTING;
        return roomList.list.listing;
    },

    _onAccountStatusChanged: function(mon, account) {
        if (account.connection_status == Tp.ConnectionStatus.CONNECTING)
            this.emit('loading-changed', account);

        if (account.connection_status != Tp.ConnectionStatus.CONNECTED)
            return;

        if (this._roomLists.has(account))
            return;

        let roomList = new Tp.RoomList({ account: account });
        roomList.init_async(GLib.PRIORITY_DEFAULT, null, (o, res) => {
            roomList.init_finish(res);
            roomList.start();
        });
        roomList.connect('got-room', Lang.bind(this, this._onGotRoom));
        roomList.connect('notify::listing',
                         Lang.bind(this, this._onListingChanged));
        this._roomLists.set(account, { list: roomList, rooms: [] });
    },

    _onAccountRemoved: function(mon, account) {
        let roomList = this._roomLists.get(account);
        if (!roomList)
            return;

        roomList.list.run_dispose();
        this._roomLists.delete(account);
    },

    _onGotRoom: function(list, roomInfo) {
        let roomList = this._roomLists.get(list.account);
        if (!roomList)
            return;

        debug('Got room %s for account %s'.format(roomInfo.get_name(),
                                                  list.account.display_name));
        roomList.rooms.push(roomInfo);
    },

    _onListingChanged: function(list) {
        this.emit('loading-changed', list.account);
    }
});
Signals.addSignalMethods(_ServerRoomManager.prototype);


const RoomListColumn = {
    CHECKED:   0,
    NAME:      1,
    COUNT:     2,

    SENSITIVE: 3,
};

const ServerRoomList = new Lang.Class({
    Name: 'ServerRoomList',
    Extends: Gtk.Box,
    Template: 'resource:///org/gnome/Polari/ui/server-room-list.ui',
    InternalChildren: ['filterEntry',
                       'list',
                       'spinner'],
    Properties: { 'can-join': GObject.ParamSpec.boolean('can-join',
                                                        'can-join',
                                                        'can-join',
                                                        GObject.ParamFlags.READABLE,
                                                        false),
                  'loading': GObject.ParamSpec.boolean('loading',
                                                       'loading',
                                                       'loading',
                                                       GObject.ParamFlags.READABLE,
                                                       false)
    },

    _init: function(params) {
        this._account = null;
        this._pendingInfos = [];

        this.parent(params);

        this.connect('destroy', () => {
            this.setAccount(null);
        });

        this._filterEntry.connect('changed', () => { this.notify('can-join'); });
        this._filterEntry.connect('stop-search', () => {
            if (this._filterEntry.get_text_length() > 0)
                this._filterEntry.set_text('');
            else if (this.get_toplevel() instanceof Gtk.Dialog)
                this.get_toplevel().response(Gtk.ResponseType.CANCEL);
        });

        this._list.connect('row-activated', (view, path, column) => {
            this._toggleChecked(path);
        });

        this.bind_property('loading', this._spinner, 'active',
                           GObject.BindingFlags.SYNC_CREATE);

        this._manager = getDefault();
        this._manager.connect('loading-changed',
                              Lang.bind(this, this._onLoadingChanged));
    },

    get can_join() {
        if (this._filterEntry.get_text_length() > 0)
            return true;

        let canJoin = false;
        this._list.model.foreach((model, path, iter) => {
            canJoin = model.get_value(iter, RoomListColumn.SENSITIVE) &&
                      model.get_value(iter, RoomListColumn.CHECKED);
            return canJoin;
        });
        return canJoin;
    },

    get loading() {
        return this._pendingInfos.length ||
               (this._account && this._manager.isLoading(this._account));
    },

    get selectedRooms() {
        let rooms = [];

        if (this._filterEntry.get_text_length() > 0)
            rooms.push(this._filterEntry.get_text());

        let [valid, iter] = this._list.model.get_iter_first();
        for (; valid; valid = this._list.model.iter_next(iter)) {
            if (!this._list.model.get_value(iter, RoomListColumn.SENSITIVE) ||
                !this._list.model.get_value(iter, RoomListColumn.CHECKED))
                continue;
            rooms.push(this._list.model.get_value(iter, RoomListColumn.NAME));
        }
        return rooms;
    },

    setAccount: function(account) {
        if (this._account == account)
            return;

        this._account = account;
        this._pendingInfos = [];
        this._list.model.clear();
        this._filterEntry.set_text('');
        this._onLoadingChanged(this._manager, account);
    },

    focusEntry: function() {
        this._filterEntry.grab_focus();
    },

    _onLoadingChanged: function(mgr, account) {
        if (account != this._account)
            return;

        this.notify('loading');

        if (this.loading)
            return;

        this._list.model.clear();

        if (this._idleId)
            Mainloop.source_remove(this._idleId);

        if (!account)
            return;

        let roomInfos = this._manager.getRoomInfos(account);
        roomInfos.sort((info1, info2) => {
            let count1 = info1.get_members_count(null);
            let count2 = info2.get_members_count(null);
            if (count1 != count2)
                return count2 - count1;
            return info1.get_name().localeCompare(info2.get_name());
        });
        this._pendingInfos = roomInfos;

        this.notify('loading');

        let roomManager = RoomManager.getDefault();

        this._idleId = Mainloop.idle_add(() => {
            this._pendingInfos.splice(0, LIST_CHUNK_SIZE).forEach(roomInfo => {
                let store = this._list.model;

                let name = roomInfo.get_name();
                if (name[0] == '#')
                    name = name.substr(1, name.length);

                let room = roomManager.lookupRoomByName(roomInfo.get_name(), this._account);
                let sensitive = room == null;
                let checked = !sensitive;
                let count = '%d'.format(roomInfo.get_members_count(null));

                store.insert_with_valuesv(-1,
                                          [RoomListColumn.CHECKED,
                                           RoomListColumn.NAME,
                                           RoomListColumn.COUNT,
                                           RoomListColumn.SENSITIVE],
                                          [checked, name, count, sensitive]);
            });
            if (this._pendingInfos.length)
                return GLib.SOURCE_CONTINUE;

            this._idleId = 0;
            this.notify('loading');
            return GLib.SOURCE_REMOVE;
        });
    },

    _toggleChecked: function(path) {
        let [valid, iter] = this._list.model.get_iter(path);
        if (!this._list.model.get_value(iter, RoomListColumn.SENSITIVE))
            return;
        let checked = this._list.model.get_value(iter, RoomListColumn.CHECKED);
        this._list.model.set_value(iter, RoomListColumn.CHECKED, !checked);

        this.notify('can-join');
    }
});
