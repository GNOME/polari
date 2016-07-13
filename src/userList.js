const Gdk = imports.gi.Gdk;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;
const Pango = imports.gi.Pango;
const Tp = imports.gi.TelepathyGLib;
const Polari = imports.gi.Polari;

const ChatroomManager = imports.chatroomManager;
const Lang = imports.lang;
const Mainloop = imports.mainloop;

const READWRITE = GObject.ParamFlags.READABLE | GObject.ParamFlags.WRITABLE;

const MAX_USERS_SHOWN = 8;
const MAX_USERS_WIDTH_CHARS = 17;

const UserListPopover = new Lang.Class({
    Name: 'UserListPopover',
    Extends: Gtk.Popover,

    _init: function(params) {
        this.parent(params);

        this._createWidget();

        this.connect('closed', Lang.bind(this, function() {
            this._entry.text = '';
        }));
        this.connect('map', Lang.bind(this, function() {
            this._revealer.transition_duration = 0;
            this._ensureUserList();
        }));
        this._revealer.connect('notify::child-revealed', Lang.bind(this, function() {
            this._revealer.transition_duration = 250;
        }));

        this._roomManager = new ChatroomManager.getDefault();
        this._roomManager.connect('active-changed',
                                  Lang.bind(this, this._activeRoomChanged));
    },

    _createWidget: function() {
        this._box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL,
                                  spacing: 6 });
        this.add(this._box);

        this._revealer = new Gtk.Revealer();
        this._box.add(this._revealer);

        this._userListBin = new Gtk.Frame({ shadow_type: Gtk.ShadowType.NONE });
        this._box.add(this._userListBin);

        this._entry = new Gtk.SearchEntry();
        this._entry.connect('search-changed',
                            Lang.bind(this, this._updateFilter));
        this._revealer.add(this._entry);

        this._box.show_all();
    },

    _activeRoomChanged: function(manager, room) {
        this._entry.text = '';

        if (this._userList)
            this._userList.destroy();
        this._userList = null;
    },

    _ensureUserList: function() {
        if (this._userList)
            return;

        let room = this._roomManager.getActiveRoom();
        if (!room || room.type != Tp.HandleType.ROOM)
            return;

        this._userList = new UserList(room);
        this._userListBin.add(this._userList);

        this._userList.vadjustment.connect('changed',
                                           Lang.bind(this, this._updateEntryVisibility));
        this._updateEntryVisibility();
    },

    _updateEntryVisibility: function() {
        if (!this._userList)
            return;

        let reveal = this._entry.text != '' ||
                     this._userList.numRows > MAX_USERS_SHOWN;
        this._revealer.reveal_child = reveal;
    },

    _updateFilter: function() {
        if (!this._userList)
            return;
        this._userList.setFilter(this._entry.text);
    }
});

