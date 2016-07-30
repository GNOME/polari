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
        this._accounts = new Map();

        this._app = Gio.Application.get_default();
        this._app.connect('prepare-shutdown',
                          Lang.bind(this, this._onPrepareShutdown));

        this._accountManager = Tp.AccountManager.dup();

        let factory = this._accountManager.get_factory();
        factory.add_channel_features([Tp.Channel.get_feature_quark_group()]);
        factory.add_channel_features([Tp.Channel.get_feature_quark_contacts()]);
        factory.add_contact_features([Tp.ContactFeature.ALIAS]);

        this._accountManager.prepare_async(null,
                                           Lang.bind(this, this._onPrepared));
    },

    get accounts() {
        return [...this._accounts.values()];
    },

    get enabledAccounts() {
        return [...this._accounts.values()].filter(a => a.enabled);
    },

    get accountManager() {
        return this._accountManager;
    },

    lookupAccount: function(accountPath) {
        return this._accounts.get(accountPath);
    },

    _onPrepared: function(am, res) {
        try {
            am.prepare_finish(res);
        } catch(e) {
            this._app.release();
            return; // no point in carrying on
        }

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

        this.emit('account-manager-prepared', am);
    },

    _onPrepareShutdown: function() {
        for (let account of this._accounts.values()) {
            let presence = Tp.ConnectionPresenceType.OFFLINE;
            if (account.requested_presence_type == presence)
                continue;

            this._app.hold();
            account.request_presence_async(presence, 'offline', '',
                Lang.bind(this, function(account, result) {
                    try {
                        account.request_presence_finish(result);
                    } catch(e) { }
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

        if (this._accounts.has(account.object_path))
            return;

        account._statusNotifyId =
            account.connect('notify::connection-status', Lang.bind(this,
                function() {
                    this.emit('account-status-changed', account);
                }));
        this._accounts.set(account.object_path, account);

        this.emit('account-added', account);
        this.emit('accounts-changed');
    },

    _removeAccount: function(account) {
        if (!this._accounts.delete(account.object_path))
            return;

        account.disconnect(account._statusNotifyId);
        delete account._statusNotifyId;

        this.emit('account-removed', account);
        this.emit('accounts-changed');
    },

    _accountEnabledChanged: function(am, account) {
        if (!this._accounts.has(account.object_path))
            return;
        this.emit(account.enabled ? 'account-enabled'
                                  : 'account-disabled', account);
        this.emit('accounts-changed');
    }
});
Signals.addSignalMethods(AccountsMonitor.prototype);
