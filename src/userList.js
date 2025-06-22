// SPDX-FileCopyrightText: 2013 Florian Müllner <fmuellner@gnome.org>
// SPDX-FileCopyrightText: 2015 Bastian Ilsø <bastianilso@gnome.org>
// SPDX-FileCopyrightText: 2016 raresv <rares.visalom@gmail.com>
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';
import Pango from 'gi://Pango';
import Polari from 'gi://Polari';
import Tp from 'gi://TelepathyGLib';

import * as Utils from './utils.js';

const FILTER_ENTRY_THRESHOLD = 8;
const MAX_USERS_WIDTH_CHARS = 17;

export const UserListPopover = GObject.registerClass(
class UserListPopover extends Gtk.Popover {
    constructor(params) {
        super(params);

        this._createWidget();

        this.connect('closed', () => (this._entry.text = ''));
        this.connect('map', () => {
            this._revealer.transition_duration = 0;
            this._updateContentHeight();
            this._ensureUserList();
        });
        this._revealer.connect('notify::child-revealed', () => {
            this._revealer.transition_duration = 250;
        });
    }

    vfunc_realize() {
        super.vfunc_realize();

        const toplevel = this.get_root();
        toplevel.connect('notify::active-room',
            this._activeRoomChanged.bind(this));
        toplevel.connect('notify::view-height',
            this._updateContentHeight.bind(this));
    }

    _createWidget() {
        this._box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 6,
        });
        this.set_child(this._box);

        this._revealer = new Gtk.Revealer();
        this._box.append(this._revealer);

        this._entry = new Gtk.SearchEntry();
        this._entry.connect('search-changed', this._updateFilter.bind(this));
        this._entry.connect('stop-search', this._onStopSearch.bind(this));
        this._revealer.set_child(this._entry);
    }

    _activeRoomChanged() {
        this._entry.text = '';

        if (this._userList)
            this._box.remove(this._userList);
        this._userList?.run_dispose();
        this._userList = null;
    }

    _updateContentHeight() {
        if (!this._userList)
            return;
        if (!this.get_mapped())
            return;

        const viewHeight = this.get_root().view_height;
        const [popoverHeight] = this.measure(Gtk.Orientation.VERTICAL, -1);
        const [userListHeight] = this._userList.measure(Gtk.Orientation.VERTICAL, -1);
        let chromeHeight = popoverHeight - userListHeight;
        this._userList.max_content_height = viewHeight - chromeHeight;
    }

    _ensureUserList() {
        if (this._userList)
            return;

        const room = this.get_root().active_room;
        if (!room || room.type !== Tp.HandleType.ROOM)
            return;

        this._userList = new UserList(room);
        this._box.append(this._userList);

        this._userList.vadjustment.connect('changed',
            this._updateEntryVisibility.bind(this));
        this._updateEntryVisibility();
        this._updateContentHeight();
    }

    _updateEntryVisibility() {
        if (!this._userList)
            return;

        let reveal = this._entry.text !== '' ||
                     this._userList.numRows > FILTER_ENTRY_THRESHOLD;
        this._revealer.reveal_child = reveal;
    }

    _updateFilter() {
        if (!this._userList)
            return;
        this._userList.setFilter(this._entry.text);
    }

    _onStopSearch() {
        if (this._entry.text.length > 0)
            this._entry.text = '';
        else
            this.popdown();
    }
});

