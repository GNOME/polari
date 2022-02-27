import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';
import Pango from 'gi://Pango';

const TIMEOUT = 7;

const AppNotification = GObject.registerClass(
class AppNotification extends Gtk.Revealer {
    static [GObject.GTypeFlags] = GObject.TypeFlags.ABSTRACT;

    constructor() {
        super({
            reveal_child: true,
            transition_type: Gtk.RevealerTransitionType.SLIDE_DOWN,
        });
        this.connect('notify::child-revealed',
            this._onChildRevealed.bind(this));
    }

    close() {
        this.reveal_child = false;
    }

    _onChildRevealed() {
        if (!this.child_revealed)
            this.hide();
    }
});

export const MessageNotification = GObject.registerClass(
class MessageNotification extends AppNotification {
    constructor(label, iconName) {
        super();

        GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, TIMEOUT, this.close.bind(this));

        this._box = new Gtk.Box({ spacing: 12 });

        if (iconName)
            this._box.append(new Gtk.Image({ icon_name: iconName }));

        this._box.append(new Gtk.Label({
            label,
            hexpand: true,
            ellipsize: Pango.EllipsizeMode.END,
        }));

        let closeButton = new Gtk.Button({
            icon_name: 'window-close-symbolic',
            has_frame: false,
        });
        closeButton.connect('clicked', this.close.bind(this));
        this._box.pack_end(closeButton, false, false, 0);

        this.set_child(this._box);
    }


    addButton(label, callback) {
        let button = new Gtk.Button({ label });
        button.connect('clicked', () => {
            if (callback)
                callback();
            this.close();
        });

        this._box.append(button);
    }
});

export const UndoNotification = GObject.registerClass(
class UndoNotification extends MessageNotification {
    static [GObject.signals] = {
        closed: {},
        undo: {},
    };

    constructor(label) {
        super(label);

        this._undo = false;
        this._closed = false;

        this.connect('destroy', () => this.close());

        this.addButton(_('Undo'), () => (this._undo = true));
    }

    close() {
        if (this._closed)
            return;

        this._closed = true;
        this.emit(this._undo ? 'undo' : 'closed');
        super.close();
    }
});

export const NotificationQueue = GObject.registerClass(
class NotificationQueue extends Gtk.Frame {
    constructor() {
        super({
            valign: Gtk.Align.START,
            halign: Gtk.Align.CENTER,
            margin_start: 24, margin_end: 24,
            visible: false,
        });
        this.add_css_class('app-notification');

        this._grid = new Gtk.Grid({
            orientation: Gtk.Orientation.VERTICAL,
            row_spacing: 6,
        });
        this.set_child(this._grid);
    }

    addNotification(notification) {
        this._grid.attach_next_to(notification,
            null, Gtk.PositionType.BOTTOM, 1, 1);

        notification.connect('notify::visible',
            this._onChildVisibleChanged.bind(this));
        this.show();
    }

    _onChildVisibleChanged(child) {
        if (child.visible)
            return;

        this._grid.remove(child);
        child.run_dispose();

        if (this._grid.get_first_child() === null)
            this.hide();
    }
});

export const CommandOutputQueue = GObject.registerClass(
class CommandOutputQueue extends NotificationQueue {
    constructor() {
        super();

        this.valign = Gtk.Align.END;
        this.add_css_class('irc-feedback');
    }
});
