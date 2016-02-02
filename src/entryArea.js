const Gdk = imports.gi.Gdk;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;

const ChatView = imports.chatView;
const IrcParser = imports.ircParser;
const Lang = imports.lang;
const Mainloop = imports.mainloop;
const TabCompletion = imports.tabCompletion;
const Tp = imports.gi.TelepathyGLib;

const MAX_NICK_UPDATE_TIME = 5; /* s */
const MAX_LINES = 5;


const ChatEntry = new Lang.Class({
    Name: 'ChatEntry',
    Extends: Gtk.Entry,
    Signals: { 'text-pasted': { param_types: [GObject.TYPE_STRING,
                                              GObject.TYPE_INT] } },

    _init: function(params) {
        this.parent(params);

        this._useDefaultHandler = false;
    },

    vfunc_paste_clipboard: function(entry) {
        if (!this.editable || this._useDefaultHandler) {
            this.parent();
            return;
        }

        let clipboard = Gtk.Clipboard.get_default(this.get_display());
        clipboard.request_text(Lang.bind(this,
            function(clipboard, text) {
            	text = text.trim();

                let nLines = text.split('\n').length;
                if (nLines >= MAX_LINES) {
                    this.emit('text-pasted', text, nLines);
                    return;
                }

                this._useDefaultHandler = true;
                this.emit('paste-clipboard');
                this._useDefaultHandler = false;
            }));
    },
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
                       'multiLineBox',
                       'multiLineLabel',
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

        this._chatEntry.connect('text-pasted', Lang.bind(this, this._onTextPasted));
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

        this._cancelButton.connect('clicked', Lang.bind(this, this._onButtonClicked));
        this._pasteButton.connect('clicked', Lang.bind(this, this._onButtonClicked));

        this._multiLineBox.connect_after('key-press-event', Lang.bind(this,
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

    _onKeyPressEvent: function(w, event) {
        if (!this._chatEntry.get_mapped())
            return Gdk.EVENT_PROPAGATE;

        if (!this.sensitive)
            return Gdk.EVENT_PROPAGATE;

        if (this._chatEntry.has_focus)
            return Gdk.EVENT_PROPAGATE;

        if (this._chatEntry.get_toplevel().get_focus() instanceof Gtk.Entry)
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

    _onTextPasted: function(entry, text, nLines) {
        this._multiLineLabel.label =
            ngettext("Paste %s line of text to public paste service?",
                     "Paste %s lines of text to public paste service?",
                     nLines).format(nLines);
        this._pasteButton.action_target = new GLib.Variant('s', text);
        this.visible_child_name = 'multiline';
        this._pasteButton.grab_focus();
    },

    _onButtonClicked: function() {
            this._chatEntry.text = '';
            this.visible_child_name = 'default';
    },

    _onSensitiveChanged: function() {
        if (!this.sensitive)
            return;

        Mainloop.idle_add(Lang.bind(this,
            function() {
                this._chatEntry.grab_focus();
                return GLib.SOURCE_REMOVE;
            }));
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
