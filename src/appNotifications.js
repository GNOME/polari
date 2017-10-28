const Gio = imports.gi.Gio;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;
const Pango = imports.gi.Pango;
const Tp = imports.gi.TelepathyGLib;

const Lang = imports.lang;
const Mainloop = imports.mainloop;

const TIMEOUT = 7;
const COMMAND_OUTPUT_REVEAL_TIME = 3;

var AppNotification = GObject.registerClass(
class AppNotification extends Gtk.Revealer {
    _init() {
        if (this.constructor.name == 'AppNotification')
            throw new Error('Cannot instantiate abstract class AppNotification');

        super._init({ reveal_child: true,
                      transition_type: Gtk.RevealerTransitionType.SLIDE_DOWN });
        this.connect('notify::child-revealed',
                     Lang.bind(this, this._onChildRevealed));
    }

    close() {
        this.reveal_child = false;
    }

    _onChildRevealed() {
        if (!this.child_revealed)
            this.destroy();
    }
});

var MessageNotification = GObject.registerClass(
class MessageNotification extends AppNotification {
    _init(label, iconName) {
        super._init();

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
    }


    addButton(label, callback) {
        let button = new Gtk.Button({ label: label, visible: true });
        button.connect('clicked', () => {
            if (callback)
                callback();
            this.close();
        });

        this._box.add(button);
    }
});

var UndoNotification = GObject.registerClass({
    Signals: { closed: {}, undo: {} }
}, class UndoNotification extends MessageNotification {
    _init(label) {
        super._init(label);

        this._undo = false;

        this.connect('destroy', Lang.bind(this, this._onDestroy));

        this.addButton(_("Undo"), () => { this._undo = true; });

        this._app = Gio.Application.get_default();
        this._shutdownId = this._app.connect('prepare-shutdown',
                                             Lang.bind(this, this.close));
    }

    close() {
        this.emit(this._undo ? 'undo' : 'closed');
        super.close();
    }

    _onDestroy() {
        if (this._shutdownId)
            this._app.disconnect(this._shutdownId);
        this._shutdownId = 0;
    }
});

var CommandOutputNotification = GObject.registerClass(
class CommandOutputNotification extends AppNotification {
    _init() {
        if (this.constructor.name == 'CommandOutputNotification')
            throw new Error('Cannot instantiate abstract class CommandOutputNotification');

        super._init();

        this.transition_type = Gtk.RevealerTransitionType.SLIDE_UP;
        Mainloop.timeout_add_seconds(COMMAND_OUTPUT_REVEAL_TIME,
                                     Lang.bind(this, this.close));
    }
});

var SimpleOutput = GObject.registerClass(
class SimpleOutput extends CommandOutputNotification {
    _init(text) {
        super._init();

        let label = new Gtk.Label({ label: text,
                                    vexpand: true,
                                    visible: true,
                                    wrap: true });
        this.add(label);
        this.show_all();
    }
});

var GridOutput = GObject.registerClass(
class GridOutput extends CommandOutputNotification {
    _init(header, items) {
        super._init();

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

var NotificationQueue = GObject.registerClass(
class NotificationQueue extends Gtk.Frame {
    _init() {
        super._init({ valign: Gtk.Align.START,
                      halign: Gtk.Align.CENTER,
                      margin_start: 24, margin_end: 24,
                      no_show_all: true });
        this.get_style_context().add_class('app-notification');

        this._grid = new Gtk.Grid({ orientation: Gtk.Orientation.VERTICAL,
                                    row_spacing: 6, visible: true });
        this.add(this._grid);
    }

    addNotification(notification) {
        this._grid.add(notification);

        notification.connect('destroy', Lang.bind(this, this._onChildDestroy));
        this.show();
    }

    _onChildDestroy() {
        if (this._grid.get_children().length == 0)
           this.hide();
    }
});

var CommandOutputQueue = GObject.registerClass(
class CommandOutputQueue extends NotificationQueue {
    _init() {
        super._init();

        this.valign = Gtk.Align.END;
        this.get_style_context().add_class('irc-feedback');
    }
});
