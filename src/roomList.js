// SPDX-FileCopyrightText: 2013 Florian Müllner <fmuellner@gnome.org>
// SPDX-FileCopyrightText: 2015 Bastian Ilsø <bastianilso@gnome.org>
// SPDX-FileCopyrightText: 2016 Isabella Ribeiro <belinhacbr@gmail.com>
// SPDX-FileCopyrightText: 2016 raresv <rares.visalom@gmail.com>
// SPDX-FileCopyrightText: 2018 unkemptArc99 <abhishekbhardwaj540@gmail.com>
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';
import Tp from 'gi://TelepathyGLib';

import AccountsMonitor from './accountsMonitor.js';
import RoomManager from './roomManager.js';
import UserStatusMonitor from './userTracker.js';

const MIN_SPINNER_TIME = 1000000;   // in microsecond

function _onPopoverVisibleChanged(popover) {
    if (popover.visible)
        popover.get_parent().add_css_class('has-open-popup');
    else
        popover.get_parent().remove_css_class('has-open-popup');
}

const RoomRow = GObject.registerClass(
class RoomRow extends Gtk.ListBoxRow {
    static [Gtk.template] = 'resource:///org/gnome/Polari/ui/room-list-row.ui';
    static [Gtk.internalChildren] = [
        'box',
        'icon',
        'roomLabel',
        'counter',
        'eventStack',
    ];

    constructor(room) {
        super({
            name: `RoomRow ${room.display_name}`,
            actionName: 'navigation.push',
            actionTarget: new GLib.Variant('s', 'content'),
        });

        this._room = room;
        this._popover = null;

        const mon = UserStatusMonitor.getDefault();
        this._userTracker = mon.getUserTrackerForAccount(this.account);

        this._connectingTimeoutId = 0;

        this._mutedIcon = new Gio.EmblemedIcon({gicon: room.icon});
        this._mutedIcon.add_emblem(new Gio.Emblem({
            icon: new Gio.ThemedIcon({name: 'emblem-unreadable'}),
        }));

        this._icon.visible = room.icon !== null;

        this._keyController = new Gtk.EventControllerKey();
        this._keyController.connect('key-pressed', this._onKeyPressed.bind(this));
        this.add_controller(this._keyController);

        this._clickGesture = new Gtk.GestureClick({
            button: Gdk.BUTTON_SECONDARY,
        });
        this._clickGesture.connect('released',
            this._onButtonReleased.bind(this));
        this._box.add_controller(this._clickGesture);

        room.bind_property('display-name',
            this._roomLabel, 'label',
            GObject.BindingFlags.SYNC_CREATE);

        let channelChangedId = room.connect('notify::channel',
            this._onChannelChanged.bind(this));

        let connectionStatusChangedId = 0;
        let mutedChangedId = 0;

        if (this._room.type === Tp.HandleType.ROOM) {
            connectionStatusChangedId =
                this.account.connect('notify::connection-status',
                    this._onConnectionStatusChanged.bind(this));
            this._onConnectionStatusChanged();
        } else {
            mutedChangedId = this._userTracker.connect(
                `muted-changed::${room.channel_name}`,
                this._onMutedChanged.bind(this));
            this._onMutedChanged();
        }

        this.connect('destroy', () => {
            room.disconnect(channelChangedId);
            this._channelSignals.forEach(id => {
                room.channel.disconnect(id);
            });
            if (mutedChangedId)
                this._userTracker.disconnect(mutedChangedId);
            if (connectionStatusChangedId)
                this.account.disconnect(connectionStatusChangedId);
            this._clearConnectingTimeout();
        });

        this._updatePending();
        this._onChannelChanged();
        this._eventStack.visible_child_name = 'messages';
    }

    get room() {
        return this._room;
    }

    get account() {
        return this._room.account;
    }

    get hasPending() {
        return !this.get_style_context().has_class('inactive');
    }

    get muted() {
        return this._userTracker.isMuted(this._room.channel_name);
    }

    selected() {
        if (!this._room.channel)
            this._updatePending();
    }

    _getNumPending() {
        if (!this._room.channel)
            return [0, 0];

        let pending = this._room.channel.dup_pending_messages();
        let nPending = pending.length;

        if (this.muted)
            return [nPending, 0];

        let highlights = pending.filter(m => {
            let [text] = m.to_text();
            return this._room.should_highlight_message(m.sender.alias, text);
        });
        return [nPending, highlights.length];
    }

    _getConnectionStatus() {
        let presence = this.account.requested_presence_type;
        if (presence === Tp.ConnectionPresenceType.OFFLINE)
            return Tp.ConnectionStatus.DISCONNECTED;
        return this.account.connection_status;
    }

    _onConnectionStatusChanged() {
        let status = this._getConnectionStatus();
        // Show loading indicator if joining a room takes more than 3 seconds
        if (status === Tp.ConnectionStatus.CONNECTED && !this._room.channel) {
            this._connectingTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 3, () => {
                this._connectingTimeoutId = 0;

                if (this._room.channel)
                    return GLib.SOURCE_REMOVE;
                this._eventStack.visible_child_name = 'connecting';
                return GLib.SOURCE_REMOVE;
            });
        } else {
            this._clearConnectingTimeout();
            this._eventStack.visible_child_name = 'messages';
        }
    }

    _onMutedChanged() {
        if (this.muted) {
            this._icon.gicon = this._mutedIcon;
            this.add_css_class('muted');
        } else {
            this._icon.gicon = this.room.icon;
            this.remove_css_class('muted');
        }

        this._updatePending();
    }

    _updatePending() {
        let [nPending, nHighlights] = this._getNumPending();

        this._counter.label = nHighlights.toString();
        this._counter.opacity = nHighlights > 0 ? 1. : 0.;

        if (nPending === 0)
            this.add_css_class('inactive');
        else
            this.remove_css_class('inactive');
    }

    _onChannelChanged() {
        this._channelSignals = [];

        if (!this._room.channel)
            return;
        this._clearConnectingTimeout();
        this._eventStack.visible_child_name = 'messages';

        for (let signal of ['message-received', 'pending-message-removed']) {
            this._channelSignals.push(
                this._room.channel.connect(signal,
                    this._updatePending.bind(this)));
        }
        this._updatePending();
    }

    _onButtonReleased(controller) {
        controller.set_state(Gtk.EventSequenceState.CLAIMED);
        this._showPopover();
    }

    _onKeyPressed(controller, keyval, keycode, mods) {
        if (keyval !== Gdk.KEY_Menu &&
            !(keyval === Gdk.KEY_F10 &&
              mods & Gdk.ModifierType.SHIFT_MASK))
            return Gdk.EVENT_PROPAGATE;

        this._showPopover();

        return Gdk.EVENT_STOP;
    }

    _showPopover() {
        if (!this._popover)
            this._popover = new RoomRowPopover(this);
        this._popover.popup();
    }

    _clearConnectingTimeout() {
        if (this._connectingTimeoutId)
            GLib.source_remove(this._connectingTimeoutId);
        this._connectingTimeoutId = 0;
    }
});

