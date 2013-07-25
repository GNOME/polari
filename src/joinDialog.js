const Gdk = imports.gi.Gdk;
const GLib = imports.gi.GLib;
const Gtk = imports.gi.Gtk;
const Tp = imports.gi.TelepathyGLib;

const AccountsMonitor = imports.accountsMonitor;
const Lang = imports.lang;

const MAX_RETRIES = 3;

const TP_ERROR_PREFIX = 'org.freedesktop.Telepathy.Error.'
const TP_ERROR_ALREADY_CONNECTED = TP_ERROR_PREFIX + 'AlreadyConnected';

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

        this._requestData = { account: account, target: room };
        this._originalNick = account.nickname;
        this._retry = 0;

        this._ensureChannel();
    },

    _updateAccountName: function(account, name, callback) {
        let sv = { account: GLib.Variant.new('s', name) };
        let asv = GLib.Variant.new('a{sv}', sv);
        account.update_parameters_vardict_async(asv, [], callback);
    },

    _ensureChannel: function() {
        let account = this._requestData.account;

        let req = Tp.AccountChannelRequest.new_text(account, Gdk.CURRENT_TIME);
        req.set_target_id(Tp.HandleType.ROOM, this._requestData.target);
        req.set_delegate_to_preferred_handler(true);
        let preferredHandler = Tp.CLIENT_BUS_NAME_BASE + 'Polari';
        req.ensure_channel_async(preferredHandler, null,
                                 Lang.bind(this, this._onEnsureChannel));
    },

    _onEnsureChannel: function(req, res) {
        let account = req.account;

        try {
            req.ensure_channel_finish(res);
        } catch (e if e.matches(Tp.Error, Tp.Error.DISCONNECTED)) {
            let [error,] = account.dup_detailed_error_vardict();
            if (error != TP_ERROR_ALREADY_CONNECTED)
                throw(e);

            if (++this._retry >= MAX_RETRIES) {
                throw(e);
                return;
            }

            // Try again with a different nick
            let params = account.dup_parameters_vardict().deep_unpack();
            let oldNick = params['account'].deep_unpack();
            let nick = oldNick + '_';
            this._updateAccountName(account, nick, Lang.bind(this,
                function() {
                    this._ensureChannel();
                }));
            return;
        } catch (e) {
            logError(e, 'Failed to ensure channel');
        }

        if (this._retry > 0)
            this._updateAccountName(account, this._originalNick, null);

        this.widget.response(Gtk.ResponseType.OK);
    },

    _updateCanConfirm: function() {
            let sensitive = this._connectionCombo.get_active() > -1  &&
                            this._nameEntry.get_text_length() > 0;
            this._joinButton.sensitive = sensitive;
    }
});
