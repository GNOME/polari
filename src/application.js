// SPDX-FileCopyrightText: 2013 Florian Müllner <fmuellner@gnome.org>
// SPDX-FileCopyrightText: 2015 Bastian Ilsø <bastianilso@gnome.org>
// SPDX-FileCopyrightText: 2016 Kunaal Jain <kunaalus@gmail.com>
// SPDX-FileCopyrightText: 2017 Danny Mølgaard <moelgaard.dmp@gmail.com>
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Polari from 'gi://Polari';
import Tp from 'gi://TelepathyGLib';

import {setConsoleLogDomain} from 'console';

import AccountsMonitor from './accountsMonitor.js';
import * as Connections from './connections.js';
import InitialSetupWindow from './initialSetup.js';
import * as Logger from './logger.js';
import MainWindow from './mainWindow.js';
import NetworksManager from './networksManager.js';
import PasteManager from './pasteManager.js';
import RoomManager from './roomManager.js';
import ServerRoomManager from './serverRoomManager.js';
import TelepathyClient from './telepathyClient.js';
import UserStatusMonitor from './userTracker.js';
import * as Utils from './utils.js';

Gio._promisify(Tp.AccountRequest.prototype,
    'create_account_async', 'create_account_finish');
Gio._promisify(Tp.Account.prototype, 'remove_async', 'remove_finish');
Gio._promisify(Tp.Account.prototype,
    'request_presence_async', 'request_presence_finish');
Gio._promisify(Tp.Account.prototype,
    'set_enabled_async', 'set_enabled_finish');
Gio._promisify(Tp.Account.prototype,
    'set_nickname_async', 'set_nickname_finish');
Gio._promisify(Tp.Account.prototype,
    'update_parameters_vardict_async', 'update_parameters_vardict_finish');

const MAX_RETRIES = 3;

const IRC_SCHEMA_REGEX = /^(irc?:\/\/)([\da-z.-]+):?(\d+)?\/(?:%23)?([\w.+-]+)/i;

