const Gio = imports.gi.Gio;
const Tp = imports.gi.TelepathyGLib;

const Lang = imports.lang;
const Signals = imports.signals;

let _singleton = null;

function getDefault() {
    if (_singleton == null)
        _singleton = new AccountsMonitor();
    return _singleton;
}

const AccountsMonitor = new Lang.Class({
    Name: 'AccountsMonitor',

    _init: function() {
        this._accounts = [];

        this._app = Gio.Application.get_default();
        this._app.connectJS('prepare-shutdown',
                            Lang.bind(this, this._onPrepareShutdown));

        this._accountManager = Tp.AccountManager.dup();
        this._accountManager.prepare_async(null,
                                           Lang.bind(this, this._onPrepared));
    },

    dupAccounts: function() {
        return this._accounts.slice();
    },

    _onPrepared: function(am, res) {
        am.prepare_finish(res);

        am.dup_valid_accounts().forEach(Lang.bind(this, this._addAccount));

        am.connect('account-validity-changed', Lang.bind(this,
            function(am, account, valid) {
                if (valid)
                    this._addAccount(account);
                else
                    this._removeAccount(account);
            }));
        am.connect('account-removed', Lang.bind(this,
            function(am, account) {
                this._removeAccount(account);
            }));
        am.connect('account-enabled',
                   Lang.bind(this, this._accountEnabledChanged));
        am.connect('account-disabled',
                   Lang.bind(this, this._accountEnabledChanged));
    },

    _onPrepareShutdown: function() {
        for (let i = 0; i < this._accounts.length; i++) {
            let account = this._accounts[i];

            let presence = Tp.ConnectionPresenceType.OFFLINE;
            if (account.requested_presence_type == presence)
                continue;

            this._app.hold();
            account.request_presence_async(presence, '', '',
                Lang.bind(this, function() {
                    this._app.release();
                }));
        }
    },

    _shouldMonitorAccount: function(account) {
        return account.protocol_name == 'irc';
    },

    _addAccount: function(account) {
        if (!this._shouldMonitorAccount(account))
            return;

        account._statusNotifyId =
            account.connect('notify::connection-status', Lang.bind(this,
                function() {
                    this.emit('account-status-changed', account);
                }));
        this._accounts.push(account);

        this.emit('account-added', account);
        this.emit('accounts-changed');
    },

    _removeAccount: function(account) {
        let index = this._accounts.indexOf(account);

        if (index == -1)
            return;

        account.disconnect(account._statusNotifyId);
        delete account._statusNotifyId;
        this._accounts.splice(index, 1);

        this.emit('account-removed', account);
        this.emit('accounts-changed');
    },

    _accountEnabledChanged: function(am, account) {
        if (this._accounts.indexOf(account) == -1)
            return;
        this.emit('accounts-changed');
    }
});
Signals.addSignalMethods(AccountsMonitor.prototype);
