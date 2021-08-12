import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';
import Tp from 'gi://TelepathyGLib';

import AccountsMonitor from './accountsMonitor.js';
import ChatView from './chatView.js';
import EntryArea from './entryArea.js';
import { MessageInfoBar } from './appNotifications.js';
import RoomManager from './roomManager.js';

export default GObject.registerClass({
    Properties: {
        'entry-area-height': GObject.ParamSpec.uint(
            'entry-area-height', 'entry-area-height', 'entry-area-height',
            GObject.ParamFlags.READABLE,
            0, GLib.MAXUINT32, 0),
    },
}, class RoomStack extends Gtk.Stack {
    _init(params) {
        super._init(params);

        this._sizeGroup = new Gtk.SizeGroup({ mode: Gtk.SizeGroupMode.VERTICAL });
        this._rooms = new Map();

        this._roomManager = RoomManager.getDefault();

        this._roomAddedId =
            this._roomManager.connect('room-added', this._roomAdded.bind(this));
        this._roomRemovedId =
            this._roomManager.connect('room-removed', this._roomRemoved.bind(this));
        this._roomManager.rooms.forEach(r => this._roomAdded(this._roomManager, r));

        this.add_named(new ChatPlaceholder(this._sizeGroup), 'placeholder');

        this._entryAreaHeight = 0;
        this._sizeGroup.get_widgets()[0].connect('size-allocate', (w, rect) => {
            if (this._entryAreaHeight !== rect.height - 1) {
                this._entryAreaHeight = rect.height - 1;
                this.notify('entry-area-height');
            }
        });

        this.connect('destroy', () => {
            this._roomManager.disconnect(this._roomAddedId);
            this._roomManager.disconnect(this._roomRemovedId);
        });
    }

    vfunc_realize() {
        super.vfunc_realize();

        let toplevel = this.get_toplevel();

        toplevel.connect('notify::active-room',
            this._activeRoomChanged.bind(this));
        toplevel.connect('active-room-state-changed',
            this._updateSensitivity.bind(this));
        this._activeRoomChanged();
        this._updateSensitivity();
    }

    // eslint-disable-next-line camelcase
    get entry_area_height() {
        return this._entryAreaHeight;
    }

    _addView(id, view) {
        this._rooms.set(id, view);
        this.add_named(view, id);
    }

    _roomAdded(roomManager, room) {
        this._addView(room.id, new RoomView(room, this._sizeGroup));
    }

    _roomRemoved(roomManager, room) {
        this._rooms.get(room.id).destroy();
        this._rooms.delete(room.id);
    }

    _activeRoomChanged() {
        let room = this.get_toplevel().active_room;
        this.set_visible_child_name(room ? room.id : 'placeholder');
    }

    _updateSensitivity() {
        let room = this.get_toplevel().active_room;
        if (!room)
            return;
        let sensitive = room && room.channel;
        this._rooms.get(room.id).inputSensitive = sensitive;
    }
});

const SavePasswordConfirmationBar = GObject.registerClass(
class SavePasswordConfirmationBar extends MessageInfoBar {
    _init(room) {
        this._room = room;

        let title = _('Should the password be saved?');
        let subtitle = vprintf(
            _('Identification will happen automatically the next time you connect to %s'),
            this._room.account.display_name);
        super._init({ title, subtitle });

        this.connect('destroy', this._onDestroy.bind(this));

        this.add_button(_('_Save Password'), Gtk.ResponseType.ACCEPT).set({
            action_name: 'app.save-identify-password',
            action_target: new GLib.Variant('o', this._room.account.object_path),
        });

        this._identifySentId = this._room.connect('identify-sent', () => {
            this.revealed = true;
        });
    }

    on_response(response) {
        if (response === Gtk.ResponseType.ACCEPT)
            return;

        let app = Gio.Application.get_default();
        let target = new GLib.Variant('o', this._room.account.object_path);
        app.lookup_action('discard-identify-password').activate(target);
    }

    _onDestroy() {
        if (this._identifySentId)
            this._room.disconnect(this._identifySentId);
        this._identifySentId = 0;
    }
});

