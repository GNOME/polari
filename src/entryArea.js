const Gdk = imports.gi.Gdk;
const GdkPixbuf = imports.gi.GdkPixbuf;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;

const ChatView = imports.chatView;
const IrcParser = imports.ircParser;
const Lang = imports.lang;
const Mainloop = imports.mainloop;
const TabCompletion = imports.tabCompletion;
const Tp = imports.gi.TelepathyGLib;
const PasteManager = imports.pasteManager;
const Utils = imports.utils;

const MAX_NICK_UPDATE_TIME = 5; /* s */
const MAX_LINES = 5;


const ChatEntry = new Lang.Class({
    Name: 'ChatEntry',
    Extends: Gtk.Entry,
    Implements: [PasteManager.DropTargetIface],
    Properties: {
        'can-drop': GObject.ParamSpec.override('can-drop', PasteManager.DropTargetIface),
    },
    Signals: { 'text-pasted': { param_types: [GObject.TYPE_STRING,
                                              GObject.TYPE_INT] },
               'image-pasted': { param_types: [GdkPixbuf.Pixbuf.$gtype] },
               'file-pasted': { param_types: [Gio.File.$gtype] } },

    _init: function(params) {
        this.parent(params);

        PasteManager.DropTargetIface.addTargets(this, this);

        this._useDefaultHandler = false;
    },

    get can_drop() {
        return true;
    },

    vfunc_drag_data_received: function(context, x, y, data, info, time) {
        let str = data.get_text();
        if (!str || str.split('\n').length >= MAX_LINES)
            // Disable GtkEntry's built-in drop target support
            return;

         GObject.signal_stop_emission_by_name(this, 'drag-data-received');
        this.parent(context, x, y, data, info, time);
    },

    vfunc_paste_clipboard: function(entry) {
        if (!this.editable || this._useDefaultHandler) {
            this.parent();
            return;
        }

        let clipboard = Gtk.Clipboard.get_default(this.get_display());
        clipboard.request_uris(Lang.bind(this,
            function(clipboard, uris) {
                if (uris && uris.length)
                    this.emit('file-pasted', Gio.File.new_for_uri(uris[0]));
                else
                    clipboard.request_text(Lang.bind(this, this._onTextReceived));
            }));

        clipboard.request_image(Lang.bind(this,
            function(clipboard, pixbuf) {
                if (pixbuf == null)
                    return;
                this.emit('image-pasted', pixbuf);
            }));
    },

    _onTextReceived: function(clipboard, text) {
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

const EntryArea = new Lang.Class({
    Name: 'EntryArea',
    Extends: Gtk.Stack,
    Template: 'resource:///org/gnome/Polari/ui/entry-area.ui',
    InternalChildren: ['chatEntry',
                       'nickButton',
                       'nickLabel',
                       'nickPopover',
                       'nickEntry',
                       'changeButton',
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

    _init: function(params) {
        this._room = params.room;
        delete params.room;

        this._ircParser = new IrcParser.IrcParser();
        this._maxNickChars = ChatView.MAX_NICK_CHARS;

        this.parent(params);

        this.connect('destroy', Lang.bind(this, this._onDestroy));
        this.connect('notify::sensitive', Lang.bind(this, this._onSensitiveChanged));
        this.connect('realize', Lang.bind(this,
            function() {
                this._toplevel = this.get_toplevel();
                this._keyPressId = this._toplevel.connect('key-press-event',
                                                          Lang.bind(this, this._onKeyPressEvent));
            }));

        this._nickLabel.set_state_flags(Gtk.StateFlags.LINK, false);
        this._nickLabel.width_chars = this._maxNickChars;

        this._changeButton.connect('clicked', Lang.bind(this,
            function() {
               if (this._nickEntry.text)
                   this._setNick(this._nickEntry.text);
               this._nickButton.active = false;
            }));
        this._nickPopover.set_default_widget(this._changeButton);

        this._chatEntry.connect('text-pasted', Lang.bind(this,
            function(entry, text, nLines) {
                this.pasteText(text, nLines);
            }));
        this._chatEntry.connect('text-dropped', Lang.bind(this,
            function(entry, text) {
                this.pasteText(text, text.split('\n').length);
            }));

        this._chatEntry.connect('image-pasted', Lang.bind(this,
            function(entry, image) {
                this.pasteImage(image);
            }));
        this._chatEntry.connect('image-dropped', Lang.bind(this,
            function(entry, image) {
                this.pasteImage(image);
            }));

        this._chatEntry.connect('file-pasted', Lang.bind(this,
            function(entry, file) {
                this.pasteFile(file);
            }));
        this._chatEntry.connect('file-dropped', Lang.bind(this,
            function(entry, file) {
                this.pasteFile(file);
            }));

        this._chatEntry.connect('changed', Lang.bind(this, this._onEntryChanged));

        this._chatEntry.connect('activate', Lang.bind(this,
            function() {
                if (this._ircParser.process(this._chatEntry.text)) {
                    this._chatEntry.text = '';
                } else {
                    this._chatEntry.get_style_context().add_class('error');
                    this._chatEntry.grab_focus(); // select text
                }
            }));

        this._cancelButton.connect('clicked', Lang.bind(this, this._onCancelClicked));
        this._pasteButton.connect('clicked', Lang.bind(this, this._onPasteClicked));

        this._pasteBox.connect_after('key-press-event', Lang.bind(this,
            function(w, event) {
                let [, keyval] = event.get_keyval();
                let [, mods] = event.get_state();
                if (keyval == Gdk.KEY_Escape || keyval == Gdk.KEY_BackSpace ||
                    keyval == Gdk.KEY_Delete ||
                    keyval == Gdk.KEY_z && mods & Gdk.ModifierType.CONTROL_MASK) {
                    this._cancelButton.clicked();
                    return Gdk.EVENT_STOP;
                }
                return Gdk.EVENT_PROPAGATE;
            }));

        if (!this._room)
            return;

        this._completion = new TabCompletion.TabCompletion(this._chatEntry);
        this._membersChangedId =
            this._room.connect('members-changed',
                               Lang.bind(this, this._updateCompletions));
        this._channelChangedId =
            this._room.connect('notify::channel',
                               Lang.bind(this, this._onChannelChanged));
        this._onChannelChanged(this._room);

        this._chatEntry.connect('map', Lang.bind(this, this._updateCompletions));
        this._chatEntry.connect('unmap', Lang.bind(this, this._updateCompletions));
    },

    set max_nick_chars(maxChars) {
        this._maxNickChars = maxChars;
        this._updateNick();
    },

    _updateCompletions: function() {
        let nicks = [];

        if (this._chatEntry.get_mapped() &&
            this._room &&
            this._room.channel &&
            this._room.channel.has_interface(Tp.IFACE_CHANNEL_INTERFACE_GROUP)) {
            let members = this._room.channel.group_dup_members_contacts();
            nicks = members.map(function(member) { return member.alias; });
        }
        this._completion.setCompletions(nicks);
    },

    _canFocusChatEntry: function() {
        let toplevelFocus = this._chatEntry.get_toplevel().get_focus();
        return this.sensitive &&
               this._chatEntry.get_mapped() &&
               !this._chatEntry.has_focus &&
               !(toplevelFocus instanceof Gtk.Entry);
    },

    _onKeyPressEvent: function(w, event) {
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
        if (activationKeys.indexOf(keyval) != -1)
            return Gdk.EVENT_PROPAGATE;

        this._chatEntry.grab_focus_without_selecting();
        this._chatEntry.event(event);
        return Gdk.EVENT_STOP;
    },

    _onEntryChanged: function() {
        this._chatEntry.get_style_context().remove_class('error');
    },

    _setPasteContent: function(content) {
        this._pasteContent = content;

        if (content) {
            this._confirmLabel.show();
            this.visible_child_name = 'paste-confirmation';
            this._pasteButton.grab_focus();
        } else {
            this.visible_child_name = 'default';
            this._chatEntry.grab_focus_without_selecting();
        }
    },

    pasteText: function(text, nLines) {
        this._confirmLabel.label =
            ngettext("Paste %s line of text to public paste service?",
                     "Paste %s lines of text to public paste service?",
                     nLines).format(nLines);
        this._uploadLabel.label =
            ngettext("Uploading %s line of text to public paste service…",
                     "Uploading %s lines of text to public paste service…",
                     nLines).format(nLines);
        this._setPasteContent(text);
    },

    pasteImage: function(pixbuf) {
        this._confirmLabel.label = _("Upload image to public paste service?");
        this._uploadLabel.label = _("Uploading image to public paste service…");
        this._setPasteContent(pixbuf);
    },

    pasteFile: function(file) {
        file.query_info_async(Gio.FILE_ATTRIBUTE_STANDARD_DISPLAY_NAME,
                              Gio.FileQueryInfoFlags.NONE,
                              GLib.PRIORITY_DEFAULT, null,
                              Lang.bind(this, this._onFileInfoReady));
    },

    _onFileInfoReady: function(file, res) {
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
        this._uploadLabel.label = _("Uploading “%s” to public paste service …").format(name);
        this._setPasteContent(file);
    },

    _onPasteClicked: function() {
        let title;
        let nick = this._room.channel.connection.self_contact.alias;
        if (this._room.type == Tp.HandleType.ROOM)
            /* translators: %s is a nick, #%s a channel */
            title = _("%s in #%s").format(nick, this._room.display_name);
        else
            title = _("Paste from %s").format(nick);

        let app = Gio.Application.get_default();
        try {
            app.pasteManager.pasteContent(this._pasteContent, title,
                Lang.bind(this, function(url) {
                    // TODO: handle errors
                    this._setPasteContent(null);
                    if (url)
                        this._chatEntry.emit('insert-at-cursor', url);
                }));
        } catch(e) {
            let type = typeof this._pasteContent;
            Utils.debug('Failed to paste content of type ' +
                        (type == 'object' ? this._pasteContent.toString() : type));
        }
        this._confirmLabel.hide();
    },

    _onCancelClicked: function() {
        this._setPasteContent(null);
    },

    _onSensitiveChanged: function() {
        if (this._canFocusChatEntry())
            this._chatEntry.grab_focus();
    },

    _onChannelChanged: function(room) {
        this._updateCompletions();

        if (room.channel)
            this._nicknameChangedId =
                room.channel.connection.connect('notify::self-contact',
                                                Lang.bind(this, this._updateNick));
        else
            this._nicknameChangedId = 0;
        this._updateNick();
    },


    _setNick: function(nick) {
        this._nickLabel.width_chars = Math.max(nick.length, this._maxNickChars);
        this._nickLabel.label = nick;

        let account = this._room.account;
        account.set_nickname_async(nick, Lang.bind(this,
            function(a, res) {
                try {
                    a.set_nickname_finish(res);
                } catch(e) {
                    logError(e, "Failed to change nick");

                    this._updateNick();
                    return;
                }

                // TpAccount:nickname is a local property which doesn't
                // necessarily match the externally visible nick; telepathy
                // doesn't consider failing to sync the two an error, so
                // we give the server MAX_NICK_UPDATE_TIME seconds until
                // we assume failure and revert back to the server nick
                //
                // (set_aliases() would do what we want, but it's not
                // introspected)
                Mainloop.timeout_add_seconds(MAX_NICK_UPDATE_TIME,
                    Lang.bind(this, function() {
                        this._updateNick();
                        return GLib.SOURCE_REMOVE;
                    }));
            }));
    },

    _updateNick: function() {
        let channel = this._room ? this._room.channel : null;
        let nick = channel ? channel.connection.self_contact.alias
                           : this._room ? this._room.account.nickname : '';

        this._nickLabel.width_chars = Math.max(nick.length, this._maxNickChars);
        this._nickLabel.label = nick;

        if (!this._nickEntry.is_focus)
            this._nickEntry.text = nick;
    },

    _onDestroy: function() {
        if (this._membersChangedId)
            this._room.disconnect(this._membersChangedId);
        this._membersChangedId = 0;
        if (this._nicknameChangedId)
            this._room.channel.connection.disconnect(this._nicknameChangedId);
        this._nicknameChangedId = 0;
        if (this._channelChangedId)
            this._room.disconnect(this._channelChangedId);
        this._channelChangedId = 0;
        if (this._keyPressId)
            this._toplevel.disconnect(this._keyPressId);
        this._keyPressId = 0;
    }
});
