const Gtk = imports.gi.Gtk;
const Pango = imports.gi.Pango;
const Tp = imports.gi.TelepathyGLib;

const Lang = imports.lang;
const Mainloop = imports.mainloop;

const TIMEOUT = 7;
const COMMAND_OUTPUT_REVEAL_TIME = 3;

var AppNotification = new Lang.Class({
    Name: 'AppNotification',
    Abstract: true,
    Extends: Gtk.Revealer,

    _init: function() {
        this.parent({ reveal_child: true,
                      transition_type: Gtk.RevealerTransitionType.SLIDE_DOWN });
        this.connect('notify::child-revealed',
                     Lang.bind(this, this._onChildRevealed));
    },

    close: function() {
        this.reveal_child = false;
    },

    _onChildRevealed: function() {
        if (!this.child_revealed)
            this.destroy();
    }
});

var MessageNotification = new Lang.Class({
    Name: 'MessageNotification',
    Extends: AppNotification,

    _init: function(label, iconName) {
        this.parent();

        Mainloop.timeout_add_seconds(TIMEOUT, Lang.bind(this, this.close));

        this._box = new Gtk.Box({ spacing: 12 });

        if (iconName)
            this._box.add(new Gtk.Image({ icon_name: iconName }));

        this._box.add(new Gtk.Label({ label: label, hexpand: true,
                                      ellipsize: Pango.EllipsizeMode.END }));

        let closeButton = new Gtk.Button({ relief: Gtk.ReliefStyle.NONE });
        closeButton.image = new Gtk.Image({ icon_name: 'window-close-symbolic' });
        closeButton.connect('clicked', Lang.bind(this, this.close));
        this._box.pack_end(closeButton, false, false, 0);

        this.add(this._box);
        this.show_all();
    },


    addButton: function(label, callback) {
        let button = new Gtk.Button({ label: label, visible: true });
        button.connect('clicked', () => {
            if (callback)
                callback();
            this.close();
        });

        this._box.add(button);
    }
});

var UndoNotification = new Lang.Class({
    Name: 'UndoNotification',
    Extends: MessageNotification,
    Signals: { closed: {}, undo: {} },

    _init: function(label) {
        this.parent(label);

        this._undo = false;
        this._closed = false;

        this.connect('destroy', () => { this.close(); });

        this.addButton(_("Undo"), () => { this._undo = true; });
    },

    close: function() {
        if (this._closed)
            return;

        this._closed = true;
        this.emit(this._undo ? 'undo' : 'closed');
        this.parent();
    }
});

var CommandOutputNotification = new Lang.Class({
    Name: 'CommandOutputNotification',
    Extends: AppNotification,
    Abstract: true,

    _init: function() {
        this.parent();

        this.transition_type = Gtk.RevealerTransitionType.SLIDE_UP;
        Mainloop.timeout_add_seconds(COMMAND_OUTPUT_REVEAL_TIME,
                                     Lang.bind(this, this.close));
    }
});

var SimpleOutput = new Lang.Class({
    Name: 'SimpleOutput',
    Extends: CommandOutputNotification,

    _init: function(text) {
        this.parent();

        let label = new Gtk.Label({ label: text,
                                    vexpand: true,
                                    visible: true,
                                    wrap: true });
        this.add(label);
        this.show_all();
    }
});

var GridOutput = new Lang.Class({
    Name: 'GridOutput',
    Extends: CommandOutputNotification,

    _init: function(header, items) {
        this.parent();

        let numItems = items.length;
        let numCols = Math.min(numItems, 4);
        let numRows = Math.floor(numItems / numCols) + numItems % numCols;

        let grid = new Gtk.Grid({ column_homogeneous: true,
                                  row_spacing: 6,
                                  column_spacing: 18 });
        grid.attach(new Gtk.Label({ label: header }), 0, 0, numCols, 1);

        let row = 1;
        for (let i = 0; i < numRows; i++) {
            for (let j = 0; j < numCols; j++) {
                let item = items[i + j * numRows];
                if (!item)
                    continue;
                let w = new Gtk.Label({ label: item });
                grid.attach(w, j, row, 1, 1);
             }
            row++;
        }
        this.add(grid);
        this.show_all();
    }
});

var NotificationQueue = new Lang.Class({
    Name: 'NotificationQueue',
    Extends: Gtk.Frame,

    _init: function() {
        this.parent({ valign: Gtk.Align.START,
                      halign: Gtk.Align.CENTER,
                      margin_start: 24, margin_end: 24,
                      no_show_all: true });
        this.get_style_context().add_class('app-notification');

        this._grid = new Gtk.Grid({ orientation: Gtk.Orientation.VERTICAL,
                                    row_spacing: 6, visible: true });
        this.add(this._grid);
    },

    addNotification: function(notification) {
        this._grid.add(notification);

        notification.connect('destroy', Lang.bind(this, this._onChildDestroy));
        this.show();
    },

    _onChildDestroy: function() {
        if (this._grid.get_children().length == 0)
           this.hide();
    }
});

var CommandOutputQueue = new Lang.Class({
    Name: 'CommandOutputQueue',
    Extends: NotificationQueue,

    _init: function() {
        this.parent();

        this.valign = Gtk.Align.END;
        this.get_style_context().add_class('irc-feedback');
    }
});
