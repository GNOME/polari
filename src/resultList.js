const Gdk = imports.gi.Gdk;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;
const Pango = imports.gi.Pango;
const Tp = imports.gi.TelepathyGLib;

const AccountsMonitor = imports.accountsMonitor;
const ChatroomManager = imports.chatroomManager;
const Lang = imports.lang;

const ResultRow = new Lang.Class({
    Name: 'ResultRow',
    Extends: Gtk.ListBoxRow,
    Template: 'resource:///org/gnome/Polari/ui/result-list-row.ui',
    InternalChildren: ['box1', 'source_name', 'short_time_label', 'content_label'],

    _init: function(message, uid) {
        this.parent();

        this._uid = uid;

        // this._icon.gicon = room.icon;
        // this._icon.visible = room.icon != null;
        this.connect('key-press-event',
                     Lang.bind(this, this._onKeyPress));

        // room.connect('notify::channel', Lang.bind(this,
        //     function() {
        //         if (!room.channel)
        //             return;
        //         room.channel.connect('message-received',
        //                              Lang.bind(this, this._updatePending));
        //         room.channel.connect('pending-message-removed',
        //                              Lang.bind(this, this._updatePending));
        //     }));
        // room.bind_property('display-name', this._roomLabel, 'label',
        //                    GObject.BindingFlags.SYNC_CREATE);
        //
        // this._updatePending();
    },

    _onButtonRelease: function(w, event) {
        let [, button] = event.get_button();
        if (button != Gdk.BUTTON_SECONDARY)
            return Gdk.EVENT_PROPAGATE;

        // this._showPopover();

        return Gdk.EVENT_STOP;
    },

    _onKeyPress: function(w, event) {
        let [, keyval] = event.get_keyval();
        let [, mods] = event.get_state();
        if (keyval != Gdk.KEY_Menu &&
            !(keyval == Gdk.KEY_F10 &&
              mods & Gdk.ModifierType.SHIFT_MASK))
            return Gdk.EVENT_PROPAGATE;

        // this._showPopover();

        return Gdk.EVENT_STOP;
    }
});
