const Gdk = imports.gi.Gdk;
const Gtk = imports.gi.Gtk;

const ChatroomManager = imports.chatroomManager;
const ChatView = imports.chatView;
const Lang = imports.lang;
const Mainloop = imports.mainloop;
const RoomList = imports.roomList;
const TelepathyClient = imports.telepathyClient;
const UserList = imports.userList;
const Utils = imports.utils;

const MAX_NICK_UPDATE_TIME = 5;


const MainWindow = new Lang.Class({
    Name: 'MainWindow',

    _init: function(app) {
        let builder = new Gtk.Builder();
        builder.add_from_resource('/org/gnome/polari/main-window.ui');

        this.window = builder.get_object('main_window');
        this.window.application = app;

        this._tpClient = new TelepathyClient.TelepathyClient(); // should be in app

        this._roomManager = new ChatroomManager.getDefault();
        this._roomManager.connect('room-added',
                                  Lang.bind(this, this._roomAdded));
        this._roomManager.connect('room-removed',
                                  Lang.bind(this, this._roomRemoved));
        this._roomManager.connect('active-changed',
                                  Lang.bind(this, this._activeRoomChanged));

        this._rooms = {};

        this._room = null;
        this._account = null;

        this._displayNameChangedId = 0;
        this._nicknameChangedId = 0;
        this._channelChangedId = 0;

        let actionEntries = [
          { name: 'join-room',
            activate: Lang.bind(this, this._joinRoom) },
          { name: 'message-user',
            activate: Lang.bind(this, this._messageUser) },
          { name: 'leave-room',
            activate: Lang.bind(this, this._leaveRoom) },
          { name: 'user-list',
            activate: Lang.bind(this, this._toggleAction),
            state: GLib.Variant.new('b', false) }
        ];
        Utils.createActions(actionEntries).forEach(Lang.bind(this,
            function(a) {
                this.window.add_action(a);
            }));
        this._updateActionStates();

        let accels = [
          { accel: '<Primary>n', action: 'win.join-room', parameter: null },
          { accel: '<Primary>w', action: 'win.leave-room', parameter: null },
          { accel: 'F9', action: 'win.user-list', parameter: null }
        ];
        accels.forEach(Lang.bind(this, function(a) {
            app.add_accelerator(a.accel, a.action, a.parameter);
        }));


        this._titlebar = builder.get_object('titlebar');
        this._revealer = builder.get_object('room_list_revealer');
        this._chatStack = builder.get_object('chat_stack');
        this._inputArea = builder.get_object('main_input_area');
        this._nickEntry = builder.get_object('nick_entry');
        this._entry = builder.get_object('message_entry');
        this._sendButton = builder.get_object('send_button');

        this._nickEntry.width_chars = ChatView.MAX_NICK_CHARS

        let scroll = builder.get_object('room_list_scrollview');
        this._roomList = new RoomList.RoomList();
        scroll.add(this._roomList.widget);

        scroll = builder.get_object('user_list_scrollview');
        this._userListStack = new Gtk.Stack();
        scroll.add(this._userListStack);

        let revealer = builder.get_object('user_list_revealer');
        this.window.connect('action-state-changed::user-list', Lang.bind(this,
            function(group, actionName, value) {
                revealer.reveal_child = value.get_boolean();
            }));

        this._sendButton.connect('clicked', Lang.bind(this,
            function() {
                if (this._entry.text)
                    this._room.send(this._entry.text);
                this._entry.text = '';
            }));

        this._nickEntry.connect('activate', Lang.bind(this,
            function() {
               if (this._nickEntry.text)
                   this._setNick(this._nickEntry.text);
               this._entry.grab_focus();
            }));
        this._nickEntry.connect('focus-out-event', Lang.bind(this,
             function() {
               this._nickEntry.text = '';
            }));
        this._nickEntry.connect('key-press-event', Lang.bind(this,
            function(w, event) {
                let [, keyval] = event.get_keyval();
                if (keyval == Gdk.KEY_Escape) {
                    this._entry.grab_focus();
                    return true;
                }
                return false;
            }));

        this._updateSensitivity();

        this.window.show_all();
    },

    _roomAdded: function(roomManager, room) {
        let userList = new UserList.UserList(room);
        let chatView = new ChatView.ChatView(room);

        this._rooms[room.id] = [chatView, userList];

        this._userListStack.add_named(userList.widget, room.id);
        this._chatStack.add_named(chatView.widget, room.id);

        this._revealer.reveal_child = roomManager.roomCount > 0;
    },

    _roomRemoved: function(roomManager, room) {
        this._rooms[room.id].forEach(function(w) { w.widget.destroy(); });
        delete this._rooms[room.id];

        this._revealer.reveal_child = roomManager.roomCount > 0;
    },

    _activeRoomChanged: function(manager, room) {
        if (this._room) {
            this._room.disconnect(this._displayNameChangedId);
            this._room.disconnect(this._channelChangedId);
        }
        this._displayNameChangedId = 0;
        this._channelChangedId = 0;

        this._room = room;

        if (this._room) {
            this._displayNameChangedId =
                this._room.connect('notify::display-name',
                                   Lang.bind(this, this._updateTitlebar));
            this._channelChangedId =
                this._room.connect('notify::channel',
                                   Lang.bind(this, this._updateAccount));

            this._chatStack.set_visible_child_name(this._room.id);
            this._userListStack.set_visible_child_name(this._room.id);
            this._entry.grab_focus();
        }

        this._updateTitlebar();
        this._updateAccount();
        this._updateActionStates();
    },

    _setNick: function(nick) {
        this._nickEntry.placeholder_text = nick;
        this._account.set_nickname_async(nick, Lang.bind(this,
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

    _joinRoom: function() {
        let builder = new Gtk.Builder();
        builder.add_from_resource('/org/gnome/polari/join-room-dialog.ui');

        let dialog = builder.get_object('join_room_dialog');
        dialog.set_transient_for(this.window);

        let connectionCombo = builder.get_object('connection_combo');

        let accounts = this._tpClient.getAccounts();
        let names = accounts.map(function(a) { return a.display_name; });
        for (let i = 0; i < names.length; i++)
            connectionCombo.append_text(names[i]);
        connectionCombo.set_active(0);
        connectionCombo.sensitive = accounts.length > 1;

        let joinButton = builder.get_object('join_button');
        joinButton.sensitive = false;

        let nameEntry = builder.get_object('name_entry');
        nameEntry.connect('changed', function() {
            joinButton.sensitive = accounts.length > 0 &&
                                   nameEntry.get_text_length() > 0;
        });
        dialog.show();
        dialog.connect('response', Lang.bind(this, function(dialog, response) {
            if (response == Gtk.ResponseType.OK) {
                let account = accounts[connectionCombo.get_active()];

                let room = nameEntry.get_text();
                if (room[0] != '#')
                    room = '#' + room;

                this._tpClient.joinRoom(account, room);
            }
            dialog.destroy();
        }));
    },

    _messageUser: function() {
        log('Activated action "Message user"');
    },

    _leaveRoom: function() {
        this._room.leave();
    },

    _toggleAction: function(action) {
        let state = action.get_state();
        action.change_state(GLib.Variant.new('b', !state.get_boolean()));
    },

    _updateTitlebar: function() {
        this._titlebar.title = this._room ? this._room.display_name : null;
    },

    _updateAccount: function() {
        if (this._account)
            this._account.disconnect(this._nicknameChangedId);
        this._nicknameChangedId = 0;

        if (this._room && this._room.channel)
            this._account = this._room.channel.connection.get_account();
        else
            this._account = null;

        if (this._account)
            this._nicknameChangedId =
                this._account.connect('notify::normalized-name',
                                      Lang.bind(this, this._updateNick));

        this._updateNick();
        this._updateSensitivity();
    },

    _updateNick: function() {
        let nick = this._account ? this._account.normalized_name : '';
        this._nickEntry.placeholder_text = nick;
    },

    _updateSensitivity: function() {
        this._inputArea.sensitive = this._account != null;

        if (!this._inputArea.sensitive)
            return;

        this._sendButton.grab_default();
        this._entry.grab_focus();
    },

    _updateActionStates: function() {
        let actionNames = ['leave-room', 'user-list'];
        actionNames.forEach(Lang.bind(this,
            function(actionName) {
                let action = this.window.lookup_action(actionName);
                action.enabled = this._room != null;
                if (action.state && !action.enabled)
                    action.change_state(GLib.Variant.new('b', false));
            }));
    }
});
