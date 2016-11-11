const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;
const Tp = imports.gi.TelepathyGLib;

const AccountsMonitor = imports.accountsMonitor;
const Lang = imports.lang;
const Mainloop = imports.mainloop;
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

const ServerRoomList = new Lang.Class({
    Name: 'ServerRoomList',
    Extends: Gtk.ScrolledWindow,
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

        this._list = new Gtk.ListBox({ visible: true });
        this._list.set_header_func(Lang.bind(this, this._updateHeader));
        this._list.connect('row-activated',
                               Lang.bind(this, this._onRowActivated));
        this.add(this._list);

        this._manager = getDefault();
        this._manager.connect('loading-changed',
                              Lang.bind(this, this._onLoadingChanged));
    },

    get can_join() {
        return this._list.get_children().some(r => r.checked);
    },

    get loading() {
        return this._pendingInfos.length ||
               (this._account && this._manager.isLoading(this._account));
    },

    _onRowActivated: function(list, row) {
        row.activate();
    },

    get selectedRooms() {
        let selectedRows = this._list.get_children().filter(r => r.checked);
        return selectedRows.map(r => r.info.get_name());
    },

    setAccount: function(account) {
        if (this._account == account)
            return;

        this._account = account;
        this._pendingInfos = [];
        this._list.foreach(function(w) { w.destroy(); });
        this._onLoadingChanged(this._manager, account);
    },

    _updateHeader: function(row, before) {
        if (!before)
            row.set_header(null);
        else if (!row.get_header())
            row.set_header(new Gtk.Separator());
    },

    _onLoadingChanged: function(mgr, account) {
        if (account != this._account)
            return;

        this.notify('loading');

        if (this.loading)
            return;

        this._list.foreach(function(w) { w.destroy(); });

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

        this._idleId = Mainloop.idle_add(() => {
            this._pendingInfos.splice(0, LIST_CHUNK_SIZE).forEach(roomInfo => {
                let row = new ServerRoomRow({ info: roomInfo });
                row.connect('notify::checked', () => { this.notify('can-join'); });
                this._list.add(row);
            });
            if (this._pendingInfos.length)
                return GLib.SOURCE_CONTINUE;

            this._idleId = 0;
            this.notify('loading');
            return GLib.SOURCE_REMOVE;
        });
    }
});

const ServerRoomRow = new Lang.Class({
    Name: 'ServerRoomRow',
    Extends: Gtk.ListBoxRow,
    Properties: { 'checked': GObject.ParamSpec.boolean('checked',
                                                       'checked',
                                                       'checked',
                                                       GObject.ParamFlags.READABLE,
                                                       false),
    },

    _init: function(params) {
        if (!params || !params.info)
            throw new Error('No info in parameters');

        this._info = params.info;
        delete params.info;

        this.parent(params);

        let name = this._info.get_name();
        if (name[0] == '#')
           name = name.substr(1, name.length);

        let box = new Gtk.Box({ spacing: 12, margin: 12 });
        this.add(box);

        this._checkbox = new Gtk.CheckButton();
        this._checkbox.connect('toggled', Lang.bind(this,
            function() {
                this.notify('checked');
            }));

        box.add(this._checkbox);

        box.add(new Gtk.Label({ label: name,
                                hexpand: true,
                                halign: Gtk.Align.START }));

        let count = this._info.get_members_count(null);
        let label = new Gtk.Label({ label: "%d".format(count) });
        label.get_style_context().add_class('dim-label');
        box.add(label);

        this.show_all();
    },

    get info() {
        return this._info;
    },

    get checked() {
        return this._checkbox.active;
    },

    vfunc_activate: function() {
        this._checkbox.activate();
    }
});
