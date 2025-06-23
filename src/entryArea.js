// SPDX-FileCopyrightText: 2013 Florian Müllner <fmuellner@gnome.org>
// SPDX-FileCopyrightText: 2015 Bastian Ilsø <bastianilso@gnome.org>
// SPDX-FileCopyrightText: 2016 Kunaal Jain <kunaalus@gmail.com>
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gdk from 'gi://Gdk';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';
import Tp from 'gi://TelepathyGLib';

import {DropTargetIface, gtypeFromFormats} from './pasteManager.js';
import IrcParser from './ircParser.js';
import TabCompletion from './tabCompletion.js';

const MAX_NICK_UPDATE_TIME = 5; /* s */
const MAX_LINES = 5;

Gio._promisify(Gio._LocalFilePrototype,
    'query_info_async', 'query_info_finish');

export const ChatEntry = GObject.registerClass(
class ChatEntry extends Gtk.Entry {
    static [GObject.interfaces] = [DropTargetIface];
    static [GObject.properties] = {
        'can-drop': GObject.ParamSpec.override('can-drop', DropTargetIface),
    };

    static [GObject.signals] = {
        'text-pasted': {param_types: [GObject.TYPE_STRING, GObject.TYPE_INT]},
        'image-pasted': {param_types: [GdkPixbuf.Pixbuf.$gtype]},
        'file-pasted': {param_types: [Gio.File.$gtype]},
    };

    constructor(params) {
        super(params);

        const delegate = this.get_delegate();
        this.addTargets(delegate);

        let app = Gio.Application.get_default();
        let action = app.lookup_action('show-emoji-picker');
        action.connect('activate', () => {
            if (this.is_sensitive() && this.get_mapped())
                delegate.emit('insert-emoji');
        });

        delegate.connect('insert-text', this._onInsertText.bind(this));
        delegate.connect('paste-clipboard', this._onPasteClipboard.bind(this));
    }

    get can_drop() {
        return true;
    }

    _onInsertText(editable, text) {
        const nLines = text.split('\n').length;
        if (nLines < MAX_LINES)
            return;

        editable.stop_emission_by_name('insert-text');
        this.emit('text-pasted', text, nLines);
    }

    async _onPasteClipboard(editable) {
        if (!this.editable)
            return;

        editable.stop_emission_by_name('paste-clipboard');
        const clipboard = this.get_clipboard();

        const {formats} = clipboard;
        const type = gtypeFromFormats(formats);
        const value = await this._readClipboardValue(clipboard, type);
        if (typeof value === 'string')
            editable.emit('insert-at-cursor', value);
        else if (value instanceof GdkPixbuf.Pixbuf)
            this.emit('image-pasted', value);
        else if (value instanceof Gio.File)
            this.emit('file-pasted', value);
    }

    _readClipboardValue(clipboard, type) {
        return new Promise((resolve, reject) => {
            clipboard.read_value_async(type, 0, null, (_, res) => {
                try {
                    const value = clipboard.read_value_finish(res);
                    resolve(value);
                } catch (e) {
                    console.error(e);
                    reject(e);
                }
            });
        });
    }
});

export const NickPopover = GObject.registerClass(
class NickPopover extends Gtk.Popover {
    static [Gtk.template] = 'resource:///org/gnome/Polari/ui/nick-popover.ui';
    static [Gtk.internalChildren] = [
        'nickEntry',
        'changeButton',
    ];

    static [GObject.properties] = {
        nick: GObject.ParamSpec.string(
            'nick', null, null,
            GObject.ParamFlags.READWRITE,
            ''),
    };

    static [GObject.signals] = {
        'nick-changed': {},
    };

    constructor() {
        super();

        this.set_default_widget(this._changeButton);

        this._changeButton.connect('clicked', () => {
            if (!this._nickEntry.text)
                return;

            this._nick = this._nickEntry.text;
            this.emit('nick-changed');
        });
    }

    get nick() {
        return this._nick;
    }

    set nick(nick) {
        if (this._nick === nick)
            return;

        if (!this._nickEntry['is-focus'])
            this._nickEntry.text = nick;
        this._nick = nick;

        this.notify('nick');
    }
});

