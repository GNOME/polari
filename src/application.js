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
const TelepathyClient = imports.telepathyClient;
const Utils = imports.utils;
const NetworksManager = imports.networksManager;

const MAX_RETRIES = 3;

const IRC_SCHEMA_REGEX = /^(irc?:\/\/)([\da-z\.-]+):?(\d+)?\/(?:%23)?([\w\.\+-]+)/i;

const Application = new Lang.Class({
    Name: 'Application',
    Extends: Gtk.Application,
    Signals: { 'prepare-shutdown': {},
               'room-focus-changed': {} },

    _init: function() {
        this.parent({ application_id: 'org.gnome.Polari',
                      flags: Gio.ApplicationFlags.HANDLES_OPEN });

        GLib.set_application_name('Polari');
        this._window = null;
        this._retryData = new Map();
    },

    isRoomFocused: function(room) {
        return this.active_window &&
               this.active_window.is_active &&
               this.active_window.active_room == room;
    },

    vfunc_startup: function() {
        this.parent();

        let actionEntries = [
          { name: 'show-join-dialog',
            activate: Lang.bind(this, this._onShowJoinDialog),
            accels: ['<Primary>n'] },
          { name: 'join-room',
            activate: Lang.bind(this, this._onJoinRoom),
            parameter_type: GLib.VariantType.new('(ssu)') },
          { name: 'message-user',
            activate: Lang.bind(this, this._onMessageUser),
            parameter_type: GLib.VariantType.new('(sssu)') },
          { name: 'leave-room',
            parameter_type: GLib.VariantType.new('(ss)') },
          { name: 'leave-current-room',
            activate: Lang.bind(this, this._onLeaveCurrentRoom),
            create_hook: (a) => { a.enabled = false; },
            accels: ['<Primary>w'] },
          { name: 'authenticate-account',
            parameter_type: GLib.VariantType.new('(os)') },
          { name: 'connect-account',
            activate: Lang.bind(this, this._onConnectAccount),
            parameter_type: GLib.VariantType.new('o') },
          { name: 'reconnect-account',
            activate: Lang.bind(this, this._onConnectAccount),
            parameter_type: GLib.VariantType.new('o') },
          { name: 'user-list',
            activate: Lang.bind(this, this._onToggleAction),
            create_hook: Lang.bind(this, this._userListCreateHook),
            state: GLib.Variant.new('b', false),
            accels: ['F9', '<Primary>u'] },
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
          { name: 'help',
            activate: Lang.bind(this, this._onShowHelp),
            accels: ['F1'] },
          { name: 'about',
            activate: Lang.bind(this, this._onShowAbout) },
          { name: 'quit',
            activate: Lang.bind(this, this._onQuit),
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
        actionEntries.forEach(Lang.bind(this,
            function(actionEntry) {
                let props = {};
                ['name', 'state', 'parameter_type'].forEach(
                    function(prop) {
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
        }));

        for (let i = 1; i < 10; i++)
            this.set_accels_for_action('app.nth-room(%d)'.format(i), ['<Alt>' + i]);

        this._telepathyClient = null;

        this._roomManager = RoomManager.getDefault();
        this._accountsMonitor = AccountsMonitor.getDefault();
        this._networksManager = NetworksManager.getDefault();

        this._accountsMonitor.connect('account-status-changed',
                                      Lang.bind(this, this._onAccountStatusChanged));

        this.pasteManager = new PasteManager.PasteManager();
        this.notificationQueue = new AppNotifications.NotificationQueue();
        this.commandOutputQueue = new AppNotifications.CommandOutputQueue();
    },

    vfunc_activate: function() {
        if (!this._telepathyClient) {
            let params = {
                name: 'Polari',
                account_manager: this._accountsMonitor.accountManager,
                uniquify_name: false
            };
            this._telepathyClient = new TelepathyClient.TelepathyClient(params);
        }

        if (!this._window) {
            this._window = new MainWindow.MainWindow({ application: this });
            this._window.connect('destroy',
                                 () => { this.emit('prepare-shutdown'); });
            this._window.connect('notify::active-room',
                                 () => { this.emit('room-focus-changed'); });
            this._window.connect('notify::is-active',
                                 () => { this.emit('room-focus-changed'); });
            this._window.show_all();
        }
        this._window.present();
    },

    vfunc_window_added: function(window) {
        this.parent(window);

        let action = this.lookup_action('leave-current-room');
        window.connect('notify::active-room', () => {
            action.enabled = window.active_room != null;
        });
        action.enabled = window.active_room != null;

        window.connect('active-room-state-changed',
                       Lang.bind(this, this._updateUserListAction));
        this._updateUserListAction();
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
            this.notificationQueue.addNotification(n);
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

    _updateUserListAction: function() {
        let room = this.active_window.active_room;
        let action = this.lookup_action('user-list');
        action.enabled = room && room.type == Tp.HandleType.ROOM && room.channel;
    },

    _userListCreateHook: function(action) {
        action.connect('notify::enabled', function() {
            if (!action.enabled)
                action.change_state(GLib.Variant.new('b', false));
        });
        action.enabled = false;
    },

    _onShowJoinDialog: function() {
        this._window.showJoinRoomDialog();
    },

    _maybePresent: function(time) {
        let [present, ] = Tp.user_action_time_should_present(time);

        if (!this._window || present)
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
        Utils.debug('Failed to connect to %s with username %s'.format(server, accountName));

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

        Utils.debug('Retrying with nickname %s'.format(nick + '_'));
        let params = { account: new GLib.Variant('s', nick + '_') };
        this._retryWithParams(account, new GLib.Variant('a{sv}', params));
        return true;
    },

    _retryServerRequest: function(account) {
        let retryData = this._ensureRetryData(account);

        let server = retryData.alternateServers.shift();
        if (!server)
            return false;

        Utils.debug('Retrying with %s:%d'.format(server.address, server.port));
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
                Utils.debug('Account %s disconnected with reason %s'.format(
                            account.display_name, strReasons[reason]));
            }
        }

        this._restoreAccountName(account);
    },

    _onLeaveCurrentRoom: function() {
        let room = this._window.active_room;
        if (!room)
            return;
        let action = this.lookup_action('leave-room');
        action.activate(GLib.Variant.new('(ss)', [room.id, '']));
    },

    _onConnectAccount: function(action, parameter) {
        let accountPath = parameter.deep_unpack();
        let account = this._accountsMonitor.lookupAccount(accountPath);
        if (account)
            this._restoreAccountName(account);
        this._retryData.delete(accountPath);
    },

    _onToggleAction: function(action) {
        let state = action.get_state();
        action.change_state(GLib.Variant.new('b', !state.get_boolean()));
    },

    _onRemoveConnection: function(action, parameter){
        let accountPath = parameter.deep_unpack();
        let account = this._accountsMonitor.lookupAccount(accountPath);
        account.set_enabled_async(false, Lang.bind(this,
            function() {
                let label = _("%s removed.").format(account.display_name);
                let n = new AppNotifications.UndoNotification(label);
                this.notificationQueue.addNotification(n);

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
        dialog.transient_for = this._window;
        dialog.connect('response', Lang.bind(this,
            function(w, response) {
                w.destroy();
            }));
        dialog.show();
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
                'Sam Hewitt',
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

            transient_for: this._window,
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
        this._window.destroy();
    }
});