export const UserDetails = GObject.registerClass(
class UserDetails extends Gtk.Box {
    static [Gtk.template] = 'resource:///org/gnome/Polari/ui/user-details.ui';
    static [Gtk.internalChildren] = [
        'spinnerBox',
        'detailsGrid',
        'fullnameLabel',
        'lastLabel',
        'notificationLabel',
        'messageButton',
    ];

    static [GObject.properties] = {
        'expanded': GObject.ParamSpec.boolean(
            'expanded', null, null,
            GObject.ParamFlags.READWRITE,
            false),
        'notifications-enabled': GObject.ParamSpec.boolean(
            'notifications-enabled', null, null,
            GObject.ParamFlags.READWRITE,
            false),
    };

    _initialDetailsLoaded = false;
    _user = null;

    constructor(params = {}) {
        let {user} = params;
        delete params.user;

        super(params);

        this.user = user;

        this._messageButton.connect('clicked',
            this._onMessageButtonClicked.bind(this));

        this._updateButtonVisibility();
        this._detailsGrid.hide();

        this.bind_property_full('notifications-enabled',
            this._notificationLabel, 'opacity',
            GObject.BindingFlags.SYNC_CREATE,
            (p, source) => [true, source ? 1. : 0.],
            null);

        this.connect('notify::expanded', () => {
            if (this.expanded)
                this._expand();
            else
                this._unexpand();
        });
    }

    set user(user) {
        if (this._user === user)
            return;

        if (this._user)
            this._user.connection.disconnect(this._selfContactChangedId);
        this._selfContactChangedId = 0;

        this._user = user;

        if (this._user) {
            this._selfContactChangedId =
                this._user.connection.connect('notify::self-contact',
                    this._updateButtonVisibility.bind(this));
        }

        if (this.expanded)
            this._expand();

        this._updateButtonVisibility();
        this._notificationLabel.visible = this._user === null;
        this._lastLabel.visible = this._user !== null;
    }

    set nickname(nickname) {
        this._nickname = nickname;

        if (!this._fullnameLabel.label)
            this._fullnameLabel.label = this._nickname || '';


        this._updateButtonVisibility();
    }

    _expand() {
        this._detailsGrid.visible = this._initialDetailsLoaded;
        this._spinnerBox.visible = !this._initialDetailsLoaded;

        this._cancellable = new Gio.Cancellable();

        if (this._user) {
            this._user.request_contact_info_async(
                this._cancellable,
                this._onContactInfoReady.bind(this));
        } else {
            // TODO: else use this._nickname to query tracker
            this._revealDetails();
        }
    }

    _unexpand() {
        if (this._cancellable)
            this._cancellable.cancel();
        this._cancellable = null;
    }

    _onContactInfoReady() {
        this._initialDetailsLoaded = true;

        let fn, last;
        let info = this._user.get_contact_info();
        for (let i = 0; i < info.length; i++) {
            if (info[i].field_name === 'fn')
                [fn] = info[i].field_value;
            else if (info[i].field_name === 'x-idle-time')
                [last] = info[i].field_value;
        }

        if (!fn)
            fn = this._user.alias;

        this._fullnameLabel.label = fn;

        if (last) {
            this._lastLabel.label = Utils.formatTimePassed(last);
            this._lastLabel.show();
        } else {
            this._lastLabel.hide();
        }

        this._revealDetails();
    }

    _revealDetails() {
        this._spinnerBox.hide();
        this._detailsGrid.show();
    }

    _onMessageButtonClicked() {
        let account = this._user.connection.get_account();

        let app = Gio.Application.get_default();
        let action = app.lookup_action('message-user');
        action.activate(GLib.Variant.new('(sssb)', [
            account.get_object_path(),
            this._user.alias,
            '',
            true,
        ]));
    }

    _updateButtonVisibility() {
        if (!this._user) {
            this._messageButton.sensitive = false;

            return;
        }

        if (this._user === this._user.connection.self_contact) {
            this._messageButton.visible = false;
            this._messageButton.sensitive = true;
        } else {
            this._messageButton.visible = true;
            this._messageButton.sensitive = true;
        }
    }
});