export default GObject.registerClass(
class EntryArea extends Gtk.Stack {
    static [Gtk.template] = 'resource:///org/gnome/Polari/ui/entry-area.ui';
    static [Gtk.internalChildren] = [
        'chatEntry',
        'nickButton',
        'nickLabel',
        'pasteBox',
        'confirmLabel',
        'uploadLabel',
        'uploadSpinner',
        'cancelButton',
        'pasteButton',
    ];

    static [GObject.properties] = {
        'max-nick-chars': GObject.ParamSpec.uint(
            'max-nick-chars', null, null,
            GObject.ParamFlags.WRITABLE,
            0, GLib.MAXUINT32, 0),
        'confirmation-visible': GObject.ParamSpec.boolean(
            'confirmation-visible', null, null,
            GObject.ParamFlags.READABLE,
            false),
    };

    static get _nickPopover() {
        if (!this.__nickPopover)
            this.__nickPopover = new NickPopover();
        return this.__nickPopover;
    }

    _nickChangedId = 0;
    _popoverClosedId = 0;

    constructor(params) {
        const {room} = params;
        delete params.room;

        super(params);

        this._room = room;

        this.connect('notify::visible-child-name',
            () => this.notify('confirmation-visible'));

        this.connect('destroy', this._onDestroy.bind(this));
        this.connect('notify::sensitive', this._onSensitiveChanged.bind(this));
        this.connect('realize', () => {
            this._toplevel = this.get_root();
            this._toplevelKeyController = new Gtk.EventControllerKey();
            this._toplevelKeyController.connect('key-pressed',
                this._onKeyPressed.bind(this));
            this._toplevel.add_controller(this._toplevelKeyController);
        });
        this.connect('map', () => {
            EntryArea._nickPopover.unparent();
            EntryArea._nickPopover.set_parent(this._nickButton);

            if (this._nickChangedId)
                return;

            this._popoverCloseId = EntryArea._nickPopover.connect('closed',
                () => (this._nickButton.active = false));

            this._nickChangedId = EntryArea._nickPopover.connect('nick-changed',
                () => {
                    this._setNick(EntryArea._nickPopover.nick);
                    this._nickButton.active = false;
                });
            this._updateNick();
        });
        this.connect('unmap', () => {
            if (this._nickChangedId)
                EntryArea._nickPopover.disconnect(this._nickChangedId);
            this._nickChangedId = 0;

            if (this._popoverClosedId)
                EntryArea._nickPopover.disconnect(this._popoverClosedId);
            this._popoverClosedId = 0;
        });
        this._nickButton.connect('toggled', () => {
            if (this._nickButton.active)
                EntryArea._nickPopover.popup();
            else
                EntryArea._nickPopover.popdown();
        });

        this._nickLabel.width_chars = this._maxNickChars;

        this._chatEntry.connect('text-pasted', (entry, text, nLines) => {
            this.pasteText(text, nLines);
        });
        this._chatEntry.connect('text-dropped', (entry, text) => {
            this.pasteText(text, text.split('\n').length);
        });

        this._chatEntry.connect('image-pasted', (entry, image) => {
            this.pasteImage(image);
        });
        this._chatEntry.connect('image-dropped', (entry, image) => {
            this.pasteImage(image);
        });

        this._chatEntry.connect('file-pasted', (entry, file) => {
            this.pasteFile(file);
        });
        this._chatEntry.connect('file-dropped', (entry, file) => {
            this.pasteFile(file);
        });

        this._chatEntry.connect('changed', this._onEntryChanged.bind(this));

        this._cancelButton.connect('clicked', this._onCancelClicked.bind(this));
        this._pasteButton.connect('clicked', this._onPasteClicked.bind(this));

        this._pasteController = new Gtk.EventControllerKey();
        this._pasteController.connect_after('key-pressed', (c, keyval, code, mods) => {
            if (keyval === Gdk.KEY_Escape ||
                keyval === Gdk.KEY_BackSpace ||
                keyval === Gdk.KEY_Delete ||
                keyval === Gdk.KEY_z && mods & Gdk.ModifierType.CONTROL_MASK) {
                this._cancelButton.emit('clicked');
                return Gdk.EVENT_STOP;
            }
            return Gdk.EVENT_PROPAGATE;
        });
        this._pasteBox.add_controller(this._pasteController);

        if (!this._room)
            return;

        this._ircParser = new IrcParser(this._chatEntry, this._room);
        this._completion = new TabCompletion(this._chatEntry);
        this._membersChangedId = this._room.connect('members-changed',
            this._updateCompletions.bind(this));
        this._nicknameChangedId =
            this._room.account.connect('notify::nickname', () => {
                if (!this._room.channel)
                    this._updateNick();
            });
        this._channelChangedId = this._room.connect('notify::channel',
            this._onChannelChanged.bind(this));
        this._onChannelChanged(this._room);

        this._chatEntry.connect('map', this._updateCompletions.bind(this));
        this._chatEntry.connect('unmap', this._updateCompletions.bind(this));
    }

    set max_nick_chars(maxChars) {
        this._maxNickChars = maxChars;
        this._updateNick();
    }

    get confirmation_visible() {
        return this.visible_child_name === 'paste-confirmation';
    }

    _setToolbarStyle(style) {
        if (this._toolbarStyle === style)
            return;

        this._toolbarStyle = style;
        this.notify('toolbar-style');
    }

    _updateCompletions() {
        let nicks = [];

        if (this._chatEntry.get_mapped() &&
            this._room &&
            this._room.channel &&
            this._room.channel.has_interface(Tp.IFACE_CHANNEL_INTERFACE_GROUP)) {
            let members = this._room.channel.group_dup_members_contacts();
            nicks = members.map(member => member.alias);
        }
        this._completion.setCompletions(nicks);
    }

    _canFocusChatEntry() {
        const toplevelFocus = this._chatEntry.get_root()?.get_focus();
        return this.sensitive &&
               this._chatEntry.get_mapped() &&
               !this._chatEntry['has-focus'] &&
               !(toplevelFocus instanceof Gtk.Entry);
    }

    _onKeyPressed(controller, keyval, keycode, state) {
        if (!this._canFocusChatEntry())
            return Gdk.EVENT_PROPAGATE;

        if (Gdk.keyval_to_unicode(keyval) === 0)
            return Gdk.EVENT_PROPAGATE;

        if (state !== 0 && state !== Gdk.ModifierType.SHIFT_MASK)
            return Gdk.EVENT_PROPAGATE;

        let activationKeys = [
            Gdk.KEY_Tab,
            Gdk.KEY_Return,
            Gdk.KEY_ISO_Enter,
            Gdk.KEY_space,
        ];
        if (activationKeys.includes(keyval))
            return Gdk.EVENT_PROPAGATE;

        this._chatEntry.grab_focus_without_selecting();
        controller.forward(this._chatEntry.get_delegate());
        return Gdk.EVENT_STOP;
    }

    _onEntryChanged() {
        this._chatEntry.remove_css_class('error');
    }

    _setPasteContent(content) {
        this._pasteContent = content;

        if (content) {
            this._confirmLabel.show();
            this.visible_child_name = 'paste-confirmation';
            this._pasteButton.grab_focus();
        } else {
            this.visible_child_name = 'default';
            this._chatEntry.grab_focus_without_selecting();
        }
    }

    pasteText(text, nLines) {
        this._confirmLabel.label = vprintf(
            ngettext(
                'Paste %s line of text to public paste service?',
                'Paste %s lines of text to public paste service?', nLines),
            nLines);
        this._uploadLabel.label = vprintf(
            ngettext(
                'Uploading %s line of text to public paste service…',
                'Uploading %s lines of text to public paste service…', nLines),
            nLines);
        this._setPasteContent(text);
    }

    pasteImage(pixbuf) {
        this._confirmLabel.label = _('Upload image to public paste service?');
        this._uploadLabel.label = _('Uploading image to public paste service…');
        this._setPasteContent(pixbuf);
    }

    async pasteFile(file) {
        let fileInfo = null;
        try {
            fileInfo = await file.query_info_async(
                Gio.FILE_ATTRIBUTE_STANDARD_DISPLAY_NAME,
                Gio.FileQueryInfoFlags.NONE,
                GLib.PRIORITY_DEFAULT, null);
        } catch {
            return;
        }

        let name = fileInfo.get_display_name();
        /* Translators: %s is a filename */
        this._confirmLabel.label = vprintf(_('Upload “%s” to public paste service?'), name);
        /* Translators: %s is a filename */
        this._uploadLabel.label = vprintf(_('Uploading “%s” to public paste service…'), name);
        this._setPasteContent(file);
    }

    async _onPasteClicked() {
        let title;
        let nick = this._room.channel.connection.self_contact.alias;
        if (this._room.type === Tp.HandleType.ROOM)
            /* translators: %s is a nick, #%s a channel */
            title = vprintf(_('%s in #%s'), nick, this._room.display_name);
        else
            title = vprintf(_('Paste from %s'), nick);
        this._confirmLabel.hide();

        this._confirmLabel.hide();
        this._uploadSpinner.show();

        let app = Gio.Application.get_default();
        try {
            const url =
                await app.pasteManager.pasteContent(this._pasteContent, title);
            this._setPasteContent(null);
            this._chatEntry.get_delegate().emit('insert-at-cursor', url);
        } catch (e) {
            let type = typeof this._pasteContent;
            if (type === 'object')
                type = this._pasteContent.toString();
            console.warn(`Failed to paste content of type ${type}`);
            console.debug(e);
        } finally {
            this._uploadSpinner.hide();
        }
    }

    _onCancelClicked() {
        this._setPasteContent(null);
    }

    _onSensitiveChanged() {
        if (this._canFocusChatEntry())
            this._chatEntry.grab_focus();

        if (this.sensitive)
            this._nickLabel.add_css_class('polari-active-nick');
        else
            this._nickLabel.remove_css_class('polari-active-nick');
    }

    _onChannelChanged(room) {
        this._updateCompletions();

        if (room.channel) {
            this._selfAliasChangedId =
                room.channel.connection.connect('notify::self-contact',
                    this._updateNick.bind(this));
        } else {
            this._selfAliasChangedId = 0;
        }
        this._updateNick();
    }

    _setNick(nick) {
        this._nickLabel.width_chars = Math.max(nick.length, this._maxNickChars);
        this._nickLabel.label = nick;

        if (!this.get_mapped())
            return;

        let app = Gio.Application.get_default();
        app.setAccountNick(this._room.account, nick);

        // TpAccount:nickname is a local property which doesn't
        // necessarily match the externally visible nick; telepathy
        // doesn't consider failing to sync the two an error, so
        // we give the server MAX_NICK_UPDATE_TIME seconds until
        // we assume failure and revert back to the server nick
        //
        // (set_aliases() would do what we want, but it's not
        // introspected)
        GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, MAX_NICK_UPDATE_TIME, () => {
            this._updateNick();
            return GLib.SOURCE_REMOVE;
        });
    }

    _updateNick() {
        let {channel} = this._room || {};
        let nick = '';
        if (channel)
            nick = channel.connection.self_contact.alias;
        else if (this._room)
            nick = this._room.account.nickname;

        this._nickLabel.width_chars = Math.max(nick.length, this._maxNickChars);
        this._nickLabel.label = nick;

        if (this.get_mapped())
            EntryArea._nickPopover.nick = nick;
    }

    _onDestroy() {
        if (this._membersChangedId)
            this._room.disconnect(this._membersChangedId);
        this._membersChangedId = 0;
        if (this._selfAliasChangedId)
            this._room.channel.connection.disconnect(this._selfAliasChangedId);
        this._selfAliasChangedId = 0;
        if (this._nicknameChangedId)
            this._room.account.disconnect(this._nicknameChangedId);
        this._nicknameChangedId = 0;
        if (this._channelChangedId)
            this._room.disconnect(this._channelChangedId);
        this._channelChangedId = 0;
        if (this._nickChangedId)
            EntryArea._nickPopover.disconnect(this._nickChangedId);
        this._nickChangedId = 0;
        if (this._toplevelKeyController)
            this._toplevel.remove_controller(this._toplevelKeyController);
        this._toplevelKeyController = null;
    }
});