const UserDetails = new Lang.Class({
    Name: 'UserDetails',
    Extends: Gtk.Frame,
    Template: 'resource:///org/gnome/Polari/ui/user-details.ui',
    InternalChildren: ['spinnerBox',
                       'spinner',
                       'detailsGrid',
                       'userIcon',
                       'fullnameLabel',
                       'lastHeader',
                       'lastLabel',
                       'notificationIcon',
                       'notificationLabel',
                       'separator',
                       'messageButton',
                       'pastActivityButton'],
    Properties: { 'expanded': GObject.ParamSpec.boolean('expanded',
                                                        'expanded',
                                                        'expanded',
                                                        READWRITE,
                                                        false),
                  'isUserWatched': GObject.ParamSpec.boolean('isUserWatched',
                                                             'isUserWatched',
                                                             'isUserWatched',
                                                             READWRITE,
                                                             false)},

    _init: function(params) {
        this._expanded = false;

        this.parent(params);

        this._messageButton.connect('clicked',
                                    Lang.bind(this, this._onMessageButtonClicked));

        this._updateButtonVisibility();
        this._detailsGrid.hide();

        this._notificationLabel.set_text("Will notify if user appears online.");

        this.bind_property('isUserWatched', this._notificationIcon, 'visible', GObject.BindingFlags.SYNC_CREATE);
        this.bind_property('isUserWatched', this._notificationLabel, 'visible', GObject.BindingFlags.SYNC_CREATE);

        this._fullnameLabel.ellipsize = Pango.EllipsizeMode.END;
        this._fullnameLabel.max_width_chars = MAX_USERS_WIDTH_CHARS;
    },

    set user(user) {
        if (this._user == user)
            return;

        if (this._user)
            this._user.connection.disconnect(this._selfContactChangedId);
        this._selfContactChangedId = 0;

        this._user = user;

        if (this._user)
            this._selfContactChangedId = this._user.connection.connect('notify::self-contact',
                                                    Lang.bind(this, this._updateButtonVisibility));

        if (this.expanded) {
            this.expanded = false;
            this.expanded = true;
        }

        this._updateButtonVisibility();
    },

    set nickname(nickname) {
        this._nickname = nickname;

        this._updateButtonVisibility();
    },

    get expanded() {
        return this._expanded;
    },

    set expanded(v) {
        if (v == this._expanded)
            return;

        this._expanded = v;

        if (this._expanded)
            this._expand();
        else
            this._unexpand();

        this.notify('expanded');
    },

    clearPrevUserAndDetails: function() {
        this.user = null;
        this._fullnameLabel.label = '';
        this._lastLabel.label = '';
    },

    _expand: function() {
        let prevDetails = this._fullnameLabel.label != '';
        this._detailsGrid.visible = prevDetails;
        this._spinnerBox.visible = !prevDetails;
        this._spinner.start();

        this._cancellable = new Gio.Cancellable();

        if (this._user)
            this._user.request_contact_info_async(this._cancellable,
                                              Lang.bind(this, this._onContactInfoReady));
        //TODO: else use this._falbackNick to query tracker
        else
            this._trackFallbackNick(this._nickname);
    },

    _unexpand: function() {
        this._spinner.stop();

        if (this._cancellable)
            this._cancellable.cancel();
        this._cancellable = null;
    },

    _formatLast: function(seconds) {
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
    },

    _onContactInfoReady: function(c, res) {
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

        this._fullnameLabel.label = '<small>' + fn + '</small>';
        this._userIcon.visible = true;

        if (last) {
            this._lastHeader.label = '<small>' + _("Last Activity:") + '</small>';
            this._lastHeader.show();

            this._lastLabel.label = '<small>' + this._formatLast(last) + '</small>';
            this._lastLabel.show();
        } else {
            this._lastHeader.hide();
            this._lastLabel.hide();
        }

        //this._notificationIcon.hide();
        //this._notificationLabel.hide();

        this._revealDetails();
    },

    _trackFallbackNick: function(nickname) {
        this._lastHeader.label = '<small>' + _("Last Activity:") + '</small>';
        this._lastHeader.show();

        this._userIcon.visible = false;

        this._revealDetails();
    },

    _revealDetails: function() {
        this._spinner.stop();
        this._spinnerBox.hide();
        this._detailsGrid.show();
    },

    _onMessageButtonClicked: function() {
        let account = this._user.connection.get_account();

        let app = Gio.Application.get_default();
        let action = app.lookup_action('message-user');
        let time = Gtk.get_current_event().get_time();
        action.activate(GLib.Variant.new('(sssu)',
                                         [ account.get_object_path(),
                                           this._user.alias,
                                           '',
                                           time ]));
    },

    _updateButtonVisibility: function() {
        if (!this._user) {
            this._messageButton.sensitive = false;

            return;
        }

        if (this._user == this._user.connection.self_contact) {
            this._messageButton.visible = false;
            this._messageButton.sensitive = true; //TODO: does this even make sense?
        } else {
            this._messageButton.visible = true;
            this._messageButton.sensitive = true;
        }
    }
});