const ChannelErrorBar = GObject.registerClass(
class ChannelErrorBar extends MessageInfoBar {
    _init(room) {
        this._room = room;

        super._init({ title: _('Failed to join the room') });

        this.add_button(_('_Retry'), Gtk.ResponseType.ACCEPT).set({
            action_name: 'app.reconnect-room',
            action_target: new GLib.Variant('s', this._room.id),
        });


        this.connect('destroy', this._onDestroy.bind(this));

        this._identifyError = this._room.connect('notify::channel-error', () => {
            if (this._room.channel_error === '') {
                this.revealed = false;
                return;
            }
            this._updateLabels();
            this.revealed = true;
        });
    }

    _updateLabels() {
        let text;

        switch (this._room.channel_error) {
        case Tp.error_get_dbus_name(Tp.Error.CHANNEL_FULL):
            text = _('The room is full.');
            break;
        case Tp.error_get_dbus_name(Tp.Error.CHANNEL_BANNED):
            text = _('You have been banned from the room.');
            break;
        case Tp.error_get_dbus_name(Tp.Error.CHANNEL_INVITE_ONLY):
            text = _('The room is invite-only.');
            break;
        case Tp.error_get_dbus_name(Tp.Error.CHANNEL_KICKED):
            text = _('You have been kicked from the room.');
            break;
        default:
            text = _('It is not possible to join the room now, but you can retry later.');
        }

        this.subtitle = text;
    }

    _onDestroy() {
        if (this._identifyError)
            this._room.disconnect(this._identifyError);
    }
});

const ChatPlaceholder = GObject.registerClass(
class ChatPlaceholder extends Gtk.Overlay {
    _init(sizeGroup) {
        this._accountsMonitor = AccountsMonitor.getDefault();

        let image = new Gtk.Image({
            icon_name: 'org.gnome.Polari-symbolic',
            pixel_size: 96, halign: Gtk.Align.END,
            margin_end: 14,
        });

        let title = new Gtk.Label({
            use_markup: true,
            halign: Gtk.Align.START,
            margin_start: 14,
        });
        title.label = `<span letter_spacing="4500">${_('Polari')}<${'/'}span>`;
        title.get_style_context().add_class('polari-background-title');

        let description = new Gtk.Label({
            label: _('Join a room using the + button.'),
            halign: Gtk.Align.CENTER, wrap: true,
            margin_top: 24, use_markup: true,
        });
        description.get_style_context().add_class('polari-background-description');

        let inputPlaceholder = new Gtk.Box({ valign: Gtk.Align.END });
        sizeGroup.add_widget(inputPlaceholder);

        super._init();
        let grid = new Gtk.Grid({
            column_homogeneous: true,
            can_focus: false,
            column_spacing: 18,
            hexpand: true,
            vexpand: true,
            valign: Gtk.Align.CENTER,
        });
        grid.get_style_context().add_class('polari-background');
        grid.attach(image, 0, 0, 1, 1);
        grid.attach(title, 1, 0, 1, 1);
        grid.attach(description, 0, 1, 2, 1);
        this.add(grid);
        this.add_overlay(inputPlaceholder);
        this.show_all();
    }
});

const RoomView = GObject.registerClass(
class RoomView extends Gtk.Overlay {
    _init(room, sizeGroup) {
        super._init({ name: `RoomView ${room.display_name}` });

        let box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
        this.add(box);

        if (room.type === Tp.HandleType.CONTACT)
            this.add_overlay(new SavePasswordConfirmationBar(room));

        this.add_overlay(new ChannelErrorBar(room));

        this._view = new ChatView(room);
        box.add(this._view);

        this._entryArea = new EntryArea({
            room,
            sensitive: false,
        });
        box.add(this._entryArea);

        this._view.bind_property('max-nick-chars',
            this._entryArea, 'max-nick-chars',
            GObject.BindingFlags.SYNC_CREATE);
        sizeGroup.add_widget(this._entryArea);

        this._view.connect('text-dropped', (view, text) => {
            this._entryArea.pasteText(text, text.split('\n').length);
        });
        this._view.connect('image-dropped', (view, image) => {
            this._entryArea.pasteImage(image);
        });
        this._view.connect('file-dropped', (view, file) => {
            this._entryArea.pasteFile(file);
        });

        this.show_all();
    }

    set inputSensitive(sensitive) {
        this._entryArea.sensitive = sensitive;
    }
});
