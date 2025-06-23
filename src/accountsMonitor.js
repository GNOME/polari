// SPDX-FileCopyrightText: 2013 Florian Müllner <fmuellner@gnome.org>
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Polari from 'gi://Polari';
import Tp from 'gi://TelepathyGLib';

const Signals = imports.signals;

import NetworksManager from './networksManager.js';

Gio._promisify(Tp.AccountManager.prototype, 'prepare_async', 'prepare_finish');
Gio._promisify(Tp.Account.prototype,
    'request_presence_async', 'request_presence_finish');

export default class AccountsMonitor {
    static getDefault() {
        if (!this._singleton)
            this._singleton = new AccountsMonitor();
        return this._singleton;
    }

    constructor() {
        this._accounts = new Map();

        this._networkMonitor = Gio.NetworkMonitor.get_default();

        this._app = Gio.Application.get_default();

        if (!this._app.isTestInstance) {
            this._app.connect('prepare-shutdown',
                this._onPrepareShutdown.bind(this));
        }

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
        } catch {
            this._app.release();
            return; // no point in carrying on
        }

        am.dup_valid_accounts().forEach(this._addAccount.bind(this));

        am.connect('account-validity-changed', (o, account, valid) => {
            if (valid) {
                this._addAccount(account);
                this._updateAccountReachable(account);
            } else {
                this._removeAccount(account);
            }
        });
        am.connect('account-removed', (o, account) => {
            this._removeAccount(account);
        });
        am.connect('account-enabled', this._accountEnabledChanged.bind(this));
        am.connect('account-disabled', this._accountEnabledChanged.bind(this));

        this._preparedCallbacks.forEach(callback => callback());

        this._networkMonitor.connect('network-changed',
            this._onNetworkChanged.bind(this));
        this._onNetworkChanged();
    }

    _onNetworkChanged() {
        this.visibleAccounts.forEach(a => this._updateAccountReachable(a));
    }

    async _onPrepareShutdown() {
        const presence = Tp.ConnectionPresenceType.OFFLINE;
        const onlineAccounts =
            this.accounts.filter(a => a.requested_presence_type !== presence);

        this._app.hold();

        await Promise.all(onlineAccounts.map(
            a => a.request_presence_async(presence, 'offline', '')));

        this._app.release();
    }

    _shouldMonitorAccount(account) {
        return account.protocol_name === 'irc';
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
        account._reachableNotifyId =
            account.connect('notify::reachable', () => {
                this.emit('account-reachable-changed', account);
            });
        account._visibleNotifyId =
            account.connect('notify::visible', () => {
                this._updateAccountReachable(account);
                let signal = account.visible
                    ? 'account-shown' : 'account-hidden';
                this.emit(signal, account);
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

        account.disconnect(account._reachableNotifyId);
        delete account._reachableNotifyId;

        account.disconnect(account._visibleNotifyId);
        delete account._visibleNotifyId;

        this.emit('account-removed', account);
        this.emit('accounts-changed');
    }

    _accountEnabledChanged(am, account) {
        if (!this._accounts.has(account.object_path))
            return;
        let signal = account.enabled ? 'account-enabled' : 'account-disabled';
        this.emit(signal, account);
        this.emit('accounts-changed');
    }

    async _updateAccountReachable(account) {
        if (!this._networkMonitor.state_valid)
            return;

        let servers = account.getServers().map(s => {
            return new Gio.NetworkAddress({
                hostname: s.address,
                port: s.port,
            });
        });

        try {
            let reachable = await this._canReachAny(servers);
            account._setReachable(reachable);
        } catch {
            account._setReachable(false);
        }
    }

    _canReachAny(servers) {
        let reverse = promise => {
            return new Promise((resolve, reject) => {
                return Promise.resolve(promise).then(reject, resolve);
            });
        };
        return reverse(Promise.all(servers.map(s => reverse(this._canReach(s)))));
    }

    _canReach(addr) {
        return new Promise((resolve, reject) => {
            this._networkMonitor.can_reach_async(addr, null, (mon, res) => {
                try {
                    resolve(this._networkMonitor.can_reach_finish(res));
                } catch (e) {
                    reject(e);
                }
            });
        });
    }
}
Signals.addSignalMethods(AccountsMonitor.prototype);

const ClientFactory = GObject.registerClass(
class ClientFactory extends Polari.ClientFactory {
    vfunc_create_account(objectPath) {
        return new PolariAccount({
            factory: this,
            dbus_daemon: this.dbus_daemon,
            bus_name: Tp.ACCOUNT_MANAGER_BUS_NAME,
            object_path: objectPath,
        });
    }
});

const PolariAccount = GObject.registerClass(
class PolariAccount extends Tp.Account {
    static [GObject.properties] = {
        predefined: GObject.ParamSpec.boolean(
            'predefined', null, null,
            GObject.ParamFlags.READABLE,
            false),
        reachable: GObject.ParamSpec.boolean(
            'reachable', null, null,
            GObject.ParamFlags.READABLE,
            false),
        visible: GObject.ParamSpec.boolean(
            'visible', null, null,
            GObject.ParamFlags.READWRITE,
            true),
        settings: GObject.ParamSpec.object(
            'settings', null, null,
            GObject.ParamFlags.READABLE,
            Gio.Settings.$gtype),
    };

    _visible = true;
    _reachable = undefined;
    _networksManager = NetworksManager.getDefault();

    constructor(params) {
        super(params);

        this._settings = new Gio.Settings({
            schema_id: 'org.gnome.Polari.Account',
            path: `/org/gnome/Polari/Accounts/${this.get_path_suffix()}/`,
        });
    }

    get predefined() {
        return this._networksManager.getAccountIsPredefined(this);
    }

    get reachable() {
        return this._reachable;
    }

    _setReachable(reachable) {
        if (this._reachable === reachable)
            return;

        this._reachable = reachable;
        this.notify('reachable');
    }

    get visible() {
        return this._visible;
    }

    set visible(value) {
        if (this._visible === value)
            return;

        this._visible = value;
        this.notify('visible');
    }

    getConnectionParams() {
        let params = this.dup_parameters_vardict().deep_unpack();
        for (let p in params)
            params[p] = params[p].deep_unpack();

        params['use-ssl'] = !!params['use-ssl'];

        let defaultPort = params['use-ssl'] ? 6697 : 6667;
        params['port'] = params['port'] || defaultPort;

        return params;
    }

    getServers() {
        if (this.predefined)
            return this._networksManager.getNetworkServers(this.service);

        let params = this.getConnectionParams();
        return [{
            address: params.server,
            port: params.port,
        }];
    }

    get settings() {
        return this._settings;
    }
});
