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
                let toplevel = this.widget.get_toplevel();
                toplevel.connect('key-press-event',
                                       Lang.bind(this, this._onKeyPressEvent));
            }));

        this._nickEntry = new Gtk.Entry();
        this._nickEntry.width_chars = ChatView.MAX_NICK_CHARS
        this._nickEntry.get_style_context().add_class('dim-label');
        this.widget.add(this._nickEntry);

        this._nickEntry.connect('activate', Lang.bind(this,
            function() {
               if (this._nickEntry.text)
                   this._setNick(this._nickEntry.text);
               this._entry.grab_focus();
            }));
        this._nickEntry.connect('focus-out-event', Lang.bind(this,
             function() {
               this._nickEntry.text = '';
               return false;
            }));
        this._nickEntry.connect_after('key-press-event', Lang.bind(this,
            function(w, event) {
                let [, keyval] = event.get_keyval();
                if (keyval == Gdk.KEY_Escape) {
                    this._entry.grab_focus();
                    return true;
                }
                return false;
            }));

        this._entry = new Gtk.Entry({ hexpand: true,
                                      activates_default: true });
        this.widget.add(this._entry);

        this._entry.connect('activate', Lang.bind(this,
            function() {
                this._ircParser.process(this._entry.text);
                this._entry.text = '';
            }));

        this.widget.show_all();
    },

    _updateCompletions: function() {
        let nicks = [];

        if (this._room &&
            this._room.channel &&
            this._room.channel.has_interface(Tp.IFACE_CHANNEL_INTERFACE_GROUP)) {
            let members = this._room.channel.group_dup_members_contacts();
            nicks = members.map(function(member) { return member.alias; });
        }
        this._completion.setCompletions(nicks);
    },

    _onKeyPressEvent: function(w, event) {
        if (!this._entry.get_mapped())
            return false;

        if (this._entry.has_focus)
            return false;

        if (this._entry.get_toplevel().get_focus() instanceof Gtk.Entry)
            return false;

        let [, keyval] = event.get_keyval();
        if (Gdk.keyval_to_unicode(keyval) == 0)
            return false;

        let [, state] = event.get_state();
        if (state != 0)
            return false;

        this._entry.editable = false;
        this._entry.grab_focus();
        this._entry.editable = true;
        this._entry.event(event);
        return true;
    },

    _onSensitiveChanged: function() {
        if (!this.widget.sensitive)
            return;

        Mainloop.idle_add(Lang.bind(this,
            function() {
                this._entry.grab_focus();
                return false;
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
                        return false;
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
    }
});
