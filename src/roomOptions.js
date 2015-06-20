const Gio = imports.gi.Gio;
const Gdk = imports.gi.Gdk;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;
const Tp = imports.gi.TelepathyGLib;

const ChatroomManager = imports.chatroomManager;
const Lang = imports.lang;
const Mainloop = imports.mainloop;

const RoomOptions = new Lang.Class({
    Name: 'RoomOptions',
    Extends: Gtk.Popover,
    Template: 'resource:///org/gnome/Polari/room-options.ui',
    InternalChildren: ['revealer',
                       'box',
                       'roomLabelBox',
                       'userIcon',
                       'roomLabel',
                       'groupOptionsBox',
                       'topicLabel',
                       'scrolledWindow',
                       'textView',
                       'leaveButton'],

    _init: function(params) {
        this.parent(params);
        this.set_size_request(320, -1);
        this._textView.wrap_mode = Gtk.WrapMode.WORD_CHAR;
        this._textView.connect('key-press-event', Lang.bind(this, function(w, event) {
            let [, keyval] = event.get_keyval();
            if (keyval == Gdk.KEY_ISO_Enter || keyval == Gdk.KEY_Return)
                this.hide();
            return Gdk.EVENT_PROPAGATE;
        }));

        this._leaveButton.connect('clicked', Lang.bind(this, function() {
            let app = Gio.Application.get_default();
            let LeaveAction = app.lookup_action('leave-room');
            LeaveAction.activate(GLib.Variant.new('(ss)', [this._room.id, '']));
            this.hide();
        }));


        this._box.show_all();

        this.connect('map', Lang.bind(this, function() {
            this._revealer.transition_duration = 0;
            this._evaluateRoomType();
        }));
        this._revealer.connect('notify::child-revealed', Lang.bind(this, function() {
            this._revealer.transition_duration = 250;
        }));

        this.connect('closed', Lang.bind(this, function() {
            let buffer = this._textView.buffer;
            let start = buffer.get_start_iter();
            let end = buffer.get_end_iter();
            let text = buffer.get_text(start,end,false);
            if (this._room && this._room.topic != text) {
                this._room.set_topic(text);
            }
        }));

        this._roomManager = new ChatroomManager.getDefault();
    },

    _evaluateRoomType: function() {
        if (this._userList)
            return;

        this._room = this._roomManager.getActiveRoom();

        if (!this._room)
            return;

        this._roomLabel.label = '<b>' + this._room.display_name + '</b>';
        if (this._room.type == Tp.HandleType.ROOM) {
            this._userIcon.icon_name = 'polari-symbolic';
            this._groupOptionsBox.visible = true;
            let topic = this._room.topic ? this._room.topic : '';
            this._textView.buffer.set_text(topic, topic.length);
        } else {
            this._userIcon.icon_name = 'avatar-default-symbolic';
            this._groupOptionsBox.visible = false;
        }
    }
});
