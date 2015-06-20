const Gdk = imports.gi.Gdk;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;
const Tp = imports.gi.TelepathyGLib;

const ChatroomManager = imports.chatroomManager;
const Lang = imports.lang;
const Mainloop = imports.mainloop;

const RoomOptionsPopover = new Lang.Class({
    Name: 'RoomOptionsPopover',

    _init: function() {
        this._createWidget();

        this.widget.connect('map', Lang.bind(this, function() {
            this._revealer.transition_duration = 0;
            this._ensureRoomOptions();
        }));
        this._revealer.connect('notify::child-revealed', Lang.bind(this, function() {
            this._revealer.transition_duration = 250;
        }));

        this._roomManager = new ChatroomManager.getDefault();
    },

    _createWidget: function() {
        this.widget = new Gtk.Popover({ modal: true,
                                        position: Gtk.PositionType.TOP });

        this.widget.set_border_width(6);
        this.widget.set_size_request(250, -1);

        this.widget.get_style_context().add_class('polari-user-list');

        this._box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL,
                                  spacing: 6 });
        this.widget.add(this._box);

        this._revealer = new Gtk.Revealer();
        this._box.add(this._revealer);
        this._box.show_all();
    },

    _ensureRoomOptions: function() {
        if (this._userList)
            return;

        let room = this._roomManager.getActiveRoom();
        if (!room)
            return;
    }
});
