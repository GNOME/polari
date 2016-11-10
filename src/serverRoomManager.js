const GLib = imports.gi.GLib;
const Tp = imports.gi.TelepathyGLib;

const AccountsMonitor = imports.accountsMonitor;
const Lang = imports.lang;
const Signals = imports.signals;

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