const RoomRowPopover = GObject.registerClass(
class RoomRowPopover extends Gtk.PopoverMenu {
    constructor(row) {
        super({
            position: Gtk.PositionType.BOTTOM,
        });
        this.set_parent(row);

        this.connect('notify::visible', _onPopoverVisibleChanged);

        this._row = row;
        this._menu = new Gio.Menu();
        const isRoom = row.room.type === Tp.HandleType.ROOM;

        if (!isRoom) {
            this._muteItem = new Gio.MenuItem();
            this._muteTarget = new GLib.Variant('(ss)', [
                row.account.object_path,
                row.room.channel_name,
            ]);
            this._menu.append_item(this._muteItem);
        }

        const label = isRoom ?  _('Leave chatroom') : _('End conversation');
        this._menu.append(label, `app.leave-room(("${this._row.room.id}", ""))`);

        this.set_menu_model(this._menu);
    }

    vfunc_map() {
        if (this._row.room.type !== Tp.HandleType.ROOM)
            this._updateMuteItem();
        this._previousFocus = this.get_root().get_focus();
        super.vfunc_map();
    }

    vfunc_unmap() {
        this._previousFocus.grab_focus();
        super.vfunc_unmap();
    }

    _updateMuteItem() {
        this._menu.remove(0);

        if (this._row.muted) {
            this._muteItem.set_label(_('Unmute'));
            this._muteItem.set_action_and_target_value(
                'app.unmute-nick', this._muteTarget);
        } else {
            this._muteItem.set_label(_('Mute'));
            this._muteItem.set_action_and_target_value(
                'app.mute-nick', this._muteTarget);
        }

        this._menu.insert_item(0, this._muteItem);
    }
});

