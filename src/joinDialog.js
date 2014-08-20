const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Gtk = imports.gi.Gtk;
const Tp = imports.gi.TelepathyGLib;
const Tpl = imports.gi.TelepathyLogger;

const AccountsMonitor = imports.accountsMonitor;
const Connections = imports.connections;
const Lang = imports.lang;

const TP_CURRENT_TIME = GLib.MAXUINT32;

const DialogPage = {
    MAIN: 0,
    CONNECTION: 1
};

const JoinDialog = new Lang.Class({
    Name: 'JoinDialog',

    _init: function() {
        this._createWidget();

        this._settings = new Gio.Settings({ schema: 'org.gnome.polari' });

        this._accountsMonitor = AccountsMonitor.getDefault();

        this._accounts = {};
        this._accountsMonitor.dupAccounts().forEach(Lang.bind(this,
            function(a) {
                if (!a.enabled)
                    return;
                this._accounts[a.display_name] = a;
            }));
        this._accountAddedId =
            this._accountsMonitor.connect('account-added', Lang.bind(this,
                function(am, account) {
                    this._accounts[account.display_name] = account;
                    this._updateConnectionCombo();
                }));
        this._accountRemovedId =
            this._accountsMonitor.connect('account-removed', Lang.bind(this,
                function(am, account) {
                    delete this._accounts[account.display_name];
                    this._updateConnectionCombo();
                }));

        this.widget.connect('destroy', Lang.bind(this,
            function() {
                this._accountsMonitor.disconnect(this._accountAddedId);
                this._accountsMonitor.disconnect(this._accountRemovedId);
            }));

        this._updateConnectionCombo();
        this._updateCanConfirm();

        this._nameEntry.grab_focus();
    },

    _createWidget: function() {
        let builder = new Gtk.Builder();
        builder.add_from_resource('/org/gnome/Polari/join-room-dialog.ui');

        this.widget = builder.get_object('join_room_dialog');

        this._titlebar = builder.get_object('titlebar');

        this._stack = builder.get_object('stack');

        this._details = new Connections.ConnectionDetails(null);
        this._stack.add_named(this._details.widget, 'connection');
        this._details.connect('can-confirm-changed',
                              Lang.bind(this, this._updateCanConfirm));

        this._connectionButton = builder.get_object('add_connection_button');
        this._connectionButton.connect('clicked', Lang.bind(this,
            function() {
                this._setPage(DialogPage.CONNECTION);
            }));
        this._backButton = builder.get_object('back_button');
        this._backButton.connect('clicked', Lang.bind(this,
            function() {
                this._setPage(DialogPage.MAIN);
            }));

        let backIcon = builder.get_object('back_icon');
        if (backIcon.get_direction() == Gtk.TextDirection.RTL)
            backIcon.icon_name = 'go-previous-rtl-symbolic';
        else
            backIcon.icon_name = 'go-previous-symbolic';

        this._connectionCombo = builder.get_object('connection_combo');
        this._connectionCombo.connect('changed',
                                      Lang.bind(this, this._onAccountChanged));
        this._connectionCombo.sensitive = false;

        this._confirmButton = builder.get_object('confirm_button');
        this._confirmButton.connect('clicked',
                                    Lang.bind(this, this._onConfirmClicked));

        this._cancelButton = builder.get_object('cancel_button');

        this._nameCompletion = builder.get_object('name_completion');
        this._nameEntry = builder.get_object('name_entry');
        this._nameEntry.connect('changed',
                                Lang.bind(this, this._updateCanConfirm));

        this._setPage(DialogPage.MAIN);
    },

    _onAccountChanged: function() {
        this._nameEntry.set_text('');
        this._nameCompletion.model.clear();

        let selected = this._connectionCombo.get_active_text();
        let account = this._accounts[selected];
        if (!account)
            return;
        let logManager = Tpl.LogManager.dup_singleton();

        logManager.get_entities_async(account, Lang.bind(this,
            function(m, res) {
                let [, entities] = logManager.get_entities_finish(res);
                let names = entities.filter(function(e) {
                    return e.type == Tpl.EntityType.ROOM;
                }).map(function(e) {
                    return e.alias;
                });
                for (let i = 0; i < names.length; i++) {
                    let model = this._nameCompletion.model;
                    let iter = model.append();
                    model.set_value(iter, 0, names[i]);
                    if (names[i].startsWith('#')) {
                        iter = model.append();
                        model.set_value(iter, 0, names[i].substr(1));
                    }
                }
            }));
    },

    _onConfirmClicked: function() {
        if (this._page == DialogPage.MAIN) {
            this._joinRoom();
            this.widget.response(Gtk.ResponseType.OK);
        } else {
            this._details.save();
            this._setPage(DialogPage.MAIN);
        }
    },

    _joinRoom: function() {
        this.widget.hide();

        let selected = this._connectionCombo.get_active_text();
        let account = this._accounts[selected];

        this._settings.set_string('last-used-account',
                                  account.get_object_path());

        let room = this._nameEntry.get_text();
        if (room[0] != '#')
            room = '#' + room;

        let app = Gio.Application.get_default();
        let action = app.lookup_action('join-room');
        action.activate(GLib.Variant.new('(ssu)',
                                         [ account.get_object_path(),
                                           room,
                                           TP_CURRENT_TIME ]));
    },

    _updateConnectionCombo: function() {
        this._connectionCombo.remove_all();

        let names = Object.keys(this._accounts).sort(
            function(a, b) {
                // TODO: figure out combo box sorting
                return (a < b) ? -1 : ((a > b) ? 1 : 0);
            });
        for (let i = 0; i < names.length; i++)
            this._connectionCombo.append_text(names[i]);
        this._connectionCombo.sensitive = names.length > 1;

        let factory = Tp.AccountManager.dup().get_factory();
        let lastUsed = factory.ensure_account(this._settings.get_string('last-used-account'), []);
        let activeIndex = lastUsed ? names.indexOf(lastUsed.display_name) : 0;
        this._connectionCombo.set_active(activeIndex);
    },

    _updateCanConfirm: function() {
        let sensitive;

        if (this._page == DialogPage.MAIN) {
            sensitive = this._connectionCombo.get_active() > -1  &&
                        this._nameEntry.get_text_length() > 0;
        } else {
            sensitive = this._details.canConfirm;
        }

        this._confirmButton.sensitive = sensitive;
        this.widget.set_default_response(sensitive ? Gtk.ResponseType.OK
                                                   : Gtk.ResponseType.NONE);
    },

    get _page() {
        if (this._stack.visible_child_name == 'connection')
            return DialogPage.CONNECTION;
        else
            return DialogPage.MAIN;
    },

    _setPage: function(page) {
        let isMain = page == DialogPage.MAIN;

        if (isMain)
            this._details.reset();

        this._backButton.visible = !isMain;
        this._cancelButton.visible = isMain;
        this._titlebar.title = isMain ? _("Join Chat Room")
                                      : _("Add Connection");
        this._confirmButton.label = isMain ? _("_Join")
                                           : _("_Save");
        this._stack.visible_child_name = isMain ? 'main' : 'connection';
        this._updateCanConfirm();
    }
});
