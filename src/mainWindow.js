const Gdk = imports.gi.Gdk;
const Gtk = imports.gi.Gtk;
const Tp = imports.gi.TelepathyGLib;

const AccountsMonitor = imports.accountsMonitor;
const AppNotifications = imports.appNotifications;
const ChatroomManager = imports.chatroomManager;
const ChatView = imports.chatView;
const IrcParser = imports.ircParser;
const JoinDialog = imports.joinDialog;
const Lang = imports.lang;
const Mainloop = imports.mainloop;
const RoomList = imports.roomList;
const TelepathyClient = imports.telepathyClient;
const UserList = imports.userList;

const MAX_NICK_UPDATE_TIME = 5;


const MainWindow = new Lang.Class({
    Name: 'MainWindow',

    _init: function(app) {
        let builder = new Gtk.Builder();
        builder.add_from_resource('/org/gnome/polari/main-window.ui');

        this.window = builder.get_object('main_window');
        this.window.application = app;

        this._tpClient = new TelepathyClient.TelepathyClient(); // should be in app

        let overlay = builder.get_object('overlay');

        overlay.add_overlay(app.notificationQueue.widget);
        overlay.add_overlay(app.commandOutputQueue.widget);

        this._ircParser = new IrcParser.IrcParser();

        this._accountsMonitor = new AccountsMonitor.getDefault();
        this._accountsMonitor.connect('account-status-changed',
                                      Lang.bind(this, this._accountStatusChanged));

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
        this._topicChangedId = 0;
        this._nicknameChangedId = 0;

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
        app.connect('action-state-changed::user-list', Lang.bind(this,
            function(group, actionName, value) {
                revealer.reveal_child = value.get_boolean();
            }));

        this._sendButton.connect('clicked', Lang.bind(this,
            function() {
                this._ircParser.process(this._entry.text);
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

    _accountStatusChanged: function(am, account) {
        if (account.connection_status != Tp.ConnectionStatus.CONNECTING)
            return;

        let notification = new AppNotifications.ConnectingNotification(account);
        this._notifications.addNotification(notification);
    },


    _roomAdded: function(roomManager, room) {
        let userList;
        let chatView = new ChatView.ChatView(room);

        if (room.channel.handle_type == Tp.HandleType.ROOM)
            userList = new UserList.UserList(room);
        else
            userList = { widget: new Gtk.Label() };

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
            this._room.disconnect(this._topicChangedId);
        }
        this._displayNameChangedId = 0;
        this._topicChangedId = 0;

        this._room = room;

        if (this._room) {
            this._displayNameChangedId =
                this._room.connect('notify::display-name',
                                   Lang.bind(this, this._updateTitlebar));
            this._topicChangedId =
                this._room.connect('notify::topic',
                                   Lang.bind(this, this._updateTitlebar));

            this._chatStack.set_visible_child_name(this._room.id);
            this._userListStack.set_visible_child_name(this._room.id);
            this._entry.grab_focus();
        }

        this._updateTitlebar();
        this._updateAccount();
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

    showJoinRoomDialog: function() {
        let dialog = new JoinDialog.JoinDialog();
        dialog.widget.transient_for = this.window;
        dialog.widget.show();
        dialog.widget.connect('response',
            function(widget) {
                widget.destroy();
            });
    },

    _updateTitlebar: function() {
        this._titlebar.title = this._room ? this._room.display_name : null;
        this._titlebar.subtitle = this._room ? this._room.topic : null;
    },

    _updateAccount: function() {
        if (this._conn)
            this._conn.disconnect(this._nicknameChangedId);
        this._nicknameChangedId = 0;

        if (this._room) {
            this._conn = this._room.channel.connection;
            this._account = this._room.channel.connection.get_account();
        } else {
            this._account = null;
            this._conn = null;
        }

        if (this._conn)
            this._nicknameChangedId =
                this._conn.connect('notify::self-contact',
                                   Lang.bind(this, this._updateNick));

        this._updateNick();
        this._updateSensitivity();
    },

    _updateNick: function() {
        let nick = this._conn ? this._conn.self_contact.alias : '';
        this._nickEntry.placeholder_text = nick;
    },

    _updateSensitivity: function() {
        this._inputArea.sensitive = this._account != null;

        if (!this._inputArea.sensitive)
            return;

        this._sendButton.grab_default();
        this._entry.grab_focus();
    }
});
