/* exported UserList UserListPopover UserDetails UserPopover */

const {
    Gio, GLib, GObject, Gtk, Pango, Polari, TelepathyGLib: Tp,
} = imports.gi;

const Utils = imports.utils;

const FILTER_ENTRY_THRESHOLD = 8;
const MAX_USERS_WIDTH_CHARS = 17;

var UserListPopover = GObject.registerClass(
class UserListPopover extends Gtk.Popover {
    _init(params) {
        super._init(params);

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

        let toplevel = this.get_toplevel();
        toplevel.connect('notify::active-room',
            this._activeRoomChanged.bind(this));
        toplevel.connect('notify::view-height',
            this._updateContentHeight.bind(this));
    }

    _createWidget() {
        this._box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 6,
            margin: 6,
        });
        this.add(this._box);

        this._revealer = new Gtk.Revealer();
        this._box.add(this._revealer);

        this._entry = new Gtk.SearchEntry();
        this._entry.connect('search-changed', this._updateFilter.bind(this));
        this._revealer.add(this._entry);

        this._box.show_all();
    }

    _activeRoomChanged() {
        this._entry.text = '';

        if (this._userList)
            this._userList.destroy();
        this._userList = null;
    }

    _updateContentHeight() {
        if (!this._userList)
            return;
        if (!this.get_mapped())
            return;

        let viewHeight = this.get_toplevel().view_height;
        let [popoverHeight] = this.get_preferred_height();
        let [userListHeight] = this._userList.get_preferred_height();
        let chromeHeight = popoverHeight - userListHeight;
        this._userList.max_content_height = viewHeight - chromeHeight;
    }

    _ensureUserList() {
        if (this._userList)
            return;

        let room = this.get_toplevel().active_room;
        if (!room || room.type !== Tp.HandleType.ROOM)
            return;

        this._userList = new UserList(room);
        this._box.add(this._userList);

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
});

