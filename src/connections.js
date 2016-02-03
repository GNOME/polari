const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;
const Tp = imports.gi.TelepathyGLib;

const Lang = imports.lang;
const Signals = imports.signals;

const ConnectionDetails = new Lang.Class({
    Name: 'ConnectionDetails',
    Extends: Gtk.Box,
    Template: 'resource:///org/gnome/Polari/ui/connection-details.ui',
    InternalChildren: ['serverEntry',
                       'descEntry',
                       'nickEntry',
                       'realnameEntry',
                       'errorBox',
                       'errorIcon',
                       'errorLabel'],
    Properties: { 'can-confirm': GObject.ParamSpec.boolean('can-confirm',
                                                           'can-confirm',
                                                           'can-confirm',
                                                           GObject.ParamFlags.READABLE,
                                                           false)},
    Signals: { 'account-created': { param_types: [Tp.Account.$gtype] }},

    _init: function(params) {
        if (params) {
            this._account = params.account;
            delete params.account;
        }

        this.parent(params);

        this._serverEntry.connect('changed',
                                  Lang.bind(this, this._onCanConfirmChanged));
        this._nickEntry.connect('changed',
                                Lang.bind(this, this._onCanConfirmChanged));

        let realnameStore = new Gtk.ListStore();
        realnameStore.set_column_types([GObject.TYPE_STRING]);
        realnameStore.insert_with_valuesv(-1, [0], [GLib.get_real_name()]);

        let completion = new Gtk.EntryCompletion({ model: realnameStore,
                                                   text_column: 0,
                                                   inline_completion: true,
                                                   popup_completion: false });
        this._realnameEntry.set_completion(completion);

        this.reset();

        if (!this._account)
            return;

        this._populateFromAccount(this._account);

        this._account.connect('notify::connection-status', Lang.bind(this, this._syncErrorMessage));
        this._syncErrorMessage();
    },

    _syncErrorMessage: function() {
        let status = this._account.connection_status;
        let reason = this._account.connection_status_reason;

        if (status == Tp.ConnectionStatus.DISCONNECTED &&
            reason != Tp.ConnectionStatusReason.REQUESTED) {
            switch (this._account.connection_error) {
                case Tp.error_get_dbus_name(Tp.Error.CONNECTION_REFUSED):
                case Tp.error_get_dbus_name(Tp.Error.NETWORK_ERROR): {
                    this._errorLabel.label = _("Polari disconnected due to a network error. Please check if the address field is correct.");
                    this._serverEntry.get_style_context().add_class('error');
                    this._errorBox.visible = true;
                    break;
                }
            }
        }
    },

    _getParams: function() {
        let serverText = this._serverEntry.text.trim();
        let descText = this._descEntry.text.trim();

        let serverRegEx = /(.*?)(?::(\d{1,5}))?$/;
        let [, server, port] = serverText.match(serverRegEx);

        let params = {
            name: descText.length ? descText : server,
            server: server,
            account: this._nickEntry.text.trim()
        };

        if (port)
            params.port = port;
        if (this._realnameEntry.text)
            params.fullname = this._realnameEntry.text.trim();

        return params;
    },

    reset: function() {
        this._serverEntry.text = '';
        this._descEntry.text = '';
        this._nickEntry.text = GLib.get_user_name();
        this._realnameEntry.text = '';

        this._serverEntry.grab_focus();
    },

    _onCanConfirmChanged: function() {
        this.notify('can-confirm');
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

    get can_confirm() {
        return this._serverEntry.get_text_length() > 0 &&
               this._nickEntry.get_text_length() > 0;
    },

    save: function() {
        if (!this.can_confirm)
            return;

        if (this._account)
            this._updateAccount();
        else
            this._createAccount();
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
                let account = req.create_account_finish(res);
                if (account) // TODO: Handle errors
                    this.emit('account-created', account);
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


const ConnectionProperties = new Lang.Class({
    Name: 'ConnectionProperties',
    Extends: Gtk.Dialog,

    _init: function(account) {
        /* Translators: %s is a connection name */
        let title = _("“%s” Properties").format(account.display_name);
        this.parent({ title: title,
                      modal: true,
                      destroy_with_parent: true,
                      use_header_bar: 1,
                      default_width: 450 });

        this.get_content_area().border_width = 0;

        this.connect('response', Lang.bind(this,
            function(w, response) {
                if (response == Gtk.ResponseType.OK)
                    this._details.save();
            }));

        this.add_button(_("_Cancel"), Gtk.ResponseType.CANCEL);

        this._confirmButton = this.add_button(_("A_pply"), Gtk.ResponseType.OK);
        this._confirmButton.get_style_context().add_class('suggested-action');

        this._details = new ConnectionDetails({ account: account });
        this._details.bind_property('can-confirm',
                                    this._confirmButton, 'sensitive',
                                    GObject.BindingFlags.SYNC_CREATE);
        this.get_content_area().add(this._details);
        this.set_default_response(Gtk.ResponseType.OK);
    }
});