export const UserPopover = GObject.registerClass(
class UserPopover extends Gtk.Popover {
    static [Gtk.template] = 'resource:///org/gnome/Polari/ui/user-popover.ui';
    static [Gtk.internalChildren] = [
        'nickLabel',
        'statusLabel',
        'notifyButton',
        'userDetails',
    ];

    _nickname = null;
    _basenick = null;

    constructor(params) {
        const {room, userTracker} = params;
        delete params.room;
        delete params.userTracker;

        super(params);

        this._room = room;
        this._userTracker = userTracker;

        this._app = Gio.Application.get_default();

        this._roomStatusChangedId = 0;
        this._globalStatusChangedId = 0;
        this._contactsChangedId = 0;

        this.connect('destroy', () => {
            this.nickname = null;
        });
    }

    set nickname(nickname) {
        if (this._nickname === nickname)
            return;

        if (nickname === null)
            return;

        this._nickname = nickname;
        this._nickLabel.label = this._nickname;
        this._userDetails.nickname = nickname;

        let actionName = this._userTracker.getNotifyActionName(this._nickname);
        this._notifyButton.action_name = actionName;

        this._setBasenick(Polari.util_get_basenick(nickname));
    }

    _setBasenick(basenick) {
        if (this._basenick === basenick)
            return;

        this._basenick = basenick;

        if (this._roomStatusChangedId > 0) {
            this._userTracker.unwatchRoomStatus(
                this._room, this._roomStatusChangedId);
        }
        this._roomStatusChangedId = this._userTracker.watchRoomStatus(
            this._room, this._basenick, this._onStatusChanged.bind(this));

        if (this._globalStatusChangedId > 0)
            this._userTracker.disconnect(this._globalStatusChangedId);
        this._globalStatusChangedId =
            this._userTracker.connect(`status-changed::${basenick}`,
                this._onStatusChanged.bind(this));

        if (this._contactsChangedId > 0)
            this._userTracker.disconnect(this._contactsChangedId);
        this._contactsChangedId =
            this._userTracker.connect(`contacts-changed::${basenick}`, () => {
                this._userDetails.user = this._userTracker.lookupContact(this._nickname);
            });

        this._onStatusChanged();
        this._updateDetailsContact();
    }

    get nickname() {
        return this._nickname;
    }

    _onStatusChanged() {
        let status = this._userTracker.getNickStatus(this._nickname);
        let roomStatus = this._userTracker.getNickRoomStatus(
            this._nickname, this._room);

        let label;
        if (status !== roomStatus)
            label = _('Available in another room.');
        else if (status === Tp.ConnectionPresenceType.AVAILABLE)
            label = _('Online');
        else
            label = _('Offline');
        this._statusLabel.label = label;

        if (status === Tp.ConnectionPresenceType.AVAILABLE) {
            this._nickLabel.remove_css_class('polari-inactive-nick');
            this._nickLabel.add_css_class('polari-active-nick');
        } else {
            this._nickLabel.remove_css_class('polari-active-nick');
            this._nickLabel.add_css_class('polari-inactive-nick');
        }
    }

    _updateDetailsContact() {
        this._userDetails.user = this._userTracker.lookupContact(this._nickname);
    }
});

const UserListRow = GObject.registerClass(
class UserListRow extends Gtk.ListBoxRow {
    static [GObject.properties] = {
        'filter': GObject.ParamSpec.string(
            'filter', 'filter', 'filter',
            GObject.ParamFlags.READWRITE,
            ''),
    };

    constructor(user) {
        super({name: `UserListRow ${user.alias}`});

        this._user = user;

        this._createWidget();

        this.connect('unmap', () => {
            this._revealer.reveal_child = false;
        });
        this.connect('state-flags-changed',
            this._updateArrowVisibility.bind(this));

        this._revealer.connect('notify::reveal-child',
            this._onExpandedChanged.bind(this));

        this.connect('notify::filter', () => this._updateLabel());
    }

    get user() {
        return this._user;
    }

    get expand() {
        return this._revealer.reveal_child;
    }

    set expand(expand) {
        if (expand)
            this._ensureDetails();
        this._revealer.reveal_child = expand;
    }

    _createWidget() {
        let vbox = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL});
        this.set_child(vbox);

        let hbox = new Gtk.Box({
            margin_end: 12,
            margin_start: 4,
            margin_top: 4,
            margin_bottom: 4,
            spacing: 4,
        });
        this._arrow = new Gtk.Image({
            icon_name: 'pan-end-symbolic',
            visible: false,
        });
        this._label = new Gtk.Label({
            label: this._user.alias,
            halign: Gtk.Align.START,
            hexpand: true,
            use_markup: true,
            ellipsize: Pango.EllipsizeMode.END,
            max_width_chars: MAX_USERS_WIDTH_CHARS,
        });
        hbox.append(this._label);
        hbox.append(this._arrow);
        vbox.append(hbox);

        this._revealer = new Gtk.Revealer({reveal_child: false});
        vbox.append(this._revealer);
    }

    _ensureDetails() {
        if (this._revealer.get_child())
            return;

        let details = new UserDetails({user: this._user});

        this._revealer.bind_property('reveal-child', details, 'expanded', 0);

        this._revealer.set_child(details);
    }

    shouldShow() {
        return this._user.alias.toLowerCase().includes(this.filter.toLowerCase());
    }

    _updateLabel() {
        const str = GLib.regex_escape_string(this.filter ?? '', -1);
        const regex = new RegExp(`(${str})`, 'i');
        this._label.label = this._user.alias.replace(regex, '<b>$1</b>');
    }

    _updateArrowVisibility() {
        let flags = this.get_state_flags();
        this._arrow.visible = this.expand ||
                              flags & Gtk.StateFlags.PRELIGHT ||
                              flags & Gtk.StateFlags.FOCUSED;
    }

    _onExpandedChanged() {
        if (this._revealer.reveal_child) {
            this.add_css_class('expanded');
            this._arrow.icon_name = 'pan-down-symbolic';
        } else {
            this.remove_css_class('expanded');
            this._arrow.icon_name = 'pan-end-symbolic';
            this._updateArrowVisibility();
        }
    }
});