const UserPopover = new Lang.Class({
    Name: 'UserPopover',
    Extends: Gtk.Popover,

    _init: function(params) {
        this._room = params.room;
        delete params.room;

        this._userTracker = params.userTracker;
        delete params.userTracker;

        this.parent(params);

        this._nickLabel = new Gtk.Label({ halign: Gtk.Align.START, margin_top: 0, ellipsize: Pango.EllipsizeMode.END, max_width_chars: MAX_USERS_WIDTH_CHARS });
        this._statusLabel = new Gtk.Label({ halign: Gtk.Align.START, margin_bottom: 0, use_markup: true });

        this._headervbox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, halign: Gtk.Align.FILL });
        this._headervbox.add(this._nickLabel);
        this._headervbox.add(this._statusLabel);

        this._hbox = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, halign: Gtk.Align.FILL, margin: 9 });
        this._hbox.add(this._headervbox);

        this._notifyButton = new Gtk.ToggleButton({ image: new Gtk.Image({ icon_name: 'alarm-symbolic' }), halign: Gtk.Align.END, hexpand: true });
        this._notifyButton.connect('clicked',
                                    Lang.bind(this, this._onNotifyButtonClicked));
        this._hbox.add(this._notifyButton);


        this._userDetails = new UserDetails();
        this.bind_property('visible', this._userDetails, 'expanded', 0);

        this._vbox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
        this._vbox.add(this._hbox);
        this._vbox.add(this._userDetails);

        this.add(this._vbox);

        this._vbox.show_all();

        this._notifyButton.bind_property('active', this._userDetails, 'isUserWatched', GObject.BindingFlags.SYNC_CREATE);
    },

    set nickname(nickname) {
        this._nickname = nickname;

        let baseNick = Polari.util_get_basenick(nickname);

        /*TODO: these need to be disconnected when not used anymore*/
        this._userTracker.watchUser(this._room, this._nickname, Lang.bind(this, this._onNickStatusChanged));
        this._userTracker.connect("status-changed::"+this._nickname, Lang.bind(this, this._updateContents));
        this._userTracker.connect("notification-emitted::" + baseNick, Lang.bind(this, this._onNotificationEmitted))

        this._updateContents();

        /*TODO: disconnect when not needed anymore*/

        if (this._contactsChangedSignal)
            this._userTracker.disconnect(this._contactsChangedSignal);

        this._contactsChangedSignal = this._userTracker.connect("contacts-changed::" + baseNick, () => {
            this._userDetails.user = this._userTracker.lookupContact(this._nickname);
        });
    },

    get nickname() {
        return this._nickname;
    },

    _updateContents: function() {
        let bestMatchingContact = this._userTracker.lookupContact(this._nickname);

        this._nickLabel.set_label(this._nickname);

        let labelStatus = "";
        if (!bestMatchingContact)
            labelStatus = "<small>Offline</small>";
        else
            if (this._userTracker.getNickRoomStatus(this._nickname, this._room) == Tp.ConnectionPresenceType.AVAILABLE)
                labelStatus = "<small>Online</small>";
            else
                labelStatus = "<small>Available in another room.</small>";

        this._statusLabel.set_label(labelStatus);

        if (bestMatchingContact) {
            this._userDetails.user = bestMatchingContact;

            let context = this._statusLabel.get_style_context();
            context.set_state(Gtk.StateFlags.LINK);
            context.save();

            this._statusLabel.sensitive = true;
        }
        else {
            this._userDetails.clearPrevUserAndDetails();

            this._statusLabel.sensitive = false;
        }

        this._updateNotifyButton();

        this._userDetails.nickname = this._nickname;
    },

    _onNotifyButtonClicked: function() {
        if (!this._userTracker.isUserWatched(this._nickname, this._room.account.get_display_name())) {
            this._userTracker.addToWatchlist(this._nickname, this._room.account.get_display_name());
            this._updateNotifyButton();
        }
        else {
            this._userTracker.popUserFromWatchlist(this._nickname, this._room.account.get_display_name());
            this._updateNotifyButton();
        }
    },

    _updateNotifyButton: function() {
        let isUserGloballyOnline = this._userTracker.getNickStatus(this._nickname) == Tp.ConnectionPresenceType.AVAILABLE ? true : false;

        /*TODO: too many conditionals*/
        if (!this._userTracker.isUserWatched(this._nickname, this._room.account.get_display_name()))
            if (this._userTracker.getNickRoomStatus(this._nickname, this._room) == Tp.ConnectionPresenceType.AVAILABLE) {
                this._notifyButton.visible = false;
                //this._notifyButton.set_active(false);
            }
            else {
                if (isUserGloballyOnline)
                    this._notifyButton.visible = false;
                else
                    this._notifyButton.visible = true;

                //this._notifyButton.set_active(false);
            }
        else
            if (this._userTracker.getNickRoomStatus(this._nickname, this._room) == Tp.ConnectionPresenceType.AVAILABLE) {
                this._notifyButton.visible = false;
                //this._notifyButton.set_active(true);
            }
            else {
                if (isUserGloballyOnline)
                    this._notifyButton.visible = false;
                else
                    this._notifyButton.visibile = true;

                //this._notifyButton.set_active(true);
            }
    },

    _onNickStatusChanged: function(nickName, status) {
        this._updateContents();
    },

    _onNotificationEmitted: function() {
        this._notifyButton.set_active(false);
    }
});

