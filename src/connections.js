const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;
const Tp = imports.gi.TelepathyGLib;

const {AccountsMonitor} = imports.accountsMonitor;
const {NetworksManager} = imports.networksManager;
const Utils = imports.utils;

const DEFAULT_PORT = 6667;
const DEFAULT_SSL_PORT = 6697;

const ErrorHint = {
    NONE: 0,
    SERVER: 1,
    NICK: 2
};

function getAccountParams(account) {
    let params = account.dup_parameters_vardict().deep_unpack();
    for (let p in params)
        params[p] = params[p].deep_unpack();

    params['use-ssl'] = !!params['use-ssl'];
    params['port'] = params['port'] || params['use-ssl'] ? DEFAULT_SSL_PORT
                                                         : DEFAULT_PORT;
    return params;
};

const ConnectionRow = GObject.registerClass(
class ConnectionRow extends Gtk.ListBoxRow {
    _init(params) {
        if (!params || !params.id)
            throw new Error('No id in parameters');

        this._id = params.id;
        delete params.id;

        super._init(params);

        let name = NetworksManager.getDefault().getNetworkName(this._id);
        this.name = `ConnectionRow ${name}`;

        this.bind_property('sensitive', this, 'activatable',
                           GObject.BindingFlags.SYNC_CREATE);

        let box = new Gtk.Box({ spacing: 12, margin: 12 });
        this.add(box);

        box.add(new Gtk.Label({ label: name, halign: Gtk.Align.START }));

        let insensitiveDesc = new Gtk.Label({ label: _("Already added"),
                                              hexpand: true,
                                              no_show_all: true,
                                              halign: Gtk.Align.END });
        box.add(insensitiveDesc);

        this.show_all();

        this.bind_property('sensitive', insensitiveDesc, 'visible',
                           GObject.BindingFlags.SYNC_CREATE |
                           GObject.BindingFlags.INVERT_BOOLEAN);
    }

    get id() {
        return this._id;
    }
});

