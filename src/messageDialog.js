const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Gtk = imports.gi.Gtk;
const Tp = imports.gi.TelepathyGLib;
const Tpl = imports.gi.TelepathyLogger;

const AccountsMonitor = imports.accountsMonitor;
const Lang = imports.lang;

const TP_CURRENT_TIME = GLib.MAXUINT32;
const MAX_RECENT_USERS = 5;

const MessageDialog = new Lang.Class({
    Name: 'MessageDialog',

    _init: function() {
        this._createWidget();

        this._accounts = {};
        AccountsMonitor.getDefault().dupAccounts().forEach(Lang.bind(this,
            function(a) {
                if (!a.enabled)
                    return;
                this._accounts[a.display_name] = a;
            }));
        let names = Object.keys(this._accounts).sort(
            function(a, b) {
                // TODO: figure out combo box sorting
                return (a < b) ? -1 : ((a > b) ? 1 : 0);
            });
        for (let i = 0; i < names.length; i++)
            this._connectionCombo.append_text(names[i]);
        this._connectionCombo.set_active(0);
        this._connectionCombo.sensitive = names.length > 1;
        this._updateCanConfirm();
        this._updateRecentList([]);
    },

    _createWidget: function() {
        let builder = new Gtk.Builder();
        builder.add_from_resource('/org/gnome/polari/message-user-dialog.ui');

        this.widget = builder.get_object('message_user_dialog');

        this._connectionCombo = builder.get_object('connection_combo');
        this._connectionCombo.connect('changed',
                                      Lang.bind(this, this._onAccountChanged));
        this._connectionCombo.sensitive = false;

        this._recentList = builder.get_object('recent_list');
        this._recentList.connect('row-activated', Lang.bind(this,
            function(w, row) {
                this._nameEntry.text = row.name;
            }));
        this._nameCompletion = builder.get_object('name_completion');

        this._messageButton = builder.get_object('message_button');
        this._messageButton.connect('clicked',
                                 Lang.bind(this, this._onMessageClicked));
        this._messageButton.sensitive = false;

        this._nameEntry = builder.get_object('name_entry');
        this._nameEntry.connect('changed',
                                Lang.bind(this, this._updateCanConfirm));
    },

    _updateRecentList: function(names) {
        this._recentList.foreach(Lang.bind(this,
            function(row) {
                row.destroy();
            }));

        if (names.length == 0) {
            let row = new Gtk.ListBoxRow({ sensitive: false });
            this._recentList.add(row);

            let text = '<i>%s</i>'.format(_("No recent users"));
            let label = new Gtk.Label({ label: text,
                                        use_markup: true });
            row.add(label);
            row.show_all();
        }

        for (let i = 0; i < names.length; i++) {
            let model = this._nameCompletion.model;
            let iter = model.append();
            model.set_value(iter, 0, names[i]);

            if (i >= MAX_RECENT_USERS)
                continue;

            let row = new Gtk.ListBoxRow();
            row.name = names[i];

            let box = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL,
                                    spacing: 6 });
            row.add(box);

            box.add(new Gtk.Image({ icon_name: 'avatar-default-symbolic',
                                    icon_size: Gtk.IconSize.MENU,
                                    valign: Gtk.Align.BASELINE }));
           box.add(new Gtk.Label({ label: row.name,
                                   valign: Gtk.Align.BASELINE }));
           row.show_all();

           this._recentList.add(row);
        }
    },

    _onAccountChanged: function() {
        this._nameEntry.set_text('');
        this._nameCompletion.model.clear();

        let selected = this._connectionCombo.get_active_text();
        let account = this._accounts[selected];
        let logManager = Tpl.LogManager.dup_singleton();

        logManager.get_entities_async(account, Lang.bind(this,
            function(m, res) {
                let [, entities] = logManager.get_entities_finish(res);
                entities = entities.filter(function(e) {
                    return e.type == Tpl.EntityType.CONTACT;
                });
                let pending = entities.length;
                if (pending == 0) {
                    this._updateRecentList([]);
                    return;
                }
                for (let i = 0; i < entities.length; i++) {
                    let entity = entities[i];
                    logManager.get_filtered_events_async(account, entity,
                        Tpl.EventTypeMask.TEXT, 1, null,
                        Lang.bind(this, function(m, res) {
                            let [, events] = m.get_filtered_events_finish(res);
                            entity._timestamp = events[0].timestamp;
                            if (--pending > 0)
                                return;
                            let names = entities.sort(function(a, b) {
                                return b._timestamp - a._timestamp;
                            }).map(function(e) {
                                return e.alias;
                            });
                            this._updateRecentList(names);
                        }));
                }
            }));
    },

    _onMessageClicked: function() {
        this.widget.hide();

        let selected = this._connectionCombo.get_active_text();
        let account = this._accounts[selected];

        let user = this._nameEntry.get_text();

        let app = Gio.Application.get_default();
        let action = app.lookup_action('message-user');
        action.activate(GLib.Variant.new('(ssu)',
                                         [ account.get_object_path(),
                                           user,
                                           TP_CURRENT_TIME ]));
        this.widget.response(Gtk.ResponseType.OK);
    },

    _updateCanConfirm: function() {
            let sensitive = this._connectionCombo.get_active() > -1  &&
                            this._nameEntry.get_text_length() > 0;
            this._messageButton.sensitive = sensitive;
    }
});
