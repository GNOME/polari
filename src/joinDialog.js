const Gdk = imports.gi.Gdk;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;

const {AccountsMonitor} = imports.accountsMonitor;
const Utils = imports.utils;

const DialogPage = {
    MAIN: 0,
    CONNECTION: 1
};

var JoinDialog = GObject.registerClass({
    Template: 'resource:///org/gnome/Polari/ui/join-room-dialog.ui',
    InternalChildren: ['cancelButton',
                       'joinButton',
                       'mainStack',
                       'connectionCombo',
                       'connectionButton',
                       'connectionStack',
                       'filterEntry',
                       'connectionsList',
                       'serverRoomList',
                       'details',
                       'addButton',
                       'customToggle'],
}, class JoinDialog extends Gtk.Dialog {
    _init(params) {
        params['use-header-bar'] = 1;
        super._init(params);

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

        this._accounts = new Map();
        this._accountsMonitor.visibleAccounts.forEach(a => {
            this._accounts.set(a.display_name, a);
        });
        this._accountAddedId =
            this._accountsMonitor.connect('account-added', (am, account) => {
                this._accounts.set(account.display_name, account);
                this._updateConnectionCombo();
            });
        this._accountRemovedId =
            this._accountsMonitor.connect('account-removed', (am, account) => {
                this._accounts.delete(account.display_name);
                this._updateConnectionCombo();
            });

        this.connect('response', (w, response) => {
            if (response == Gtk.ResponseType.OK)
                this._joinRoom();
            this.destroy();
        });
        this.connect('destroy', () => {
            this._accountsMonitor.disconnect(this._accountAddedId);
            this._accountsMonitor.disconnect(this._accountRemovedId);
        });

        if (this._hasAccounts)
            this._setPage(DialogPage.MAIN);
        else
            this._setPage(DialogPage.CONNECTION);

        this._updateConnectionCombo();
        this._updateCanJoin();
    }

    get _hasAccounts() {
      return this._accounts.size > 0;
    }

    _setupMainPage() {
        this._connectionButton.connect('clicked', () => {
            this._setPage(DialogPage.CONNECTION);
        });

        this._connectionCombo.connect('changed',
                                      this._onAccountChanged.bind(this));
        this._connectionCombo.sensitive = false;

        this._serverRoomList.connect('notify::can-join',
                                     this._updateCanJoin.bind(this));
    }

    _setupConnectionPage() {
        this._backButton.connect('clicked', () => {
            this._setPage(DialogPage.MAIN);
        });
        this._connectionsList.connect('account-selected', () => {
            this._setPage(DialogPage.MAIN);
        });
        this._addButton.connect('clicked', () => {
            this._details.save();
            this._setPage(DialogPage.MAIN);
        });

        this._connectionsList.connect('account-created',
                                      this._onAccountCreated.bind(this));
        this._details.connect('account-created',
                              this._onAccountCreated.bind(this));

        this._customToggle.connect('notify::active', () => {
            let isCustom = this._customToggle.active;
            this._connectionStack.visible_child_name = isCustom ? 'custom'
                                                                : 'predefined';
            if (isCustom) {
                this._addButton.grab_default();
                this._details.reset();
            }
        });

        this._filterEntry.connect('search-changed', () => {
            this._connectionsList.setFilter(this._filterEntry.text);
        });
        this._filterEntry.connect('stop-search', () => {
            if (this._filterEntry.text.length > 0)
                this._filterEntry.text = '';
            else
                this.response(Gtk.ResponseType.CANCEL);
        });
        this._filterEntry.connect('activate', () => {
            if (this._filterEntry.text.length > 0)
                this._connectionsList.activateSelected();
        });
    }

    _onAccountChanged() {
        let selected = this._connectionCombo.get_active_text();
        let account = this._accounts.get(selected);
        if (!account)
            return;

       this._serverRoomList.setAccount(account);
    }

    _onAccountCreated(w, account) {
        this._connectionCombo.set_active_id(account.display_name);
    }

    _joinRoom() {
        this.hide();

        let selected = this._connectionCombo.get_active_text();
        let account = this._accounts.get(selected);

        let toJoinRooms = this._serverRoomList.selectedRooms;
        toJoinRooms.forEach(room => {
            if (room[0] != '#')
                room = '#' + room;

            let app = Gio.Application.get_default();
            let action = app.lookup_action('join-room');
            action.activate(GLib.Variant.new('(ssu)',
                                             [ account.get_object_path(),
                                             room,
                                             Utils.getTpEventTime() ]));
        });
    }

    _updateConnectionCombo() {
        this._connectionCombo.remove_all();

        let names = [...this._accounts.keys()].sort((a, b) => {
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
    }

    _updateCanJoin() {
        let sensitive = false;

        if (this._page == DialogPage.MAIN)
            sensitive = this._connectionCombo.get_active() > -1  &&
                        this._serverRoomList.can_join;

        this._joinButton.sensitive = sensitive;
        this.set_default_response(sensitive ? Gtk.ResponseType.OK
                                            : Gtk.ResponseType.NONE);
    }

    get _page() {
        if (this._mainStack.visible_child_name == 'connection')
            return DialogPage.CONNECTION;
        else
            return DialogPage.MAIN;
    }

    _setPage(page) {
        let isMain = page == DialogPage.MAIN;
        let isAccountsEmpty = !this._hasAccounts;

        if (isMain)
            this._serverRoomList.focusEntry();
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
