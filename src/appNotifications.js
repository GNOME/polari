const Gtk = imports.gi.Gtk;

const Lang = imports.lang;

const AppNotification = new Lang.Class({
    Name: 'AppNotification',
    Abstract: true,

    _init: function() {
        this.widget = new Gtk.Revealer({ reveal_child: true });
        this.widget.transition_type = Gtk.RevealerTransitionType.SLIDE_DOWN;

        this.widget.connect('notify::child-revealed',
                            Lang.bind(this, this._onChildRevealed));
    },

    close: function() {
        this.widget.reveal_child = false;
    },

    _onChildRevealed: function() {
        if (!this.widget.child_revealed)
            this.widget.destroy();
    }
});

const NotificationQueue = new Lang.Class({
    Name: 'NotificationQueue',

    _init: function() {
        this.widget = new Gtk.Frame({ valign: Gtk.Align.START,
                                      halign: Gtk.Align.CENTER,
                                      no_show_all: true });
        this.widget.get_style_context().add_class('app-notification');

        this._grid = new Gtk.Grid({ orientation: Gtk.Orientation.VERTICAL,
                                    row_spacing: 6, visible: true });
        this.widget.add(this._grid);
    },

    addNotification: function(notification) {
        this._grid.add(notification.widget);

        notification.widget.connect('destroy',
                                    Lang.bind(this, this._onChildDestroy));
        this.widget.show();
    },

    _onChildDestroy: function() {
        if (this._grid.get_children().length == 0)
           this.widget.hide();
    }
});
