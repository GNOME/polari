const Gdk = imports.gi.Gdk;
const Gtk = imports.gi.Gtk;
const Pango = imports.gi.Pango;

const Lang = imports.lang;

const UserList = new Lang.Class({
    Name: 'UserList',

    _init: function(room) {
        this.widget = new Gtk.ListBox();

        this.widget.set_selection_mode(Gtk.SelectionMode.NONE);
        this.widget.set_header_func(Lang.bind(this, this._updateHeader));
        this.widget.set_sort_func(Lang.bind(this, this._sort));

        this._room = room;

        /* tmp - use a stylesheet instead */
        let bg = new Gdk.RGBA();
        bg.parse("#eee");
        this.widget.override_background_color(0, bg);


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
                                //max_width_chars: MAX_NICK_CHARS,
                                ellipsize: Pango.EllipsizeMode.END }));
        row.add(box);
        row.show_all();
        this.widget.add(row);
    },

    _removeMember: function(member) {
        let rows = this.widget.get_children();
        for (let i = 0; i < rows.length; i++) {
            if (rows[i]._member != member)
                continue;
            this.widget.remove(rows[i]);
            break;
        }
    },

    _sort: function(row1, row2) {
        return (row1._member.alias < row2._member.alias) ? -1 : 1;
    },

    _updateHeader: function(row, before) {
        let numMembers = this.widget.get_children().length;

        if (before)
            row.set_header(null);

        let header = this.widget.get_row_at_index(0).get_header();
        if (header) {
            header._counterLabel.label = numMembers.toString();
            return;
        }

        let box = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL,
                                margin_left: 6,
                                margin_right: 6,
                                spacing: 6 });
        box.add(new Gtk.Label({ label: '<b>' + "All" + '</b>',
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
