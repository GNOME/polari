const Gdk = imports.gi.Gdk;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Gtk = imports.gi.Gtk;
const Pango = imports.gi.Pango;
const Tp = imports.gi.TelepathyGLib;

const ChatroomManager = imports.chatroomManager;
const Lang = imports.lang;

const UserListPopover = new Lang.Class({
    Name: 'UserListPopover',

    _init: function() {
        this._createWidget();

        this.widget.connect('closed', Lang.bind(this, function() {
            this._entry.text = '';
        }));
        this.widget.connect('map', Lang.bind(this, function() {
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
        this.widget = new Gtk.Popover({ modal: true,
                                        position: Gtk.PositionType.TOP,
                                        vexpand: true,
                                        margin_start: 12,
                                        margin_end: 12,
                                        margin_bottom: 12 });
        this.widget.set_border_width(6);
        this.widget.set_size_request(250, -1);

        this.widget.get_style_context().add_class('polari-user-list');

        this._box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL,
                                  spacing: 6 });
        this.widget.add(this._box);

        this._revealer = new Gtk.Revealer();
        this._box.add(this._revealer);

        this._entry = new Gtk.SearchEntry();
        this._entry.connect('search-changed',
                            Lang.bind(this, this._updateFilter));
        this._entry.connect('key-press-event', Lang.bind(this,
            function(w, event) {
                let [, keyval] = event.get_keyval();
                if (keyval == Gdk.KEY_Escape) {
                    this._entry.text = '';
                    return Gdk.EVENT_STOP;
                }
                return Gdk.EVENT_PROPAGATE;
            }));
        this._revealer.add(this._entry);

        this._box.show_all();
    },

    _activeRoomChanged: function(manager, room) {
        this._entry.text = '';

        if (this._userList)
            this._userList.widget.destroy();
        this._userList = null;
    },

    _ensureUserList: function() {
        if (this._userList)
            return;

        let room = this._roomManager.getActiveRoom();
        if (!room || room.type != Tp.HandleType.ROOM)
            return;

        this._userList = new UserList(room);
        this._box.add(this._userList.widget);

        this._userList.widget.vadjustment.connect('changed',
                                                  Lang.bind(this, this._updateEntryVisibility));
        this._updateEntryVisibility();
    },

    _updateEntryVisibility: function() {
        if (!this._userList)
            return;
        let [, natHeight] = this._userList.widget.get_child().get_preferred_height();
        let height = this._userList.widget.get_allocated_height();
        this._revealer.reveal_child = this._entry.text != '' ||
                                      natHeight > height;
    },

    _updateFilter: function() {
        if (!this._userList)
            return;
        this._userList.setFilter(this._entry.text);
    }
});

const UserListRow = new Lang.Class({
    Name: 'UserListRow',

    _init: function(user) {
        this._createWidget(user);

        this.widget.user = user;

        this.widget.connect('unmap', Lang.bind(this, function() {
            this._revealer.reveal_child = false;
        }));
        this.widget.connect('state-flags-changed',
                            Lang.bind(this, this._updateArrowVisibility));

        this._revealer.connect('notify::reveal-child',
                               Lang.bind(this, this._onExpandedChanged));
    },

    get expand() {
        return this._revealer.reveal_child;
    },

    set expand(expand) {
        this._revealer.reveal_child = expand;
    },

    _createWidget: function(user) {
        this.widget = new Gtk.ListBoxRow();

        let vbox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
        this.widget.add(vbox);

        let hbox = new Gtk.Box({ margin: 4, spacing: 4 });
        this._arrow = new Gtk.Arrow({ arrow_type: Gtk.ArrowType.RIGHT,
                                      no_show_all: true });
        hbox.add(new Gtk.Image({ icon_name: 'avatar-default-symbolic' }));
        hbox.add(new Gtk.Label({ label: user.alias,
                                 halign: Gtk.Align.START,
                                 hexpand: true,
                                 ellipsize: Pango.EllipsizeMode.END }));
        hbox.add(this._arrow);
        vbox.add(hbox);

        this._revealer = new Gtk.Revealer({ reveal_child: false });
        vbox.add(this._revealer);

        let frame = new Gtk.Frame({ hexpand: true });
        this._revealer.add(frame);

        let box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL,
                                spacing: 6, margin: 6 });
        frame.add(box);

        this._spinnerBox = new Gtk.Box({ spacing: 6, margin: 12,
                                         hexpand: true,
                                         halign: Gtk.Align.CENTER });
        this._spinner = new Gtk.Spinner();
        this._spinnerBox.add(this._spinner);
        this._spinnerBox.add(new Gtk.Label({ label: _("Loading details") }));
        box.add(this._spinnerBox);

        this._detailsGrid = new Gtk.Grid({ row_spacing: 6, column_spacing: 6,
                                           hexpand: true });
        box.add(this._detailsGrid);

        if (user != user.connection.self_contact) {
            let button = new Gtk.Button({ label: _("Message"),
                                          margin_top: 12,
                                          hexpand: true,
                                          halign: Gtk.Align.END });
            button.connect('clicked', Lang.bind(this, this._onButtonClicked));
            user.connection.connect('notify::self-contact', function() {
                if (user == user.connection.self_contact)
                    button.destroy();
            });
            box.add(button);
        }

        this.widget.show_all();
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
        let info = this.widget.user.get_contact_info();
        for (let i = 0; i < info.length; i++) {
            if (info[i].field_name == 'fn')
                fn = info[i].field_value[0];
            else if (info[i].field_name == 'x-idle-time')
                last = info[i].field_value[0];
        }

        if (!fn)
            fn = this.widget.user.alias;

        let row = 0;
        let w = new Gtk.Label({ label: fn, ellipsize: Pango.EllipsizeMode.END,
                                halign: Gtk.Align.START });
        this._detailsGrid.attach(w, 0, row++, 2, 1);

        if (last) {

            w = new Gtk.Label({ label: '<small>' + _("Last Activity:") + '</small>',
                                use_markup: true,
                                valign: Gtk.Align.START });
            this._detailsGrid.attach(w, 0, row, 1, 1);

            w = new Gtk.Label({ label: '<small>' + this._formatLast(last) + '</small>',
                                use_markup: true,
                                wrap: true,
                                hexpand: true });
            this._detailsGrid.attach(w, 1, row++, 1, 1);
        }

        this._detailsGrid.show_all();

        this._spinner.stop();
        this._spinnerBox.hide();
    },

    _onButtonClicked: function() {
        let account = this.widget.user.connection.get_account();

        let app = Gio.Application.get_default();
        let action = app.lookup_action('message-user');
        let time = Gtk.get_current_event().get_time();
        action.activate(GLib.Variant.new('(ssu)',
                                         [ account.get_object_path(),
                                           this.widget.user.alias,
                                           time ]));
    },

    _updateArrowVisibility: function() {
        let flags = this.widget.get_state_flags();
        this._arrow.visible = this.expand ||
                              flags & Gtk.StateFlags.PRELIGHT ||
                              flags & Gtk.StateFlags.FOCUSED;
    },

    _onExpandedChanged: function() {
        if (this._revealer.reveal_child) {
            this.widget.get_style_context().add_class('expanded');
            this._arrow.arrow_type = Gtk.ArrowType.DOWN;

            this._spinnerBox.show();
            this._spinner.start();

            this._detailsGrid.foreach(function(w) { w.destroy(); });

            this._cancellable = new Gio.Cancellable();
            this.widget.user.request_contact_info_async(this._cancellable,
                                                        Lang.bind(this, this._onContactInfoReady));
        } else {
            this.widget.get_style_context().remove_class('expanded');
            this._arrow.arrow_type = Gtk.ArrowType.RIGHT;
            this._updateArrowVisibility();

            this._spinner.stop();

            if (this._cancellable)
                this._cancellable.cancel();
            this._cancellable = null;
        }
    }
});

