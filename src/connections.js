const Gdk = imports.gi.Gdk;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;
const Tp = imports.gi.TelepathyGLib;

const AccountsMonitor = imports.accountsMonitor;
const Lang = imports.lang;
const Signals = imports.signals;

const ConnectionsDialog = new Lang.Class({
    Name: 'ConnectionsDialog',

    _init: function() {
        this._createWindow();

        this._accountsMonitor = AccountsMonitor.getDefault();

        this._accountAddedId =
            this._accountsMonitor.connect('account-added', Lang.bind(this,
                function(am, account) {
                    this._addAccount(account);
                }));
        this._accountRemovedId =
            this._accountsMonitor.connect('account-removed', Lang.bind(this,
                function(am, account) {
                    this._removeAccount(account);
                }));
        this._accountsMonitor.dupAccounts().forEach(Lang.bind(this, this._addAccount));
    },

    _createWindow: function() {
        let app = Gio.Application.get_default();

        let builder = new Gtk.Builder();
        builder.add_from_resource('/org/gnome/polari/connection-list-dialog.ui');

        this.widget = builder.get_object('connection_list_dialog');
        this.widget.transient_for = app.get_active_window();

        this._listBox = builder.get_object('accounts_list');
        this._stack = builder.get_object('stack');

        this._listBox.set_sort_func(function(row1, row2) {
            return row1._account.display_name < row2._account.display_name ? -1 : 1;
        });

        let toolbar = builder.get_object('toolbar');
        let context = toolbar.get_style_context();
        context.set_junction_sides(Gtk.JunctionSides.TOP);

        let scrolledwindow = builder.get_object('scrolledwindow');
        context = scrolledwindow.get_style_context();
        context.set_junction_sides(Gtk.JunctionSides.BOTTOM);

        let addButton = builder.get_object('add_button');
        addButton.connect('clicked', Lang.bind(this, this._addConnection));

        let remButton = builder.get_object('remove_button');
        remButton.connect('clicked', Lang.bind(this, this._removeConnection));
        remButton.sensitive = false;

        let editButton = builder.get_object('edit_button');
        editButton.connect('clicked', Lang.bind(this, this._editConnection));
        editButton.sensitive = false;

        this._listBox.connect('row-selected',
            function(w, row) {
                remButton.sensitive = row != null;
                editButton.sensitive = row != null;
            });
        this.widget.connect('destroy', Lang.bind(this, this._onDestroy));
    },

    _addAccount: function(account) {
        let row = new Gtk.ListBoxRow();
        row._account = account;

        let box = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL,
                                spacing: 6, margin: 6 });
        row.add(box);

        let label = new Gtk.Label({ hexpand: true, halign: Gtk.Align.START });
        box.add(label);

        let sw = new Gtk.Switch();
        box.add(sw);

        this._listBox.add(row);
        row.show_all();

        account.bind_property('display-name', label, 'label',
                              GObject.BindingFlags.SYNC_CREATE);
        account.bind_property('enabled', sw, 'active',
                              GObject.BindingFlags.SYNC_CREATE);
        account.connect('notify::display-name',
            function() {
                row.changed();
            });

        sw.connect('notify::active',
            function() {
                account.set_enabled_async(sw.active, Lang.bind(this,
                    function(a, res) {
                        a.set_enabled_finish(res);
                    }));
            });

        row.connect('key-press-event', Lang.bind(this,
            function(w, ev) {
                let [, keyval] = ev.get_keyval();
                if (keyval == Gdk.KEY_space ||
                    keyval == Gdk.KEY_Return ||
                    keyval == Gdk.KEY_ISO_Enter ||
                    keyval == Gdk.KEY_KP_Enter)
                    sw.activate();
            }));
    },

    _removeAccount: function(account) {
        let rows = this._listBox.get_children();
        for (let i = 0; i < rows.length; i++)
            if (rows[i]._account == account) {
                rows[i].destroy();
                return;
            }
    },

    _addConnection: function() {
        this._showConnectionDetailsDialog(null);
    },

    _removeConnection: function() {
        let row = this._listBox.get_selected_row();
        row._account.remove_async(Lang.bind(this,
            function(a, res) {
                a.remove_finish(res); // TODO: Check for errors
            }));
    },

    _editConnection: function() {
        let account = this._listBox.get_selected_row()._account;
        this._showConnectionDetailsDialog(account);
    },

    _showConnectionDetailsDialog: function(account) {
        let dialog = new ConnectionDetailsDialog(account);
        dialog.widget.transient_for = this.widget;
        dialog.widget.show();
        dialog.widget.connect('response',
            function(w, response) {
                dialog.widget.destroy();
            });
    },

    _onDestroy: function() {
        this._accountsMonitor.disconnect(this._accountAddedId);
        this._accountsMonitor.disconnect(this._accountRemovedId);
    }
});

