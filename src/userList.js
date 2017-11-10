const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;
const Mainloop = imports.mainloop;
const Pango = imports.gi.Pango;
const Polari = imports.gi.Polari;
const Tp = imports.gi.TelepathyGLib;

const READWRITE = GObject.ParamFlags.READABLE | GObject.ParamFlags.WRITABLE;

const MAX_USERS_SHOWN = 8;
const MAX_USERS_WIDTH_CHARS = 17;

var UserListPopover = GObject.registerClass(
class UserListPopover extends Gtk.Popover {
    _init(params) {
        super._init(params);

        this._createWidget();

        this.connect('closed', () => { this._entry.text = ''; });
        this.connect('map', () => {
            this._revealer.transition_duration = 0;
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
    }

    _createWidget() {
        this._box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL,
                                  spacing: 6 });
        this.add(this._box);

        this._revealer = new Gtk.Revealer();
        this._box.add(this._revealer);

        this._userListBin = new Gtk.Frame({ shadow_type: Gtk.ShadowType.NONE });
        this._box.add(this._userListBin);

        this._entry = new Gtk.SearchEntry({ primary_icon_name: 'avatar-default-symbolic' });
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

    _ensureUserList() {
        if (this._userList)
            return;

        let room = this.get_toplevel().active_room;
        if (!room || room.type != Tp.HandleType.ROOM)
            return;

        this._userList = new UserList(room);
        this._userListBin.add(this._userList);

        this._userList.vadjustment.connect('changed',
                                           this._updateEntryVisibility.bind(this));
        this._updateEntryVisibility();
    }

    _updateEntryVisibility() {
        if (!this._userList)
            return;

        let reveal = this._entry.text != '' ||
                     this._userList.numRows > MAX_USERS_SHOWN;
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
    InternalChildren: ['spinnerBox',
                       'spinner',
                       'detailsGrid',
                       'fullnameLabel',
                       'lastLabel',
                       'notificationLabel',
                       'messageButton'],
    Properties: { 'expanded': GObject.ParamSpec.boolean('expanded',
                                                        'expanded',
                                                        'expanded',
                                                        READWRITE,
                                                        false),
                  'notifications-enabled': GObject.ParamSpec.boolean('notifications-enabled',
                                                             'notifications-enabled',
                                                             'notifications-enabled',
                                                             READWRITE,
                                                             false)},
}, class UserDetails extends Gtk.Frame {
    _init(params = {}) {
        let user = params.user;
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

    get notifications_enabled() {
        return this._notificationsEnabled;
    }

    set notifications_enabled(value) {
        if (this._notificationsEnabled == value)
            return;

        this._notificationsEnabled = value;

        this.notify('notifications-enabled');

        this._notificationLabel.opacity = value ? 1. : 0.;
    }

    set user(user) {
        if (this._user == user)
            return;

        if (this._user)
            this._user.connection.disconnect(this._selfContactChangedId);
        this._selfContactChangedId = 0;

        this._user = user;

        if (this._user)
            this._selfContactChangedId =
                this._user.connection.connect('notify::self-contact',
                                              this._updateButtonVisibility.bind(this));

        if (this.expanded)
            this._expand();

        this._updateButtonVisibility();
        this._notificationLabel.visible = this._user == null;
        this._lastLabel.visible = this._user != null;
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
        if (v == this._expanded)
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

        if (this._user)
            this._user.request_contact_info_async(this._cancellable,
                                                  this._onContactInfoReady.bind(this));
        //TODO: else use this._nickname to query tracker
        else
            this._revealDetails();
    }

    _unexpand() {
        this._spinner.stop();

        if (this._cancellable)
            this._cancellable.cancel();
        this._cancellable = null;
    }

    _formatLast(seconds) {
        if (seconds < 60)
            return ngettext("%d second ago",
                            "%d seconds ago", seconds).format(seconds);

        let minutes = seconds / 60;
        if (minutes < 60)
            return ngettext("%d minute ago",
                            "%d minutes ago", minutes).format(minutes);

        let hours = minutes / 60;
        if (hours < 24)
            return ngettext("%d hour ago",
                            "%d hours ago", hours).format(hours);

        let days = hours / 24;
        if (days < 7)
            return ngettext("%d day ago",
                            "%d days ago", days).format(days);

        let weeks = days / 7;
        if (days < 30)
            return ngettext("%d week ago",
                            "%d weeks ago", weeks).format(weeks);

        let months = days / 30;
        return ngettext("%d month ago",
                        "%d months ago", months).format(months);
    }

    _onContactInfoReady(c, res) {
        this._initialDetailsLoaded = true;

        let fn, last;
        let info = this._user.get_contact_info();
        for (let i = 0; i < info.length; i++) {
            if (info[i].field_name == 'fn')
                fn = info[i].field_value[0];
            else if (info[i].field_name == 'x-idle-time')
                last = info[i].field_value[0];
        }

        if (!fn)
            fn = this._user.alias;

        this._fullnameLabel.label = fn;

        if (last) {
            this._lastLabel.label = this._formatLast(last);
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
        action.activate(GLib.Variant.new('(sssu)',
                                         [ account.get_object_path(),
                                           this._user.alias,
                                           '',
                                           time ]));
    }

    _updateButtonVisibility() {
        if (!this._user) {
            this._messageButton.sensitive = false;

            return;
        }

        if (this._user == this._user.connection.self_contact) {
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
    InternalChildren: ['nickLabel',
                       'statusLabel',
                       'notifyButton',
                       'userDetails'],
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
        if (this._nickname == nickname)
            return;

        if (nickname == null)
            return;

        this._nickname = nickname;
        this._nickLabel.label = this._nickname;
        this._userDetails.nickname = nickname;

        let actionName = this._userTracker.getNotifyActionName(this._nickname);
        this._notifyButton.action_name = actionName;

        this._setBasenick(Polari.util_get_basenick(nickname));
    }

    _setBasenick(basenick) {
        if (this._basenick == basenick)
            return;

        this._basenick = basenick;

        if (this._roomStatusChangedId > 0)
            this._userTracker.unwatchRoomStatus(this._room, this._roomStatusChangedId);
        this._roomStatusChangedId =
            this._userTracker.watchRoomStatus(this._room, this._basenick,
                                              this._onNickStatusChanged.bind(this));

        if (this._globalStatusChangedId > 0)
            this._userTracker.disconnect(this._globalStatusChangedId);
        this._globalStatusChangedId =
            this._userTracker.connect("status-changed::" + basenick,
                                      this._onStatusChanged.bind(this));

        if (this._contactsChangedId > 0)
            this._userTracker.disconnect(this._contactsChangedId);
        this._contactsChangedId = this._userTracker.connect("contacts-changed::" + basenick, () => {
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
        let roomStatus = this._userTracker.getNickRoomStatus(this._nickname,
                                                             this._room);

        let label;
        if (status != roomStatus)
            label = _("Available in another room.");
        else if (status == Tp.ConnectionPresenceType.AVAILABLE)
            label = _("Online");
        else
            label = _("Offline");
        this._statusLabel.label = label;

        this._nickLabel.sensitive = (status == Tp.ConnectionPresenceType.AVAILABLE);
    }

    _updateDetailsContact() {
        this._userDetails.user = this._userTracker.lookupContact(this._nickname);
     }

    _onNickStatusChanged(baseNick, status) {
        this._onStatusChanged();
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

        let hbox = new Gtk.Box({ margin_end: 12,
                                 margin_start: 4,
                                 margin_top: 4,
                                 margin_bottom: 4,
                                 spacing: 4 });
        this._arrow = new Gtk.Arrow({ arrow_type: Gtk.ArrowType.RIGHT,
                                      no_show_all: true });
        this._label = new Gtk.Label({ label: this._user.alias,
                                      halign: Gtk.Align.START,
                                      hexpand: true,
                                      use_markup: true,
                                      ellipsize: Pango.EllipsizeMode.END,
                                      max_width_chars: MAX_USERS_WIDTH_CHARS });
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
            let theMatch = this._user.alias.substring(filterIndex, filterIndex + this._filter.length);
            let postMatch = this._user.alias.substring(filterIndex + this._filter.length);
            this._label.label = preMatch + '<b>' + theMatch + '</b>' + postMatch;
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
            this._arrow.arrow_type = Gtk.ArrowType.DOWN;
        } else {
            this.get_style_context().remove_class('expanded');
            this._arrow.arrow_type = Gtk.ArrowType.RIGHT;
            this._updateArrowVisibility();
        }
    }
});

var UserList = GObject.registerClass(
class UserList extends Gtk.ScrolledWindow {
    _init(room) {
        super._init({ hexpand: true,
                      shadow_type: Gtk.ShadowType.ETCHED_IN,
                      hscrollbar_policy: Gtk.PolicyType.NEVER,
                      propagate_natural_width: true });

        this._list = new Gtk.ListBox({ vexpand: true });
        this.add(this._list);

        let placeholder = new Gtk.Box({ halign: Gtk.Align.CENTER,
                                        valign: Gtk.Align.CENTER,
                                        orientation: Gtk.Orientation.VERTICAL,
                                        visible: true });
        placeholder.add(new Gtk.Image({ icon_name: 'edit-find-symbolic',
                                        pixel_size: 64,
                                        visible: true }));
        placeholder.add(new Gtk.Label({ label: _("No results"),
                                        visible: true }));

        placeholder.get_style_context().add_class('dim-label');

        this._list.set_placeholder(placeholder);

        this._updateHeightId = 0;
        this._list.connect('size-allocate',
                           this._updateContentHeight.bind(this));

        this._list.set_selection_mode(Gtk.SelectionMode.NONE);
        /* see https://bugzilla.gnome.org/show_bug.cgi?id=725403 */
        //this._list.set_header_func(this._updateHeader.bind(this));
        this._filter = '';
        this._list.set_filter_func(this._filterRows.bind(this));
        this._list.set_sort_func(this._sort.bind(this));

        this._list.connect('row-activated', this._onRowActivated.bind(this));
        this.connect('destroy', this._onDestroy.bind(this));

        this._room = room;
        this._rows = new Map();
        this._activeRow = null;

        let roomSignals = [
            { name: 'member-renamed',
              handler: this._onMemberRenamed.bind(this) },
            { name: 'member-disconnected',
              handler: this._onMemberRemoved.bind(this) },
            { name: 'member-kicked',
              handler: this._onMemberRemoved.bind(this) },
            { name: 'member-banned',
              handler: this._onMemberRemoved.bind(this) },
            { name: 'member-left',
              handler: this._onMemberRemoved.bind(this) },
            { name: 'member-joined',
              handler: this._onMemberJoined.bind(this) },
            /*
            // see https://bugzilla.gnome.org/show_bug.cgi?id=725403
            { name: 'members-changed',
              handler: this._onMembersChanged.bind(this) },
            */
            { name: 'notify::channel',
              handler: this._onChannelChanged.bind(this) }
        ];
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
        for (let i = 0; i < this._roomSignals.length; i++)
            this._room.disconnect(this._roomSignals[i]);
        this._roomSignals = [];
    }

    setFilter(filter) {
        this._filter = filter;
        this._list.invalidate_filter();
    }

    _updateContentHeight() {
        if (this._updateHeightId != 0)
            return;

        this._updateHeightId = Mainloop.idle_add(() => {
            let topRow = this._list.get_row_at_y(this.vadjustment.value);
            let membersShown = Math.min(this.numRows, MAX_USERS_SHOWN);
            // topRow is unset when all rows are hidden due to filtering,
            // base height on the first membersShown rows in that case
            let index = 0;
            if (topRow)
                index = Math.min(topRow.get_index(), this.numRows - membersShown);
            let height = 0;

            for (let i = 0; i < membersShown; i++)
                height += this._list.get_row_at_index(index + i).get_allocated_height();

            this.max_content_height = height;
            this.propagate_natural_height = true;
            this._updateHeightId = 0;
            return GLib.SOURCE_REMOVE;
        });
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

    _onMembersChanged(room) {
        this._counterLabel.label = this.numRows.toString();
    }

    _onChannelChanged(room) {
        this._list.foreach(w => { w.destroy(); });
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
        if (this._activeRow && this._activeRow != row)
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

    _updateHeader(row, before) {
        if (before) {
            row.set_header(null);
            return;
        }

        if (row.get_header())
            return;

        if (!this._room.channel)
            return;

        let box = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL,
                                margin_start: 6,
                                margin_end: 6,
                                spacing: 6 });
        box.add(new Gtk.Label({ label: '<b>' + _("All") + '</b>',
                                use_markup: true,
                                hexpand: true,
                                halign: Gtk.Align.START }));
        this._counterLabel = new Gtk.Label({ label: this.numRows.toString(),
                                             halign: Gtk.Align.END });
        box.add(this._counterLabel);
        box.show_all();

        row.set_header(box);
    }
});