const UserList = new Lang.Class({
    Name: 'UserList',

    _init: function(room) {
        this.widget = new Gtk.ScrolledWindow({ hexpand: true, vexpand: true,
                                               shadow_type: Gtk.ShadowType.ETCHED_IN });
        this.widget.hscrollbar_policy = Gtk.PolicyType.NEVER;

        this._list = new Gtk.ListBox();
        this.widget.add(this._list);

        this._list.set_selection_mode(Gtk.SelectionMode.NONE);
        /* see https://bugzilla.gnome.org/show_bug.cgi?id=725403 */
        //this._list.set_header_func(Lang.bind(this, this._updateHeader));
        this._list.set_filter_func(Lang.bind(this, this._filterRows));
        this._list.set_sort_func(Lang.bind(this, this._sort));

        this._list.connect('row-activated',
                           Lang.bind(this, this._onRowActivated));

        this._room = room;
        this._rows = {};
        this._activeRow = null;

        room.connect('member-renamed',
                     Lang.bind(this, this._onMemberRenamed));
        room.connect('member-disconnected',
                     Lang.bind(this, this._onMemberRemoved));
        room.connect('member-kicked',
                     Lang.bind(this, this._onMemberRemoved));
        room.connect('member-banned',
                     Lang.bind(this, this._onMemberRemoved));
        room.connect('member-left',
                     Lang.bind(this, this._onMemberRemoved));
        room.connect('member-joined',
                     Lang.bind(this, this._onMemberJoined));
        /*
        // see https://bugzilla.gnome.org/show_bug.cgi?id=725403
        room.connect('members-changed',
                     Lang.bind(this, this._onMembersChanged));
        */
        room.connect('notify::channel',
                     Lang.bind(this, this._onChannelChanged));
        this._onChannelChanged(room);

        this.widget.show_all();
    },

    setFilter: function(filter) {
        this._filter = filter.toLowerCase();
        this._list.invalidate_filter();
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
        let numMembers = room.channel.group_dup_members_contacts().length;
        this._counterLabel.label = numMembers.toString();
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
        this._list.add(row.widget);
    },

    _removeMember: function(member) {
        let row = this._rows[member];
        if (row && row.widget.get_parent())
            this._list.remove(row.widget);
        delete this._rows[member];
    },

    _setActiveRow: function(row) {
        if (this._activeRow && this._activeRow != row)
            this._activeRow.expand = false;
        this._activeRow = row;
    },

    _onRowActivated: function(list, row) {
        this._setActiveRow(this._rows[row.user]);
        this._activeRow.expand = !this._activeRow.expand;
    },

    _sort: function(row1, row2) {
        return row1.user.alias.localeCompare(row2.user.alias);
    },

    _filterRows: function(row) {
        if (!this._filter)
            return true;
        return row.user.alias.toLowerCase().indexOf(this._filter) != -1;
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

        let members = this._room.channel.group_dup_members_contacts();
        let numMembers = members.length;

        let box = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL,
                                margin_start: 6,
                                margin_end: 6,
                                spacing: 6 });
        box.add(new Gtk.Label({ label: '<b>' + _("All") + '</b>',
                                use_markup: true,
                                hexpand: true,
                                halign: Gtk.Align.START }));
        this._counterLabel = new Gtk.Label({ label: numMembers.toString(),
                                             halign: Gtk.Align.END });
        box.add(this._counterLabel);
        box.show_all();

        row.set_header(box);
    }
});
