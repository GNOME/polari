const Gdk = imports.gi.Gdk;
const GdkPixbuf = imports.gi.GdkPixbuf;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gspell = imports.gi.Gspell;
const Gtk = imports.gi.Gtk;
const Mainloop = imports.mainloop;
const Tp = imports.gi.TelepathyGLib;

const ChatView = imports.chatView;
const {DropTargetIface} = imports.pasteManager;
const {EmojiPicker} = imports.emojiPicker;
const {IrcParser} = imports.ircParser;
const {TabCompletion} = imports.tabCompletion;

const MAX_NICK_UPDATE_TIME = 5; /* s */
const MAX_LINES = 5;


var ChatEntry = GObject.registerClass({
    Implements: [DropTargetIface],
    Properties: {
        'can-drop': GObject.ParamSpec.override('can-drop', DropTargetIface),
    },
    Signals: { 'text-pasted': { param_types: [GObject.TYPE_STRING,
                                              GObject.TYPE_INT] },
               'image-pasted': { param_types: [GdkPixbuf.Pixbuf.$gtype] },
               'file-pasted': { param_types: [Gio.File.$gtype] } },
}, class ChatEntry extends Gtk.Entry {
    static get _checker() {
        if (!this.__checker)
            this.__checker = new Gspell.Checker();
        return this.__checker;
    }

    static get _emojiPicker() {
        if (!this.__emojiPicker)
            this.__emojiPicker = new EmojiPicker();
        return this.__emojiPicker;
    }

    _init(params) {
        super._init(params);

        DropTargetIface.addTargets(this, this);

        this._emojiPickedId = 0;

        this.connect('icon-press', this._showEmojiPicker.bind(this));
        this.connect('unmap', () => {
            if (this._emojiPickedId)
                ChatEntry._emojiPicker.disconnect(this._emojiPickedId);
            this._emojiPickedId = 0;
        });

        let app = Gio.Application.get_default();
        let action = app.lookup_action('show-emoji-picker');
        action.connect('activate', this._showEmojiPicker.bind(this));

        let buffer = Gspell.EntryBuffer.get_from_gtk_entry_buffer(this.buffer);
        buffer.set_spell_checker (ChatEntry._checker);

        let spellEntry = Gspell.Entry.get_from_gtk_entry(this);
        spellEntry.set_inline_spell_checking(true);

        this._useDefaultHandler = false;
    }

    _showEmojiPicker() {
        if (!this.is_sensitive() || !this.get_mapped())
            return;

        if (!this._emojiPickedId)
            this._emojiPickedId = ChatEntry._emojiPicker.connect('emoji-picked',
                (w, emoji) => {
                    this.delete_selection();
                    let pos = this.insert_text(emoji, -1, this.get_position());
                    this.set_position(pos);
                    this.grab_focus_without_selecting();
                });

        let rect = this.get_icon_area(Gtk.EntryIconPosition.SECONDARY);
        ChatEntry._emojiPicker.set_relative_to(this);
        ChatEntry._emojiPicker.set_pointing_to(rect);
        ChatEntry._emojiPicker.popup();
    }

    get can_drop() {
        return true;
    }

    vfunc_drag_data_received(context, x, y, data, info, time) {
        let str = data.get_text();
        if (!str || str.split('\n').length >= MAX_LINES)
            // Disable GtkEntry's built-in drop target support
            return;

         GObject.signal_stop_emission_by_name(this, 'drag-data-received');
        super.vfunc_drag_data_received(context, x, y, data, info, time);
    }

    vfunc_paste_clipboard(entry) {
        if (!this.editable || this._useDefaultHandler) {
            super.vfunc_paste_clipboard();
            return;
        }

        let clipboard = Gtk.Clipboard.get_default(this.get_display());
        clipboard.request_uris((clipboard, uris) => {
            if (uris && uris.length)
                this.emit('file-pasted', Gio.File.new_for_uri(uris[0]));
            else
                clipboard.request_text(this._onTextReceived.bind(this));
        });

        clipboard.request_image((clipboard, pixbuf) => {
            if (pixbuf == null)
                return;
            this.emit('image-pasted', pixbuf);
        });
    }

    _onTextReceived(clipboard, text) {
        if (text == null)
            return;
        text = text.trim();

        let nLines = text.split('\n').length;
        if (nLines >= MAX_LINES) {
            this.emit('text-pasted', text, nLines);
            return;
        }

        this._useDefaultHandler = true;
        this.emit('paste-clipboard');
        this._useDefaultHandler = false;
    }
});