var ConnectionsList = GObject.registerClass({
    Properties: {
        'favorites-only': GObject.ParamSpec.boolean('favorites-only',
                                                    'favorites-only',
                                                    'favorites-only',
                                                    GObject.ParamFlags.READWRITE |
                                                    GObject.ParamFlags.CONSTRUCT_ONLY,
                                                    false)
    },
    Signals: { 'account-created': { param_types: [Tp.Account.$gtype] },
               'account-selected': {}}
}, class ConnectionsList extends Gtk.ScrolledWindow {
    _init(params) {
        this._favoritesOnly = false;

        super._init(params);

        this.hscrollbar_policy = Gtk.PolicyType.NEVER;

        this._list = new Gtk.ListBox({ visible: true });
        this._list.connect('row-activated', this._onRowActivated.bind(this));
        this.add(this._list);

        this._rows = new Map();

        this._filterTerms = [];
        this._list.set_filter_func(this._filterRows.bind(this));
        this._list.set_header_func(this._updateHeader.bind(this));
        this._list.set_sort_func(this._sort.bind(this));

        let placeholder = new Gtk.Box({ halign: Gtk.Align.CENTER,
                                        valign: Gtk.Align.CENTER,
                                        orientation: Gtk.Orientation.VERTICAL,
                                        visible: true });
        placeholder.add(new Gtk.Image({ icon_name: 'edit-find-symbolic',
                                        pixel_size : 115,
                                        visible : true }));
        placeholder.add(new Gtk.Label({ label : _("No results."),
                                        visible : true}));

        placeholder.get_style_context().add_class('dim-label');

        this._list.set_placeholder(placeholder);

        this._accountsMonitor = AccountsMonitor.getDefault();
        let accountAddedId =
            this._accountsMonitor.connect('account-added', (mon, account) => {
                this._setAccountRowSensitive(account, false);
            });
        let accountRemovedId =
            this._accountsMonitor.connect('account-removed', (mon, account) => {
                this._setAccountRowSensitive(account, true);
            });

        this._networksManager = NetworksManager.getDefault();
        let networksChangedId =
            this._networksManager.connect('changed',
                                          this._networksChanged.bind(this));
        this._networksChanged();

        this.connect('destroy', () => {
            this._accountsMonitor.disconnect(accountAddedId);
            this._accountsMonitor.disconnect(accountRemovedId);
            this._networksManager.disconnect(networksChangedId);
        });
    }

    get favorites_only() {
        return this._favoritesOnly;
    }

    set favorites_only(favsOnly) {
        if (this._favoritesOnly == favsOnly)
            return;

        this._favoritesOnly = favsOnly;
        this.notify('favorites-only');
    }

    setFilter(filter) {
        if (!Utils.updateTerms(this._filterTerms, filter))
            return;

        this._list.invalidate_filter();

        let row = this._list.get_row_at_y(0);
        if (row)
            this._list.select_row(row);
    }

    activateSelected() {
        let row = this._list.get_selected_row();
        if (row)
            row.activate();
    }

    activateSelected() {
        let row = this._list.get_selected_row();
        if (row)
            row.activate();
    }

    _filterRows(row) {
        let matchTerms = this._networksManager.getNetworkMatchTerms(row.id);
        return this._filterTerms.every(term => {
            return matchTerms.some(s => s.includes(term));
        });
    }

    _updateHeader(row, before) {
        if (!before)
            row.set_header(null);
        else if (!row.get_header())
            row.set_header(new Gtk.Separator());
    }

    _networksChanged() {
        this._list.foreach(w => { w.destroy(); });

        let accounts = this._accountsMonitor.accounts;
        let usedNetworks = accounts.filter(a => {
            return this._networksManager.getAccountIsPredefined(a);
        }).map(a => a.service);

        this._networksManager.networks.forEach(network => {
            if (this._favoritesOnly &&
                !this._networksManager.getNetworkIsFavorite(network.id))
                return;

            let sensitive = !usedNetworks.includes(network.id);
            this._rows.set(network.id,
                           new ConnectionRow({ id: network.id,
                                               sensitive: sensitive }));
            this._list.add(this._rows.get(network.id));
        });
    }

    _onRowActivated(list, row) {
        let name = this._networksManager.getNetworkName(row.id);
        let req = new Tp.AccountRequest({ account_manager: Tp.AccountManager.dup(),
                                          connection_manager: 'idle',
                                          protocol: 'irc',
                                          display_name: name });
        req.set_service(row.id);
        req.set_enabled(true);

        let details = this._networksManager.getNetworkDetails(row.id);

        for (let prop in details)
            req.set_parameter(prop, details[prop]);

        req.create_account_async((r, res) => {
            let account = req.create_account_finish(res);
            if (account) // TODO: Handle errors
                this.emit('account-created', account);
        });
        this.emit('account-selected');
    }

    _setAccountRowSensitive(account, sensitive) {
        if (!this._networksManager.getAccountIsPredefined(account))
            return;

        if (!this._rows.has(account.service))
            return;

        this._rows.get(account.service).sensitive = sensitive;
    }

    _sort(row1, row2) {
        let isFavorite1 = this._networksManager.getNetworkIsFavorite(row1.id);
        let isFavorite2 = this._networksManager.getNetworkIsFavorite(row2.id);

        if (isFavorite1 != isFavorite2)
            return isFavorite1 ? -1 : 1;

        let name1 = this._networksManager.getNetworkName(row1.id);
        let name2 = this._networksManager.getNetworkName(row2.id);

        return name1.localeCompare(name2);
    }
});

