const Gdk = imports.gi.Gdk;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;
const Pango = imports.gi.Pango;
const Tp = imports.gi.TelepathyGLib;

const AccountsMonitor = imports.accountsMonitor;
const Lang = imports.lang;
const RoomManager = imports.roomManager;

function _onPopoverVisibleChanged(popover) {
    let context = popover.relative_to.get_style_context();
    if (popover.visible)
        context.add_class('has-open-popup');
    else
        context.remove_class('has-open-popup');
}

const RoomRow = new Lang.Class({
    Name: 'RoomRow',
    Extends: Gtk.ListBoxRow,
    Template: 'resource:///org/gnome/Polari/ui/room-list-row.ui',
    InternalChildren: ['eventBox', 'icon', 'roomLabel', 'counter'],

    _init: function(room) {
        this.parent();

        this._room = room;
        this._popover = null;

        this._icon.gicon = room.icon;
        this._icon.visible = room.icon != null;

        this._eventBox.connect('button-release-event',
                               Lang.bind(this, this._onButtonRelease));
        this.connect('key-press-event',
                     Lang.bind(this, this._onKeyPress));

        room.connect('notify::channel',
                     Lang.bind(this, this._onChannelChanged));
        room.bind_property('display-name', this._roomLabel, 'label',
                           GObject.BindingFlags.SYNC_CREATE);

        this._updatePending();
        this._onChannelChanged();
    },

    get room() {
        return this._room;
    },

    get account() {
        return this._room.account;
    },

    get hasPending() {
        return !this.get_style_context().has_class('inactive');
    },

    selected: function() {
        if (!this._room.channel)
            this._updatePending();
    },

    _getNumPending: function() {
        if (!this._room.channel)
            return [0, 0];

        let pending = this._room.channel.dup_pending_messages();
        let nPending = pending.length;
        if (!this._room.channel.has_interface(Tp.IFACE_CHANNEL_INTERFACE_GROUP))
            return [nPending, nPending];

        let highlights = pending.filter(m => {
            let [text, ] = m.to_text();
            return this._room.should_highlight_message(m.sender.alias, text);
        });
        return [nPending, highlights.length];
    },

    _updatePending: function() {
        let [nPending, nHighlights] = this._getNumPending();

        this._counter.label = nHighlights.toString();
        this._counter.opacity = nHighlights > 0 ? 1. : 0.;

        let context = this.get_style_context();
        if (nPending == 0)
            context.add_class('inactive');
        else
            context.remove_class('inactive');
    },

    _onChannelChanged: function() {
        if (!this._room.channel)
            return;
        this._room.channel.connect('message-received',
                                   Lang.bind(this, this._updatePending));
        this._room.channel.connect('pending-message-removed',
                                   Lang.bind(this, this._updatePending));
        this._updatePending();
    },

    _onButtonRelease: function(w, event) {
        let [, button] = event.get_button();
        if (button != Gdk.BUTTON_SECONDARY)
            return Gdk.EVENT_PROPAGATE;

        this._showPopover();

        return Gdk.EVENT_STOP;
    },

    _onKeyPress: function(w, event) {
        let [, keyval] = event.get_keyval();
        let [, mods] = event.get_state();
        if (keyval != Gdk.KEY_Menu &&
            !(keyval == Gdk.KEY_F10 &&
              mods & Gdk.ModifierType.SHIFT_MASK))
            return Gdk.EVENT_PROPAGATE;

        this._showPopover();

        return Gdk.EVENT_STOP;
    },

    _showPopover: function() {
        if (!this._popover) {
            let menu = new Gio.Menu();
            let isRoom = this._room.type == Tp.HandleType.ROOM;
            menu.append(isRoom ? _("Leave chatroom") : _("End conversation"),
                        'app.leave-room(("%s", ""))'.format(this._room.id));

            this._popover = Gtk.Popover.new_from_model(this, menu);
            this._popover.connect('notify::visible', _onPopoverVisibleChanged);
            this._popover.position = Gtk.PositionType.BOTTOM;
        }
        this._popover.show();
    }
});

