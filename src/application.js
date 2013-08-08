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

        Gtk.init(null);

        let w = new Polari.FixedSizeFrame(); // register gtype
        w.destroy();

        let resource = Gio.Resource.load(Config.RESOURCE_DIR + '/polari.gresource');
        resource._register();

        this._chatroomManager = ChatroomManager.getDefault();
        this._accountsMonitor = AccountsMonitor.getDefault();

        this.pasteManager = new PasteManager.PasteManager();
        this.notificationQueue = new AppNotifications.NotificationQueue();
        this.commandOutputQueue = new AppNotifications.CommandOutputQueue();

        let builder = new Gtk.Builder();
        builder.add_from_resource('/org/gnome/polari/app-menu.ui');
        this.set_app_menu(builder.get_object('app-menu'));

        let actionEntries = [
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
        let windowAccels = [
          { name: 'show-join-dialog',
            accel: '<Primary>n' },
          { name: 'leave-current-room',
            accel: '<Primary>w' },
          { name: 'user-list',
            accel: 'F9' },
          { name: 'next-room',
            accel: '<Primary>Page_Down' },
          { name: 'previous-room',
            accel: '<Primary>Page_Up' },
          { name: 'first-room',
            accel: '<Primary>Home' },
          { name: 'last-room',
            accel: '<Primary>End' }
        ];
        windowAccels.forEach(Lang.bind(this,
            function(actionEntry) {
                if (actionEntry.accel)
                    this.add_accelerator(actionEntry.accel,
                                         'win.' + actionEntry.name, null);
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
Utils.addJSSignalMethods(Application.prototype);