const UserListRow = new Lang.Class({
    Name: 'UserListRow',
    Extends: Gtk.ListBoxRow,

    _init: function(user) {
        this._user = user;

        this.parent();

        this._createWidget();

        this.connect('unmap', Lang.bind(this, function() {
            this._revealer.reveal_child = false;
        }));
        this.connect('state-flags-changed',
                     Lang.bind(this, this._updateArrowVisibility));

        this._revealer.connect('notify::reveal-child',
                               Lang.bind(this, this._onExpandedChanged));
    },

    get user() {
        return this._user;
    },

    get expand() {
        return this._revealer.reveal_child;
    },

    set expand(expand) {
        if (expand)
            this._ensureDetails();
        this._revealer.reveal_child = expand;
    },

    _createWidget: function() {
        let vbox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
        this.add(vbox);

        let hbox = new Gtk.Box({ margin: 4, spacing: 4 });
        this._arrow = new Gtk.Arrow({ arrow_type: Gtk.ArrowType.RIGHT,
                                      no_show_all: true });
        //hbox.add(new Gtk.Image({ icon_name: 'avatar-default-symbolic' }));
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
    },

    _ensureDetails: function() {
        if (this._revealer.get_child())
            return;

        let details = new UserDetails();
        details.user = this._user;

        this._revealer.bind_property('reveal-child', details, 'expanded', 0);

        this._revealer.add(details);
    },

    shouldShow: function() {
        return this._user.alias.toLowerCase().indexOf(this._filter) != -1;
    },

    setFilter: function(filter) {
        this._filter = filter.toLowerCase();
        this._updateLabel();
    },

    _updateLabel: function() {
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
    },

    _updateArrowVisibility: function() {
        let flags = this.get_state_flags();
        this._arrow.visible = this.expand ||
                              flags & Gtk.StateFlags.PRELIGHT ||
                              flags & Gtk.StateFlags.FOCUSED;
    },

    _onExpandedChanged: function() {
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

const UserList = new Lang.Class({
    Name: 'UserList',
    Extends: Gtk.ScrolledWindow,

    _init: function(room) {
        this.parent({ hexpand: true,
                      shadow_type: Gtk.ShadowType.ETCHED_IN,
                      hscrollbar_policy: Gtk.PolicyType.NEVER });

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
                           Lang.bind(this, this._updateContentHeight));

        this._list.set_selection_mode(Gtk.SelectionMode.NONE);
        /* see https://bugzilla.gnome.org/show_bug.cgi?id=725403 */
        //this._list.set_header_func(Lang.bind(this, this._updateHeader));
        this._filter = '';
        this._list.set_filter_func(Lang.bind(this, this._filterRows));
        this._list.set_sort_func(Lang.bind(this, this._sort));

        this._list.connect('row-activated',
                           Lang.bind(this, this._onRowActivated));
        this.connect('destroy',
                     Lang.bind(this, this._onDestroy));

        this._room = room;
        this._rows = {};
        this._activeRow = null;

        let roomSignals = [
            { name: 'member-renamed',
              handler: Lang.bind(this, this._onMemberRenamed) },
            { name: 'member-disconnected',
              handler: Lang.bind(this, this._onMemberRemoved) },
            { name: 'member-kicked',
              handler: Lang.bind(this, this._onMemberRemoved) },
            { name: 'member-banned',
              handler: Lang.bind(this, this._onMemberRemoved) },
            { name: 'member-left',
              handler: Lang.bind(this, this._onMemberRemoved) },
            { name: 'member-joined',
              handler: Lang.bind(this, this._onMemberJoined) },
            /*
            // see https://bugzilla.gnome.org/show_bug.cgi?id=725403
            { name: 'members-changed',
              handler: Lang.bind(this, this._onMembersChanged) },
            */
            { name: 'notify::channel',
              handler: Lang.bind(this, this._onChannelChanged) }
        ];
        this._roomSignals = [];
        roomSignals.forEach(Lang.bind(this, function(signal) {
            this._roomSignals.push(room.connect(signal.name, signal.handler));
        }));
        this._onChannelChanged(room);

        this.show_all();
    },

    get numRows() {
        return Object.keys(this._rows).length;
    },

    _onDestroy: function() {
        for (let i = 0; i < this._roomSignals.length; i++)
            this._room.disconnect(this._roomSignals[i]);
        this._roomSignals = [];
    },

    setFilter: function(filter) {
        this._filter = filter;
        this._list.invalidate_filter();
    },

    _updateContentHeight: function() {
        if (this._updateHeightId != 0)
            return;

        this._updateHeightId = Mainloop.idle_add(Lang.bind(this, function() {
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
            this._updateHeightId = 0;
            return GLib.SOURCE_REMOVE;
        }));
    },

    _onMemberRenamed: function(room, oldMember, newMember) {
        this._removeMember(oldMember);
        this._addMember(newMember);
    },

    _onMemberRemoved: function(room, member) {
        this._removeMember(member);
    },

    _onMemberJoined: function(room, member) {
        this._addMember(member);
    },

    _onMembersChanged: function(room) {
        this._counterLabel.label = this.numRows.toString();
    },

    _onChannelChanged: function(room) {
        this._list.foreach(function(w) { w.destroy(); });
        this._rows = {};

        if (!room.channel)
            return;

        let members = room.channel.group_dup_members_contacts();
        for (let i = 0; i < members.length; i++)
            this._addMember(members[i]);
    },

    _addMember: function(member) {
        let row = new UserListRow(member);
        this._rows[member] = row;
        this._list.add(row);
    },

    _removeMember: function(member) {
        let row = this._rows[member];
        if (row)
            row.destroy();
        delete this._rows[member];
    },

    _setActiveRow: function(row) {
        if (this._activeRow && this._activeRow != row)
            this._activeRow.expand = false;
        this._activeRow = row;
    },

    _onRowActivated: function(list, row) {
        this._setActiveRow(row);
        this._activeRow.expand = !this._activeRow.expand;
    },

    _sort: function(row1, row2) {
        return row1.user.alias.localeCompare(row2.user.alias);
    },

    _filterRows: function(row) {
        row.setFilter(this._filter);
        return row.shouldShow();
    },

    _updateHeader: function(row, before) {
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
