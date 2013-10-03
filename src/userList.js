const Gdk = imports.gi.Gdk;
const Gtk = imports.gi.Gtk;
const Pango = imports.gi.Pango;
const Tp = imports.gi.TelepathyGLib;

const ChatroomManager = imports.chatroomManager;
const Lang = imports.lang;

const UserListSidebar = new Lang.Class({
    Name: 'UserListSidebar',

    _init: function() {
        this._createWidget();

        this._rooms = {};
        this._room = null;

        this._roomManager = new ChatroomManager.getDefault();
        this._roomManager.connect('room-added',
                                  Lang.bind(this, this._roomAdded));
        this._roomManager.connect('room-removed',
                                  Lang.bind(this, this._roomRemoved));
        this._roomManager.connect('active-changed',
                                  Lang.bind(this, this._activeRoomChanged));
    },

    _createWidget: function() {
        this.widget = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });

        this._revealer = new Gtk.Revealer();
        this.widget.add(this._revealer);

        let frame = new Gtk.Frame();
        frame.get_style_context().add_class('polari-user-list-search-area');
        this._revealer.add(frame);

        this._entry = new Gtk.SearchEntry({ margin: 4 });
        this._entry.connect('search-changed',
                            Lang.bind(this, this._updateFilter));
        this._entry.connect_after('key-press-event', Lang.bind(this,
            function(w, event) {
                let [, keyval] = event.get_keyval();
                if (keyval == Gdk.KEY_Escape) {
                    this._entry.text = '';
                    return true;
                }
                return false;
            }));
        frame.add(this._entry);

        this._stack = new Gtk.Stack({ hexpand: true, vexpand: true });
        this._stack.transition_type = Gtk.StackTransitionType.CROSSFADE;
        this.widget.add(this._stack);

        this.widget.show_all();
    },

    _roomAdded: function(roomManager, room) {
        if (room.channel.handle_type != Tp.HandleType.ROOM)
            return;

        let userList = new UserList(room);
        this._rooms[room.id] = userList;

        this._stack.add_named(userList.widget, room.id);

        userList.widget.vadjustment.connect('changed',
                                            Lang.bind(this, this._updateEntryVisibility));
    },

    _roomRemoved: function(roomManager, room) {
        if (!this._rooms[room.id])
            return;
        this._rooms[room.id].widget.destroy();
        delete this._rooms[room.id];
    },

    _activeRoomChanged: function(manager, room) {
        this._entry.text = '';
        this._updateFilter();

        this._room = room;

        if (!room || !this._rooms[room.id])
            return;

        this._stack.set_visible_child_name(room.id);
        this._updateEntryVisibility();
    },

    _updateEntryVisibility: function() {
        if (!this._room || !this._rooms[this._room.id])
            return;
        let userList = this._rooms[this._room.id];
        let [, natHeight] = userList.widget.get_child().get_preferred_height();
        let height = this.widget.get_allocated_height();
        this._revealer.reveal_child = this._entry.text != '' ||
                                      natHeight > height;
    },

    _updateFilter: function() {
        if (!this._room || !this._rooms[this._room.id])
            return;
        this._rooms[this._room.id].setFilter(this._entry.text);
    }
});

const UserListRow = new Lang.Class({
    Name: 'UserListRow',

    _init: function(user) {
        this._createWidget(user);

        this.widget.user = user;
    },

    _createWidget: function(user) {
        this.widget = new Gtk.ListBoxRow();
        let box = new Gtk.Box({ margin: 4, spacing: 4 });
        box.add(new Gtk.Image({ icon_name: 'avatar-default-symbolic' }));
        box.add(new Gtk.Label({ label: user.alias,
                                halign: Gtk.Align.START,
                                ellipsize: Pango.EllipsizeMode.END }));
        this.widget.add(box);
        this.widget.show_all();
    }
});

const UserList = new Lang.Class({
    Name: 'UserList',

    _init: function(room) {
        this.widget = new Gtk.ScrolledWindow();
        this.widget.hscrollbar_policy = Gtk.PolicyType.NEVER;

        this._list = new Gtk.ListBox();
        this.widget.add(this._list);

        this._list.set_selection_mode(Gtk.SelectionMode.NONE);
        this._list.set_header_func(Lang.bind(this, this._updateHeader));
        this._list.set_filter_func(Lang.bind(this, this._filterRows));
        this._list.set_sort_func(Lang.bind(this, this._sort));

        this._room = room;
        this._rows = {};

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

        let members = room.channel.group_dup_members_contacts();
        for (let i = 0; i < members.length; i++)
            this._addMember(members[i]);

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

    _sort: function(row1, row2) {
        return row1.user.alias.localeCompare(row2.user.alias);
    },

    _filterRows: function(row) {
        if (!this._filter)
            return true;
        return row.user.alias.toLowerCase().indexOf(this._filter) != -1;
    },

    _updateHeader: function(row, before) {
        let numMembers = this._list.get_children().length;

        if (before) {
            row.set_header(null);
            return;
        }

        let header = this._list.get_row_at_index(0).get_header();
        if (header) {
            header._counterLabel.label = numMembers.toString();
            return;
        }

        let box = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL,
                                margin_left: 6,
                                margin_right: 6,
                                spacing: 6 });
        box.add(new Gtk.Label({ label: '<b>' + _("All") + '</b>',
                                use_markup: true,
                                hexpand: true,
                                halign: Gtk.Align.START }));
        box._counterLabel = new Gtk.Label({ label: numMembers.toString(),
                                            halign: Gtk.Align.END });
        box.add(box._counterLabel);
        box.show_all();

        row.set_header(box);
    }
});
