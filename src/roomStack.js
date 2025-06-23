// SPDX-FileCopyrightText: 2014 Florian Müllner <fmuellner@gnome.org>
// SPDX-FileCopyrightText: 2015 Bastian Ilsø <bastianilso@gnome.org>
// SPDX-FileCopyrightText: 2019 Daronion <stefanosdimos.98@gmail.com>
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';
import Pango from 'gi://Pango';
import Tp from 'gi://TelepathyGLib';

import AccountsMonitor from './accountsMonitor.js';
import ChatView from './chatView.js';
import EntryArea from './entryArea.js';
import RoomManager from './roomManager.js';

export default GObject.registerClass(
class RoomStack extends Gtk.Stack {
    static [GObject.properties] = {
        'view-height': GObject.ParamSpec.uint(
            'view-height', null, null,
            GObject.ParamFlags.READABLE,
            0, GLib.MAXUINT32, 0),
    };

    constructor(params) {
        super(params);

        this._sizeGroup = new Gtk.SizeGroup({mode: Gtk.SizeGroupMode.VERTICAL});
        this._rooms = new Map();

        this._roomManager = RoomManager.getDefault();

        this._roomAddedId =
            this._roomManager.connect('room-added', this._roomAdded.bind(this));
        this._roomRemovedId =
            this._roomManager.connect('room-removed', this._roomRemoved.bind(this));
        this._roomManager.rooms.forEach(r => this._roomAdded(this._roomManager, r));

        this.add_named(new ChatPlaceholder(this._sizeGroup), 'placeholder');

        this._viewHeight = 0;

        this.connect('destroy', () => {
            this._roomManager.disconnect(this._roomAddedId);
            this._roomManager.disconnect(this._roomRemovedId);
        });
    }

    vfunc_realize() {
        super.vfunc_realize();

        const toplevel = this.get_root();

        this._toplevelSignals = [
            toplevel.connect('notify::active-room',
                this._activeRoomChanged.bind(this)),
            toplevel.connect('active-room-state-changed',
                this._updateSensitivity.bind(this)),
        ];
        this._activeRoomChanged();
        this._updateSensitivity();
    }

    vfunc_unrealize() {
        super.vfunc_unrealize();

        const toplevel = this.get_root();
        this._toplevelSignals.forEach(id => toplevel.disconnect(id));
        this._toplevelSignals = [];
    }

    vfunc_size_allocate(width, height, baseline) {
        super.vfunc_size_allocate(width, height, baseline);

        const [firstEntry] =
            this._sizeGroup.get_widgets().filter(w => w.get_mapped());
        const entryHeight = firstEntry
            ? firstEntry.get_allocated_height() - 1 : 0;

        const viewHeight = this.get_allocated_height() - entryHeight;
        if (this._viewHeight !== viewHeight) {
            this._viewHeight = viewHeight;
            this.notify('view-height');
        }
    }

    get view_height() {
        return this._viewHeight;
    }

    _addView(id, view) {
        this._rooms.set(id, view);
        this.add_named(view, id);
    }

    _roomAdded(roomManager, room) {
        this._addView(room.id, new RoomView(room, this._sizeGroup));
    }

    _roomRemoved(roomManager, room) {
        const view = this._rooms.get(room.id);
        this._rooms.delete(room.id);

        this.remove(view);
        view.run_dispose();
    }

    _activeRoomChanged() {
        const room = this.get_root().active_room;
        this.set_visible_child_name(room ? room.id : 'placeholder');
    }

    _updateSensitivity() {
        const room = this.get_root().active_room;
        if (!room)
            return;
        let sensitive = room && room.channel;
        this._rooms.get(room.id).inputSensitive = sensitive;
    }
});

export const MessageInfoBar = GObject.registerClass(
class MessageInfoBar extends Gtk.InfoBar {
    static [GObject.properties] = {
        'title': GObject.ParamSpec.string(
            'title', null, null,
            GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT,
            ''),
        'subtitle': GObject.ParamSpec.string(
            'subtitle', null, null,
            GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT,
            ''),
    };

    constructor(params) {
        let defaultParams = {
            show_close_button: true,
            revealed: false,
            valign: Gtk.Align.START,
        };
        super(Object.assign(defaultParams, params));

        let box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL});
        this.add_child(box);

        this._titleLabel = new Gtk.Label({
            css_classes: ['heading'],
            halign: Gtk.Align.START,
            valign: Gtk.Align.CENTER,
            wrap: true,
        });
        box.append(this._titleLabel);

        this._subtitleLabel = new Gtk.Label({
            halign: Gtk.Align.START,
            valign: Gtk.Align.CENTER,
            ellipsize: Pango.EllipsizeMode.END,
        });
        box.append(this._subtitleLabel);

        this.bind_property('title',
            this._titleLabel, 'label',
            GObject.BindingFlags.SYNC_CREATE);
        this.bind_property('subtitle',
            this._subtitleLabel, 'label',
            GObject.BindingFlags.SYNC_CREATE);

        this.connect('response', () => (this.revealed = false));
    }
});

const SavePasswordConfirmationBar = GObject.registerClass(
class SavePasswordConfirmationBar extends MessageInfoBar {
    constructor(room) {
        let title = _('Should the password be saved?');
        let subtitle = vprintf(
            _('Identification will happen automatically the next time you connect to %s'),
            room.account.display_name);
        super({title, subtitle});

        this._room = room;

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
    constructor(room) {
        super({title: _('Failed to join the room')});

        this._room = room;

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
    _accountsMonitor = AccountsMonitor.getDefault();

    constructor(sizeGroup) {
        super();

        const statusPage = new Adw.StatusPage({
            icon_name: 'org.gnome.Polari-symbolic',
            title: _('Polari'),
            description: _('Join a room using the + button.'),
            vexpand: true,
        });
        this.set_child(statusPage);

        const inputPlaceholder = new Gtk.Box({valign: Gtk.Align.END});
        sizeGroup.add_widget(inputPlaceholder);
        this.add_overlay(inputPlaceholder);
    }
});

const RoomView = GObject.registerClass(
class RoomView extends Gtk.Overlay {
    constructor(room, sizeGroup) {
        super({name: `RoomView ${room.display_name}`});

        const toolbarView = new Adw.ToolbarView();
        this.set_child(toolbarView);

        if (room.type === Tp.HandleType.CONTACT)
            this.add_overlay(new SavePasswordConfirmationBar(room));

        this.add_overlay(new ChannelErrorBar(room));

        this._view = new ChatView(room);
        toolbarView.content = this._view;

        this._entryArea = new EntryArea({
            room,
            sensitive: false,
        });
        toolbarView.add_bottom_bar(this._entryArea);
        this._entryArea.bind_property_full('confirmation-visible',
            toolbarView, 'bottom-bar-style',
            GObject.BindingFlags.SYNC_CREATE,
            (v, source) => [
                true,
                source ? Adw.ToolbarStyle.RAISED : Adw.ToolbarStyle.FLAT,
            ],
            null);

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
    }

    set inputSensitive(sensitive) {
        this._entryArea.sensitive = sensitive;
    }
});
