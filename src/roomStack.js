const Gio = imports.gi.Gio;
const Gtk = imports.gi.Gtk;

const ChatroomManager = imports.chatroomManager;
const ChatView = imports.chatView;
const EntryArea = imports.entryArea;
const Lang = imports.lang;

const RoomStack = new Lang.Class({
    Name: 'RoomStack',

    _init: function(inputSizeGroup) {
        this._inputSizeGroup = inputSizeGroup;

        this.widget = new Gtk.Stack();
        this.widget.show_all();

        this._roomManager = ChatroomManager.getDefault();

        this._roomManager.connect('room-added',
                                  Lang.bind(this, this._roomAdded));
        this._roomManager.connect('room-removed',
                                  Lang.bind(this, this._roomRemoved));
        this._roomManager.connect('active-changed',
                                  Lang.bind(this, this._activeRoomChanged));
        this._roomManager.connect('active-state-changed',
                                  Lang.bind(this, this._updateSensitivity));

        let app = Gio.Application.get_default();
        this._selectionModeAction = app.lookup_action('selection-mode');
        this._selectionModeAction.connect('notify::state',
                                          Lang.bind(this, this._updateSensitivity));

        this._rooms = {};

        this._addView('placeholder', new RoomView(null));
    },

    _addView: function(id, view) {
        this._rooms[id] = view;

        this._inputSizeGroup.add_widget(view.inputWidget);
        this.widget.add_named(view.widget, id);
    },

    _roomAdded: function(roomManager, room) {
        this._addView(room.id, new RoomView(room));
    },

    _roomRemoved: function(roomManager, room) {
        this._rooms[room.id].widget.destroy();
        delete this._rooms[room.id];
    },

    _activeRoomChanged: function(manager, room) {
        this.widget.set_visible_child_name(room ? room.id : 'placeholder');
        this.widget.transition_type = room ? Gtk.StackTransitionType.CROSSFADE
                                           : Gtk.StackTransitionType.NONE;
    },

    _updateSensitivity: function() {
        let room = this._roomManager.getActiveRoom();
        let id = room ? room.id : 'placeholder';
        let sensitive = room && room.channel &&
                        !this._selectionModeAction.state.get_boolean();
        this._rooms[id].inputSensitive = sensitive;
    }
});

const ChatPlaceholder = new Lang.Class({
    Name: 'ChatPlaceholder',

    _init: function() {
        this.widget = new Gtk.Label({ vexpand: true });
    }
});

const RoomView = new Lang.Class({
    Name: 'RoomView',

    _init: function(room) {
        this._view = room ? new ChatView.ChatView(room)
                          : new ChatPlaceholder();

        this._entryArea = new EntryArea.EntryArea(room);

        this.widget = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
        this.widget.add(this._view.widget);

        this.inputWidget = new Gtk.Frame();
        this.inputWidget.get_style_context().add_class('polari-input-area');
        this.widget.add(this.inputWidget);

        this.inputWidget.add(this._entryArea.widget);

        this.widget.show_all();
    },

    set inputSensitive(sensitive) {
        this._entryArea.widget.sensitive = sensitive;
    }
});