const RoomListHeader = GObject.registerClass(
class RoomListHeader extends Gtk.Widget {
    static [Gtk.cssName] = 'row';
    static [Gtk.template] = 'resource:///org/gnome/Polari/ui/room-list-header.ui';
    static [Gtk.internalChildren] = [
        'label',
        'iconStack',
        'popoverStatus',
        'popoverTitle',
        'popoverPassword',
        'popoverConnect',
        'popoverDisconnect',
        'popoverReconnect',
        'popoverRemove',
        'popoverProperties',
        'spinner',
    ];

    static [GObject.properties] = {
        'popover': GObject.ParamSpec.object(
            'popover', null, null,
            GObject.ParamFlags.READWRITE,
            Gtk.Popover.$gtype),
    };

    static [GObject.signals] = {
        'activate': {flags: GObject.SignalFlags.ACTION},
    };

    static _classInit(klass) {
        klass = Gtk.Widget._classInit(klass);

        Gtk.Widget.set_activate_signal_from_name.call(klass, 'activate');
        Gtk.Widget.set_layout_manager_type = Gtk.GridLayout;

        return klass;
    }

    constructor(params) {
        const {account} = params;
        delete params.account;

        super({
            ...params,
            name: `RoomListHeader ${account.display_name}`,
        });

        this._account = account;

        this._app = Gio.Application.get_default();

        this.connect('activate',
            () => this._popover?.popup());

        this._clickGesture = new Gtk.GestureClick({
            propagation_phase: Gtk.PropagationPhase.CAPTURE,
            button: 0,
        });
        this.add_controller(this._clickGesture);

        this._clickGesture.connect('released', () => {
            const button = this._clickGesture.get_current_button();
            if (button !== Gdk.BUTTON_PRIMARY && button !== Gdk.BUTTON_SECONDARY)
                return;

            this._clickGesture.set_state(Gtk.EventSequenceState.CLAIMED);

            this._previousFocus = this.get_root().get_focus();
            this._popover?.popup();
        });

        this.popover.name = `ConnectionPopover ${this._account.display_name}`;

        this.popover.set_default_widget(this._popoverPassword);
        this.popover.connect('notify::visible', _onPopoverVisibleChanged);
        this.popover.connect('closed', () => {
            this._popoverPassword.text = '';
            this._previousFocus?.grab_focus();
        });

        let target = new GLib.Variant('o', this._account.get_object_path());
        this._popoverConnect.action_target = target;
        this._popoverConnect.action_name = 'app.connect-account';
        this._popoverDisconnect.action_target = target;
        this._popoverDisconnect.action_name = 'app.disconnect-account';
        this._popoverReconnect.action_target = target;
        this._popoverReconnect.action_name = 'app.reconnect-account';
        this._popoverRemove.action_target = target;
        this._popoverRemove.action_name = 'app.remove-connection';
        this._popoverProperties.action_target = target;
        this._popoverProperties.action_name = 'app.edit-connection';

        this._popoverPassword.connect('activate', () => {
            let action = this._app.lookup_action('authenticate-account');
            let password = this._popoverPassword.text;
            let accountPath = this._account.get_object_path();
            let param = new GLib.Variant('(os)', [accountPath, password]);
            action.activate(param);
            this.popover.hide();
        });

        this._spinnerActivationTime = 0;

        let displayNameChangedId =
            this._account.connect('notify::display-name',
                this._onDisplayNameChanged.bind(this));
        this._onDisplayNameChanged();

        let connectionStatusChangedId =
            this._account.connect('notify::connection-status',
                this._onConnectionStatusChanged.bind(this));

        let presenceChangedId =
            this._account.connect('notify::requested-presence-type',
                this._onRequestedPresenceChanged.bind(this));
        this._onRequestedPresenceChanged();

        this.connect('destroy', () => {
            this._account.disconnect(displayNameChangedId);
            this._account.disconnect(connectionStatusChangedId);
            this._account.disconnect(presenceChangedId);
        });
    }

    get popover() {
        return this._popover;
    }

    set popover(popover) {
        if (this._popover === popover)
            return;

        this._popover?.unparent();
        this._popover?.run_dispose();

        this._popover = popover;

        this._popover?.set_parent(this);

        this.notify('popover');
    }

    _onDisplayNameChanged() {
        this._label.label = this._account.display_name;

        /* update pop-over status label */
        this._onConnectionStatusChanged();

        let parent;
        do
            parent = this.get_parent();
        while (parent && !(parent instanceof Gtk.ListBox));

        if (parent)
            parent.invalidate_sort();

        let accessibleName = vprintf(_('Network %s has an error'), this._account.display_name);
        this.update_property(
            [Gtk.AccessibleProperty.LABEL], [accessibleName]);
    }

    _getConnectionStatus() {
        let presence = this._account.requested_presence_type;
        if (presence === Tp.ConnectionPresenceType.OFFLINE)
            return Tp.ConnectionStatus.DISCONNECTED;
        return this._account.connection_status;
    }

    _onConnectionStatusChanged() {
        let status = this._getConnectionStatus();
        let reason = this._account.connection_status_reason;
        let authError = Tp.error_get_dbus_name(Tp.Error.AUTHENTICATION_FAILED);
        let isError = status === Tp.ConnectionStatus.DISCONNECTED &&
                      reason !== Tp.ConnectionStatusReason.REQUESTED;
        let isAuth = isError && this._account.connection_error === authError;

        let child = 'default';
        if (status === Tp.ConnectionStatus.CONNECTING)
            child = 'connecting';
        else if (isError)
            child = isAuth ? 'auth' : 'error';
        else if (status === Tp.ConnectionStatus.DISCONNECTED)
            child = 'disconnected';

        if (isError && this._spinner.get_mapped()) {
            let spinnerTime = GLib.get_monotonic_time() - this._spinnerActivationTime;
            if (spinnerTime < MIN_SPINNER_TIME) {
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, (MIN_SPINNER_TIME - spinnerTime) / 1000, () => {
                    this._onConnectionStatusChanged();
                    return GLib.SOURCE_REMOVE;
                });
                return;
            }
        }

        this._iconStack.visible_child_name = child;
        this._popoverTitle.visible = !isAuth;

        if (this._spinner.get_mapped())
            this._spinnerActivationTime = GLib.get_monotonic_time();

        if (!isError) {
            this._popoverStatus.add_css_class('dim-label');
            this._popoverStatus.add_css_class('caption');
            this._popoverTitle.remove_css_class('heading');

            let params = this._account.dup_parameters_vardict().deep_unpack();
            let server = params['server'].deep_unpack();
            let accountName = this._account.display_name;

            /* Translators: This is an account name followed by a
               server address, e.g. "Libera (irc.libera.chat)" */
            let fullTitle = vprintf(_('%s (%s)'), accountName, server);
            this._popoverTitle.label = accountName === server ? accountName : fullTitle;
            this._popoverStatus.label = this._getStatusLabel();
        } else {
            this._popoverStatus.remove_css_class('dim-label');
            this._popoverStatus.remove_css_class('caption');
            this._popoverTitle.add_css_class('heading');

            this._popoverTitle.label = _('Connection Problem');
            this._popoverStatus.label = this._getErrorLabel();
        }
    }

    _onRequestedPresenceChanged() {
        let presence = this._account.requested_presence_type;
        let offline = presence === Tp.ConnectionPresenceType.OFFLINE;
        this._popoverConnect.visible = offline;
        this._popoverDisconnect.visible = !offline;
        this._popoverReconnect.visible = !offline;
        this._onConnectionStatusChanged();
    }

    _getStatusLabel() {
        switch (this._getConnectionStatus()) {
        case Tp.ConnectionStatus.CONNECTED:
            return _('Connected');
        case Tp.ConnectionStatus.CONNECTING:
            return _('Connecting…');
        case Tp.ConnectionStatus.DISCONNECTED:
            return _('Offline');
        default:
            return _('Unknown');
        }
    }

    _getErrorLabel() {
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
            return vprintf(_('Could not connect to %s in a safe way.'), this._account.display_name);

        case Tp.error_get_dbus_name(Tp.Error.AUTHENTICATION_FAILED):
            return vprintf(_('%s requires a password.'), this._account.display_name);

        case Tp.error_get_dbus_name(Tp.Error.CONNECTION_FAILED):
        case Tp.error_get_dbus_name(Tp.Error.CONNECTION_LOST):
        case Tp.error_get_dbus_name(Tp.Error.CONNECTION_REPLACED):
        case Tp.error_get_dbus_name(Tp.Error.SERVICE_BUSY):
            return vprintf(_('Could not connect to %s. The server is busy.'), this._account.display_name);

        default:
            return vprintf(_('Could not connect to %s.'), this._account.display_name);
        }
    }
});

