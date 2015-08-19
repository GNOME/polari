const Gdk = imports.gi.Gdk;
const GLib = imports.gi.GLib;
const Gtk = imports.gi.Gtk;

const ChatView = imports.chatView;
const IrcParser = imports.ircParser;
const Lang = imports.lang;
const Mainloop = imports.mainloop;
const TabCompletion = imports.tabCompletion;
const Tp = imports.gi.TelepathyGLib;

const MAX_NICK_UPDATE_TIME = 5; /* s */
const MAX_LINES = 5;

const EntryArea = new Lang.Class({
    Name: 'EntryArea',

    _init: function(room) {
        this._createWidget();

        this._ircParser = new IrcParser.IrcParser();

        this._room = room;

        if (!room)
            return;

        this._completion = new TabCompletion.TabCompletion(this._entry);
        this._membersChangedId =
            this._room.connect('members-changed',
                               Lang.bind(this, this._updateCompletions));
        this._channelChangedId =
            this._room.connect('notify::channel',
                               Lang.bind(this, this._onChannelChanged));
        this._onChannelChanged(room);

        this._entry.connect('map', Lang.bind(this, this._updateCompletions));
        this._entry.connect('unmap', Lang.bind(this, this._updateCompletions));
    },

    _createWidget: function() {
        this.widget = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL,
                                    sensitive: false,
                                    margin: 6 });
        this.widget.get_style_context().add_class('linked');

        this.widget.connect('destroy', Lang.bind(this, this._onDestroy));
        this.widget.connect('notify::sensitive', Lang.bind(this, this._onSensitiveChanged));
        this.widget.connect('realize', Lang.bind(this,
            function() {
                this._toplevel = this.widget.get_toplevel();
                this._keyPressId = this._toplevel.connect('key-press-event',
                                                          Lang.bind(this, this._onKeyPressEvent));
            }));

        let chatBox = new Gtk.Box ({ orientation: Gtk.Orientation.HORIZONTAL });

        this._nickEntry = new Gtk.Entry();
        this._nickEntry.width_chars = ChatView.MAX_NICK_CHARS
        this._nickEntry.get_style_context().add_class('polari-nick-entry');
        chatBox.add(this._nickEntry);

        this._nickEntry.connect('activate', Lang.bind(this,
            function() {
               if (this._nickEntry.text)
                   this._setNick(this._nickEntry.text);
               this._entry.grab_focus();
            }));
        this._nickEntry.connect('focus-out-event', Lang.bind(this,
            function() {
                this._nickEntry.text = '';
                return Gdk.EVENT_PROPAGATE;
            }));
        this._nickEntry.connect_after('key-press-event', Lang.bind(this,
            function(w, event) {
                let [, keyval] = event.get_keyval();
                log(keyval);
                if (keyval == Gdk.KEY_Escape) {
                    this._entry.grab_focus();
                    return Gdk.EVENT_STOP;
                }
                return Gdk.EVENT_PROPAGATE;
            }));

        this._entry = new Gtk.Entry({ hexpand: true,
                                      activates_default: true });
        this._entry.connect('changed', Lang.bind(this, this._onEntryChanged));
        chatBox.add(this._entry);

        this._entry.connect('activate', Lang.bind(this,
            function() {
                this._ircParser.process(this._entry.text);
                this._entry.text = '';
            }));

        this.stack = new Gtk.Stack({ transition_type: Gtk.StackTransitionType.CROSSFADE,
                                     vhomogeneous: true });
        this.stack.add_named(chatBox, 'default');

        let multiLineBox = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL,
                                         spacing: 6 });

        this._multiLinelabel = new Gtk.Label({ halign: Gtk.Align.START,
                                               xalign: 0, hexpand: true });
        multiLineBox.add(this._multiLinelabel);

        let cancelButton = new Gtk.Button({ label: _("Cancel") });
        cancelButton.connect('clicked', Lang.bind(this, this._resetEntry));
        multiLineBox.add(cancelButton);
        multiLineBox.connect_after('key-press-event', Lang.bind(this,
            function(w, event) {
                let [, keyval] = event.get_keyval();
                let [, mods] = event.get_state();
                if (keyval == Gdk.KEY_Escape || keyval == Gdk.KEY_BackSpace ||
                    keyval == Gdk.KEY_z && mods & Gdk.ModifierType.CONTROL_MASK) {
                    this._resetEntry();
                    return Gdk.EVENT_STOP;
                }
                return Gdk.EVENT_PROPAGATE;
            }));

        this._pasteButton = new Gtk.Button({ label: _("Paste"), has_focus: true,
                                             action_name: 'app.paste-text' });
        this._pasteButton.get_style_context().add_class('suggested-action');
        this._pasteButton.connect('clicked', Lang.bind(this, this._resetEntry));
        multiLineBox.add(this._pasteButton);

        this.stack.add_named(multiLineBox, 'multiline');
        this.widget.add(this.stack);
        this.widget.show_all();
    },

    _resetEntry: function() {
        this._entry.text = '';
        this.stack.visible_child_name = 'default';
    },

    _updateCompletions: function() {
        let nicks = [];

        if (this._entry.get_mapped() &&
            this._room &&
            this._room.channel &&
            this._room.channel.has_interface(Tp.IFACE_CHANNEL_INTERFACE_GROUP)) {
            let members = this._room.channel.group_dup_members_contacts();
            nicks = members.map(function(member) { return member.alias; });
        }
        this._completion.setCompletions(nicks);
    },

    _onKeyPressEvent: function(w, event) {
        if (!this._entry.get_mapped())
            return Gdk.EVENT_PROPAGATE;

        if (!this.widget.sensitive)
            return Gdk.EVENT_PROPAGATE;

        if (this._entry.has_focus)
            return Gdk.EVENT_PROPAGATE;

        if (this._entry.get_toplevel().get_focus() instanceof Gtk.Entry)
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

        this._entry.editable = false;
        this._entry.grab_focus();
        this._entry.editable = true;
        this._entry.event(event);
        return Gdk.EVENT_STOP;
    },

    _onEntryChanged: function() {
        let lineAmount = this._entry.text.split('\n').length;

        if (lineAmount < MAX_LINES)
            return;

        this._multiLinelabel.label = _("Paste %s lines of text to public paste service?").format(lineAmount);
        this._pasteButton.action_target = new GLib.Variant('s', this._entry.text),
        this.stack.visible_child_name = 'multiline';
        this._pasteButton.grab_focus();
    },

    _onSensitiveChanged: function() {
        if (!this.widget.sensitive)
            return;

        Mainloop.idle_add(Lang.bind(this,
            function() {
                this._entry.grab_focus();
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
        this._nickEntry.width_chars = Math.max(nick.length, ChatView.MAX_NICK_CHARS)
        this._nickEntry.placeholder_text = nick;

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

        this._nickEntry.width_chars = Math.max(nick.length, ChatView.MAX_NICK_CHARS)
        this._nickEntry.placeholder_text = nick;
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