var ConnectionDetails = GObject.registerClass({
    Template: 'resource:///org/gnome/Polari/ui/connection-details.ui',
    InternalChildren: ['nameEntry',
                       'serverEntry',
                       'nickEntry',
                       'realnameEntry',
                       'sslCheckbox'],
    Properties: { 'can-confirm': GObject.ParamSpec.boolean('can-confirm',
                                                           'can-confirm',
                                                           'can-confirm',
                                                           GObject.ParamFlags.READABLE,
                                                           false),
                  'has-serivce': GObject.ParamSpec.boolean('has-service',
                                                           'has-service',
                                                           'has-service',
                                                           GObject.ParamFlags.READABLE,
                                                           false)},
    Signals: { 'account-created': { param_types: [Tp.Account.$gtype] }},
}, class ConnectionDetails extends Gtk.Grid {
    _init(params) {
        this._networksManager = NetworksManager.getDefault();
        let id = this._networksManager.connect('changed', () => {
            this.notify('has-service');
        });

        this._account = null;

        super._init(params);

        this.connect('destroy', () => {
            this._networksManager.disconnect(id);
        });

        this._nameEntry.connect('changed',
                                this._onCanConfirmChanged.bind(this));
        this._serverEntry.connect('changed',
                                  this._onCanConfirmChanged.bind(this));
        this._nickEntry.connect('changed',
                                this._onCanConfirmChanged.bind(this));
        this._realnameEntry.connect('changed',
                                    this._onCanConfirmChanged.bind(this));
        this._sslCheckbox.connect('toggled',
                                  this._onCanConfirmChanged.bind(this));

        let realnameStore = new Gtk.ListStore();
        realnameStore.set_column_types([GObject.TYPE_STRING]);
        realnameStore.insert_with_valuesv(-1, [0], [GLib.get_real_name()]);

        let completion = new Gtk.EntryCompletion({ model: realnameStore,
                                                   text_column: 0,
                                                   inline_completion: true,
                                                   popup_completion: false });
        this._realnameEntry.set_completion(completion);

        this.reset();
    }

    setErrorHint(hint) {
        if (hint == ErrorHint.SERVER)
            this._serverEntry.get_style_context().add_class('error');
        else
            this._serverEntry.get_style_context().remove_class('error');

        if (hint == ErrorHint.NICK)
            this._nickEntry.get_style_context().add_class('error');
        else
            this._nickEntry.get_style_context().remove_class('error');
    }

    _getParams() {
        let nameText = this._nameEntry.text.trim();
        let serverText = this._serverEntry.text.trim();

        let serverRegEx = /(.*?)(?::(\d{1,5}))?$/;
        let [, server, port] = serverText.match(serverRegEx);

        let params = {
            name: nameText.length ? nameText : server,
            server: server,
            account: this._nickEntry.text.trim()
        };

        if (this._realnameEntry.text)
            params.fullname = this._realnameEntry.text.trim();
        if (this._sslCheckbox.active)
            params.use_ssl = true;
        if (port)
            params.port = port;
        else if (params.use_ssl)
            params.port = DEFAULT_SSL_PORT;

        return params;
    }

    reset() {
        this._savedName = '';
        this._savedServer = '';
        this._savedNick = GLib.get_user_name();
        this._savedRealname = '';
        this._savedSSL = false;

        this._nameEntry.text = this._savedName;
        this._serverEntry.text = this._savedServer;
        this._nickEntry.text = this._savedNick;
        this._realnameEntry.text = this._savedRealname;
        this._sslCheckbox.active = this._savedSSL;

        if (this._serverEntry.visible)
            this._serverEntry.grab_focus();
        else
            this._nickEntry.grab_focus();
    }

    _onCanConfirmChanged() {
        this.notify('can-confirm');
    }

    _populateFromAccount(account) {
        let params = getAccountParams(account);

        this._savedSSL = params['use-ssl'];
        let defaultPort = this._savedSSL ? DEFAULT_SSL_PORT : DEFAULT_PORT;
        this._savedServer = params.server || '';
        let port = params.port;
        this._savedNick = params.account || '';
        this._savedRealname = params.fullname || '';

        if (port != defaultPort)
            this._savedServer += ':%d'.format(port);

        if (this._savedServer != account.display_name)
            this._savedName = account.display_name;

        this._serverEntry.text = this._savedServer;
        this._nickEntry.text = this._savedNick;
        this._realnameEntry.text = this._savedRealname;
        this._nameEntry.text = this._savedName;
        this._sslCheckbox.active = this._savedSSL;
    }

    get can_confirm() {
        let paramsChanged = this._nameEntry.text != this._savedName ||
                            this._serverEntry.text != this._savedServer ||
                            this._nickEntry.text != this._savedNick ||
                            this._realnameEntry.text != this._savedRealname ||
                            this._sslCheckbox.active != this._savedSSL;

        return this._serverEntry.get_text_length() > 0 &&
               this._nickEntry.get_text_length() > 0 &&
               paramsChanged;
    }

    get has_service() {
        return this._networksManager.getAccountIsPredefined(this._account);
    }

    set account(account) {
        this._account = account;
        this.notify('has-service');

        this.reset();
        if (this._account)
            this._populateFromAccount(this._account);
    }

    save() {
        if (!this.can_confirm)
            return;

        if (this._account)
            this._updateAccount();
        else
            this._createAccount();
    }

    _createAccount() {
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

        req.create_account_async((r, res) => {
            let account = req.create_account_finish(res);
            if (account) // TODO: Handle errors
                this.emit('account-created', account);
        });
    }

    _updateAccount() {
        let params = this._getParams();
        let account = this._account;
        let oldDetails = account.dup_parameters_vardict().deep_unpack();
        let [details, removed] = this._detailsFromParams(params, oldDetails);
        let vardict = GLib.Variant.new('a{sv}', details);

        account.update_parameters_vardict_async(vardict, removed, (a, res) => {
            a.update_parameters_vardict_finish(res); // TODO: Check for errors
        });

        account.set_display_name_async(params.name, (a, res) => {
            a.set_display_name_finish(res); // TODO: Check for errors
        });
    }

    _detailsFromParams(params, oldDetails) {
        let details = { account:  GLib.Variant.new('s', params.account),
                        username: GLib.Variant.new('s', params.account),
                        server:   GLib.Variant.new('s', params.server) };

        if (params.port)
            details.port = GLib.Variant.new('u', params.port);
        if (params.fullname)
            details.fullname = GLib.Variant.new('s', params.fullname);
        if (params.use_ssl)
            details['use-ssl'] = GLib.Variant.new('b', params.use_ssl);

        let removed = Object.keys(oldDetails).filter(p => !details.hasOwnProperty(p));

        return [details, removed];
    }
});


