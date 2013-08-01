const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Gtk = imports.gi.Gtk;
const Tp = imports.gi.TelepathyGLib;

const AccountsMonitor = imports.accountsMonitor;
const Lang = imports.lang;

const MAX_RETRIES = 3;

const TP_ERROR_PREFIX = 'org.freedesktop.Telepathy.Error.'
const TP_ERROR_ALREADY_CONNECTED = TP_ERROR_PREFIX + 'AlreadyConnected';

const TP_CURRENT_TIME = GLib.MAXUINT32;

const JoinDialog = new Lang.Class({
    Name: 'JoinDialog',

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
    },

    _createWidget: function() {
        let builder = new Gtk.Builder();
        builder.add_from_resource('/org/gnome/polari/join-room-dialog.ui');

        this.widget = builder.get_object('join_room_dialog');

        this._connectionCombo = builder.get_object('connection_combo');
        this._connectionCombo.sensitive = false;

        this._joinButton = builder.get_object('join_button');
        this._joinButton.connect('clicked',
                                 Lang.bind(this, this._onJoinClicked));
        this._joinButton.sensitive = false;

        this._nameEntry = builder.get_object('name_entry');
        this._nameEntry.connect('changed',
                                Lang.bind(this, this._updateCanConfirm));
    },

    _onJoinClicked: function() {
        this.widget.hide();

        let selected = this._connectionCombo.get_active_text();
        let account = this._accounts[selected];

        let room = this._nameEntry.get_text();
        if (room[0] != '#')
            room = '#' + room;

        let app = Gio.Application.get_default();
        let action = app.lookup_action('join-room');
        action.activate(GLib.Variant.new('(ssu)',
                                         [ account.get_object_path(),
                                           room,
                                           TP_CURRENT_TIME ]));
        this.widget.response(Gtk.ResponseType.OK);
    },

    _updateCanConfirm: function() {
            let sensitive = this._connectionCombo.get_active() > -1  &&
                            this._nameEntry.get_text_length() > 0;
            this._joinButton.sensitive = sensitive;
    }
});
