const Gdk = imports.gi.Gdk;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Gtk = imports.gi.Gtk;
const Polari = imports.gi.Polari;
const Tp = imports.gi.TelepathyGLib;

const AccountsMonitor = imports.accountsMonitor;
const AppNotifications = imports.appNotifications;
const Connections = imports.connections;
const Lang = imports.lang;
const MainWindow = imports.mainWindow;
const PasteManager = imports.pasteManager;
const RoomManager = imports.roomManager;
const ServerRoomManager = imports.serverRoomManager;
const TelepathyClient = imports.telepathyClient;
const UserTracker = imports.userTracker;
const Utils = imports.utils;
const NetworksManager = imports.networksManager;

const MAX_RETRIES = 3;

const IRC_SCHEMA_REGEX = /^(irc?:\/\/)([\da-z\.-]+):?(\d+)?\/(?:%23)?([\w\.\+-]+)/i;

const AUTOSTART_DIR = GLib.get_user_config_dir() + '/autostart';
const AUTOSTART_FILE = '/org.gnome.Polari.Autostart.desktop';

const Application = new Lang.Class({
    Name: 'Application',
    Extends: Gtk.Application,
    Signals: { 'room-attached': { param_types: [Polari.Room.$gtype] },
               'room-detached': { param_types: [Polari.Room.$gtype] },
               'prepare-shutdown': {},
               'room-focus-changed': {} },

    _init: function() {
        this.parent({ application_id: 'org.gnome.Polari',
                      flags: Gio.ApplicationFlags.HANDLES_OPEN });

        GLib.set_application_name('Polari');
        GLib.set_prgname('org.gnome.Polari');
        this._retryData = new Map();
        this._demons = [];

        this.add_main_option('start-client', 0,
                             GLib.OptionFlags.NONE, GLib.OptionArg.NONE,
                             _("Start Telepathy client"), null);
        this.connect('handle-local-options', (o, dict) => {
            try {
                this.register(null);
            } catch(e) {
                return 1;
            }

            let v = dict.lookup_value('start-client', null);
            if (v && v.get_boolean()) {
                this.activate_action('start-client', null);
                return 0;
            }

            return -1;
        });
    },

    isRoomFocused: function(room) {
        return this.active_window &&
               this.active_window.is_active &&
               this.active_window.active_room == room;
    },

    _checkService: function(conn, name, opath, iface) {
        let flags = Gio.DBusProxyFlags.DO_NOT_LOAD_PROPERTIES |
                    Gio.DBusProxyFlags.DO_NOT_CONNECT_SIGNALS;
        let proxy = null;

        try {
            proxy = Gio.DBusProxy.new_sync(conn, flags, null,
                                           name, opath, iface, null);
        } catch(e) {}

        return proxy != null && proxy.get_name_owner() != null;
    },

    _ensureService: function(conn, name, opath, iface, command) {
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
    },

    vfunc_dbus_register: function(conn, path) {
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
    },

    vfunc_dbus_unregister: function(conn, path) {
        for (let proc of this._demons)
            proc.force_exit();
        this._demons = [];
    },

    get active_main_window() {
        return this.get_windows().filter(w => !w.single_room).shift();
    },

    vfunc_startup: function() {
        this.parent();

        let actionEntries = [
          { name: 'join-room',
            activate: Lang.bind(this, this._onJoinRoom),
            parameter_type: GLib.VariantType.new('(ssu)') },
          { name: 'message-user',
            activate: Lang.bind(this, this._onMessageUser),
            parameter_type: GLib.VariantType.new('(sssu)') },
          { name: 'leave-room',
            parameter_type: GLib.VariantType.new('(ss)') },
          { name: 'authenticate-account',
            parameter_type: GLib.VariantType.new('(os)') },
          { name: 'connect-account',
            activate: Lang.bind(this, this._onConnectAccount),
            parameter_type: GLib.VariantType.new('o') },
          { name: 'reconnect-account',
            activate: Lang.bind(this, this._onConnectAccount),
            parameter_type: GLib.VariantType.new('o') },
          { name: 'remove-connection',
            activate: Lang.bind(this, this._onRemoveConnection),
            parameter_type: GLib.VariantType.new('o') },
          { name: 'edit-connection',
            activate: Lang.bind(this, this._onEditConnection),
            parameter_type: GLib.VariantType.new('o') },
          { name: 'save-identify-password',
            parameter_type: GLib.VariantType.new('o') },
          { name: 'discard-identify-password',
            parameter_type: GLib.VariantType.new('o') },
          { name: 'start-client',
            activate: Lang.bind(this, this._onStartClient) },
          { name: 'new-window',
            activate: Lang.bind(this, this._onNewWindow) },
          { name: 'open-in-window',
            parameter_type: GLib.VariantType.new('s'),
            activate: Lang.bind(this, this._onOpenInWindow) },
          { name: 'help',
            activate: Lang.bind(this, this._onShowHelp),
            accels: ['F1'] },
          { name: 'about',
            activate: Lang.bind(this, this._onShowAbout) },
          { name: 'quit',
            activate: Lang.bind(this, this._onQuit),
            accels: ['<Primary>q'] }
        ];
        Utils.addActionEntries(this, 'app', actionEntries);

        this._settings = new Gio.Settings({ schema_id: 'org.gnome.Polari' });
        let action = this._settings.create_action('run-in-background');
        this.add_action(action);

        this._settings.connect('changed::run-in-background',
                               Lang.bind(this, this._onRunInBackgroundChanged));
        this._onRunInBackgroundChanged();

        for (let i = 1; i < 10; i++)
            this.set_accels_for_action('win.nth-room(%d)'.format(i), ['<Alt>' + i]);

        this._telepathyClient = null;

        this._roomManager = RoomManager.getDefault();
        this._accountsMonitor = AccountsMonitor.getDefault();
        this._userStatusMonitor = UserTracker.getUserStatusMonitor();
        this._networksManager = NetworksManager.getDefault();
        this._serverRoomManager = ServerRoomManager.getDefault();

        this._accountsMonitor.connect('account-status-changed',
                                      Lang.bind(this, this._onAccountStatusChanged));

        this.pasteManager = new PasteManager.PasteManager();

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
    },

    vfunc_activate: function() {
        this.activate_action('start-client', null);

        if (!this.active_window) {
            let window = new MainWindow.MainWindow({ application: this });
            window.connect('notify::active-room',
                           () => { this.emit('room-focus-changed'); });
            window.connect('notify::is-active',
                           () => { this.emit('room-focus-changed'); });
            window.show_all();
        }
        this.active_window.present();
    },

    vfunc_window_removed: function(window) {
        this.parent(window);

        if (this._settings.get_boolean('run-in-background') || this.active_window)
            return;
        this.emit('prepare-shutdown');
    },

    vfunc_open: function(files) {
        this.activate();

        let time = Utils.getTpEventTime();
        let uris = files.map(function(f) { return f.get_uri(); });

        this._accountsMonitor.prepare(() => {
            this._openURIs(uris, time);
        });
    },

    _openURIs: function(uris, time) {
        let map = {};

        this._accountsMonitor.enabledAccounts.forEach(a => {
            let params = a.dup_parameters_vardict().deep_unpack();
            map[a.get_object_path()] = {
                server: params.server.deep_unpack(),
                service: a.service
            };
        });

        let joinAction = this.lookup_action('join-room');
        uris.forEach(Lang.bind(this, function(uri) {
            let [success, server, port, room] = this._parseURI(uri);
            if (!success)
                return;

            let matchedId = this._networksManager.findByServer(server);
            let matches = Object.keys(map).filter(function(a) {
                return GLib.ascii_strcasecmp(map[a].server, server) == 0 ||
                       map[a].service == matchedId;
            });

            if (matches.length)
                joinAction.activate(new GLib.Variant('(ssu)',
                                [matches[0], '#' + room, time]));
            else
                this._createAccount(matchedId, server, port,
                    function(a) {
                        if (a)
                            joinAction.activate(new GLib.Variant('(ssu)',
                                            [a.get_object_path(),
                                             '#' + room, time]));
                    });
        }));
    },

    _parseURI: function(uri) {
        let server, port, room;
        let success = false;
        try {
            [,, server, port, room] = uri.match(IRC_SCHEMA_REGEX);
            success = true;
        } catch(e) {
            let label = _("Failed to open link");
            let n = new AppNotifications.MessageNotification(label,
                                                             'dialog-error-symbolic');
            this.active_window.notificationQueue.addNotification(n);
        }

        return [success, server, port, room];
    },

    _createAccount: function(id, server, port, callback) {
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

        req.create_account_async(Lang.bind(this,
            function(r, res) {
                let account = req.create_account_finish(res);
                callback(account);
            }));
    },

    _maybePresent: function(time) {
        let [present, ] = Tp.user_action_time_should_present(time);

        if (!this.active_window || present)
            this.activate();
    },

    _onJoinRoom: function(action, parameter) {
        let [accountPath, channelName, time] = parameter.deep_unpack();
        this._maybePresent(time);
    },

    _onMessageUser: function(action, parameter) {
        let [accountPath, contactName, message, time] = parameter.deep_unpack();
        this._maybePresent(time);
    },

    _ensureRetryData: function(account) {
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
            originalAccountName: accountName,
            alternateServers: accountServers.filter(s => s.address != server ||
                                                         s.port != port)
        };
        this._retryData.set(account.object_path, data);
        return data;
    },

    _restoreAccountName: function(account) {
        let data = this._retryData.get(account.object_path);
        if (!data || !data.retry || !data.originalAccountName)
            return;

        let params = { account: new GLib.Variant('s', data.originalAccountName) };
        let asv = new GLib.Variant('a{sv}', params);
        account.update_parameters_vardict_async(asv, [], null);
        delete data.originalAccountName;
    },

    _retryWithParams: function(account, params) {
        account.update_parameters_vardict_async(params, [], () => {
            let presence = Tp.ConnectionPresenceType.AVAILABLE;
            let msg = account.requested_status_message;
            account.request_presence_async(presence, 'available', msg, null);
        });
    },

    _retryNickRequest: function(account) {
        let retryData = this._ensureRetryData(account);

        if (retryData.retry++ >= MAX_RETRIES)
            return false;

        let oldParams = account.dup_parameters_vardict().deep_unpack();
        let nick = oldParams['account'].deep_unpack();

        debug('Retrying with nickname %s'.format(nick + '_'));
        let params = { account: new GLib.Variant('s', nick + '_') };
        this._retryWithParams(account, new GLib.Variant('a{sv}', params));
        return true;
    },

    _retryServerRequest: function(account) {
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
    },

    _onAccountStatusChanged: function(mon, account) {
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
            }
        }

        this._restoreAccountName(account);
    },

    _onConnectAccount: function(action, parameter) {
        let accountPath = parameter.deep_unpack();
        let account = this._accountsMonitor.lookupAccount(accountPath);
        if (account)
            this._restoreAccountName(account);
        this._retryData.delete(accountPath);
    },

    _onRemoveConnection: function(action, parameter){
        let accountPath = parameter.deep_unpack();
        let account = this._accountsMonitor.lookupAccount(accountPath);
        account.set_enabled_async(false, Lang.bind(this,
            function() {
                let label = _("%s removed.").format(account.display_name);
                let n = new AppNotifications.UndoNotification(label);
                this.active_window.notificationQueue.addNotification(n);

                n.connect('closed', function() {
                    account.remove_async(function(a, res) {
                        a.remove_finish(res); // TODO: Check for errors
                    });
                });
                n.connect('undo', function() {
                    account.set_enabled_async(true, function(a, res) {
                        a.set_enabled_finish(res); // TODO: Check for errors
                    });
                });
            }));
    },

    _onEditConnection: function(action, parameter) {
        let accountPath = parameter.deep_unpack();
        let account = this._accountsMonitor.lookupAccount(accountPath);
        let dialog = new Connections.ConnectionProperties(account);
        dialog.transient_for = this.active_window;
        dialog.connect('response', Lang.bind(this,
            function(w, response) {
                w.destroy();
            }));
        dialog.show();
    },

    _onNewWindow: function() {
        let activeRoom = this.active_window.active_room;
        let window = new MainWindow.MainWindow({ application: this,
                                                 active_room: activeRoom });
        window.present();
    },

    _createLink: function(file, target) {
        try {
            file.get_parent().make_directory_with_parents(null);
        } catch(e if e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS)) {
            // not an error, carry on
        }

        file.make_symbolic_link(target, null);
    },

    _onRunInBackgroundChanged: function() {
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
    },

    _onStartClient: function() {
        if (this._telepathyClient)
            return;

        let params = {
            name: 'Polari',
            account_manager: this._accountsMonitor.accountManager,
            uniquify_name: false
        };
        this._telepathyClient = new TelepathyClient.TelepathyClient(params);
    },

    _onOpenInWindow: function(action, param) {
        let [roomId] = param.get_string();
        let room = this._chatroomManager.getRoomById(roomId);
        if (!room)
            return;
        let window = new MainWindow.MainWindow({ application: this,
                                                 active_room: room,
                                                 single_room: true });
        window.connect('destroy', () => { this.emit('room-attached', room); });
        this.emit('room-detached', room);

        window.present();
    },

    _onShowHelp: function() {
        Utils.openURL('help:org.gnome.Polari', Gtk.get_current_event_time());
    },

    _onShowAbout: function() {
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
                'Danny Mølgaard <moelgaard.dmp@gmail.com>'
            ],
            artists: [
                'Sam Hewitt <hewittsamuel@gmail.com>',
                'Jakub Steiner <jimmac@gmail.com>'
            ],
            translator_credits: _("translator-credits"),
            comments: _("An Internet Relay Chat Client for GNOME"),
            copyright: 'Copyright © 2013-2015 The Polari authors',
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
        this._aboutDialog.connect('response', Lang.bind(this, function() {
            this._aboutDialog.destroy();
            this._aboutDialog = null;
        }));
    },

    _onQuit: function() {
        this.get_windows().reverse().forEach(w => { w.destroy(); });
        this.emit('prepare-shutdown');
    }
});
