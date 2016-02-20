const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;

const AccountsMonitor = imports.accountsMonitor;
const ChatroomManager = imports.chatroomManager;
const ChatView = imports.chatView;
const EntryArea = imports.entryArea;
const Lang = imports.lang;

const RoomStack = new Lang.Class({
    Name: 'RoomStack',
    Extends: Gtk.Stack,
    Properties: {
        'entry-area-height': GObject.ParamSpec.uint('entry-area-height',
                                                    'entry-area-height',
                                                    'entry-area-height',
                                                    GObject.ParamFlags.READABLE,
                                                    0, GLib.MAXUINT32, 0)
    },

    _init: function(params) {
        this.parent(params);

        this._sizeGroup = new Gtk.SizeGroup({ mode: Gtk.SizeGroupMode.VERTICAL });
        this._rooms = {};

        this._roomManager = ChatroomManager.getDefault();

        this._roomManager.connect('room-added',
                                  Lang.bind(this, this._roomAdded));
        this._roomManager.connect('room-removed',
                                  Lang.bind(this, this._roomRemoved));
        this._roomManager.connect('active-changed',
                                  Lang.bind(this, this._activeRoomChanged));
        this._roomManager.connect('active-state-changed',
                                  Lang.bind(this, this._updateSensitivity));

        this.add_named(new ChatPlaceholder(this._sizeGroup), 'placeholder');

        this._entryAreaHeight = 0;
        this._sizeGroup.get_widgets()[0].connect('size-allocate', Lang.bind(this,
            function(w, rect) {
                this._entryAreaHeight = rect.height - 1;
                this.notify('entry-area-height');
            }));
    },

    get entry_area_height() {
        return this._entryAreaHeight;
    },

    _addView: function(id, view) {
        this._rooms[id] = view;
        this.add_named(view, id);
    },

    _roomAdded: function(roomManager, room) {
        this._addView(room.id, new RoomView(room, this._sizeGroup));
    },

    _roomRemoved: function(roomManager, room) {
        this._rooms[room.id].destroy();
        delete this._rooms[room.id];
    },

    _activeRoomChanged: function(manager, room) {
        this.set_visible_child_name(room ? room.id : 'placeholder');
    },

    _updateSensitivity: function() {
        let room = this._roomManager.getActiveRoom();
        if (!room)
            return;
        let sensitive = room && room.channel;
        this._rooms[room.id].inputSensitive = sensitive;
    }
});

const ChatPlaceholder = new Lang.Class({
    Name: 'ChatPlaceholder',
    Extends: Gtk.Overlay,

    _init: function(sizeGroup) {
        this._accountsMonitor = AccountsMonitor.getDefault();

        let image = new Gtk.Image({ icon_name: 'org.gnome.Polari-symbolic',
                                      pixel_size: 96, halign: Gtk.Align.END,
                                      margin_end: 14 });

        let title = new Gtk.Label({ use_markup: true, halign: Gtk.Align.START,
                                    margin_start: 14 });
        title.label = '<span letter_spacing="4500">%s</span>'.format(_("Polari"));
        title.get_style_context().add_class('polari-background-title');

        let description = new Gtk.Label({ label: _("Join a room using the + button."),
                                          halign: Gtk.Align.CENTER, wrap: true,
                                          margin_top: 24, use_markup: true });
        description.get_style_context().add_class('polari-background-description');

        let inputPlaceholder = new Gtk.Box({ valign: Gtk.Align.END });
        sizeGroup.add_widget(inputPlaceholder);

        this.parent();
        let grid = new Gtk.Grid({ column_homogeneous: true, can_focus: false,
                                  column_spacing: 18, hexpand: true, vexpand: true,
                                  valign: Gtk.Align.CENTER });
        grid.get_style_context().add_class('polari-background');
        grid.attach(image, 0, 0, 1, 1);
        grid.attach(title, 1, 0, 1, 1);
        grid.attach(description, 0, 1, 2, 1);
        this.add(grid);
        this.add_overlay(inputPlaceholder);
        this.show_all();
    }
});

const RoomView = new Lang.Class({
    Name: 'RoomView',
    Extends: Gtk.Box,

    _init: function(room, sizeGroup) {
        this.parent({ orientation: Gtk.Orientation.VERTICAL });

        this._view = new ChatView.ChatView(room);
        this.add(this._view);

        this._entryArea = new EntryArea.EntryArea({ room: room,
                                                    sensitive: false });
        this.add(this._entryArea);

        this._view.bind_property('max-nick-chars',
                                 this._entryArea, 'max-nick-chars',
                                 GObject.BindingFlags.SYNC_CREATE);
        sizeGroup.add_widget(this._entryArea);

        this.show_all();
    },

    set inputSensitive(sensitive) {
        this._entryArea.sensitive = sensitive;
    }
});