export default GObject.registerClass(
class RoomList extends Gtk.ListBox {
    constructor(params) {
        super(params);

        this.set_header_func(this._updateHeader.bind(this));
        this.set_sort_func(this._sort.bind(this));

        this._placeholders = new Map();
        this._roomRows = new Map();

        this._accountsMonitor = AccountsMonitor.getDefault();
        this._accountsMonitor.connect('account-added',
            this._accountAdded.bind(this));
        this._accountsMonitor.connect('account-removed',
            this._accountRemoved.bind(this));
        this._accountsMonitor.connect('account-shown', (mon, account) => {
            this._updatePlaceholderVisibility(account);
        });
        this._accountsMonitor.connect('account-hidden', (mon, account) => {
            this._updatePlaceholderVisibility(account);
        });
        this._accountsMonitor.prepare(() => {
            this._accountsMonitor.accounts.forEach(account => {
                this._accountAdded(this._accountsMonitor, account);
            });
        });

        this._roomManager = RoomManager.getDefault();
        this._roomManager.connect('room-added',
            this._roomAdded.bind(this));
        this._roomManager.connect('room-removed',
            this._roomRemoved.bind(this));
        this._roomManager.rooms.forEach(r => this._roomAdded(this._roomManager, r));

        let app = Gio.Application.get_default();
        let actions = [{
            name: 'next-room',
            handler: () => this._moveSelection(Gtk.DirectionType.DOWN),
        }, {
            name: 'previous-room',
            handler: () => this._moveSelection(Gtk.DirectionType.UP),
        }, {
            name: 'first-room',
            handler: () => this._selectRoomAtIndex(0),
        }, {
            name: 'last-room',
            handler: () => {
                let nRows = this._roomManager.roomCount;
                this._selectRoomAtIndex(nRows - 1);
            },
        }, {
            name: 'nth-room',
            handler: (a, param) => {
                this._selectRoomAtIndex(param.get_int32() - 1);
            },
        }, {
            name: 'next-pending-room',
            handler: () => {
                this._moveSelectionFull(Gtk.DirectionType.DOWN,
                    row => row.hasPending && !row.muted);
            },
        }, {
            name: 'previous-pending-room',
            handler: () => {
                this._moveSelectionFull(Gtk.DirectionType.UP,
                    row => row.hasPending && !row.muted);
            },
        }];
        actions.forEach(a => {
            app.lookup_action(a.name).connect('activate', a.handler);
        });
    }

    vfunc_realize() {
        super.vfunc_realize();

        const toplevel = this.get_root();
        this._toplevelSignals = [
            toplevel.connect('notify::active-room',
                () => this._activeRoomChanged()),
        ];
        this._activeRoomChanged();
    }

    vfunc_unrealize() {
        super.vfunc_unrealize();

        const toplevel = this.get_root();
        this._toplevelSignals.forEach(id => toplevel.disconnect(id));
        this._toplevelSignals = [];
    }

    _rowToRoomIndex(index) {
        let placeholders = [...this._placeholders.values()];
        let nBefore = placeholders.filter(p => p.get_index() < index).length;
        return index - nBefore;
    }

    _roomToRowIndex(index) {
        let roomRows = [...this].filter(r => r instanceof RoomRow);
        return index >= 0 && index < roomRows.length ? roomRows[index].get_index() : -1;
    }

    _getRoomRowAtIndex(index) {
        return this.get_row_at_index(this._roomToRowIndex(index));
    }

    _selectRoomAtIndex(index) {
        let row = this._getRoomRowAtIndex(index);
        if (row)
            this.select_row(row);
    }

    _moveSelection(direction) {
        this._moveSelectionFull(direction, () => true);
    }

    _moveSelectionFull(direction, testFunction) {
        let current = this.get_selected_row();
        if (!current)
            return;

        let inc = direction === Gtk.DirectionType.UP ? -1 : 1;
        let index = this._rowToRoomIndex(current.get_index());

        let row = current;

        do {
            index += inc;
            row = this._getRoomRowAtIndex(index);
        } while (row && !testFunction(row));

        if (row)
            this.select_row(row);
    }

    _moveSelectionFromRow(row) {
        if (this._roomManager.roomCount === 0)
            return;

        const toplevel = this.get_root();
        let current = this._roomRows.get(toplevel.active_room.id);

        if (current !== row)
            return;

        let selected = this.get_selected_row();
        let newActive = null;

        let index = this._rowToRoomIndex(row.get_index());
        this.select_row(row);
        this._moveSelection(index === 0
            ? Gtk.DirectionType.DOWN : Gtk.DirectionType.UP);

        let newSelected = this.get_selected_row();
        if (newSelected !== row)
            newActive = newSelected.room;
        toplevel.active_room = newActive;

        if (selected !== row)
            this.select_row(selected);
    }

    _accountAdded(am, account) {
        if (this._placeholders.has(account))
            return;

        let placeholder = new Gtk.ListBoxRow({
            selectable: false,
            activatable: false,
            visible: false,
        });
        placeholder.account = account;

        this._placeholders.set(account, placeholder);
        this.append(placeholder);

        placeholder.connect('notify::visible', () => {
            this.invalidate_sort();
        });

        this._updatePlaceholderVisibility(account);
    }

    _accountRemoved(am, account) {
        let placeholder = this._placeholders.get(account);

        if (!placeholder)
            return;

        this._placeholders.delete(account);
        this.remove(placeholder);
        placeholder.run_dispose();
    }

    _roomAdded(roomManager, room) {
        if (this._roomRows.has(room.id))
            return;

        let row = new RoomRow(room);
        this.append(row);
        this._roomRows.set(room.id, row);

        row.connect('destroy', w => this._roomRows.delete(w.room.id));
        this._placeholders.get(room.account).hide();
    }

    _roomRemoved(roomManager, room) {
        let row = this._roomRows.get(room.id);
        if (!row)
            return;

        this._moveSelectionFromRow(row);
        this.remove(row);
        row.run_dispose();
        this._roomRows.delete(room.id);
        this._updatePlaceholderVisibility(room.account);
    }

    _updatePlaceholderVisibility(account) {
        if (!account.visible) {
            this._placeholders.get(account).hide();
            return;
        }

        let rows = [...this._roomRows.values()];
        let hasRooms = rows.some(r => r.account === account);
        this._placeholders.get(account).visible = !hasRooms;
    }

    _activeRoomChanged() {
        const room = this.get_root().active_room;
        if (!room)
            return;
        let row = this._roomRows.get(room.id);
        if (!row)
            return;

        row.can_focus = false;
        this.select_row(row);
        row.can_focus = true;
    }

    on_row_selected(row) {
        this.get_root().active_room = row ? row.room : null;
        if (row)
            row.selected();
    }

    _updateHeader(row, before) {
        let {account: beforeAccount} = before || {};
        let {account} = row;

        let oldHeader = row.get_header();

        if (beforeAccount === account) {
            row.set_header(null);
            oldHeader?.unparent();
            oldHeader?.run_dispose();
            return;
        }

        if (oldHeader)
            return;

        let roomListHeader = new RoomListHeader({account});
        row.set_header(roomListHeader);
    }

    _sort(row1, row2) {
        let account1 = row1.account;
        let account2 = row2.account;

        let hasRooms1 = !this._placeholders.get(account1).visible;
        let hasRooms2 = !this._placeholders.get(account2).visible;

        if (hasRooms1 !== hasRooms2)
            return hasRooms1 ? -1 : 1;


        if (account1 !== account2) {
            let displayName1 = account1.display_name;
            let displayName2 = account2.display_name;

            if (displayName1 !== displayName2)
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

        if (room1.type !== room2.type)
            return room1.type === Tp.HandleType.ROOM ? -1 : 1;

        return room1.display_name.localeCompare(room2.display_name);
    }
});
