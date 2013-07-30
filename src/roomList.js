const Gio = imports.gi.Gio;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;
const Pango = imports.gi.Pango;

const ChatroomManager = imports.chatroomManager;
const Lang = imports.lang;

const RoomRow = new Lang.Class({
    Name: 'RoomRow',

    _init: function(room) {
        this._createWidget(room.icon);

        this.widget.room = room;

        room.channel.connect('message-received',
                             Lang.bind(this, this._updateCounter));
        room.channel.connect('pending-message-removed',
                             Lang.bind(this, this._updateCounter));
        room.connect('notify::display-name',
                     Lang.bind(this, this._updateLabel));

        this._updateCounter();
    },

    _updateCounter: function() {
        let channel = this.widget.room.channel;
        let numPending = channel.dup_pending_messages().length;

        this._counter.label = numPending.toString();
        this._counter.opacity = numPending > 0 ? 1. : 0.;

        this._updateLabel();
    },

    _updateLabel: function() {
        let room = this.widget.room;

        let highlight = false;
        let pending = room.channel.dup_pending_messages();
        for (let i = 0; i < pending.length && !highlight; i++)
            highlight = room.should_highlight_message(pending[i]);

        this._roomLabel.label = (highlight ? "<b>%s</b>"
                                           : "%s").format(room.display_name);
    },

    _createWidget: function(gicon) {
        this.widget = new Gtk.ListBoxRow({ margin_bottom: 4 });

        let box = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL,
                                margin_left: 8, margin_right: 8,
                                margin_top: 2, margin_bottom: 2, spacing: 6 });
        this.widget.add(box);

        let icon = new Gtk.Image({ gicon: gicon,
                                   icon_size: Gtk.IconSize.MENU,
                                   valign: Gtk.Align.BASELINE });
        icon.get_style_context().add_class('dim-label');
        box.add(icon);

        this._roomLabel = new Gtk.Label({ use_markup: true,
                                          hexpand: true,
                                          ellipsize: Pango.EllipsizeMode.END,
                                          halign: Gtk.Align.START,
                                          valign: Gtk.Align.BASELINE });
        box.add(this._roomLabel);

        this._counter = new Gtk.Label({ width_chars: 2,
                                        halign: Gtk.Align.END });
        this._counter.get_style_context().add_class('pending-messages-count');
        box.add(this._counter);

        this.widget.show_all();
    }
});

const RoomList = new Lang.Class({
    Name: 'RoomList',

    _init: function() {
        this.widget = new Gtk.ListBox({ hexpand: false });

        this.widget.set_selection_mode(Gtk.SelectionMode.BROWSE);
        this.widget.set_header_func(Lang.bind(this, this._updateHeader));
        this.widget.set_sort_func(Lang.bind(this, this._sort));

        this.widget.connect('row-selected',
                            Lang.bind(this, this._onRowSelected));

        this._roomManager = ChatroomManager.getDefault();
        this._roomManager.connect('room-added',
                                  Lang.bind(this, this._roomAdded));
        this._roomManager.connect('room-removed',
                                  Lang.bind(this, this._roomRemoved));
        this._roomManager.connect('active-changed',
                                  Lang.bind(this, this._activeRoomChanged));

        let app = Gio.Application.get_default();
        let action;

        action = app.lookup_action('next-room');
        action.connect('activate', Lang.bind(this,
            function() {
                this._moveSelection(Gtk.MovementStep.DISPLAY_LINES, 1);
            }));
        action = app.lookup_action('previous-room');
        action.connect('activate', Lang.bind(this,
            function() {
                this._moveSelection(Gtk.MovementStep.DISPLAY_LINES, -1);
            }));
        action = app.lookup_action('first-room');
        action.connect('activate', Lang.bind(this,
            function() {
                this._moveSelection(Gtk.MovementStep.BUFFER_ENDS, -1);
            }));
        action = app.lookup_action('last-room');
        action.connect('activate', Lang.bind(this,
            function() {
                this._moveSelection(Gtk.MovementStep.BUFFER_ENDS, 1);
            }));
    },

    _getRowByRoom: function(room) {
        let rows = this.widget.get_children();
        for (let i = 0; i < rows.length; i++)
            if (rows[i].room.id == room.id)
                return rows[i];
        return null;
    },

    _moveSelection: function(movement, count) {
        let toplevel = this.widget.get_toplevel();
        let focus = toplevel.get_focus();

        this.widget.emit('move-cursor', movement, count);

        let newFocus = this.widget.get_focus_child();
        if (newFocus)
            this.widget.select_row(newFocus);

        if (focus && focus.get_parent() != this.widget)
            focus.emit('grab-focus');
    },

    _roomAdded: function(roomManager, room) {
        let roomRow = new RoomRow(room);
        this.widget.add(roomRow.widget);
    },

    _roomRemoved: function(roomManager, room) {
        let roomRow = this._roomRows[room.id];
        if (!roomRow)
            return;

        let row = roomRow.widget;
        let selected = this.widget.get_selected_row();
        if (selected == row && this.widget.get_children().length > 1) {
            let count = row.get_index() == 0 ? 1 : -1;
            this._moveSelection(Gtk.MovementStep.DISPLAY_LINES, count);
        }
        this.widget.remove(row);
    },

    _activeRoomChanged: function(roomManager, room) {
        if (!room)
            return;
        let row = this._getRowByRoom(room);
        if (!row)
            return;

        row.can_focus = false;
        this.widget.select_row(row);
        row.can_focus = true;
    },

    _onRowSelected: function(w, row) {
        this._roomManager.setActiveRoom(row ? row.room : null);
    },

    _updateHeader: function(row, before) {
        let getAccount = function(row) {
            return row ? row.room.channel.connection.get_account() : null;
        };
        let beforeAccount = getAccount(before);
        let account = getAccount(row);

        if (beforeAccount == account) {
            row.set_header(null);
            return;
        }

        if (row.get_header())
            return;

        let label = new Gtk.Label({ margin_bottom: 4, xalign: 0,
                                    max_width_chars: 15,
                                    ellipsize: Pango.EllipsizeMode.END });
        label.get_style_context().add_class('room-list-header');

        account.bind_property('display-name', label, 'label',
                              GObject.BindingFlags.SYNC_CREATE);
        row.set_header(label);
    },

    _sort: function(row1, row2) {
        return row1.room.compare(row2.room);
    }
});
