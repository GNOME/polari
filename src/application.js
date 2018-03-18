const Gdk = imports.gi.Gdk;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;
const Polari = imports.gi.Polari;
const Tp = imports.gi.TelepathyGLib;

const {AccountsMonitor} = imports.accountsMonitor;
const AppNotifications = imports.appNotifications;
const Connections = imports.connections;
const {InitialSetupWindow} = imports.initialSetup;
const {MainWindow} = imports.mainWindow;
const {NetworksManager} = imports.networksManager;
const {PasteManager} = imports.pasteManager;
const {RoomManager} = imports.roomManager;
const {ServerRoomManager} = imports.serverRoomManager;
const {TelepathyClient} = imports.telepathyClient;
const {UserStatusMonitor} = imports.userTracker;
const Utils = imports.utils;

const MAX_RETRIES = 3;

const IRC_SCHEMA_REGEX = /^(irc?:\/\/)([\da-z\.-]+):?(\d+)?\/(?:%23)?([\w\.\+-]+)/i;

const AUTOSTART_DIR = GLib.get_user_config_dir() + '/autostart';
const AUTOSTART_FILE = '/org.gnome.Polari.Autostart.desktop';

var Application = GObject.registerClass({
    Signals: { 'prepare-shutdown': {},
               'room-focus-changed': {} },
}, class Application extends Gtk.Application {
    _init() {
        super._init({ application_id: 'org.gnome.Polari',
                      flags: Gio.ApplicationFlags.HANDLES_OPEN });

        GLib.set_application_name('Polari');
        GLib.set_prgname('org.gnome.Polari');
        this._retryData = new Map();
        this._nickTrackData = new Map();
        this._demons = [];

        this._windowRemovedId = 0;

        this.add_main_option('start-client', 0,
                             GLib.OptionFlags.NONE, GLib.OptionArg.NONE,
                             _("Start Telepathy client"), null);
        this.add_main_option('test-instance', 0,
                             GLib.OptionFlags.NONE, GLib.OptionArg.NONE,
                             _("Allow running alongside another instance"), null);
        this.add_main_option('version', 0,
                             GLib.OptionFlags.NONE, GLib.OptionArg.NONE,
                             _("Print version and exit"), null);
        this.connect('handle-local-options', (o, dict) => {
            let v = dict.lookup_value('test-instance', null);
            if (v && v.get_boolean())
                this._maybeMakeNonUnique();

            try {
                this.register(null);
            } catch(e) {
                return 1;
            }

            v = dict.lookup_value('start-client', null);
            if (v && v.get_boolean()) {
                this.activate_action('start-client', null);
                return 0;
            }

            v = dict.lookup_value('version', null);
            if (v && v.get_boolean()) {
                print("Polari %s".format(pkg.version));
                return 0;
            }

            return -1;
        });
    }

    isRoomFocused(room) {
        return this.active_window &&
               this.active_window['is-active'] &&
               this.active_window.active_room == room;
    }

    // Small wrapper to mark user-requested nick changes
    setAccountNick(account, nick) {
        account.set_nickname_async(nick, (a, res) => {
            account.set_nickname_finish(res);
        });
        this._untrackNominalNick(account);
    }

    _checkService(conn, name, opath, iface) {
        let flags = Gio.DBusProxyFlags.DO_NOT_LOAD_PROPERTIES |
                    Gio.DBusProxyFlags.DO_NOT_CONNECT_SIGNALS;
        let proxy = null;

        try {
            proxy = Gio.DBusProxy.new_sync(conn, flags, null,
                                           name, opath, iface, null);
        } catch(e) {}

        return proxy != null && proxy.get_name_owner() != null;
    }

    _ensureService(conn, name, opath, iface, command) {
        debug('Trying to ensure service %s'.format(name));

        if (this._checkService(conn, name, opath, iface))
            return;

        log('Failed to activate service %s, starting manually'.format(name));

        let proc = new Gio.Subprocess({ argv: [command] });

        try {
            proc.init(null);
            this._demons.push(proc);
        } catch(e) {
            log('Failed to launch %s: %s'.format(command, e.message));
        }
    }

    _maybeMakeNonUnique() {
        let bus = Gio.BusType.SESSION;
        let name = this.application_id;
        let flags = Gio.BusNameWatcherFlags.NONE;

        let handled = false;
        let id = Gio.bus_watch_name(bus, name, flags, () => {
                debug('Running as test instance alongside primary instance');
                this.set_flags(this.flags | Gio.ApplicationFlags.NON_UNIQUE);
                handled = true;
        }, () => {
            debug('No primary instance found, running normally');
            handled = true;
        });

        // Evil-ish ...
        let main = GLib.MainContext.default();
        while (!handled)
            main.iteration(true);
        Gio.bus_unwatch_name(id);
    }

    vfunc_dbus_register(conn, path) {
        if (!Utils.isFlatpakSandbox())
            return true;

        GLib.setenv('IDLE_PERSIST', '1', false);
        this._ensureService(conn,
                            Tp.ACCOUNT_MANAGER_BUS_NAME,
                            Tp.ACCOUNT_MANAGER_OBJECT_PATH,
                            Tp.ACCOUNT_MANAGER_BUS_NAME,
                            '/app/libexec/mission-control-5');
        this._ensureService(conn,
                            Tp.CM_BUS_NAME_BASE + 'idle',
                            Tp.CM_OBJECT_PATH_BASE + 'idle',
                            'org.freedesktop.Telepathy.ConnectionManager',
                            '/app/libexec/telepathy-idle');
        this._ensureService(conn,
                            Tp.CLIENT_BUS_NAME_BASE + 'Logger',
                            Tp.CLIENT_OBJECT_PATH_BASE + 'Logger',
                            Tp.IFACE_CLIENT,
                            '/app/libexec/telepathy-logger');
        return true;
    }

    vfunc_dbus_unregister(conn, path) {
        for (let proc of this._demons)
            proc.force_exit();
        this._demons = [];
    }

    vfunc_startup() {
        super.vfunc_startup();

        let actionEntries = [
          { name: 'show-join-dialog',
            activate: this._onShowJoinDialog.bind(this),
            accels: ['<Primary>n'] },
          { name: 'join-room',
            activate: this._onJoinRoom.bind(this),
            parameter_type: GLib.VariantType.new('(ssu)') },
          { name: 'message-user',
            activate: this._onMessageUser.bind(this),
            parameter_type: GLib.VariantType.new('(sssu)') },
          { name: 'leave-room',
            parameter_type: GLib.VariantType.new('(ss)') },
          { name: 'leave-current-room',
            activate: this._onLeaveCurrentRoom.bind(this),
            create_hook: (a) => { a.enabled = false; },
            accels: ['<Primary>w'] },
          { name: 'authenticate-account',
            parameter_type: GLib.VariantType.new('(os)') },
          { name: 'connect-account',
            activate: this._onConnectAccount.bind(this),
            parameter_type: GLib.VariantType.new('o') },
          { name: 'disconnect-account',
            activate: this._onConnectAccount.bind(this),
            parameter_type: GLib.VariantType.new('o') },
          { name: 'reconnect-account',
            activate: this._onConnectAccount.bind(this),
            parameter_type: GLib.VariantType.new('o') },
          { name: 'user-list',
            activate: this._onToggleAction.bind(this),
            create_hook: this._userListCreateHook.bind(this),
            state: GLib.Variant.new('b', false),
            accels: ['F9', '<Primary>u'] },
          { name: 'remove-connection',
            activate: this._onRemoveConnection.bind(this),
            parameter_type: GLib.VariantType.new('o') },
          { name: 'edit-connection',
            activate: this._onEditConnection.bind(this),
            parameter_type: GLib.VariantType.new('o') },
          { name: 'save-identify-password',
            parameter_type: GLib.VariantType.new('o') },
          { name: 'discard-identify-password',
            parameter_type: GLib.VariantType.new('o') },
          { name: 'show-emoji-picker',
            accels: ['<Primary>e'] },
          { name: 'start-client',
            activate: this._onStartClient.bind(this) },
          { name: 'help',
            activate: this._onShowHelp.bind(this),
            accels: ['F1'] },
          { name: 'about',
            activate: this._onShowAbout.bind(this) },
          { name: 'quit',
            activate: this._onQuit.bind(this),
            accels: ['<Primary>q'] },
          { name: 'next-room',
            accels: ['<Primary>Page_Down', '<Alt>Down'] },
          { name: 'previous-room',
            accels: ['<Primary>Page_Up', '<Alt>Up'] },
          { name: 'first-room',
            accels: ['<Primary>Home'] },
          { name: 'last-room',
            accels: ['<Primary>End'] },
          { name: 'nth-room',
            parameter_type: GLib.VariantType.new('i') },
          { name: 'next-pending-room',
            accels: ['<Alt><Shift>Down', '<Primary><Shift>Page_Down']},
          { name: 'previous-pending-room',
            accels: ['<Alt><Shift>Up', '<Primary><Shift>Page_Up']}
        ];
        actionEntries.forEach(actionEntry => {
            let props = {};
            ['name', 'state', 'parameter_type'].forEach(prop => {
                if (actionEntry[prop])
                    props[prop] = actionEntry[prop];
            });
            let action = new Gio.SimpleAction(props);
            if (actionEntry.create_hook)
                actionEntry.create_hook(action);
            if (actionEntry.activate)
                action.connect('activate', actionEntry.activate);
            if (actionEntry.change_state)
                action.connect('change-state', actionEntry.change_state);
            if (actionEntry.accels)
                this.set_accels_for_action('app.' + actionEntry.name,
                                           actionEntry.accels);
            this.add_action(action);
        });

        this._settings = new Gio.Settings({ schema_id: 'org.gnome.Polari' });
        let action = this._settings.create_action('run-in-background');
        this.add_action(action);

        this._settings.connect('changed::run-in-background',
                               this._onRunInBackgroundChanged.bind(this));
        this._onRunInBackgroundChanged();

        for (let i = 1; i < 10; i++)
            this.set_accels_for_action('app.nth-room(%d)'.format(i), ['<Alt>' + i]);

        this._telepathyClient = null;

        this._roomManager = RoomManager.getDefault();
        this._accountsMonitor = AccountsMonitor.getDefault();
        this._userStatusMonitor = UserStatusMonitor.getDefault();
        this._networksManager = NetworksManager.getDefault();

        if (!Gio.NetworkMonitor.get_default().get_network_metered())
            this._serverRoomManager = ServerRoomManager.getDefault();

        this._accountsMonitor.connect('account-status-changed',
                                      this._onAccountStatusChanged.bind(this));
        this._accountsMonitor.connect('account-added', (am, account) => {
            // Reset nickname at startup
            let accountName = this._getTrimmedAccountName(account);
            account.set_nickname_async(accountName, (a, res) => {
                a.set_nickname_finish(res);
            });
        });
        this._accountsMonitor.connect('account-removed', (am, account) => {
            // Make sure we don't 'inject' outdated data into
            // a new account with the same ID
            this._retryData.delete(account.object_path);
        });

        this.pasteManager = new PasteManager();
        this.notificationQueue = new AppNotifications.NotificationQueue();
        this.commandOutputQueue = new AppNotifications.CommandOutputQueue();

        let provider = new Gtk.CssProvider();
        let uri = 'resource:///org/gnome/Polari/css/application.css';
        let file = Gio.File.new_for_uri(uri);
        try {
            provider.load_from_file(Gio.File.new_for_uri(uri));
        } catch(e) {
            logError(e, "Failed to add application style");
        }
        Gtk.StyleContext.add_provider_for_screen(Gdk.Screen.get_default(),
                                                 provider,
                                                 Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
    }

    vfunc_activate() {
        this.activate_action('start-client', null);

        if (!this.active_window) {
            if (this._needsInitialSetup()) {
                let setupDialog = new InitialSetupWindow({ application: this });
                this._windowRemovedId = this.connect('window-removed', () => {
                    this.disconnect(this._windowRemovedId);
                    this._windowRemovedId = 0;
                    this.activate();
                });
            } else {
                let window = new MainWindow({ application: this });
                window.connect('destroy', () => {
                    if (this._settings.get_boolean('run-in-background'))
                        return;
                    this.emit('prepare-shutdown');
                });
                window.connect('notify::active-room',
                               () => { this.emit('room-focus-changed'); });
                window.connect('notify::is-active',
                               () => { this.emit('room-focus-changed'); });
            }
        }

        this.active_window.present();
    }

    vfunc_window_added(window) {
        super.vfunc_window_added(window);

        if (!(window instanceof MainWindow))
            return;

        let action = this.lookup_action('leave-current-room');
        window.connect('notify::active-room', () => {
            action.enabled = window.active_room != null;
        });
        action.enabled = window.active_room != null;

        window.connect('active-room-state-changed',
                       this._updateUserListAction.bind(this));
        this._updateUserListAction();
    }

    vfunc_open(files) {
        this.activate();

        let time = Utils.getTpEventTime();
        let uris = files.map(f => f.get_uri());

        this._accountsMonitor.prepare(() => {
            this._openURIs(uris, time);
        });
    }

    _openURIs(uris, time) {
        let map = {};

        this._accountsMonitor.visibleAccounts.forEach(a => {
            let params = a.dup_parameters_vardict().deep_unpack();
            map[a.get_object_path()] = {
                server: params.server.deep_unpack(),
                service: a.service
            };
        });

        let joinAction = this.lookup_action('join-room');
        uris.forEach(uri => {
            let [success, server, port, room] = this._parseURI(uri);
            if (!success)
                return;

            let matchedId = this._networksManager.findByServer(server);
            let matches = Object.keys(map).filter(a => {
                return GLib.ascii_strcasecmp(map[a].server, server) == 0 ||
                       map[a].service == matchedId;
            });

            if (matches.length)
                joinAction.activate(new GLib.Variant('(ssu)',
                                [matches[0], '#' + room, time]));
            else
                this._createAccount(matchedId, server, port, a => {
                    if (a)
                        joinAction.activate(new GLib.Variant('(ssu)',
                                            [a.get_object_path(),
                                             '#' + room, time]));
                });
        });
    }

    _parseURI(uri) {
        let server, port, room;
        let success = false;
        try {
            [,, server, port, room] = uri.match(IRC_SCHEMA_REGEX);
            success = true;
        } catch(e) {
            let label = _("Failed to open link");
            let n = new AppNotifications.MessageNotification(label,
                                                             'dialog-error-symbolic');
            this.notificationQueue.addNotification(n);
        }

        return [success, server, port, room];
    }

    _createAccount(id, server, port, callback) {
        let params, name;

        if (id) {
            params = this._networksManager.getNetworkDetails(id);
            name = this._networksManager.getNetworkName(id);
        } else {
            params = {
                'account': new GLib.Variant('s', GLib.get_user_name()),
                'server': new GLib.Variant('s', server),
                'port': new GLib.Variant('u', port ? port : 6667),
                'use-ssl': new GLib.Variant('b', (port == 6697)),
            };
            name = server;
        }

        let req = new Tp.AccountRequest({ account_manager: Tp.AccountManager.dup(),
                                          connection_manager: 'idle',
                                          protocol: 'irc',
                                          display_name: name });
        req.set_enabled(true);

        if (id)
            req.set_service(id);

        for (let prop in params)
            req.set_parameter(prop, params[prop]);

        req.create_account_async((r, res) => {
            let account = req.create_account_finish(res);
            callback(account);
        });
    }

    _touchFile(file) {
        try {
            file.get_parent().make_directory_with_parents(null);
        } catch(e if e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS)) {
            // not an error, carry on
        }

        let stream = file.create(0, null);
        stream.close(null);
    }

    _needsInitialSetup() {
        if (GLib.getenv('POLARI_FORCE_INITIAL_SETUP')) {
            GLib.unsetenv('POLARI_FORCE_INITIAL_SETUP');
            return true;
        }

        let f = Gio.File.new_for_path(GLib.get_user_cache_dir() +
                                      '/polari/initial-setup-completed');
        try {
            this._touchFile(f);
        } catch(e) {
            if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
                return false; // initial setup has completed
            log('Failed to mark initial setup as completed: ' + e.message);
        }

        let savedRooms = this._settings.get_value('saved-channel-list');
        return savedRooms.n_children() == 0;
    }

    get isTestInstance() {
        return this.flags & Gio.ApplicationFlags.NON_UNIQUE;
    }

    _updateUserListAction() {
        let room = this.active_window.active_room;
        let action = this.lookup_action('user-list');
        action.enabled = room && room.type == Tp.HandleType.ROOM && room.channel;
    }

    _userListCreateHook(action) {
        action.connect('notify::enabled', () => {
            if (!action.enabled)
                action.change_state(GLib.Variant.new('b', false));
        });
        action.enabled = false;
    }

    _onShowJoinDialog() {
        this.active_window.showJoinRoomDialog();
    }

    _maybePresent(time) {
        let [present, ] = Tp.user_action_time_should_present(time);

        if (!this.active_window || present)
            this.activate();
    }

    _onJoinRoom(action, parameter) {
        let [accountPath, channelName, time] = parameter.deep_unpack();
        this._maybePresent(time);
    }

    _onMessageUser(action, parameter) {
        let [accountPath, contactName, message, time] = parameter.deep_unpack();
        this._maybePresent(time);
    }

    _trackNominalNick(account) {
        if (this._nickTrackData.has(account))
            return;

        let nominalNick = this._getTrimmedAccountName(account);
        let baseNick = Polari.util_get_basenick(nominalNick);

        let tracker = this._userStatusMonitor.getUserTrackerForAccount(account);
        let contactsChangedId = tracker.connect('contacts-changed::' + baseNick,
            (t, nick) => {
                if (nick != nominalNick)
                    return;

                let contact = tracker.lookupContact(nick);
                if (contact != null && contact.alias == nick)
                    return;

                this._untrackNominalNick(account);
                account.set_nickname_async(nominalNick, (a, res) => {
                    a.set_nickname_finish(res);
                });
            });
        this._nickTrackData.set(account, { tracker, contactsChangedId });
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

        let params = Connections.getAccountParams(account);
        let server = params['server'];
        let accountName = params['account'];
        let port = params['port'];
        debug('Failed to connect to %s with username %s'.format(server, accountName));

        let accountServers = [];
        if (this._networksManager.getAccountIsPredefined(account))
            accountServers = this._networksManager.getNetworkServers(account.service);

        data = {
            retry: 0,
            alternateServers: accountServers.filter(s => s.address != server ||
                                                         s.port != port)
        };
        this._retryData.set(account.object_path, data);
        return data;
    }

    _getTrimmedAccountName(account) {
        let params = Connections.getAccountParams(account);
        return params.account.replace(/_+$/, '');
    }

    _restoreAccountName(account) {
        let accountName = this._getTrimmedAccountName(account);
        let params = { account: new GLib.Variant('s', accountName) };
        let asv = new GLib.Variant('a{sv}', params);
        account.update_parameters_vardict_async(asv, [], null);
    }

    _retryWithParams(account, params) {
        account.update_parameters_vardict_async(params, [], () => {
            let presence = Tp.ConnectionPresenceType.AVAILABLE;
            let msg = account.requested_status_message;
            account.request_presence_async(presence, 'available', msg, null);
        });
    }

    _retryNickRequest(account) {
        let retryData = this._ensureRetryData(account);

        if (retryData.retry++ >= MAX_RETRIES)
            return false;

        this._trackNominalNick(account);

        let oldParams = account.dup_parameters_vardict().deep_unpack();
        let nick = oldParams['account'].deep_unpack();

        debug('Retrying with nickname %s'.format(nick + '_'));
        let params = { account: new GLib.Variant('s', nick + '_') };
        this._retryWithParams(account, new GLib.Variant('a{sv}', params));
        return true;
    }

    _retryServerRequest(account) {
        let retryData = this._ensureRetryData(account);

        let server = retryData.alternateServers.shift();
        if (!server)
            return false;

        debug('Retrying with %s:%d'.format(server.address, server.port));
        let params = { server: new GLib.Variant('s', server.address),
                       port: new GLib.Variant('u', server.port),
                       'use-ssl': new GLib.Variant('b', server.ssl) };
        this._retryWithParams(account, new GLib.Variant('a{sv}', params));
        return true;
    }

    _onAccountStatusChanged(mon, account) {
        let status = account.connection_status;

        if (status == Tp.ConnectionStatus.CONNECTING)
            return;

        if (status == Tp.ConnectionStatus.DISCONNECTED) {
            let reason = account.connection_status_reason;

            if (reason == Tp.ConnectionStatusReason.NAME_IN_USE)
                if (this._retryNickRequest(account))
                    return;

            if (reason == Tp.ConnectionStatusReason.NETWORK_ERROR ||
                reason == Tp.ConnectionStatusReason.NONE_SPECIFIED)
                if (this._retryServerRequest(account))
                    return;

            if (reason != Tp.ConnectionStatusReason.REQUESTED) {
                let strReasons = Object.keys(Tp.ConnectionStatusReason);
                debug('Account %s disconnected with reason %s'.format(
                      account.display_name, strReasons[reason]));

                // Connection failed, keep tp from retrying over and over
                let presence = Tp.ConnectionPresenceType.OFFLINE;
                let msg = account.requested_status_message;
                account.request_presence_async(presence, 'offline', msg, null);
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

    _onRemoveConnection(action, parameter) {
        let accountPath = parameter.deep_unpack();
        let account = this._accountsMonitor.lookupAccount(accountPath);

        account.set_enabled_async(false, (o, res) => {
            account.set_enabled_finish(res);
            account.visible = false;

            let label = _("%s removed.").format(account.display_name);
            let n = new AppNotifications.UndoNotification(label);
            this.notificationQueue.addNotification(n);

            n.connect('closed', () => {
                account.remove_async((a, res) => {
                    a.remove_finish(res); // TODO: Check for errors
                });
            });
            n.connect('undo', () => {
                account.set_enabled_async(true, (o, res) => {
                  account.set_enabled_finish(res);
                  account.visible = true;
                });
            });
        });
    }

    _onEditConnection(action, parameter) {
        let accountPath = parameter.deep_unpack();
        let account = this._accountsMonitor.lookupAccount(accountPath);
        let dialog = new Connections.ConnectionProperties(account);
        dialog.transient_for = this.active_window;
        dialog.connect('response', (w, reponse) => {
            w.destroy();
        });
        dialog.show();
    }

    _createLink(file, target) {
        try {
            file.get_parent().make_directory_with_parents(null);
        } catch(e if e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS)) {
            // not an error, carry on
        }

        file.make_symbolic_link(target, null);
    }

    _onRunInBackgroundChanged() {
        let file = Gio.File.new_for_path(AUTOSTART_DIR + AUTOSTART_FILE);

        if (this._settings.get_boolean('run-in-background'))
            try {
                this._createLink(file, pkg.pkgdatadir + AUTOSTART_FILE);
            } catch(e) {
                if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
                    log('Failed to create autostart link: ' + e.message);
            }
        else
            try {
                file.delete(null);
            } catch(e) {
                if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                    log('Failed to remove autostart link: ' + e.message);
            }
    }

    _onStartClient() {
        if (this._telepathyClient)
            return;

        let params = {
            name: 'Polari',
            account_manager: this._accountsMonitor.accountManager,
            uniquify_name: this.isTestInstance
        };
        this._telepathyClient = new TelepathyClient(params);
    }

    _onShowHelp() {
        Utils.openURL('help:org.gnome.Polari', Gtk.get_current_event_time());
    }

    _onShowAbout() {
        if (this._aboutDialog) {
            this._aboutDialog.present();
            return;
        }
        let aboutParams = {
            authors: [
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
                'unkemptArc99 <abhishekbhardwaj540@gmail.com>'
            ],
            artists: [
                'Sam Hewitt <hewittsamuel@gmail.com>',
                'Jakub Steiner <jimmac@gmail.com>',
                'Lapo Calamandrei <calamandrei@gmail.com>'
            ],
            translator_credits: _("translator-credits"),
            comments: _("An Internet Relay Chat Client for GNOME"),
            copyright: 'Copyright © 2013-2018 The Polari authors',
            license_type: Gtk.License.GPL_2_0,
            logo_icon_name: 'org.gnome.Polari',
            version: pkg.version,
            website_label: _("Learn more about Polari"),
            website: 'https://wiki.gnome.org/Apps/Polari',

            transient_for: this.active_window,
            modal: true
        };

        this._aboutDialog = new Gtk.AboutDialog(aboutParams);
        this._aboutDialog.show();
        this._aboutDialog.connect('response', () => {
            this._aboutDialog.destroy();
            this._aboutDialog = null;
        });
    }

    _onQuit() {
        if (this._windowRemovedId)
            this.disconnect(this._windowRemovedId);
        this._windowRemovedId = 0;

        this.get_windows().reverse().forEach(w => { w.destroy(); });
        this.emit('prepare-shutdown');
    }
});