const RoomListHeader = new Lang.Class({
    Name: 'RoomListHeader',
    Extends: Gtk.MenuButton,
    CssName: 'row',
    Template: 'resource:///org/gnome/Polari/ui/room-list-header.ui',
    InternalChildren: ['label',
                       'iconStack',
                       'popoverStatus',
                       'popoverTitle',
                       'popoverPassword',
                       'popoverConnect',
                       'popoverReconnect',
                       'popoverRemove',
                       'popoverProperties',
                       'spinner'],

    _init: function(params) {
        this._account = params.account;
        delete params.account;

        this._networkMonitor = Gio.NetworkMonitor.get_default();
        this._app = Gio.Application.get_default();

        this.parent(params);

        this.popover.set_default_widget(this._popoverPassword);
        this.popover.connect('notify::visible', _onPopoverVisibleChanged);
        this.popover.connect('closed', Lang.bind(this,
            function() {
                this._popoverPassword.text = '';
            }));

        let target = new GLib.Variant('o', this._account.get_object_path());
        this._popoverConnect.action_target = target;
        this._popoverReconnect.action_target = target;
        this._popoverRemove.action_target = target;
        this._popoverProperties.action_target = target;

        this._popoverPassword.connect('activate', Lang.bind(this,
            function() {
                let action = this._app.lookup_action('authenticate-account');
                let password = this._popoverPassword.text;
                let accountPath = this._account.get_object_path();
                let param = new GLib.Variant('(os)', [accountPath, password]);
                action.activate(param);
                this.popover.hide();
            }));

        let displayNameChangedId =
            this._account.connect('notify::display-name',
                                  Lang.bind(this, this._onDisplayNameChanged));
        this._onDisplayNameChanged();

        let connectionStatusChangedId =
            this._account.connect('notify::connection-status',
                                  Lang.bind(this, this._onConnectionStatusChanged));

        let presenceChangedId =
            this._account.connect('notify::requested-presence-type',
                                  Lang.bind(this, this._onRequestedPresenceChanged));
        this._onRequestedPresenceChanged();

        this.connect('destroy', Lang.bind(this, function() {
            this._account.disconnect(displayNameChangedId);
            this._account.disconnect(connectionStatusChangedId);
            this._account.disconnect(presenceChangedId);
        }));
    },

    _onDisplayNameChanged: function() {
        this._label.label = this._account.display_name;

        /* update pop-over status label */
        this._onConnectionStatusChanged();

        let parent;
        do
          parent = this.get_parent();
        while (parent && !(parent instanceof Gtk.ListBox));

        if (parent)
          parent.invalidate_sort();

        let accessibleName = _("Network %s has an error").format(this._account.display_name);
        this.get_accessible().set_name(accessibleName);
    },

    /* hack: Handle primary and secondary button interchangeably */
    vfunc_button_press_event: function(event) {
        if (event.button == Gdk.BUTTON_SECONDARY)
            event.button = Gdk.BUTTON_PRIMARY;
        return this.parent(event);
    },

    vfunc_button_release_event: function(event) {
        if (event.button == Gdk.BUTTON_SECONDARY)
            event.button = Gdk.BUTTON_PRIMARY;
        return this.parent(event);
    },

    _getConnectionStatus: function() {
        let presence = this._account.requested_presence_type;
        if (presence == Tp.ConnectionPresenceType.OFFLINE)
            return Tp.ConnectionStatus.DISCONNECTED;
        return this._account.connection_status;
    },

    _onConnectionStatusChanged: function() {
        let status = this._getConnectionStatus();
        let reason = this._account.connection_status_reason;
        let authError = Tp.error_get_dbus_name(Tp.Error.AUTHENTICATION_FAILED);
        let isError = (status == Tp.ConnectionStatus.DISCONNECTED &&
                       reason != Tp.ConnectionStatusReason.REQUESTED);
        let isAuth = isError && this._account.connection_error == authError;

        let child = 'default';
        if (status == Tp.ConnectionStatus.CONNECTING)
            child = 'connecting';
        else if (isError)
            child = isAuth ? 'auth' : 'error';
        else if (status == Tp.ConnectionStatus.DISCONNECTED)
            child = 'disconnected';

        this._iconStack.visible_child_name = child;
        this._spinner.active = (child == 'connecting');
        this._popoverTitle.visible = !isAuth;

        this._popoverTitle.use_markup = isError;
        this._popoverStatus.use_markup = !isError;

        if (!isError) {
            let styleContext = this._popoverStatus.get_style_context();
            styleContext.add_class('dim-label');

            let params = this._account.dup_parameters_vardict().deep_unpack();
            let server = params['server'].deep_unpack();
            let accountName = this._account.display_name;

            /* Translators: This is an account name followed by a
               server address, e.g. "GNOME (irc.gnome.org)" */
            let fullTitle = _("%s (%s)").format(accountName, server);
            this._popoverTitle.label = (accountName == server) ? accountName : fullTitle;
            this._popoverStatus.label = '<sup>' + this._getStatusLabel() + '</sup>';
        } else {
            let styleContext = this._popoverStatus.get_style_context();
            styleContext.remove_class('dim-label');

            this._popoverTitle.label = '<b>' + _("Connection Problem") + '</b>';
            this._popoverStatus.label = this._getErrorLabel();
        }
    },

    _onRequestedPresenceChanged: function() {
        let presence = this._account.requested_presence_type;
        let offline = presence == Tp.ConnectionPresenceType.OFFLINE;
        this._popoverConnect.visible = offline;
        this._popoverReconnect.visible = !offline;
        this._onConnectionStatusChanged();
    },

    _getStatusLabel: function() {
        switch (this._getConnectionStatus()) {
            case Tp.ConnectionStatus.CONNECTED:
                return _("Connected");
            case Tp.ConnectionStatus.CONNECTING:
                return _("Connecting…");
            case Tp.ConnectionStatus.DISCONNECTED:
                return _("Offline");
            default:
                return _("Unknown");
        }
    },

    _getErrorLabel: function() {
        switch (this._account.connection_error) {

            case Tp.error_get_dbus_name(Tp.Error.CERT_REVOKED):
            case Tp.error_get_dbus_name(Tp.Error.CERT_INSECURE):
            case Tp.error_get_dbus_name(Tp.Error.CERT_LIMIT_EXCEEDED):
            case Tp.error_get_dbus_name(Tp.Error.CERT_INVALID):
            case Tp.error_get_dbus_name(Tp.Error.ENCRYPTION_ERROR):
            case Tp.error_get_dbus_name(Tp.Error.CERT_NOT_PROVIDED):
            case Tp.error_get_dbus_name(Tp.Error.ENCRYPTION_NOT_AVAILABLE):
            case Tp.error_get_dbus_name(Tp.Error.CERT_UNTRUSTED):
            case Tp.error_get_dbus_name(Tp.Error.CERT_EXPIRED):
            case Tp.error_get_dbus_name(Tp.Error.CERT_NOT_ACTIVATED):
            case Tp.error_get_dbus_name(Tp.Error.CERT_HOSTNAME_MISMATCH):
            case Tp.error_get_dbus_name(Tp.Error.CERT_FINGERPRINT_MISMATCH):
            case Tp.error_get_dbus_name(Tp.Error.CERT_SELF_SIGNED):
                return _("Could not connect to %s in a safe way.").format(this._account.display_name);

            case Tp.error_get_dbus_name(Tp.Error.AUTHENTICATION_FAILED):
                return _("%s requires a password.").format(this._account.display_name);

            case Tp.error_get_dbus_name(Tp.Error.CONNECTION_FAILED):
            case Tp.error_get_dbus_name(Tp.Error.CONNECTION_LOST):
            case Tp.error_get_dbus_name(Tp.Error.CONNECTION_REPLACED):
            case Tp.error_get_dbus_name(Tp.Error.SERVICE_BUSY):
                return _("Could not connect to %s. The server is busy.").format(this._account.display_name);

            default:
                return _("Could not connect to %s.").format(this._account.display_name);
        }
    },
});

