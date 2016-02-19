const Gio = imports.gi.Gio;
const GObject = imports.gi.GObject;
const Polari = imports.gi.Polari;
const Signals = imports.signals;
const Tp = imports.gi.TelepathyGLib;

var AccountsMonitor = class {
    static getDefault() {
        if (!this._singleton)
            this._singleton = new AccountsMonitor();
        return this._singleton;
    }

    constructor() {
        this._accounts = new Map();
        this._accountSettings = new Map();

        this._app = Gio.Application.get_default();

        if (!this._app.isTestInstance)
            this._app.connect('prepare-shutdown',
                              this._onPrepareShutdown.bind(this));

        let factory = new ClientFactory();
        factory.add_channel_features([Tp.Channel.get_feature_quark_group()]);
        factory.add_channel_features([Tp.Channel.get_feature_quark_contacts()]);
        factory.add_contact_features([Tp.ContactFeature.ALIAS]);

        this._accountManager = Tp.AccountManager.new_with_factory(factory);
        this._accountManager.set_default();

        this._preparedCallbacks = [];
        this._accountManager.prepare_async(null, this._onPrepared.bind(this));
    }

    get accounts() {
        return [...this._accounts.values()];
    }

    get visibleAccounts() {
        return [...this._accounts.values()].filter(a => a.visible);
    }

    get accountManager() {
        return this._accountManager;
    }

    lookupAccount(accountPath) {
        return this._accounts.get(accountPath);
    }

    getAccountSettings(account) {
        let accountPath = account.object_path;
        let settings = this._accountSettings.get(accountPath);
        if (settings)
            return settings;

        let path = '/org/gnome/Polari/Accounts/%s/'.format(account.get_path_suffix());
        settings = new Gio.Settings({ schema_id: 'org.gnome.Polari.Account',
                                      path: path });
        this._accountSettings.set(accountPath, settings);
        return settings;
    }

    prepare(callback) {
        let quark = Tp.AccountManager.get_feature_quark_core();
        if (this._accountManager.is_prepared(quark))
            callback();
        else
            this._preparedCallbacks.push(callback);
    }

    _onPrepared(am, res) {
        try {
            am.prepare_finish(res);
        } catch(e) {
            this._app.release();
            return; // no point in carrying on
        }

        am.dup_valid_accounts().forEach(this._addAccount.bind(this));

        am.connect('account-validity-changed', (am, account, valid) => {
            if (valid)
                this._addAccount(account);
            else
                this._removeAccount(account);
        });
        am.connect('account-removed', (am, account) => {
            this._removeAccount(account);
        });
        am.connect('account-enabled', this._accountEnabledChanged.bind(this));
        am.connect('account-disabled', this._accountEnabledChanged.bind(this));

        this._preparedCallbacks.forEach(callback => { callback(); });
    }

    _onPrepareShutdown() {
        let presence = Tp.ConnectionPresenceType.OFFLINE;
        this.accounts.filter(a => a.requested_presence_type != presence).forEach(a => {
            this._app.hold();
            a.request_presence_async(presence, 'offline', '', (a, res) => {
                try {
                    a.request_presence_finish(result);
                } catch(e) { }
                this._app.release();
            });
        });
    }

    _shouldMonitorAccount(account) {
        return account.protocol_name == 'irc';
    }

    _addAccount(account) {
        if (!this._shouldMonitorAccount(account))
            return;

        if (this._accounts.has(account.object_path))
            return;

        account._statusNotifyId =
            account.connect('notify::connection-status', () => {
                this.emit('account-status-changed', account);
            });
        account._visibleNotifyId =
            account.connect('notify::visible', () => {
                this.emit(account.visible ? 'account-shown'
                                          : 'account-hidden', account);
                this.emit('accounts-changed');
            });
        this._accounts.set(account.object_path, account);

        this.emit('account-added', account);
        this.emit('accounts-changed');
    }

    _removeAccount(account) {
        if (!this._accounts.delete(account.object_path))
            return;

        account.disconnect(account._statusNotifyId);
        delete account._statusNotifyId;

        account.disconnect(account._visibleNotifyId);
        delete account._visibleNotifyId;

        this.emit('account-removed', account);
        this.emit('accounts-changed');
    }

    _accountEnabledChanged(am, account) {
        if (!this._accounts.has(account.object_path))
            return;
        this.emit(account.enabled ? 'account-enabled'
                                  : 'account-disabled', account);
        this.emit('accounts-changed');
    }
};
Signals.addSignalMethods(AccountsMonitor.prototype);

const ClientFactory = GObject.registerClass(
class ClientFactory extends Polari.ClientFactory {
    vfunc_create_account(objectPath) {
        return new PolariAccount({ factory: this,
                                   dbus_daemon: this.dbus_daemon,
                                   bus_name: Tp.ACCOUNT_MANAGER_BUS_NAME,
                                   object_path: objectPath });
    }
});

const PolariAccount = GObject.registerClass({
    Properties: {
        visible: GObject.ParamSpec.boolean('visible',
                                           'visible',
                                           'visible',
                                           GObject.ParamFlags.READWRITE |
                                           GObject.ParamFlags.EXPLICIT_NOTIFY,
                                           true)
    }
}, class PolariAccount extends Tp.Account {
    _init(params) {
        this._visible = true;

        super._init(params);
    }

    get visible() {
        return this._visible;
    }

    set visible(value) {
        if (this._visible == value)
            return;

        this._visible = value;
        this.notify('visible');
    }
});