var ConnectionProperties = GObject.registerClass({
    Template: 'resource:///org/gnome/Polari/ui/connection-properties.ui',
    InternalChildren: ['details',
                       'errorBox',
                       'errorLabel'],
}, class ConnectionProperties extends Gtk.Dialog {
    _init(account) {
        /* Translators: %s is a connection name */
        let title = _("“%s” Properties").format(account.display_name);
        super._init({ title: title,
                      use_header_bar: 1 });

        this._details.account = account;

        this._details.connect('notify::has-service', () => {
            /* HACK:
             * Shrink back to minimum height when the visibility of
             * some elements in Details could have changed; this
             * assumes that this only happens before the user could
             * resize the dialog herself
             */
            this.resize(this.default_width, 1);
        });

        this.connect('response', (w, response) => {
            if (response == Gtk.ResponseType.OK)
                this._details.save();
        });
        this.set_default_response(Gtk.ResponseType.OK);

        let id = account.connect('notify::connection-status',
                                 this._syncErrorMessage.bind(this));
        this._syncErrorMessage(account);

        this.connect('destroy', () => { account.disconnect(id); });
    }

    _syncErrorMessage(account) {
        let status = account.connection_status;
        let reason = account.connection_status_reason;

        this._errorBox.hide();
        this._details.setErrorHint(ErrorHint.NONE);

        if (status != Tp.ConnectionStatus.DISCONNECTED ||
            reason == Tp.ConnectionStatusReason.REQUESTED)
            return;

        switch (account.connection_error) {
            case Tp.error_get_dbus_name(Tp.Error.CONNECTION_REFUSED):
            case Tp.error_get_dbus_name(Tp.Error.NETWORK_ERROR):
                this._errorBox.show();
                this._errorLabel.label = _("Polari disconnected due to a network error. Please check if the address field is correct.");
                this._details.setErrorHint(ErrorHint.SERVER);
                break;
        }
    }
});