const RoomList = new Lang.Class({
    Name: 'RoomList',
    Extends: Gtk.ListBox,

    _init: function(params) {
        this.parent(params);

        this.set_header_func(Lang.bind(this, this._updateHeader));
        this.set_sort_func(Lang.bind(this, this._sort));

        this._placeholders = new Map();
        this._roomRows = new Map();

        this._accountsMonitor = AccountsMonitor.getDefault();
        this._accountsMonitor.connect('account-added',
                                      Lang.bind(this, this._accountAdded));
        this._accountsMonitor.connect('account-removed',
                                      Lang.bind(this, this._accountRemoved));
        this._accountsMonitor.connect('account-enabled', (mon, account) => {
            this._updatePlaceholderVisibility(account);
        });
        this._accountsMonitor.connect('account-disabled', (mon, account) => {
            this._updatePlaceholderVisibility(account);
        });
        this._accountsMonitor.prepare(() => {
            this._accountsMonitor.accounts.forEach(account => {
                this._accountAdded(this._accountsMonitor, account);
            });
        });

        this._roomManager = RoomManager.getDefault();
        this._roomManager.connect('room-added',
                                  Lang.bind(this, this._roomAdded));
        this._roomManager.connect('room-removed',
                                  Lang.bind(this, this._roomRemoved));
        this._roomManager.rooms.forEach(r => { this._roomAdded(this._roomManager, r); });

        let app = Gio.Application.get_default();
        let actions = [
            { name: 'next-room',
              handler: () => { this._moveSelection(Gtk.DirectionType.DOWN); } },
            { name: 'previous-room',
              handler: () => { this._moveSelection(Gtk.DirectionType.UP); } },
            { name: 'first-room',
              handler: () => { this._selectRoomAtIndex(0); } },
            { name: 'last-room',
              handler: () => {
                  let nRows = this._roomManager.roomCount;
                  this._selectRoomAtIndex(nRows - 1);
              } },
            { name: 'nth-room',
              handler: (a, param) => {
                  this._selectRoomAtIndex(param.get_int32() - 1);
              } },
            { name: 'next-pending-room',
              handler: () => { this._moveSelectionFull(Gtk.DirectionType.DOWN,
                                                       row => row.hasPending); } },
            { name: 'previous-pending-room',
              handler: () => { this._moveSelectionFull(Gtk.DirectionType.UP,
                                                       row => row.hasPending); } }
        ];
        actions.forEach(a => {
            app.lookup_action(a.name).connect('activate', a.handler);
        });
    },

    vfunc_realize: function() {
        this.parent();

        let toplevel = this.get_toplevel();
        toplevel.connect('notify::active-room',
                         Lang.bind(this, this._activeRoomChanged));
        this._activeRoomChanged();
    },

    _rowToRoomIndex: function(index) {
        let placeholders = [...this._placeholders.values()];
        let nBefore = placeholders.filter(p => p.get_index() < index).length;
        return index - nBefore;
    },

    _roomToRowIndex: function(index) {
        let nChildren = this.get_children().length;
        for (let i = 0, roomIndex = 0; i < nChildren; i++)
            if (this.get_row_at_index(i).room && roomIndex++ == index)
                return i;
        return -1;
    },

    _getRoomRowAtIndex: function(index) {
        return this.get_row_at_index(this._roomToRowIndex(index));
    },

    _selectRoomAtIndex: function(index) {
        let row = this._getRoomRowAtIndex(index);
        if (row)
            this.select_row(row);
    },

    _moveSelection: function(direction) {
        this._moveSelectionFull(direction, () => { return true; });
    },

    _moveSelectionFull: function(direction, testFunction){
        let current = this.get_selected_row();
        if (!current)
            return;

        let inc = direction == Gtk.DirectionType.UP ? -1 : 1;
        let index = this._rowToRoomIndex(current.get_index());

        let row = current;

        do {
            index += inc;
            row = this._getRoomRowAtIndex(index);
        } while (row && !testFunction(row));

        if (row)
            this.select_row(row);
    },

    _moveSelectionFromRow: function(row) {
        if (this._roomManager.roomCount == 0)
            return;

        let toplevel = this.get_toplevel();
        let current = this._roomRows.get(toplevel.active_room.id);

        if (current != row)
            return;

        let selected = this.get_selected_row();
        let newActive = null;

        let index = this._rowToRoomIndex(row.get_index());
        this.select_row(row);
        this._moveSelection(index == 0 ? Gtk.DirectionType.DOWN
                                       : Gtk.DirectionType.UP);

        let newSelected = this.get_selected_row();
        if (newSelected != row)
            newActive = newSelected.room;
        toplevel.active_room = newActive;

        if (selected != row)
            this.select_row(selected);
    },

    _accountAdded: function(am, account) {
        if (this._placeholders.has(account))
            return;

        let placeholder = new Gtk.ListBoxRow({ selectable: false,
                                               activatable: false,
                                               no_show_all: true });
        placeholder.account = account;

        this._placeholders.set(account, placeholder);
        this.add(placeholder);

        placeholder.connect('notify::visible', Lang.bind(this,
            function() {
                this.invalidate_sort();
            }));

        this._updatePlaceholderVisibility(account);
    },

    _accountRemoved: function(am, account) {
        let placeholder = this._placeholders.get(account);

        if (!placeholder)
            return;

        this._placeholders.delete(account);
        placeholder.destroy();
    },

    _roomAdded: function(roomManager, room) {
        if (this._roomRows.has(room.id))
            return;

        let row = new RoomRow(room);
        this.add(row);
        this._roomRows.set(room.id, row);

        row.connect('destroy', w => { this._roomRows.delete(w.room.id); });
        this._placeholders.get(room.account).hide();
    },

    _roomRemoved: function(roomManager, room) {
        let row = this._roomRows.get(room.id);
        if (!row)
            return;

        this._moveSelectionFromRow(row);
        row.destroy();
        this._roomRows.delete(room.id);
        this._updatePlaceholderVisibility(room.account);
    },

    _updatePlaceholderVisibility: function(account) {
        if (!account.enabled) {
            this._placeholders.get(account).hide();
            return;
        }

        let rows = [...this._roomRows.values()];
        let hasRooms = rows.some(r => r.account == account);
        this._placeholders.get(account).visible = !hasRooms;
    },

    _activeRoomChanged: function() {
        let room = this.get_toplevel().active_room;
        if (!room)
            return;
        let row = this._roomRows.get(room.id);
        if (!row)
            return;

        row.can_focus = false;
        this.select_row(row);
        row.can_focus = true;
    },

    vfunc_row_selected: function(row) {
        this.get_toplevel().active_room = row ? row.room : null;
        if (row)
            row.selected();
    },

    _updateHeader: function(row, before) {
        let getAccount = function(row) {
            return row ? row.account : null;
        };
        let beforeAccount = getAccount(before);
        let account = getAccount(row);

        let oldHeader = row.get_header();

        if (beforeAccount == account) {
            if (oldHeader)
                oldHeader.destroy();
            return;
        }

        if (oldHeader)
            return;

        let roomListHeader = new RoomListHeader({ account: account });
        row.set_header(roomListHeader);
    },

    _sort: function(row1, row2) {
        let account1 = row1.account;
        let account2 = row2.account;

        let hasRooms1 = !this._placeholders.get(account1).visible;
        let hasRooms2 = !this._placeholders.get(account2).visible;

        if (hasRooms1 != hasRooms2)
            return hasRooms1 ? -1 : 1;


        if (account1 != account2) {
            let displayName1 = account1.display_name;
            let displayName2 = account2.display_name;

            if (displayName1 != displayName2)
                return displayName1.localeCompare(displayName2);

            // Different account with the same display name :-(
            // Fall back to the object path to guarantee a stable sort order
            let accountPath1 = account1.get_path_suffix();
            let accountPath2 = account2.get_path_suffix();
            return accountPath1.localeCompare(accountPath2);
        }

        let room1 = row1.room;
        let room2 = row2.room;

        if (!room1)
            return -1;

        if (!room2)
            return 1;

        if (room1.type != room2.type)
            return room1.type == Tp.HandleType.ROOM ? -1 : 1;

        return room1.display_name.localeCompare(room2.display_name);
    }
});