const UserList = GObject.registerClass(
class UserList extends Gtk.ScrolledWindow {
    static [Gtk.template] = 'resource:///org/gnome/Polari/ui/user-list.ui';
    static [Gtk.internalChildren] = [
        'list',
        'stack',
    ];

    constructor(room) {
        super();

        this._filter = '';
        this._list.set_filter_func(this._filterRows.bind(this));
        this._list.set_sort_func(this._sort.bind(this));

        this._list.connect('row-activated', this._onRowActivated.bind(this));
        this.connect('destroy', this._onDestroy.bind(this));

        this._room = room;
        this._rows = new Map();
        this._activeRow = null;

        let roomSignals = [{
            name: 'member-renamed',
            handler: this._onMemberRenamed.bind(this),
        }, {
            name: 'member-disconnected',
            handler: this._onMemberRemoved.bind(this),
        }, {
            name: 'member-kicked',
            handler: this._onMemberRemoved.bind(this),
        }, {
            name: 'member-banned',
            handler: this._onMemberRemoved.bind(this),
        }, {
            name: 'member-left',
            handler: this._onMemberRemoved.bind(this),
        }, {
            name: 'member-joined',
            handler: this._onMemberJoined.bind(this),
        }, {
            name: 'notify::channel',
            handler: this._onChannelChanged.bind(this),
        }];
        this._roomSignals = [];
        roomSignals.forEach(signal => {
            this._roomSignals.push(room.connect(signal.name, signal.handler));
        });
        this._onChannelChanged(room);
    }

    get numRows() {
        return this._rows.size;
    }

    _onDestroy() {
        this._roomSignals.forEach(id => this._room.disconnect(id));
        this._roomSignals = [];
    }

    setFilter(filter) {
        this._filter = filter;
        this._list.invalidate_filter();
        this._syncVisiblePage();
    }

    _onMemberRenamed(room, oldMember, newMember) {
        this._removeMember(oldMember);
        this._addMember(newMember);
    }

    _onMemberRemoved(room, member) {
        this._removeMember(member);
    }

    _onMemberJoined(room, member) {
        this._addMember(member);
    }

    _onChannelChanged(room) {
        [...this._list].forEach(w => {
            this._list.remove(w);
            w.run_dispose();
        });
        this._rows.clear();

        if (!room.channel)
            return;

        let members = room.channel.group_dup_members_contacts();
        for (let i = 0; i < members.length; i++)
            this._addMember(members[i]);
    }

    _addMember(member) {
        let row = new UserListRow(member);
        this._rows.set(member, row);
        this._list.append(row);
    }

    _removeMember(member) {
        let row = this._rows.get(member);
        if (row)
            this._list.remove(row);
        row?.run_dispose();
        this._rows.delete(member);
    }

    _setActiveRow(row) {
        if (this._activeRow && this._activeRow !== row)
            this._activeRow.expand = false;
        this._activeRow = row;
    }

    _onRowActivated(list, row) {
        this._setActiveRow(row);
        this._activeRow.expand = !this._activeRow.expand;
    }

    _sort(row1, row2) {
        return row1.user.alias.localeCompare(row2.user.alias);
    }

    _filterRows(row) {
        row.filter = this._filter;
        return row.shouldShow();
    }

    _syncVisiblePage() {
        const hasVisibleRows = [...this._list].some(c => c.get_child_visible());
        this._stack.visible_child_name = hasVisibleRows
            ? 'list'
            : 'placeholder';
    }
});