var UserDetails = GObject.registerClass({
    Template: 'resource:///org/gnome/Polari/ui/user-details.ui',
    InternalChildren: [
        'spinnerBox',
        'spinner',
        'detailsGrid',
        'fullnameLabel',
        'lastLabel',
        'notificationLabel',
        'messageButton',
    ],
    Properties: {
        'expanded': GObject.ParamSpec.boolean(
            'expanded', 'expanded', 'expanded',
            GObject.ParamFlags.READWRITE,
            false),
        'notifications-enabled': GObject.ParamSpec.boolean(
            'notifications-enabled', 'notifications-enabled', 'notifications-enabled',
            GObject.ParamFlags.READWRITE,
            false),
    },
}, class UserDetails extends Gtk.Frame {
    _init(params = {}) {
        let { user } = params;
        delete params.user;

        this._expanded = false;
        this._initialDetailsLoaded = false;
        this._notificationsEnabled = false;
        this._user = null;

        super._init(params);

        this.user = user;

        this._messageButton.connect('clicked',
            this._onMessageButtonClicked.bind(this));

        this._updateButtonVisibility();
        this._detailsGrid.hide();
        this._notificationLabel.opacity = this.notifications_enabled ? 1. : 0.;
    }

    // eslint-disable-next-line camelcase
    get notifications_enabled() {
        return this._notificationsEnabled;
    }

    // eslint-disable-next-line camelcase
    set notifications_enabled(value) {
        if (this._notificationsEnabled === value)
            return;

        this._notificationsEnabled = value;

        this.notify('notifications-enabled');

        this._notificationLabel.opacity = value ? 1. : 0.;
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

    get expanded() {
        return this._expanded;
    }

    set expanded(v) {
        if (v === this._expanded)
            return;

        this._expanded = v;

        if (this._expanded)
            this._expand();
        else
            this._unexpand();

        this.notify('expanded');
    }

    _expand() {
        this._detailsGrid.visible = this._initialDetailsLoaded;
        this._spinnerBox.visible = !this._initialDetailsLoaded;
        this._spinner.start();

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
        this._spinner.stop();

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
        this._spinner.stop();
        this._spinnerBox.hide();
        this._detailsGrid.show();
    }

    _onMessageButtonClicked() {
        let account = this._user.connection.get_account();

        let app = Gio.Application.get_default();
        let action = app.lookup_action('message-user');
        let time = Gtk.get_current_event().get_time();
        action.activate(GLib.Variant.new('(sssu)', [
            account.get_object_path(),
            this._user.alias,
            '',
            time,
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

var UserPopover = GObject.registerClass({
    Template: 'resource:///org/gnome/Polari/ui/user-popover.ui',
    InternalChildren: [
        'nickLabel',
        'statusLabel',
        'notifyButton',
        'userDetails',
    ],
}, class UserPopover extends Gtk.Popover {
    _init(params) {
        this._room = params.room;
        delete params.room;

        this._userTracker = params.userTracker;
        delete params.userTracker;

        this._nickname = null;
        this._basenick = null;

        super._init(params);

        this._nickLabel.set_state_flags(Gtk.StateFlags.LINK, false);

        this._app = Gio.Application.get_default();

        this._roomStatusChangedId = 0;
        this._globalStatusChangedId = 0;
        this._contactsChangedId = 0;

        this.connect('destroy', () => {
            this.nickname = null;
        });

        this.show();
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

        this._nickLabel.sensitive = status === Tp.ConnectionPresenceType.AVAILABLE;
    }

    _updateDetailsContact() {
        this._userDetails.user = this._userTracker.lookupContact(this._nickname);
    }
});

const UserListRow = GObject.registerClass(
class UserListRow extends Gtk.ListBoxRow {
    _init(user) {
        this._user = user;

        super._init({ name: `UserListRow ${user.alias}` });

        this._createWidget();

        this.connect('unmap', () => {
            this._revealer.reveal_child = false;
        });
        this.connect('state-flags-changed',
            this._updateArrowVisibility.bind(this));

        this._revealer.connect('notify::reveal-child',
            this._onExpandedChanged.bind(this));
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
        let vbox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
        this.add(vbox);

        let hbox = new Gtk.Box({
            margin_end: 12,
            margin_start: 4,
            margin_top: 4,
            margin_bottom: 4,
            spacing: 4,
        });
        this._arrow = new Gtk.Image({
            icon_name: 'pan-end-symbolic',
            no_show_all: true,
        });
        this._label = new Gtk.Label({
            label: this._user.alias,
            halign: Gtk.Align.START,
            hexpand: true,
            use_markup: true,
            ellipsize: Pango.EllipsizeMode.END,
            max_width_chars: MAX_USERS_WIDTH_CHARS,
        });
        hbox.add(this._label);
        hbox.add(this._arrow);
        vbox.add(hbox);

        this._revealer = new Gtk.Revealer({ reveal_child: false });
        vbox.add(this._revealer);

        this.show_all();
    }

    _ensureDetails() {
        if (this._revealer.get_child())
            return;

        let details = new UserDetails({ user: this._user });

        this._revealer.bind_property('reveal-child', details, 'expanded', 0);

        this._revealer.add(details);
    }

    shouldShow() {
        return this._user.alias.toLowerCase().includes(this._filter);
    }

    setFilter(filter) {
        this._filter = filter.toLowerCase();
        this._updateLabel();
    }

    _updateLabel() {
        let filterIndex = -1;
        if (this._filter)
            filterIndex = this._user.alias.toLowerCase().indexOf(this._filter);

        if (filterIndex < 0) {
            this._label.label = this._user.alias;
        } else {
            let preMatch = this._user.alias.substring(0, filterIndex);
            let theMatch = this._user.alias.substring(
                filterIndex,
                filterIndex + this._filter.length);
            let postMatch = this._user.alias.substring(
                filterIndex + this._filter.length);
            this._label.label = `${preMatch}<b>${theMatch}<${'/'}b>${postMatch}`;
        }
    }

    _updateArrowVisibility() {
        let flags = this.get_state_flags();
        this._arrow.visible = this.expand ||
                              flags & Gtk.StateFlags.PRELIGHT ||
                              flags & Gtk.StateFlags.FOCUSED;
    }

    _onExpandedChanged() {
        if (this._revealer.reveal_child) {
            this.get_style_context().add_class('expanded');
            this._arrow.icon_name = 'pan-down-symbolic';
        } else {
            this.get_style_context().remove_class('expanded');
            this._arrow.icon_name = 'pan-end-symbolic';
            this._updateArrowVisibility();
        }
    }
});

var UserList = GObject.registerClass(
class UserList extends Gtk.ScrolledWindow {
    _init(room) {
        super._init({
            hexpand: true,
            shadow_type: Gtk.ShadowType.ETCHED_IN,
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            propagate_natural_height: true,
            propagate_natural_width: true,
        });

        this._list = new Gtk.ListBox({ vexpand: true });
        this.add(this._list);
        let placeholder = new Gtk.Box({
            halign: Gtk.Align.CENTER,
            valign: Gtk.Align.CENTER,
            orientation: Gtk.Orientation.VERTICAL,
            margin: 32,
            spacing: 6,
            visible: true,
        });
        placeholder.add(new Gtk.Image({
            icon_name: 'edit-find-symbolic',
            pixel_size: 64,
            visible: true,
        }));
        placeholder.add(new Gtk.Label({
            label: _('No Results'),
            visible: true,
        }));

        placeholder.get_style_context().add_class('placeholder');

        this._list.set_placeholder(placeholder);

        this._list.set_selection_mode(Gtk.SelectionMode.NONE);
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

        this.show_all();
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
        this._list.foreach(w => w.destroy());
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
        this._list.add(row);
    }

    _removeMember(member) {
        let row = this._rows.get(member);
        if (row)
            row.destroy();
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
        row.setFilter(this._filter);
        return row.shouldShow();
    }
});
