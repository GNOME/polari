const Gdk = imports.gi.Gdk;
const Gtk = imports.gi.Gtk;
const Pango = imports.gi.Pango;

const Lang = imports.lang;

const UserList = new Lang.Class({
    Name: 'UserList',

    _init: function(room) {
        this.widget = new Gtk.ScrolledWindow();
        this.widget.hscrollbar_policy = Gtk.PolicyType.NEVER;

        this._list = new Gtk.ListBox();
        this.widget.add(this._list);

        this._list.set_selection_mode(Gtk.SelectionMode.NONE);
        this._list.set_header_func(Lang.bind(this, this._updateHeader));
        this._list.set_sort_func(Lang.bind(this, this._sort));

        this._room = room;

        room.connect('member-renamed',
                     Lang.bind(this, this._onMemberRenamed));
        room.connect('member-disconnected',
                     Lang.bind(this, this._onMemberRemoved));
        room.connect('member-kicked',
                     Lang.bind(this, this._onMemberRemoved));
        room.connect('member-banned',
                     Lang.bind(this, this._onMemberRemoved));
        room.connect('member-joined',
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
        let row = new Gtk.ListBoxRow();
        row._member = member;
        let box = new Gtk.Box({ margin: 4, spacing: 4 });
        box.add(new Gtk.Image({ icon_name: 'avatar-default-symbolic' }));
        box.add(new Gtk.Label({ label: member.alias,
                                halign: Gtk.Align.START,
                                ellipsize: Pango.EllipsizeMode.END }));
        row.add(box);
        row.show_all();
        this._list.add(row);
    },

    _removeMember: function(member) {
        let rows = this._list.get_children();
        for (let i = 0; i < rows.length; i++) {
            if (rows[i]._member != member)
                continue;
            this._list.remove(rows[i]);
            break;
        }
    },

    _sort: function(row1, row2) {
        return (row1._member.alias < row2._member.alias) ? -1 : 1;
    },

    _updateHeader: function(row, before) {
        let numMembers = this._list.get_children().length;

        if (before)
            row.set_header(null);

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
