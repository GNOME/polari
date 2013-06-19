const Gtk = imports.gi.Gtk;
const Pango = imports.gi.Pango;

const ChatroomManager = imports.chatroomManager;
const Lang = imports.lang;

const RoomRow = new Lang.Class({
    Name: 'RoomRow',

    _init: function(room) {
        this.widget = new Gtk.ListBoxRow({ margin_top: 4 });
        this.widget.room = room;

        let box = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL,
                                margin_left: 8, margin_right: 8,
                                margin_top: 2, margin_bottom: 2, spacing: 6 });
        this.widget.add(box);

        let icon = new Gtk.Image({ gicon: room.icon,
                                   icon_size: Gtk.IconSize.MENU });
        icon.get_style_context().add_class('dim-label');
        box.add(icon);

        this._roomLabel = new Gtk.Label({ use_markup: true,
                                          hexpand: true,
                                          halign: Gtk.Align.START });
        box.add(this._roomLabel);

        this._counter = new Gtk.Label({ width_chars: 2 });
        this._counter.get_style_context().add_class('pending-messages-count');
        box.add(this._counter);

        this.widget.show_all();

        this._room = room;
        this._room.channel.connect('message-received',
                                   Lang.bind(this, this._updateCounter));
        this._room.channel.connect('pending-message-removed',
                                   Lang.bind(this, this._updateCounter));
        this._room.connect('notify::display-name',
                           Lang.bind(this, this._updateLabel));

        this._updateLabel();
        this._updateCounter();
    },

    _updateCounter: function() {
        let numPending = this._room.channel.dup_pending_messages().length;
        this._counter.label = numPending.toString();
        this._counter.visible = numPending > 0;
        this._updateLabel();
    },

    _updateLabel: function() {
        let highlight = false;
        let pending = this._room.channel.dup_pending_messages();
        for (let i = 0; i < pending.length && !highlight; i++)
            highlight = this._room.should_highlight_message(pending[i]);
        this._roomLabel.label = (highlight ? "<b><small>%s</small></b>"
                                           : "%s").format(this._room.display_name);
    }
});

const RoomList = new Lang.Class({
    Name: 'RoomList',

    _init: function() {
        this.widget = new Gtk.ListBox({ hexpand: false });

        this.widget.get_style_context().add_class('polari-room-list');

        this.widget.set_selection_mode(Gtk.SelectionMode.BROWSE);
        this.widget.set_header_func(Lang.bind(this, this._updateHeader));
        this.widget.set_sort_func(Lang.bind(this, this._sort));

        this.widget.set_size_request(150, -1);

        this.widget.connect('row-selected',
                            Lang.bind(this, this._onRowSelected));

        this._roomManager = ChatroomManager.getDefault();
        this._roomManager.connect('room-added',
                                  Lang.bind(this, this._roomAdded));
        this._roomManager.connect('room-removed',
                                  Lang.bind(this, this._roomRemoved));
        this._roomManager.connect('active-changed',
                                  Lang.bind(this, this._activeRoomChanged));
    },

    _getRowByRoom: function(room) {
        let rows = this.widget.get_children();
        for (let i = 0; i < rows.length; i++)
            if (rows[i].room.id == room.id)
                return rows[i];
        return null;
    },

    _roomAdded: function(roomManager, room) {
        let row = new RoomRow(room);
        this.widget.add(row.widget);

        row.widget.can_focus = false;
        this._roomManager.setActiveRoom(room);
        row.widget.can_focus = true;
    },

    _roomRemoved: function(roomManager, room) {
        let row = this._getRowByRoom(room);
        if (row)
            this.widget.remove(row);
    },

    _activeRoomChanged: function(roomManager, room) {
        if (!room)
            return;
        let row = this._getRowByRoom(room);
        if (row)
            this.widget.select_row(row);
    },

    _onRowSelected: function(w, row) {
        this._roomManager.setActiveRoom(row ? row.room : null);
    },

    _updateHeader: function(row, before) {
        let beforeAccount = before ? before.room.channel.connection.get_account()
                                   : null;
        let account = row.room.channel.connection.get_account();
        if (beforeAccount == account) {
            row.set_header(null);
            return;
        }

        let label = new Gtk.Label({ label: account.display_name,
                                    xalign: 0,
                                    max_width_chars: 15,
                                    ellipsize: Pango.EllipsizeMode.END });
        label.get_style_context().add_class('room-list-header');
        row.set_header(label);
    },

    _sort: function(row1, row2) {
        return row1.room.compare(row2.room);
    }
});
