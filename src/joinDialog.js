const Gdk = imports.gi.Gdk;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Gtk = imports.gi.Gtk;
const Tp = imports.gi.TelepathyGLib;
const Tpl = imports.gi.TelepathyLogger;
const GObject = imports.gi.GObject;

const AccountsMonitor = imports.accountsMonitor;
const Connections = imports.connections;
const Lang = imports.lang;
const Utils = imports.utils;

const DialogPage = {
    MAIN: 0,
    CONNECTION: 1
};

const JoinDialog = new Lang.Class({
    Name: 'JoinDialog',
    Extends: Gtk.Dialog,
    Template: 'resource:///org/gnome/Polari/ui/join-room-dialog.ui',
    InternalChildren: ['cancelButton',
                       'joinButton',
                       'mainStack',
                       'connectionCombo',
                       'connectionButton',
                       'nameCompletion',
                       'connectionStack',
                       'filterEntry',
                       'connectionsList',
                       'serverRoomList',
                       'nameEntry',
                       'spinner',
                       'details',
                       'addButton',
                       'customToggle'],

    _init: function(params) {
        params['use-header-bar'] = 1;
        this.parent(params);

        // TODO: Is there really no way to do this in the template?
        let icon = new Gtk.Image({ icon_name: 'go-previous-symbolic' });
        this._backButton = new Gtk.Button({ image: icon,
                                            valign: Gtk.Align.CENTER,
                                            focus_on_click: false });
        this.get_header_bar().pack_start(this._backButton);

        let accelGroup = new Gtk.AccelGroup();
        this._connectionButton.add_accelerator('clicked', accelGroup,
                                               Gdk.KEY_n,
                                               Gdk.ModifierType.CONTROL_MASK, 0);
        this._backButton.add_accelerator('clicked', accelGroup,
                                         Gdk.KEY_Left,
                                         Gdk.ModifierType.MOD1_MASK, 0);
        this.add_accel_group(accelGroup);

        this._setupMainPage();
        this._setupConnectionPage();

        this._accountsMonitor = AccountsMonitor.getDefault();

        this._accounts = {};
        this._accountsMonitor.enabledAccounts.forEach(a => {
            this._accounts[a.display_name] = a;
        });
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

        this.connect('response', Lang.bind(this,
            function(w, response) {
                if (response == Gtk.ResponseType.OK)
                    this._joinRoom();
                this.destroy();
            }));
        this.connect('destroy', Lang.bind(this,
            function() {
                this._accountsMonitor.disconnect(this._accountAddedId);
                this._accountsMonitor.disconnect(this._accountRemovedId);
            }));

        if (this._hasAccounts)
            this._setPage(DialogPage.MAIN);
        else
            this._setPage(DialogPage.CONNECTION);

        this._updateConnectionCombo();
        this._updateCanJoin();
    },

    get _hasAccounts() {
      return Object.keys(this._accounts).length > 0;
    },

    _setupMainPage: function() {
        this._connectionButton.connect('clicked', Lang.bind(this,
            function() {
                this._setPage(DialogPage.CONNECTION);
            }));

        this._connectionCombo.connect('changed',
                                      Lang.bind(this, this._onAccountChanged));
        this._connectionCombo.sensitive = false;

        this._nameEntry.connect('changed',
                                Lang.bind(this, this._updateCanJoin));
        this._serverRoomList.connect('notify::can-join',
                                     Lang.bind(this, this._updateCanJoin));
        this._serverRoomList.bind_property('loading', this._spinner, 'active',
                                            GObject.BindingFlags.SYNC_CREATE);
    },

    _setupConnectionPage: function() {
        this._backButton.connect('clicked', Lang.bind(this,
            function() {
                this._setPage(DialogPage.MAIN);
            }));
        this._connectionsList.connect('account-selected', Lang.bind(this,
            function() {
                this._setPage(DialogPage.MAIN);
            }));
        this._addButton.connect('clicked', Lang.bind(this,
            function() {
                this._details.save();
                this._setPage(DialogPage.MAIN);
            }));

        this._connectionsList.connect('account-created',
                                      Lang.bind(this, this._onAccountCreated));
        this._details.connect('account-created',
                              Lang.bind(this, this._onAccountCreated));

        this._customToggle.connect('notify::active', Lang.bind(this,
            function() {
                let isCustom = this._customToggle.active;
                this._connectionStack.visible_child_name = isCustom ? 'custom'
                                                                    : 'predefined';
                if (isCustom) {
                    this._addButton.grab_default();
                    this._details.reset();
                }
            }));

        this._filterEntry.connect('search-changed', Lang.bind(this,
            function() {
                this._connectionsList.setFilter(this._filterEntry.text);
            }));
        this._filterEntry.connect('stop-search', Lang.bind(this,
            function() {
                if (this._filterEntry.text.length > 0)
                    this._filterEntry.text = '';
                else
                    this.response(Gtk.ResponseType.CANCEL);
            }));
        this._filterEntry.connect('activate', Lang.bind(this,
            function() {
                if (this._filterEntry.text.length > 0)
                    this._connectionsList.activateFirst();
            }));
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

       this._serverRoomList.setAccount(account);
    },

    _onAccountCreated: function(w, account) {
        this._connectionCombo.set_active_id(account.display_name);
    },

    _joinRoom: function() {
        this.hide();

        let selected = this._connectionCombo.get_active_text();
        let account = this._accounts[selected];

        let toJoinRooms = this._serverRoomList.selectedRooms;
        if (this._nameEntry.get_text_length() > 0)
            toJoinRooms.push(this._nameEntry.get_text());

        toJoinRooms.forEach(function(room) {
            if (room[0] != '#')
                room = '#' + room;

            let app = Gio.Application.get_default();
            let action = app.lookup_action('join-room');
            action.activate(GLib.Variant.new('(ssu)',
                                             [ account.get_object_path(),
                                             room,
                                             Utils.getTpEventTime() ]));
        });
    },

    _updateConnectionCombo: function() {
        this._connectionCombo.remove_all();

        let names = Object.keys(this._accounts).sort(
            function(a, b) {
                // TODO: figure out combo box sorting
                return (a < b) ? -1 : ((a > b) ? 1 : 0);
            });
        for (let i = 0; i < names.length; i++)
            this._connectionCombo.append(names[i], names[i]);
        this._connectionCombo.sensitive = names.length > 1;

        let activeRoom = this.transient_for ? this.transient_for.active_room
                                            : null;
        let activeIndex = 0;
        if(activeRoom)
            activeIndex = Math.max(names.indexOf(activeRoom.account.display_name), 0);
        this._connectionCombo.set_active(activeIndex);
    },

    _updateCanJoin: function() {
        let sensitive = false;

        if (this._page == DialogPage.MAIN)
            sensitive = this._connectionCombo.get_active() > -1  &&
                        (this._nameEntry.get_text_length() > 0 ||
                        this._serverRoomList.can_join);

        this._joinButton.sensitive = sensitive;
        this.set_default_response(sensitive ? Gtk.ResponseType.OK
                                            : Gtk.ResponseType.NONE);
    },

    get _page() {
        if (this._mainStack.visible_child_name == 'connection')
            return DialogPage.CONNECTION;
        else
            return DialogPage.MAIN;
    },

    _setPage: function(page) {
        let isMain = page == DialogPage.MAIN;
        let isAccountsEmpty = !this._hasAccounts;

        if (isMain)
            this._nameEntry.grab_focus();
        else
            this._customToggle.active = false;

        this._joinButton.visible = isMain;
        this._cancelButton.visible = isMain || isAccountsEmpty;
        this._backButton.visible = !(isMain || isAccountsEmpty);
        this.title = isMain ? _("Join Chat Room")
                            : _("Add Network");
        this._mainStack.visible_child_name = isMain ? 'main' : 'connection';
        this._updateCanJoin();
    }
});
