const Gio = imports.gi.Gio;
const Gtk = imports.gi.Gtk;

const AccountsMonitor = imports.accountsMonitor;
const ChatroomManager = imports.chatroomManager;
const ChatView = imports.chatView;
const EntryArea = imports.entryArea;
const Lang = imports.lang;
const Signals = imports.signals;

const RoomStack = new Lang.Class({
    Name: 'RoomStack',

    _init: function(inputSizeGroup) {
        this._inputSizeGroup = inputSizeGroup;

        this.widget = new Gtk.Stack({ homogeneous: true,
                                      transition_type: Gtk.StackTransitionType.CROSSFADE });
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
    },

    _updateSensitivity: function() {
        let room = this._roomManager.getActiveRoom();
        let id = room ? room.id : 'placeholder';
        let sensitive = room && room.channel;
        this._rooms[id].inputSensitive = sensitive;
    }
});

const ChatPlaceholder = new Lang.Class({
    Name: 'ChatPlaceholder',

    _init: function() {
        this._accountsMonitor = AccountsMonitor.getDefault();

        let image = new Gtk.Image({ icon_name: 'polari-symbolic',
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

        this.widget = new Gtk.Grid({ column_homogeneous: true, can_focus: false,
                                     column_spacing: 18, hexpand: true, vexpand: true,
                                     valign: Gtk.Align.CENTER });
        this.widget.get_style_context().add_class('polari-background');
        this.widget.attach(image, 0, 0, 1, 1);
        this.widget.attach(title, 1, 0, 1, 1);
        this.widget.attach(description, 0, 1, 2, 1);
        this.widget.show_all();
    }
});
Signals.addSignalMethods(ChatPlaceholder.prototype);

const RoomView = new Lang.Class({
    Name: 'RoomView',

    _init: function(room) {
        this._view = room ? new ChatView.ChatView(room)
                          : new ChatPlaceholder();
        this._view.connect('max-nick-chars-changed', Lang.bind(this,
            function() {
                this.inputWidget.maxNickChars = this._view.maxNickChars;
            }));

        this.widget = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
        this.widget.add(this._view.widget);

        this.inputWidget = room ? new EntryArea.EntryArea({ room: room,
                                                            sensitive: false })
                                : new Gtk.Box();
        this.widget.add(this.inputWidget);

        this.widget.show_all();
    },

    set inputSensitive(sensitive) {
        this.inputWidget.sensitive = sensitive;
    }
});
