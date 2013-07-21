const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Gtk = imports.gi.Gtk;

const Config = imports.config;
const Connections = imports.connections;
const Format = imports.format;
const Gettext = imports.gettext;
const Lang = imports.lang;
const MainWindow = imports.mainWindow;
const Utils = imports.utils;

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

        let builder = new Gtk.Builder();
        builder.add_from_resource('/org/gnome/polari/app-menu.ui');
        this.set_app_menu(builder.get_object('app-menu'));

        let actionEntries = [
          { name: 'connections',
            activate: Lang.bind(this, this._listConnections) },
          { name: 'preferences',
            activate: Lang.bind(this, this._showPreferences) },
          { name: 'about',
            activate: Lang.bind(this, this._showAbout) },
          { name: 'quit',
            activate: Lang.bind(this, this.release) }
        ];
        Utils.createActions(actionEntries).forEach(Lang.bind(this,
            function(a) {
                this.add_action(a);
            }));
        this.add_accelerator('<Primary>q', 'app.quit', null);

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

    _listConnections: function() {
        let dialog = new Connections.ConnectionsDialog();
        dialog.widget.show();
        dialog.widget.connect('response',
            function(widget) {
                widget.destroy();
            });
    },

    _showPreferences: function() {
    },

    _showAbout: function() {
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
    }
});