var NickPopover = GObject.registerClass({
    Template: 'resource:///org/gnome/Polari/ui/nick-popover.ui',
    InternalChildren: ['nickEntry',
                       'changeButton'],
    Properties: {
        nick: GObject.ParamSpec.string('nick',
                                       'nick',
                                       'nick',
                                       GObject.ParamFlags.READWRITE |
                                       GObject.ParamFlags.EXPLICIT_NOTIFY,
                                       '')
    },
    Signals: { 'nick-changed': {} }
}, class NickPopover extends Gtk.Popover {
    _init() {
        this._nick = '';

        super._init();

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
        if (this._nick == nick)
            return;

        if (!this._nickEntry['is-focus'])
            this._nickEntry.text = nick;
        this._nick = nick;

        this.notify('nick');
    }
});

var EntryArea = GObject.registerClass({
    Template: 'resource:///org/gnome/Polari/ui/entry-area.ui',
    InternalChildren: ['chatEntry',
                       'nickButton',
                       'nickLabel',
                       'pasteBox',
                       'confirmLabel',
                       'uploadLabel',
                       'cancelButton',
                       'pasteButton'],
    Properties: {
        'max-nick-chars': GObject.ParamSpec.uint('max-nick-chars',
                                                 'max-nick-chars',
                                                 'max-nick-chars',
                                                 GObject.ParamFlags.WRITABLE,
                                                 0, GLib.MAXUINT32, 0)
    },
}, class EntryArea extends Gtk.Stack {
    static get _nickPopover() {
        if (!this.__nickPopover)
            this.__nickPopover = new NickPopover();
        return this.__nickPopover;
    }

    _init(params) {
        this._room = params.room;
        delete params.room;

        this._ircParser = new IrcParser(this._room);
        this._maxNickChars = ChatView.MAX_NICK_CHARS;
        this._nickChangedId = 0;

        super._init(params);

        this.connect('destroy', this._onDestroy.bind(this));
        this.connect('notify::sensitive', this._onSensitiveChanged.bind(this));
        this.connect('realize', () => {
            this._toplevel = this.get_toplevel();
            this._keyPressId = this._toplevel.connect('key-press-event',
                                                      this._onKeyPressEvent.bind(this));
        });
        this.connect('map', () => {
            this._nickButton.popover = EntryArea._nickPopover;

            if (this._nickChangedId)
                return;

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
        });

        this._nickLabel.set_state_flags(Gtk.StateFlags.LINK, false);
        this._nickLabel.width_chars = this._maxNickChars;

        /* HACK: We don't want the button to look different when the toplevel
                 is unfocused, so filter out the BACKDROP state */
        this._nickButton.connect('state-flags-changed', w => {
            let state = w.get_state_flags();
            if (!(state & Gtk.StateFlags.BACKDROP))
                return; // avoid indefinite recursion

            state &= ~Gtk.StateFlags.BACKDROP;
            w.set_state_flags (state, true);
        });

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

        this._chatEntry.connect('activate', () => {
            if (this._ircParser.process(this._chatEntry.text)) {
                this._chatEntry.text = '';
            } else {
                this._chatEntry.get_style_context().add_class('error');
                this._chatEntry.grab_focus(); // select text
            }
        });

        this._cancelButton.connect('clicked', this._onCancelClicked.bind(this));
        this._pasteButton.connect('clicked', this._onPasteClicked.bind(this));

        this._pasteBox.connect_after('key-press-event', (w, event) => {
            let [, keyval] = event.get_keyval();
            let [, mods] = event.get_state();
            if (keyval == Gdk.KEY_Escape || keyval == Gdk.KEY_BackSpace ||
                keyval == Gdk.KEY_Delete ||
                keyval == Gdk.KEY_z && mods & Gdk.ModifierType.CONTROL_MASK) {
                this._cancelButton.clicked();
                return Gdk.EVENT_STOP;
            }
            return Gdk.EVENT_PROPAGATE;
        });

        if (!this._room)
            return;

        this._completion = new TabCompletion(this._chatEntry);
        this._membersChangedId =
            this._room.connect('members-changed',
                               this._updateCompletions.bind(this));
        this._nicknameChangedId =
            this._room.account.connect('notify::nickname', () => {
                if (!this._room.channel)
                    this._updateNick();
            });
        this._channelChangedId =
            this._room.connect('notify::channel',
                               this._onChannelChanged.bind(this));
        this._onChannelChanged(this._room);

        this._chatEntry.connect('map', this._updateCompletions.bind(this));
        this._chatEntry.connect('unmap', this._updateCompletions.bind(this));
    }

    set max_nick_chars(maxChars) {
        this._maxNickChars = maxChars;
        this._updateNick();
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
        let toplevelFocus = this._chatEntry.get_toplevel().get_focus();
        return this.sensitive &&
               this._chatEntry.get_mapped() &&
               !this._chatEntry['has-focus'] &&
               !(toplevelFocus instanceof Gtk.Entry);
    }

    _onKeyPressEvent(w, event) {
        if (!this._canFocusChatEntry())
            return Gdk.EVENT_PROPAGATE;

        let [, keyval] = event.get_keyval();
        if (Gdk.keyval_to_unicode(keyval) == 0)
            return Gdk.EVENT_PROPAGATE;

        let [, state] = event.get_state();
        if (state != 0 && state != Gdk.ModifierType.SHIFT_MASK)
            return Gdk.EVENT_PROPAGATE;

        let activationKeys = [
            Gdk.KEY_Tab,
            Gdk.KEY_Return,
            Gdk.KEY_ISO_Enter,
            Gdk.KEY_space
        ];
        if (activationKeys.includes(keyval))
            return Gdk.EVENT_PROPAGATE;

        this._chatEntry.grab_focus_without_selecting();
        this._chatEntry.event(event);
        return Gdk.EVENT_STOP;
    }

    _onEntryChanged() {
        this._chatEntry.get_style_context().remove_class('error');
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
        this._confirmLabel.label =
            ngettext("Paste %s line of text to public paste service?",
                     "Paste %s lines of text to public paste service?",
                     nLines).format(nLines);
        this._uploadLabel.label =
            ngettext("Uploading %s line of text to public paste service…",
                     "Uploading %s lines of text to public paste service…",
                     nLines).format(nLines);
        this._setPasteContent(text);
    }

    pasteImage(pixbuf) {
        this._confirmLabel.label = _("Upload image to public paste service?");
        this._uploadLabel.label = _("Uploading image to public paste service…");
        this._setPasteContent(pixbuf);
    }

    pasteFile(file) {
        file.query_info_async(Gio.FILE_ATTRIBUTE_STANDARD_DISPLAY_NAME,
                              Gio.FileQueryInfoFlags.NONE,
                              GLib.PRIORITY_DEFAULT, null,
                              this._onFileInfoReady.bind(this));
    }

    _onFileInfoReady(file, res) {
        let fileInfo = null;
        try {
            fileInfo = file.query_info_finish(res);
        } catch(e) {
            return;
        }

        let name = fileInfo.get_display_name();
        /* Translators: %s is a filename */
        this._confirmLabel.label = _("Upload “%s” to public paste service?").format(name);
        /* Translators: %s is a filename */
        this._uploadLabel.label = _("Uploading “%s” to public paste service…").format(name);
        this._setPasteContent(file);
    }

    _onPasteClicked() {
        let title;
        let nick = this._room.channel.connection.self_contact.alias;
        if (this._room.type == Tp.HandleType.ROOM)
            /* translators: %s is a nick, #%s a channel */
            title = _("%s in #%s").format(nick, this._room.display_name);
        else
            title = _("Paste from %s").format(nick);

        let app = Gio.Application.get_default();
        try {
            app.pasteManager.pasteContent(this._pasteContent, title, url => {
                // TODO: handle errors
                this._setPasteContent(null);
                if (url)
                    this._chatEntry.emit('insert-at-cursor', url);
            });
        } catch(e) {
            let type = typeof this._pasteContent;
            debug('Failed to paste content of type ' +
                  (type == 'object' ? this._pasteContent.toString() : type));
        }
        this._confirmLabel.hide();
    }

    _onCancelClicked() {
        this._setPasteContent(null);
    }

    _onSensitiveChanged() {
        if (this._canFocusChatEntry())
            this._chatEntry.grab_focus();
    }

    _onChannelChanged(room) {
        this._updateCompletions();

        if (room.channel)
            this._selfAliasChangedId =
                room.channel.connection.connect('notify::self-contact',
                                                this._updateNick.bind(this));
        else
            this._selfAliasChangedId = 0;
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
        Mainloop.timeout_add_seconds(MAX_NICK_UPDATE_TIME, () => {
            this._updateNick();
            return GLib.SOURCE_REMOVE;
        });
    }

    _updateNick() {
        let channel = this._room ? this._room.channel : null;
        let nick = channel ? channel.connection.self_contact.alias
                           : this._room ? this._room.account.nickname : '';

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
        if (this._keyPressId)
            this._toplevel.disconnect(this._keyPressId);
        this._keyPressId = 0;
        if (this._nickChangedId)
            EntryArea._nickPopover.disconnect(this._nickChangedId);
        this._nickChangedId = 0;
    }
});
