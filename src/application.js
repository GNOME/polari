const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Gtk = imports.gi.Gtk;
const Polari = imports.gi.Polari;
const Tp = imports.gi.TelepathyGLib;

const AccountsMonitor = imports.accountsMonitor;
const AppNotifications = imports.appNotifications;
const ChatroomManager = imports.chatroomManager;
const Config = imports.config;
const Connections = imports.connections;
const Format = imports.format;
const Gettext = imports.gettext;
const Lang = imports.lang;
const MainWindow = imports.mainWindow;
const PasteManager = imports.pasteManager;
const Utils = imports.utils;


const MAX_RETRIES = 3;

const TP_ERROR_PREFIX = 'org.freedesktop.Telepathy.Error.'
const TP_ERROR_ALREADY_CONNECTED = TP_ERROR_PREFIX + 'AlreadyConnected';

const Application = new Lang.Class({
    Name: 'Application',
    Extends: Gtk.Application,

    _init: function() {
        this.parent({ application_id: 'org.gnome.Polari' });

        Gettext.bindtextdomain('polari', Config.LOCALE_DIR);
        Gettext.textdomain('polari');
        GLib.set_prgname('polari');
        GLib.set_application_name('Polari');
        this._window = null;
    },

    vfunc_startup: function() {
        this.parent();
        String.prototype.format = Format.format;

        window._ = Gettext.gettext;
        window.C_ = Gettext.pgettext;
        window.ngettext = Gettext.ngettext;

        Gtk.init(null);

        let w = new Polari.FixedSizeFrame(); // register gtype
        w.destroy();

        let resource = Gio.Resource.load(Config.RESOURCE_DIR + '/polari.gresource');
        resource._register();

        this._chatroomManager = ChatroomManager.getDefault();
        this._accountsMonitor = AccountsMonitor.getDefault();

        this._settings = new Gio.Settings({ schema: 'org.gnome.polari' });

        this.pasteManager = new PasteManager.PasteManager();
        this.notificationQueue = new AppNotifications.NotificationQueue();
        this.commandOutputQueue = new AppNotifications.CommandOutputQueue();

        let builder = new Gtk.Builder();
        builder.add_from_resource('/org/gnome/polari/app-menu.ui');
        this.set_app_menu(builder.get_object('app-menu'));

        let actionEntries = [
          { name: 'room-menu',
            activate: Lang.bind(this, this._onToggleAction),
            create_hook: Lang.bind(this, this._accountActionsCreateHook),
            state: GLib.Variant.new('b', false) },
          { name: 'show-join-dialog',
            activate: Lang.bind(this, this._onShowJoinDialog),
            create_hook: Lang.bind(this, this._accountActionsCreateHook),
            accel: '<Primary>n' },
          { name: 'show-message-user-dialog',
            activate: Lang.bind(this, this._onShowMessageUserDialog),
            create_hook: Lang.bind(this, this._accountActionsCreateHook),
            accel: '<Primary>m' },
          { name: 'join-room',
            activate: Lang.bind(this, this._onJoinRoom),
            parameter_type: GLib.VariantType.new('(ssu)') },
          { name: 'message-user',
            activate: Lang.bind(this, this._onMessageUser),
            parameter_type: GLib.VariantType.new('(ssu)') },
          { name: 'leave-room',
            activate: Lang.bind(this, this._onLeaveRoom),
            parameter_type: GLib.VariantType.new('s') },
          { name: 'leave-current-room',
            activate: Lang.bind(this, this._onLeaveCurrentRoom),
            create_hook: Lang.bind(this, this._leaveRoomCreateHook),
            accel: '<Primary>w' },
          { name: 'leave-selected-rooms' },
          { name: 'user-list',
            activate: Lang.bind(this, this._onToggleAction),
            create_hook: Lang.bind(this, this._userListCreateHook),
            state: GLib.Variant.new('b', false),
            accel: 'F9' },
          { name: 'selection-mode',
            activate: Lang.bind(this, this._onToggleAction),
            create_hook: Lang.bind(this, this._selectionModeHook),
            state: GLib.Variant.new('b', false) },
          { name: 'connections',
            activate: Lang.bind(this, this._onListConnections) },
          { name: 'preferences',
            activate: Lang.bind(this, this._onShowPreferences) },
          { name: 'about',
            activate: Lang.bind(this, this._onShowAbout) },
          { name: 'quit',
            activate: Lang.bind(this, this._onQuit),
            accel: '<Primary>q' },
          { name: 'next-room',
            accel: '<Primary>Page_Down' },
          { name: 'previous-room',
            accel: '<Primary>Page_Up' },
          { name: 'first-room',
            accel: '<Primary>Home' },
          { name: 'last-room',
            accel: '<Primary>End' }
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
                if (actionEntry.accel)
                    this.add_accelerator(actionEntry.accel,
                                         'app.' + actionEntry.name, null);
                this.add_action(action);
        }));

        this._window = new MainWindow.MainWindow(this);
        this._window.window.connect('destroy', Lang.bind(this,
            function() {
                this.emitJS('prepare-shutdown');
            }));

        let provider = new Gtk.CssProvider();
        let uri = 'resource:///org/gnome/polari/application.css';
        let file = Gio.File.new_for_uri(uri);
        try {
            provider.load_from_file(Gio.File.new_for_uri(uri));
        } catch(e) {
            logError(e, "Failed to add application style");
        }
        Gtk.StyleContext.add_provider_for_screen(this._window.window.get_screen(),
                                                 provider, 600);

        this._window.window.show_all();
    },

    vfunc_activate: function() {
        if (this._window)
            this._window.window.present();
    },

    _updateAccountAction: function(action) {
        action.enabled = this._accountsMonitor.dupAccounts().filter(
            function(a) {
                return a.enabled;
            }).length > 0;
    },

    _accountActionsCreateHook: function(action) {
        this._accountsMonitor.connect('accounts-changed', Lang.bind(this,
            function() {
                this._updateAccountAction(action);
            }));
        this._updateAccountAction(action);
    },

    _leaveRoomCreateHook: function(action) {
        this._chatroomManager.connect('active-changed', Lang.bind(this,
            function() {
                action.enabled = this._chatroomManager.getActiveRoom() != null;
            }));
        action.enabled = this._chatroomManager.getActiveRoom() != null;
    },

    _updateUserListAction: function(action) {
        let room = this._chatroomManager.getActiveRoom();
        action.enabled = room && room.channel.handle_type == Tp.HandleType.ROOM;
    },

    _userListCreateHook: function(action) {
        this._chatroomManager.connect('active-changed', Lang.bind(this,
            function() {
                this._updateUserListAction(action);
            }));
        action.connect('notify::enabled', function() {
            if (action.enabled) {
                if (action._previousState)
                    action.change_state(GLib.Variant.new('b', true));
                delete action._previousState;
            } else {
                action._previousState = action.state.get_boolean();
                action.change_state(GLib.Variant.new('b', false));
            }
        });
        this._updateUserListAction(action);
    },

    _updateSelectionModeAction: function(action) {
        action.enabled = this._chatroomManager.getActiveRoom() != null;
    },

    _selectionModeHook: function(action) {
        this._chatroomManager.connect('active-changed', Lang.bind(this,
            function() {
                this._updateSelectionModeAction(action);
            }));
        action.connect('notify::enabled', function() {
            if (!action.enabled)
                action.change_state(GLib.Variant.new('b', false));
        });
        this._updateSelectionModeAction(action);
    },

    _onShowJoinDialog: function() {
        this._window.showJoinRoomDialog();
    },

    _onShowMessageUserDialog: function() {
        this._window.showMessageUserDialog();
    },

    _addSavedChannel: function(account, channel) {
        let savedChannels = this._settings.get_value('saved-channel-list').deep_unpack();
        let savedChannel = {
            account: GLib.Variant.new('s', account.get_object_path()),
            channel: GLib.Variant.new('s', channel)
        };
        for (let i = 0; i < savedChannels.length; i++)
            if (savedChannels[i].account.equal(savedChannel.account) &&
                savedChannels[i].channel.equal(savedChannel.channel))
                return;
        savedChannels.push(savedChannel);
        this._settings.set_value('saved-channel-list',
                                 GLib.Variant.new('aa{sv}', savedChannels));
    },

    _removeSavedChannel: function(account, channel) {
        let savedChannels = this._settings.get_value('saved-channel-list').deep_unpack();
        let savedChannel = {
            account: GLib.Variant.new('s', account.get_object_path()),
            channel: GLib.Variant.new('s', channel)
        };
        let i;
        for (i = 0; i < savedChannels.length; i++)
            if (savedChannels[i].account.equal(savedChannel.account) &&
                savedChannels[i].channel.equal(savedChannel.channel))
                break;
        if (!savedChannels[i])
            return;
        savedChannels.splice(i, 1);
        this._settings.set_value('saved-channel-list',
                                 GLib.Variant.new('aa{sv}', savedChannels));
    },

    _updateAccountName: function(account, name, callback) {
        let sv = { account: GLib.Variant.new('s', name) };
        let asv = GLib.Variant.new('a{sv}', sv);
        account.update_parameters_vardict_async(asv, [], callback);
    },

    _requestChannel: function(accountPath, targetType, targetId, time) {
        // have this in AccountMonitor?
        let factory = Tp.AccountManager.dup().get_factory();
        let account = factory.ensure_account(accountPath, []);

        if (!account.enabled)
            return;

        let requestData = {
          account: account,
          targetHandleType: targetType,
          targetId: targetId,
          time: time,
          retry: 0,
          originalNick: account.nickname };

        this._ensureChannel(requestData);
    },

    _ensureChannel: function(requestData) {
        let account = requestData.account;

        let req = Tp.AccountChannelRequest.new_text(account, requestData.time);
        req.set_target_id(requestData.targetHandleType, requestData.targetId);
        req.set_delegate_to_preferred_handler(true);
        let preferredHandler = Tp.CLIENT_BUS_NAME_BASE + 'Polari';
        req.ensure_channel_async(preferredHandler, null,
                                 Lang.bind(this,
                                           this._onEnsureChannel, requestData));
    },

    _onEnsureChannel: function(req, res, requestData) {
        let account = req.account;

        try {
            req.ensure_channel_finish(res);

            if (requestData.targetHandleType == Tp.HandleType.ROOM)
                this._addSavedChannel(account, requestData.targetId);
        } catch (e if e.matches(Tp.Error, Tp.Error.DISCONNECTED)) {
            let [error,] = account.dup_detailed_error_vardict();
            if (error != TP_ERROR_ALREADY_CONNECTED)
                throw(e);

            if (++requestData.retry >= MAX_RETRIES) {
                throw(e);
                return;
            }

            // Try again with a different nick
            let params = account.dup_parameters_vardict().deep_unpack();
            let oldNick = params['account'].deep_unpack();
            let nick = oldNick + '_';
            this._updateAccountName(account, nick, Lang.bind(this,
                function() {
                    this._ensureChannel(requestData);
                }));
            return;
        } catch (e) {
            logError(e, 'Failed to ensure channel');
        }

        if (requestData.retry > 0)
            this._updateAccountName(account, requestData.originalNick, null);
    },

    _onJoinRoom: function(action, parameter) {
        let [accountPath, channelName, time] = parameter.deep_unpack();
        this._requestChannel(accountPath, Tp.HandleType.ROOM,
                             channelName, time);
    },

    _onMessageUser: function(action, parameter) {
        let [accountPath, contactName, time] = parameter.deep_unpack();
        this._requestChannel(accountPath, Tp.HandleType.CONTACT,
                             contactName, time);
    },

    _onLeaveRoom: function(action, parameter) {
        let reason = Tp.ChannelGroupChangeReason.NONE;
        let message = _("Good Bye"); // TODO - our first setting!
        let room = this._chatroomManager.getRoomById(parameter.deep_unpack());
        if (!room)
            return;
        room.channel.leave_async(reason, message, Lang.bind(this,
            function(c, res) {
                try {
                    c.leave_finish(res);
                } catch(e) {
                    logError(e, 'Failed to leave channel');
                }
            }));
        this._removeSavedChannel(room.channel.connection.get_account(),
                                 room.channel.identifier);
    },

    _onLeaveCurrentRoom: function() {
        let room = this._chatroomManager.getActiveRoom();
        if (!room)
            return;
        let action = this.lookup_action('leave-room');
        action.activate(GLib.Variant.new('s', room.id));
    },

    _onToggleAction: function(action) {
        let state = action.get_state();
        action.change_state(GLib.Variant.new('b', !state.get_boolean()));
    },

    _onListConnections: function() {
        let dialog = new Connections.ConnectionsDialog();
        dialog.widget.show();
        dialog.widget.connect('response',
            function(widget) {
                widget.destroy();
            });
    },

    _onShowPreferences: function() {
    },

    _onShowAbout: function() {
        let aboutParams = {
            authors: [
                'Florian M' + String.fromCharCode(0x00FC) // ü
                            + 'llner <fmuellner@gnome.org>',
            ],
            artists: [
                'Sam Hewitt',
            ],
            translator_credits: _("translator-credits"),
            comments: _("An Internet Relay Chat Client for GNOME"),
            copyright: 'Copyright ' + String.fromCharCode(0x00A9) // ©
                                    + ' 2013 Red Hat, Inc.',
            license_type: Gtk.License.GPL_2_0,
            logo_icon_name: 'polari',
            wrap_license: true,
            version: Config.PACKAGE_VERSION,

            transient_for: this._window.window,
            modal: true
        };

        let dialog = new Gtk.AboutDialog(aboutParams);
        dialog.show();
        dialog.connect('response', function() {
            dialog.destroy();
        });
    },

    _onQuit: function() {
        this._window.window.destroy();
    }
});
Utils.addJSSignalMethods(Application.prototype);
