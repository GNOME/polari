const Gtk = imports.gi.Gtk;
const Tp = imports.gi.TelepathyGLib;

const Lang = imports.lang;
const Mainloop = imports.mainloop;

const COMMAND_OUTPUT_REVEAL_TIME = 3;

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

const CommandOutputNotification = new Lang.Class({
    Name: 'CommandOutputNotification',
    Extends: AppNotification,
    Abstract: true,

    _init: function() {
        this.parent();

        this.widget.transition_type = Gtk.RevealerTransitionType.SLIDE_UP;
        Mainloop.timeout_add_seconds(COMMAND_OUTPUT_REVEAL_TIME,
                                     Lang.bind(this, this.close));
    }
});

const SimpleOutput = new Lang.Class({
    Name: 'SimpleOutput',
    Extends: CommandOutputNotification,

    _init: function(text) {
        this.parent();

        let label = new Gtk.Label({ label: text,
                                    vexpand: true,
                                    visible: true });
        this.widget.add(label);
        this.widget.show_all();
    }
});

const GridOutput = new Lang.Class({
    Name: 'GridOutput',
    Extends: CommandOutputNotification,

    _init: function(header, items) {
        this.parent();

        let numItems = items.length;
        let numCols = Math.min(numItems, 4);
        let numRows = Number.toInteger(numItems / numCols) + numItems % numCols;

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
        this.widget.add(grid);
        this.widget.show_all();
    }
});

const ConnectingNotification = new Lang.Class({
    Name: 'ConnectingNotification',
    Extends: AppNotification,

    _init: function(account) {
        this.parent();

        this._grid = new Gtk.Grid({ orientation: Gtk.Orientation.HORIZONTAL,
                                    column_spacing: 12 });

        this._grid.add(new Gtk.Spinner({ active: true }));

        let text = _("Connecting to %s").format(account.display_name);
        let label = new Gtk.Label({ label: text });
        this._grid.add(label);

        this.widget.add(this._grid);
        this.widget.show_all();

        account.connect('notify::connection-status',
                        Lang.bind(this, this._onConnectionStatusChanged));
    },

    _onConnectionStatusChanged: function(account) {
        if (account.connection_status == Tp.ConnectionStatus.CONNECTING)
            return;
        this.close();
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

const CommandOutputQueue = new Lang.Class({
    Name: 'CommandOutputQueue',
    Extends: NotificationQueue,

    _init: function() {
        this.parent();

        this.widget.valign = Gtk.Align.END;
        this.widget.get_style_context().add_class('irc-feedback');
    }
});