export default GObject.registerClass(
class Application extends Adw.Application {
    static [GObject.signals] = {
        'prepare-shutdown': {},
        'room-focus-changed': {},
    };

    constructor() {
        super({
            application_id: 'org.gnome.Polari',
            flags: Gio.ApplicationFlags.HANDLES_OPEN,
        });

        GLib.set_prgname('polari');
        Tp.debug_set_flags(GLib.getenv('TP_DEBUG') || '');

        const logDomain = 'Polari';
        setConsoleLogDomain(logDomain);
        if (GLib.log_writer_is_journald(2))
            GLib.setenv('G_MESSAGES_DEBUG', logDomain, false);

        this._removedAccounts = new Set();

        this._retryData = new Map();
        this._nickTrackData = new Map();
        this._demons = [];

        this._windowRemovedId =
            this.connect('window-removed', this._onWindowRemoved.bind(this));

        this.add_main_option('start-client', 0,
            GLib.OptionFlags.NONE, GLib.OptionArg.NONE,
            _('Start Telepathy client'), null);
        // Only included for --help output, the actual option is handled
        // from C before handling over control to JS
        this.add_main_option('debugger', 'd',
            GLib.OptionFlags.NONE, GLib.OptionArg.NONE,
            _('Start in debug mode'), null);
        this.add_main_option('test-instance', 0,
            GLib.OptionFlags.NONE, GLib.OptionArg.NONE,
            _('Allow running alongside another instance'), null);
        this.add_main_option('version', 0,
            GLib.OptionFlags.NONE, GLib.OptionArg.NONE,
            _('Print version and exit'), null);
        this.add_main_option('quit', 0,
            GLib.OptionFlags.NONE, GLib.OptionArg.NONE,
            _('Quit'), null);
        this.connect('handle-local-options', (o, dict) => {
            let v = dict.lookup_value('version', null);
            if (v && v.get_boolean()) {
                print(`Polari ${pkg.version}`);
                return 0;
            }

            v = dict.lookup_value('test-instance', null);
            if (v && v.get_boolean())
                this._maybeMakeNonUnique();

            try {
                this.register(null);
            } catch {
                return 1;
            }

            v = dict.lookup_value('start-client', null);
            if (v && v.get_boolean()) {
                this.activate_action('start-client', null);
                return 0;
            }

            v = dict.lookup_value('quit', null);
            if (v && v.get_boolean()) {
                this.activate_action('quit', null);
                return 0;
            }

            return -1;
        });
    }

    isRoomFocused(room) {
        return this.active_window &&
               this.active_window['is-active'] &&
               this.active_window.active_room === room;
    }

    // Small wrapper to mark user-requested nick changes
    async setAccountNick(account, nick) {
        await account.set_nickname_async(nick);
        this._untrackNominalNick(account);
    }

    _checkService(conn, name, opath, iface) {
        let flags = Gio.DBusProxyFlags.DO_NOT_LOAD_PROPERTIES |
                    Gio.DBusProxyFlags.DO_NOT_CONNECT_SIGNALS;
        let proxy = null;

        try {
            proxy = Gio.DBusProxy.new_sync(
                conn, flags, null, name, opath, iface, null);
        } catch {}

        return proxy !== null && proxy.get_name_owner() !== null;
    }

    _ensureService(conn, name, opath, iface, command) {
        console.info(`Trying to ensure service ${name}`);

        if (this._checkService(conn, name, opath, iface))
            return;

        console.info(`Failed to activate service ${
            name}, starting manually`);

        let proc = new Gio.Subprocess({argv: [command]});

        try {
            proc.init(null);
            this._demons.push(proc);
        } catch (e) {
            console.error(`Failed to launch ${
                command} to provide service ${name}`);
            console.debug(e);
        }
    }

    async _maybeImportLogs() {
        const path = GLib.build_filenamev(
            [GLib.get_user_data_dir(), 'polari', 'chatlogs.v1']);
        const file = Gio.File.new_for_path(path);
        if (file.query_exists(null))
            return;

        try {
            this.hold();
            this._importingLogs = true;

            let importer = new Logger.LogImporter();

            let numFiles = await importer.init();
            let n = 0;
            this.activeWindow?.showImportProgress(n, numFiles);

            // eslint-disable-next-line no-await-in-loop
            while (await importer.importNext()) {
                this.activeWindow?.showImportProgress(n, numFiles);
                n++;
            }

            this.activeWindow?.showImportProgress(n, numFiles);
        } catch (e) {
            console.error('Failed to import telepathy-logger logs');
            console.debug(e);
        } finally {
            this.release();
            this._importingLogs = false;
        }
    }

    _maybeMakeNonUnique() {
        let bus = Gio.BusType.SESSION;
        let name = this.application_id;
        let flags = Gio.BusNameWatcherFlags.NONE;

        let handled = false;
        let id = Gio.bus_watch_name(bus, name, flags, () => {
            console.info(
                'Running as test instance alongside primary instance');
            this.set_flags(this.flags | Gio.ApplicationFlags.NON_UNIQUE);
            handled = true;
        }, () => {
            console.info('No primary instance found, running normally');
            handled = true;
        });

        // Evil-ish ...
        let main = GLib.MainContext.default();
        while (!handled)
            main.iteration(true);
        Gio.bus_unwatch_name(id);
    }

    vfunc_dbus_register(conn, _path) {
        if (!Utils.isFlatpakSandbox())
            return true;

        GLib.setenv('IDLE_PERSIST', '1', false);
        this._ensureService(conn,
            Tp.ACCOUNT_MANAGER_BUS_NAME,
            Tp.ACCOUNT_MANAGER_OBJECT_PATH,
            Tp.ACCOUNT_MANAGER_BUS_NAME,
            '/app/libexec/mission-control-5');
        this._ensureService(conn,
            `${Tp.CM_BUS_NAME_BASE}idle`,
            `${Tp.CM_OBJECT_PATH_BASE}idle`,
            'org.freedesktop.Telepathy.ConnectionManager',
            '/app/libexec/telepathy-idle');
        return true;
    }

    vfunc_dbus_unregister(_conn, _path) {
        for (let proc of this._demons)
            proc.force_exit();
        this._demons = [];
    }

    vfunc_startup() {
        super.vfunc_startup();

        const actionEntries = [{
            name: 'show-join-dialog',
            activate: this._onShowJoinDialog.bind(this),
            accels: ['<Primary>n'],
        }, {
            name: 'join-room',
            activate: this._onJoinRoom.bind(this),
            parameter_type: '(ssb)',
        }, {
            name: 'message-user',
            activate: this._onMessageUser.bind(this),
            parameter_type: '(sssb)',
        }, {
            name: 'leave-room',
            parameter_type: '(ss)',
        }, {
            name: 'leave-current-room',
            activate: this._onLeaveCurrentRoom.bind(this),
            accels: ['<Primary>w'],
        }, {
            name: 'reconnect-room',
            parameter_type: 's',
        }, {
            name: 'authenticate-account',
            parameter_type: '(os)',
        }, {
            name: 'connect-account',
            activate: this._onConnectAccount.bind(this),
            parameter_type: 'o',
        }, {
            name: 'disconnect-account',
            activate: this._onConnectAccount.bind(this),
            parameter_type: 'o',
        }, {
            name: 'reconnect-account',
            activate: this._onConnectAccount.bind(this),
            parameter_type: 'o',
        }, {
            name: 'mute-nick',
            parameter_type: '(ss)',
        }, {
            name: 'unmute-nick',
            parameter_type: '(ss)',
        }, {
            name: 'user-list',
            activate: this._onToggleAction.bind(this),
            state: 'false',
            accels: ['F9', '<Primary>u'],
        }, {
            name: 'remove-connection',
            activate: this._onRemoveConnection.bind(this),
            parameter_type: 'o',
        }, {
            name: 'undo-remove-connection',
            activate: this._onUndoRemoveConnection.bind(this),
            parameter_type: 'o',
        }, {
            name: 'edit-connection',
            activate: this._onEditConnection.bind(this),
            parameter_type: 'o',
        }, {
            name: 'save-identify-password',
            parameter_type: 'o',
        }, {
            name: 'discard-identify-password',
            parameter_type: 'o',
        }, {
            name: 'show-emoji-picker',
            accels: ['<Primary>e'],
        }, {
            name: 'start-client',
            activate: this._onStartClient.bind(this),
        }, {
            name: 'help',
            activate: this._onShowHelp.bind(this),
            accels: ['F1'],
        }, {
            name: 'about',
            activate: this._onShowAbout.bind(this),
        }, {
            name: 'quit',
            activate: this._onQuit.bind(this),
            accels: ['<Primary>q'],
        }, {
            name: 'next-room',
            accels: ['<Primary>Page_Down', '<Alt>Down'],
        }, {
            name: 'previous-room',
            accels: ['<Primary>Page_Up', '<Alt>Up'],
        }, {
            name: 'first-room',
            accels: ['<Primary>Home'],
        }, {
            name: 'last-room',
            accels: ['<Primary>End'],
        }, {
            name: 'nth-room',
            parameter_type: 'i',
        }, {
            name: 'next-pending-room',
            accels: ['<Alt><Shift>Down', '<Primary><Shift>Page_Down'],
        }, {
            name: 'previous-pending-room',
            accels: ['<Alt><Shift>Up', '<Primary><Shift>Page_Up'],
        }];
        this.add_action_entries(actionEntries);

        this._settings = new Gio.Settings({schema_id: 'org.gnome.Polari'});
        let action = this._settings.create_action('run-in-background');
        this.add_action(action);

        action = this.lookup_action('user-list');
        action.connect('notify::enabled', () => {
            if (!action.enabled)
                action.change_state(GLib.Variant.new('b', false));
        });
        action.enabled = false;

        action = this.lookup_action('leave-current-room');
        action.enabled = false;

        for (const {name, accels} of actionEntries) {
            if (accels)
                this.set_accels_for_action(`app.${name}`, accels);
        }

        for (let i = 1; i < 10; i++)
            this.set_accels_for_action(`app.nth-room(${i})`, [`<Alt>${i}`]);

        this._telepathyClient = null;

        this._roomManager = RoomManager.getDefault();
        this._accountsMonitor = AccountsMonitor.getDefault();
        this._userStatusMonitor = UserStatusMonitor.getDefault();
        this._networksManager = NetworksManager.getDefault();

        // The portal implementation fetches the initial state asynchronously,
        // so track when the it becomes valid to not base decisions on an
        // incorrect offline state
        let networkMonitor = Gio.NetworkMonitor.get_default();
        networkMonitor.state_valid =
            !Utils.isFlatpakSandbox() &&
            GLib.getenv('GTK_USE_PORTAL') !== '1';

        if (networkMonitor.state_valid) {
            if (!networkMonitor.network_metered)
                this._serverRoomManager = ServerRoomManager.getDefault();
        } else {
            let id = networkMonitor.connect('network-changed', () => {
                networkMonitor.disconnect(id);
                networkMonitor.state_valid = true;

                if (!networkMonitor.network_metered)
                    this._serverRoomManager = ServerRoomManager.getDefault();
            });
        }

        this._accountsMonitor.connect('account-status-changed',
            this._onAccountStatusChanged.bind(this));
        this._accountsMonitor.connect('account-added', (am, account) => {
            // Reset nickname at startup
            let accountName = this._getTrimmedAccountName(account);
            account.set_nickname_async(accountName);
        });
        this._accountsMonitor.connect('account-removed', (am, account) => {
            // Make sure we don't 'inject' outdated data into
            // a new account with the same ID
            this._retryData.delete(account.object_path);
        });

        this.pasteManager = new PasteManager();
    }

    vfunc_activate() {
        this.activate_action('start-client', null);

        if (!this.active_window) {
            this._maybeImportLogs();

            if (this._needsInitialSetup()) {
                new InitialSetupWindow({application: this});
            } else {
                let window = new MainWindow({application: this});
                window.connect('notify::active-room',
                    () => this.emit('room-focus-changed'));
                window.connect('notify::is-active',
                    () => this.emit('room-focus-changed'));
            }
        }

        this.active_window.present();
    }

    vfunc_window_added(window) {
        super.vfunc_window_added(window);

        if (!(window instanceof MainWindow))
            return;

        let action = this.lookup_action('leave-current-room');
        action.enabled = window.active_room !== null;

        this._toplevelSignals = [
            window.connect('notify::active-room',
                () => (action.enabled = window.active_room !== null)),
            window.connect('active-room-state-changed',
                () => this._updateUserListAction()),
        ];
        this._updateUserListAction();
    }

    _onWindowRemoved(app, window) {
        if (!(window instanceof MainWindow))
            this.activate();
        else if (!this._settings.get_boolean('run-in-background'))
            this.emit('prepare-shutdown');

        this._toplevelSignals.forEach(id => window.disconnect(id));
        this._toplevelSignals = [];

        window.run_dispose();
    }

    vfunc_open(files) {
        this.activate();

        let uris = files.map(f => f.get_uri());

        this._accountsMonitor.prepare(() => {
            this._openURIs(uris);
        });
    }

    _openURIs(uris) {
        let map = {};

        this._accountsMonitor.visibleAccounts.forEach(a => {
            let params = a.dup_parameters_vardict().deep_unpack();
            map[a.get_object_path()] = {
                server: params.server.deep_unpack(),
                service: a.service,
            };
        });

        let joinAction = this.lookup_action('join-room');
        uris.forEach(async uri => {
            let [success, server, port, room] = this._parseURI(uri);
            if (!success)
                return;

            let matchedId = this._networksManager.findByServer(server);
            let matches = Object.keys(map).filter(a => {
                return GLib.ascii_strcasecmp(map[a].server, server) === 0 ||
                       map[a].service === matchedId;
            });

            let accountPath;
            if (matches.length) {
                accountPath = matches[0];
            } else {
                const account =
                    await this._createAccount(matchedId, server, port);
                accountPath = account.get_object_path();
            }

            joinAction.activate(new GLib.Variant('(ssb)', [accountPath, `#${room}`, true]));
        });
    }

    _parseURI(uri) {
        let server, port, room;
        let success = false;
        try {
            [,, server, port, room] = uri.match(IRC_SCHEMA_REGEX);
            success = true;
        } catch {
            const toast = new Adw.Toast({
                title: _('Failed to open link'),
            });
            this.active_window?.addToast(toast);
        }

        return [success, server, port, room];
    }

    async _createAccount(id, server, port) {
        let params, name;

        if (id) {
            params = this._networksManager.getNetworkDetails(id);
            name = this._networksManager.getNetworkName(id);
        } else {
            params = {
                'account': new GLib.Variant('s', GLib.get_user_name()),
                'server': new GLib.Variant('s', server),
                'port': new GLib.Variant('u', port ? port : 6667),
                'use-ssl': new GLib.Variant('b', port === 6697),
            };
            name = server;
        }

        let req = new Tp.AccountRequest({
            account_manager: Tp.AccountManager.dup(),
            connection_manager: 'idle',
            protocol: 'irc',
            display_name: name,
        });
        req.set_enabled(true);

        if (id)
            req.set_service(id);

        for (let prop in params)
            req.set_parameter(prop, params[prop]);

        const account = await req.create_account_async();

        Utils.clearAccountPassword(account);
        Utils.clearIdentifyPassword(account);

        return account;
    }

    _needsInitialSetup() {
        if (GLib.getenv('POLARI_FORCE_INITIAL_SETUP')) {
            GLib.unsetenv('POLARI_FORCE_INITIAL_SETUP');
            return true;
        }

        if (!Utils.needsOnetimeAction('initial-setup'))
            return;

        let savedRooms = this._settings.get_value('saved-channel-list');
        return savedRooms.n_children() === 0;
    }

    get isTestInstance() {
        return this.flags & Gio.ApplicationFlags.NON_UNIQUE;
    }

    get importingLogs() {
        return this._importingLogs;
    }

    _updateUserListAction() {
        let room = this.active_window.active_room;
        let action = this.lookup_action('user-list');
        action.enabled = room && room.type === Tp.HandleType.ROOM && room.channel;
    }

    _onShowJoinDialog() {
        this.active_window.showJoinRoomDialog();
    }

    _maybePresent(present) {
        if (!this.active_window || present)
            this.activate();
    }

    _onJoinRoom(action, parameter) {
        let [accountPath_, channelName_, present] = parameter.deep_unpack();
        this._maybePresent(present);
    }

    _onMessageUser(action, parameter) {
        let [accountPath_, contactName_, msg_, present] = parameter.deep_unpack();
        this._maybePresent(present);
    }

    _trackNominalNick(account) {
        if (this._nickTrackData.has(account))
            return;

        let nominalNick = this._getTrimmedAccountName(account);
        let baseNick = Polari.util_get_basenick(nominalNick);

        let tracker = this._userStatusMonitor.getUserTrackerForAccount(account);
        let contactsChangedId = tracker.connect(`contacts-changed::${baseNick}`,
            (t, nick) => {
                if (nick !== nominalNick)
                    return;

                let contact = tracker.lookupContact(nick);
                if (contact && contact.alias === nick)
                    return;

                this._untrackNominalNick(account);
                account.set_nickname_async(nominalNick);
            });
        this._nickTrackData.set(account, {tracker, contactsChangedId});
    }

    _untrackNominalNick(account) {
        let data = this._nickTrackData.get(account);
        if (!data)
            return;

        data.tracker.disconnect(data.contactsChangedId);
        this._nickTrackData.delete(account);
    }

    _ensureRetryData(account) {
        let data = this._retryData.get(account.object_path);
        if (data)
            return data;

        let params = account.getConnectionParams();
        let {server, account: accountName, port} = params;
        console.info(`Failed to connect to ${server} with username ${
            accountName}`);

        let accountServers = [];
        if (account.predefined)
            accountServers = account.getServers();

        data = {
            retry: 0,
            alternateServers: accountServers.filter(s => s.address !== server ||
                                                         s.port !== port),
        };
        this._retryData.set(account.object_path, data);
        return data;
    }

    _getTrimmedAccountName(account) {
        let params = account.getConnectionParams();
        return params.account.replace(/_+$/, '');
    }

    _restoreAccountName(account) {
        let accountName = this._getTrimmedAccountName(account);
        let params = {account: new GLib.Variant('s', accountName)};
        let asv = new GLib.Variant('a{sv}', params);
        account.update_parameters_vardict_async(asv, []);
    }

    async _retryWithParams(account, params) {
        await account.update_parameters_vardict_async(params, []);

        const presence = Tp.ConnectionPresenceType.AVAILABLE;
        const msg = account.requested_status_message;
        account.request_presence_async(presence, 'available', msg);
    }

    _retryNickRequest(account) {
        let retryData = this._ensureRetryData(account);

        if (retryData.retry++ >= MAX_RETRIES)
            return false;

        this._trackNominalNick(account);

        let oldParams = account.dup_parameters_vardict().deep_unpack();
        let nick = oldParams['account'].deep_unpack();

        console.info(`Retrying with nickname ${nick}_`);
        let params = {account: new GLib.Variant('s', `${nick}_`)};
        this._retryWithParams(account, new GLib.Variant('a{sv}', params));
        return true;
    }

    _retryServerRequest(account) {
        let retryData = this._ensureRetryData(account);

        let server = retryData.alternateServers.shift();
        if (!server)
            return false;

        console.info(`Retrying with ${server.address}:${server.port}`);
        let params = {
            server: new GLib.Variant('s', server.address),
            port: new GLib.Variant('u', server.port),
            'use-ssl': new GLib.Variant('b', server.ssl),
        };
        this._retryWithParams(account, new GLib.Variant('a{sv}', params));
        return true;
    }

    _onAccountStatusChanged(mon, account) {
        let status = account.connection_status;

        if (status === Tp.ConnectionStatus.CONNECTING)
            return;

        if (status === Tp.ConnectionStatus.DISCONNECTED) {
            let reason = account.connection_status_reason;

            if (reason === Tp.ConnectionStatusReason.NAME_IN_USE) {
                if (this._retryNickRequest(account))
                    return;
            }

            if (reason === Tp.ConnectionStatusReason.NETWORK_ERROR ||
                reason === Tp.ConnectionStatusReason.NONE_SPECIFIED) {
                if (this._retryServerRequest(account))
                    return;
            }

            if (reason !== Tp.ConnectionStatusReason.REQUESTED) {
                let strReason = Object.keys(Tp.ConnectionStatusReason)[reason];
                let name = account.display_name;
                console.info(`Account ${name} disconnected with reason ${
                    strReason}`);

                // Connection failed, keep tp from retrying over and over
                let presence = Tp.ConnectionPresenceType.OFFLINE;
                let msg = account.requested_status_message;
                account.request_presence_async(presence, 'offline', msg);
            }
        }

        this._restoreAccountName(account);
    }

    _onLeaveCurrentRoom() {
        let room = this.active_window.active_room;
        if (!room)
            return;
        let action = this.lookup_action('leave-room');
        action.activate(GLib.Variant.new('(ss)', [room.id, '']));
    }

    _onConnectAccount(action, parameter) {
        let accountPath = parameter.deep_unpack();
        let account = this._accountsMonitor.lookupAccount(accountPath);
        if (account)
            this._restoreAccountName(account);
        this._retryData.delete(accountPath);
    }

    _onToggleAction(action) {
        let state = action.get_state();
        action.change_state(GLib.Variant.new('b', !state.get_boolean()));
    }

    async _onRemoveConnection(action, parameter) {
        let accountPath = parameter.deep_unpack();
        let account = this._accountsMonitor.lookupAccount(accountPath);

        await account.set_enabled_async(false);
        this._removedAccounts.add(account);
        account.visible = false;

        const toast = new Adw.Toast({
            title: vprintf(_('%s removed.'), account.display_name),
            button_label: _('Undo'),
            action_name: 'app.undo-remove-connection',
            action_target: parameter,
        });
        toast.connect('dismissed', async () => {
            if (!this._removedAccounts.delete(account))
                return;

            await account.remove_async(); // TODO: Check for errors

            Utils.clearAccountPassword(account);
            Utils.clearIdentifyPassword(account);
        });
        this?.active_window.addToast(toast);
    }

    async _onUndoRemoveConnection(action, parameter) {
        const accountPath = parameter.deep_unpack();
        const account = this._accountsMonitor.lookupAccount(accountPath);

        this._removedAccounts.delete(account);
        await account.set_enabled_async(true);
        account.visible = true;
    }

    _onEditConnection(action, parameter) {
        let accountPath = parameter.deep_unpack();
        let account = this._accountsMonitor.lookupAccount(accountPath);
        const dialog = new Connections.ConnectionProperties(account);
        dialog.present(this.activeWindow);
    }

    _onStartClient() {
        if (this._telepathyClient)
            return;

        let params = {
            name: 'Polari',
            account_manager: this._accountsMonitor.accountManager,
            uniquify_name: this.isTestInstance,
        };
        this._telepathyClient = new TelepathyClient(params);
    }

    _onShowHelp() {
        Utils.openURL('help:polari');
    }

    _onShowAbout() {
        const [version] = pkg.version.split('-');
        const aboutDialog = Adw.AboutDialog.new_from_appdata(
            '/org/gnome/Polari/metainfo.xml', version);

        aboutDialog.set({
            developers: [
                'Florian Müllner <fmuellner@gnome.org>',
                'William Jon McCann <william.jon.mccann@gmail.com>',
                'Carlos Soriano <carlos.soriano89@gmail.com>',
                'Giovanni Campagna <gcampagna@src.gnome.org>',
                'Carlos Garnacho <carlosg@gnome.org>',
                'Jonas Danielsson <jonas.danielsson@threetimestwo.org>',
                'Bastian Ilsø <bastianilso@gnome.org>',
                'Kunaal Jain <kunaalus@gmail.com>',
                'Cody Welsh <codyw@protonmail.com>',
                'Isabella Ribeiro <belinhacbr@gmail.com>',
                'Jonas Danielsson <jonas@threetimestwo.org>',
                'Rares Visalom <rares.visalom@gmail.com>',
                'Danny Mølgaard <moelgaard.dmp@gmail.com>',
                'Justyn Temme <Justyntemme@gmail.com>',
                'unkemptArc99 <abhishekbhardwaj540@gmail.com>',
                'Oscar Shrimpton <oscar.shrimpton.personal@gmail.com>',
                'Daronion <stefanosdimos.98@gmail.com>',
                'Georges Basile Stavracas Neto <georges.stavracas@gmail.com>',
            ],
            artists: [
                'Sam Hewitt <hewittsamuel@gmail.com>',
                'Jakub Steiner <jimmac@gmail.com>',
                'Lapo Calamandrei <calamandrei@gmail.com>',
                'Tobias Bernard <tbernard@gnome.org>',
            ],
            designers: [
                'William Jon McCann <william.jon.mccann@gmail.com>',
                'Bastian Ilsø <bastianilso@gnome.org>',
                'Allan Day <allanpday@gmail.com>',
            ],
            translator_credits: _('translator-credits'),
        });

        aboutDialog.show();
        aboutDialog.present(this.activeWindow);
    }

    _onQuit() {
        if (this._windowRemovedId)
            this.disconnect(this._windowRemovedId);
        this._windowRemovedId = 0;

        this.get_windows().reverse().forEach(w => w.destroy());
        this.emit('prepare-shutdown');
    }
});
