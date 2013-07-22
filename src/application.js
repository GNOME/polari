const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Gtk = imports.gi.Gtk;
const Tp = imports.gi.TelepathyGLib;

const AppNotifications = imports.appNotifications;
const ChatroomManager = imports.chatroomManager;
const Config = imports.config;
const Connections = imports.connections;
const Format = imports.format;
const Gettext = imports.gettext;
const Lang = imports.lang;
const MainWindow = imports.mainWindow;

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

        let resource = Gio.Resource.load(Config.RESOURCE_DIR + '/polari.gresource');
        resource._register();

        this._chatroomManager = ChatroomManager.getDefault();
        this._accountManager = Tp.AccountManager.dup();

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
          { name: 'join-room',
            activate: Lang.bind(this, this._onJoinRoom),
            create_hook: Lang.bind(this, this._accountActionsCreateHook),
            accel: '<Primary>n' },
          { name: 'message-user',
            activate: Lang.bind(this, this._onMessageUser) },
          { name: 'leave-room',
            activate: Lang.bind(this, this._onLeaveRoom),
            create_hook: Lang.bind(this, this._roomActionsCreateHook),
            accel: '<Primary>w' },
          { name: 'user-list',
            activate: Lang.bind(this, this._onToggleAction),
            create_hook: Lang.bind(this, this._roomActionsCreateHook),
            state: GLib.Variant.new('b', false),
            accel: 'F9' },
          { name: 'connections',
            activate: Lang.bind(this, this._onListConnections) },
          { name: 'preferences',
            activate: Lang.bind(this, this._onShowPreferences) },
          { name: 'about',
            activate: Lang.bind(this, this._onShowAbout) },
          { name: 'quit',
            activate: Lang.bind(this, this._onQuit),
            accel: '<Primary>q' }
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
        action.enabled = this._accountManager.dup_valid_accounts().filter(
            function(a) {
                return a.enabled;
            }).length > 0;
    },

    _accountActionsCreateHook: function(action) {
        this._accountManager.connect('account-enabled', Lang.bind(this,
            function() {
                this._updateAccountAction(action);
            }));
        this._accountManager.connect('account-disabled', Lang.bind(this,
            function() {
                this._updateAccountAction(action);
            }));
        this._accountManager.connect('account-validity-changed', Lang.bind(this,
            function() {
                this._updateAccountAction(action);
            }));
        this._accountManager.connect('account-removed', Lang.bind(this,
            function() {
                this._updateAccountAction(action);
            }));
        this._accountManager.prepare_async(null, Lang.bind(this,
            function() {
                this._updateAccountAction(action);
            }));
    },

    _updateRoomAction: function(action) {
        action.enabled = this._chatroomManager.getActiveRoom() != null;
        if (action.state && !action.enabled)
            action.change_state(GLib.Variant.new('b', false));
    },

    _roomActionsCreateHook: function(action) {
        this._chatroomManager.connect('active-changed', Lang.bind(this,
            function() {
                this._updateRoomAction(action);
            }));
        this._updateRoomAction(action);
    },

    _onJoinRoom: function() {
        this._window.showJoinRoomDialog();
    },

    _onMessageUser: function() {
        log('Activated action "Message user"');
    },

    _onLeaveRoom: function() {
        let reason = Tp.ChannelGroupChangeReason.NONE;
        let message = _("Good Bye"); // TODO - our first setting!
        let room = this._chatroomManager.getActiveRoom();
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
            translator_credits: _("translator-credits"),
            comments: _('An Internet Relay Chat Client for GNOME'),
            copyright: 'Copyright ' + String.fromCharCode(0x00A9) // ©
                                    + ' 2013 Red Hat, Inc.',
            license_type: Gtk.License.GPL_2_0,
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