const ConnectionDetails = new Lang.Class({
    Name: 'ConnectionDetails',

    _init: function(account) {
        this._createWidget();

        this._account = account;

        if (account)
            this._populateFromAccount(account);
    },

    _getParams: function() {
        let serverRegEx = /(.*?)(?::(\d{1,5}))?$/;
        let [, server, port] = this._serverEntry.text.match(serverRegEx);

        let params = {
            name: this._descEntry.text.length ? this._descEntry.text : server,
            server: server,
            account: this._nickEntry.text
        };

        if (port)
            params.port = port;
        if (this._realnameEntry.text)
            params.fullname = this._realnameEntry.text;

        return params;
    },

    setCancelVisible: function(visible) {
        this._cancelButton.visible = visible;
    },

    reset: function() {
        this._serverEntry.text = '';
        this._descEntry.text = '';
        this._nickEntry.text = '';
        this._realnameEntry.text = '';
    },

    _createWidget: function() {
        let builder = new Gtk.Builder();
        builder.add_from_resource('/org/gnome/polari/connection-details-dialog.ui');

        this.widget = builder.get_object('connection_details_content');
        this.widget.unparent();

        this._serverEntry = builder.get_object('server_entry');
        this._descEntry = builder.get_object('description_entry');
        this._nickEntry = builder.get_object('nickname_entry');
        this._realnameEntry = builder.get_object('realname_entry');
        this.confirmButton = builder.get_object('confirm_button');
        this._cancelButton = builder.get_object('cancel_button');

        this.confirmButton.connect('clicked',
                                    Lang.bind(this, this._onConfirmClicked));
        this._cancelButton.connect('clicked', Lang.bind(this,
            function() {
                this.emit('response', Gtk.ResponseType.CANCEL);
            }));

        this._serverEntry.connect('changed',
                                  Lang.bind(this, this._updateSensitivity));
        this._nickEntry.connect('changed',
                                Lang.bind(this, this._updateSensitivity));
        this._updateSensitivity();
    },

    _updateSensitivity: function() {
        let sensitive = this._serverEntry.get_text_length() > 0 &&
                        this._nickEntry.get_text_length() > 0;
        this.confirmButton.sensitive = sensitive;
    },

    _populateFromAccount: function(account) {
        let params = account.dup_parameters_vardict().deep_unpack();
        for (let p in params)
            params[p] = params[p].deep_unpack();

        let server = params.server || '';
        let port = params.port || 6667;
        let nick = params.account || '';
        let realname = params.fullname || '';

        if (port != 6667)
            server += ':%d'.format(port);

        this._serverEntry.text = server;
        this._nickEntry.text = nick;
        this._realnameEntry.text = realname;

        if (server != account.display_name)
            this._descEntry.text = account.display_name;
    },

    _onConfirmClicked: function() {
        if (this._account)
            this._updateAccount();
        else
            this._createAccount();

        this.emit('response', Gtk.ResponseType.OK);
    },

    _createAccount: function() {
        let params = this._getParams();
        let accountManager = Tp.AccountManager.dup();
        let req = new Tp.AccountRequest({ account_manager: accountManager,
                                          connection_manager: 'idle',
                                          protocol: 'irc',
                                          display_name: params.name });
        req.set_enabled(true);

        let [details,] = this._detailsFromParams(params, {});

        for (let prop in details)
            req.set_parameter(prop, details[prop]);

        req.create_account_async(Lang.bind(this,
            function(r, res) {
                req.create_account_finish(res); // TODO: Check for errors
            }));
    },

    _updateAccount: function() {
        let params = this._getParams();
        let account = this._account;
        let oldDetails = account.dup_parameters_vardict().deep_unpack();
        let [details, removed] = this._detailsFromParams(params, oldDetails);
        let vardict = GLib.Variant.new('a{sv}', details);

        account.update_parameters_vardict_async(vardict, removed,
            Lang.bind(this, function(a, res) {
                a.update_parameters_vardict_finish(res); // TODO: Check for errors
            }));

        account.set_display_name_async(params.name, Lang.bind(this,
            function(a, res) {
                a.set_display_name_finish(res); // TODO: Check for errors
            }));
    },

    _detailsFromParams: function(params, oldDetails) {
        let details = { account: GLib.Variant.new('s', params.account),
                        server:  GLib.Variant.new('s', params.server) };

        if (params.port)
            details.port = GLib.Variant.new('u', params.port);
        if (params.fullname)
            details.fullname = GLib.Variant.new('s', params.fullname);

        let removed = Object.keys(oldDetails).filter(
                function(p) {
                    return !details.hasOwnProperty(p);
                });

        return [details, removed];
    }
});
Signals.addSignalMethods(ConnectionDetails.prototype);


const ConnectionDetailsDialog = new Lang.Class({
    Name: 'ConnectionDetailsDialog',

    _init: function(account) {
        let title = account ? _("Edit Connection")
                            : _("New Connection");
        this.widget = new Gtk.Dialog({ title: title,
                                       modal: true,
                                       destroy_with_parent: true });

        this._details = new ConnectionDetails(account);
        this.widget.get_content_area().add(this._details.widget);

        this._details.confirmButton.label = account ? _("A_pply")
                                                    : _("Cr_eate");

        this._details.connect('response', Lang.bind(this,
            function(details, response) {
                this.widget.response(response);
            }));
    }
});
