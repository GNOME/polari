const Gdk = imports.gi.Gdk;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
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
const UserList = imports.userList;

const MAX_NICK_UPDATE_TIME = 5;


const MainWindow = new Lang.Class({
    Name: 'MainWindow',

    _init: function(app) {
        let builder = new Gtk.Builder();
        builder.add_from_resource('/org/gnome/polari/main-window.ui');

        this.window = builder.get_object('main_window');
        this.window.application = app;

        this._settings = new Gio.Settings({ schema: 'org.gnome.polari' });

        this._accountsMonitor = new AccountsMonitor.getDefault();
        this._accountsMonitor.connect('account-status-changed',
                                      Lang.bind(this, this._onAccountChanged));
        this._accountsMonitor.connect('account-added',
                                      Lang.bind(this, this._onAccountChanged));

        this._roomManager = new ChatroomManager.getDefault();
        this._roomManager.connect('room-added',
                                  Lang.bind(this, this._roomAdded));
        this._roomManager.connect('room-removed',
                                  Lang.bind(this, this._roomRemoved));
        this._roomManager.connect('active-changed',
                                  Lang.bind(this, this._activeRoomChanged));

        let actionEntries = [
          { name: 'room-menu',
            activate: Lang.bind(this, this._onToggleAction),
            create_hook: Lang.bind(this, this._accountActionsCreateHook),
            state: GLib.Variant.new('b', false) },
          { name: 'show-join-dialog',
            activate: Lang.bind(this, this._onShowJoinDialog),
            create_hook: Lang.bind(this, this._accountActionsCreateHook) },
          { name: 'message-user',
            activate: Lang.bind(this, this._onMessageUser) },
          { name: 'join-room',
            activate: Lang.bind(this, this._onJoinRoom),
            parameter_type: GLib.VariantType.new('(ssu)') },
          { name: 'leave-room',
            activate: Lang.bind(this, this._onLeaveRoom),
            parameter_type: GLib.VariantType.new('s') },
          { name: 'leave-current-room',
            activate: Lang.bind(this, this._onLeaveCurrentRoom),
            create_hook: Lang.bind(this, this._leaveRoomCreateHook) },
          { name: 'leave-selected-rooms' },
          { name: 'user-list',
            activate: Lang.bind(this, this._onToggleAction),
            create_hook: Lang.bind(this, this._userListCreateHook),
            state: GLib.Variant.new('b', false) },
          { name: 'selection-mode',
            activate: Lang.bind(this, this._onToggleAction),
            create_hook: Lang.bind(this, this._selectionModeHook),
            state: GLib.Variant.new('b', false) },
          { name: 'next-room',
            accel: '<Primary>Page_Down' },
          { name: 'previous-room',
            accel: '<Primary>Page_Up' },
          { name: 'first-room',
            accel: '<Primary>Home' },
          { name: 'last-room',
            accel: '<Primary>End' }
        ];
        actionEntries.forEach(Lang.bind(this,
            function(actionEntry) {
                let props = {};
                ['name', 'state', 'parameter_type'].forEach(
                    function(prop) {
                        if (actionEntry[prop])
                            props[prop] = actionEntry[prop];
                    });
                let action = new Gio.SimpleAction(props);
                if (actionEntry.create_hook)
                    actionEntry.create_hook(action);
                if (actionEntry.activate)
                    action.connect('activate', actionEntry.activate);
                if (actionEntry.change_state)
                    action.connect('change-state', actionEntry.change_state);
                this.window.add_action(action);
        }));

        let overlay = builder.get_object('overlay');

        overlay.add_overlay(app.notificationQueue.widget);
        overlay.add_overlay(app.commandOutputQueue.widget);

        this._ircParser = new IrcParser.IrcParser();

        this._rooms = {};

        this._room = null;

        this._displayNameChangedId = 0;
        this._topicChangedId = 0;
        this._nicknameChangedId = 0;

        this._titlebarRight = builder.get_object('titlebar_right');
        this._titlebarLeft = builder.get_object('titlebar_left');

        this._selectionRevealer = builder.get_object('selection_toolbar_revealer');
        this._revealer = builder.get_object('room_list_revealer');
        this._chatStack = builder.get_object('chat_stack');
        this._inputArea = builder.get_object('main_input_area');
        this._nickEntry = builder.get_object('nick_entry');
        this._entry = builder.get_object('message_entry');

        this._nickEntry.width_chars = ChatView.MAX_NICK_CHARS

        let scroll = builder.get_object('room_list_scrollview');
        this._roomList = new RoomList.RoomList(this.window);
        scroll.add(this._roomList.widget);

        this._userListStack = builder.get_object('user_list_stack');

        let revealer = builder.get_object('user_list_revealer');
        app.connect('action-state-changed::user-list', Lang.bind(this,
            function(group, actionName, value) {
                revealer.reveal_child = value.get_boolean();
            }));

        this._selectionModeAction = this.window.lookup_action('selection-mode');
        this._selectionModeAction.connect('notify::state',
                    Lang.bind(this, this._onSelectionModeChanged));

        this._entry.connect('activate', Lang.bind(this,
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
        this._nickEntry.connect_after('key-press-event', Lang.bind(this,
            function(w, event) {
                let [, keyval] = event.get_keyval();
                if (keyval == Gdk.KEY_Escape) {
                    this._entry.grab_focus();
                    return true;
                }
                return false;
            }));
        this.window.connect_after('key-press-event', Lang.bind(this,
            function(w, event) {
                let [, keyval] = event.get_keyval();
                if (keyval == Gdk.KEY_Escape) {
                    this._selectionModeAction.change_state(GLib.Variant.new('b', false));
                }
            }));

        this._updateSensitivity();

        this.window.show_all();
    },

    _onToggleAction: function(action) {
        let state = action.get_state();
        action.change_state(GLib.Variant.new('b', !state.get_boolean()));
    },

    _updateAccountAction: function(action) {
        action.enabled = this._accountsMonitor.dupAccounts().filter(
            function(a) {
                return a.enabled;
            }).length > 0;
    },

    _accountActionsCreateHook: function(action) {
        this._accountsMonitor.connect('accounts-changed', Lang.bind(this,
            function() {
                this._updateAccountAction(action);
            }));
        this._updateAccountAction(action);
    },

    _onShowJoinDialog: function() {
        this.showJoinRoomDialog();
    },

    _onMessageUser: function() {
        log('Activated action "Message user"');
    },

    _addSavedChannel: function(account, channel) {
        let savedChannels = this._settings.get_value('saved-channel-list').deep_unpack();
        let savedChannel = {
            account: GLib.Variant.new('s', account.get_object_path()),
            channel: GLib.Variant.new('s', channel)
        };
        for (let i = 0; i < savedChannels.length; i++)
            if (savedChannels[i].account.equal(savedChannel.account) &&
                savedChannels[i].channel.equal(savedChannel.channel))
                return;
        savedChannels.push(savedChannel);
        this._settings.set_value('saved-channel-list',
                                 GLib.Variant.new('aa{sv}', savedChannels));
    },

    _removeSavedChannel: function(account, channel) {
        let savedChannels = this._settings.get_value('saved-channel-list').deep_unpack();
        let savedChannel = {
            account: GLib.Variant.new('s', account.get_object_path()),
            channel: GLib.Variant.new('s', channel)
        };
        let i;
        for (i = 0; i < savedChannels.length; i++)
            if (savedChannels[i].account.equal(savedChannel.account) &&
                savedChannels[i].channel.equal(savedChannel.channel))
                break;
        if (!savedChannels[i])
            return;
        savedChannels.splice(i, 1);
        this._settings.set_value('saved-channel-list',
                                 GLib.Variant.new('aa{sv}', savedChannels));
    },

    _updateAccountName: function(account, name, callback) {
        let sv = { account: GLib.Variant.new('s', name) };
        let asv = GLib.Variant.new('a{sv}', sv);
        account.update_parameters_vardict_async(asv, [], callback);
    },

    _ensureChannel: function(requestData) {
        let account = requestData.account;

        let req = Tp.AccountChannelRequest.new_text(account, requestData.time);
        req.set_target_id(Tp.HandleType.ROOM, requestData.target);
        req.set_delegate_to_preferred_handler(true);
        let preferredHandler = Tp.CLIENT_BUS_NAME_BASE + 'Polari';
        req.ensure_channel_async(preferredHandler, null,
                                 Lang.bind(this,
                                           this._onEnsureChannel, requestData));
    },

    _onEnsureChannel: function(req, res, requestData) {
        let account = req.account;

        try {
            req.ensure_channel_finish(res);
        } catch (e if e.matches(Tp.Error, Tp.Error.DISCONNECTED)) {
            let [error,] = account.dup_detailed_error_vardict();
            if (error != TP_ERROR_ALREADY_CONNECTED)
                throw(e);

            if (++requestData.retry >= MAX_RETRIES) {
                throw(e);
                return;
            }

            // Try again with a different nick
            let params = account.dup_parameters_vardict().deep_unpack();
            let oldNick = params['account'].deep_unpack();
            let nick = oldNick + '_';
            this._updateAccountName(account, nick, Lang.bind(this,
                function() {
                    this._ensureChannel(requestData);
                }));
            return;
        } catch (e) {
            logError(e, 'Failed to ensure channel');
        }

        if (requestData.retry > 0)
            this._updateAccountName(account, requestData.originalNick, null);
        this._addSavedChannel(account, requestData.target);
    },

    _onJoinRoom: function(action, parameter) {
        let [accountPath, channelName, time] = parameter.deep_unpack();
        // have this in AccountMonitor?
        let factory = Tp.AccountManager.dup().get_factory();
        let account = factory.ensure_account(accountPath, []);

        let requestData = {
          account: account,
          target: channelName,
          time: time,
          retry: 0,
          originalNick: account.nickname };

        this._ensureChannel(requestData);
    },

    _onLeaveRoom: function(action, parameter) {
        let reason = Tp.ChannelGroupChangeReason.NONE;
        let message = _("Good Bye"); // TODO - our first setting!
        let room = this._roomManager.getRoomById(parameter.deep_unpack());
        if (!room)
            return;
        room.channel.leave_async(reason, message, Lang.bind(this,
            function(c, res) {
                try {
                    c.leave_finish(res);
                } catch(e) {
                    logError(e, 'Failed to leave channel');
                }
            }));
        this._removeSavedChannel(room.channel.connection.get_account(),
                                 room.channel.identifier);
    },

    _leaveRoomCreateHook: function(action) {
        this._roomManager.connect('active-changed', Lang.bind(this,
            function() {
                action.enabled = this._roomManager.getActiveRoom() != null;
            }));
        action.enabled = this._roomManager.getActiveRoom() != null;
    },

    _onLeaveCurrentRoom: function() {
        let room = this._roomManager.getActiveRoom();
        if (!room)
            return;
        let action = this.lookup_action('leave-room');
        action.activate(GLib.Variant.new('s', room.id));
    },

    _updateUserListAction: function(action) {
        let room = this._roomManager.getActiveRoom();
        action.enabled = room && room.channel.handle_type == Tp.HandleType.ROOM;
        if (!action.enabled)
            action.change_state(GLib.Variant.new('b', false));
    },

    _userListCreateHook: function(action) {
        this._roomManager.connect('active-changed', Lang.bind(this,
            function() {
                this._updateUserListAction(action);
            }));
        this._updateUserListAction(action);
    },

    _updateSelectionModeAction: function(action) {
        action.enabled = this._roomManager.roomCount > 0;
        if (!action.enabled)
            action.change_state(GLib.Variant.new('b', false));
    },

    _selectionModeHook: function(action) {
        this._roomManager.connect('active-changed', Lang.bind(this,
            function() {
                this._updateSelectionModeAction(action);
            }));
        this._updateSelectionModeAction(action);
    },

    _onSelectionModeChanged: function() {
        let enabled = this._selectionModeAction.state.get_boolean();
        this._selectionRevealer.reveal_child = enabled;

        if (enabled) {
            this._titlebarLeft.get_style_context().add_class('selection-mode');
            this._titlebarRight.get_style_context().add_class('selection-mode');
        } else {
            this._titlebarLeft.get_style_context().remove_class('selection-mode');
            this._titlebarRight.get_style_context().remove_class('selection-mode');
        }
    },

    _onAccountChanged: function(am, account) {
        if (account.connection_status != Tp.ConnectionStatus.CONNECTING)
            return;

        if (account._connectingNotification)
            return;

        let app = Gio.Application.get_default();
        let notification = new AppNotifications.ConnectingNotification(account);
        app.notificationQueue.addNotification(notification);

        account._connectingNotification = notification;
        notification.widget.connect('destroy',
            function() {
		delete account._connectingNotification;
            });
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
            this._room.channel.connection.disconnect(this._nicknameChangedId);
        }
        this._displayNameChangedId = 0;
        this._topicChangedId = 0;
        this._nicknameChangedId = 0;

        this._room = room;

        this._updateTitlebar();
        this._updateNick();
        this._updateSensitivity();

        if (!this._room)
            return; // finished

        this._displayNameChangedId =
            this._room.connect('notify::display-name',
                               Lang.bind(this, this._updateTitlebar));
        this._topicChangedId =
            this._room.connect('notify::topic',
                               Lang.bind(this, this._updateTitlebar));
        this._nicknameChangedId =
            this._room.channel.connection.connect('notify::self-contact',
                                                  Lang.bind(this,
                                                            this._updateNick));

        this._chatStack.set_visible_child_name(this._room.id);
        this._userListStack.set_visible_child_name(this._room.id);
    },

    _setNick: function(nick) {
        this._nickEntry.placeholder_text = nick;

        let account = this._room.channel.connection.get_account();
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

    showJoinRoomDialog: function() {
        let dialog = new JoinDialog.JoinDialog(this.window);
        dialog.widget.transient_for = this.window;
        dialog.widget.show();
        dialog.widget.connect('response',
            function(widget) {
                widget.destroy();
            });
    },

    _updateTitlebar: function() {
        this._titlebarRight.title = this._room ? this._room.display_name : null;
        this._titlebarRight.subtitle = this._room ? this._room.topic : null;
    },

    _updateNick: function() {
        let nick = this._room ? this._room.channel.connection.self_contact.alias
                              : '';
        this._nickEntry.placeholder_text = nick;
    },

    _updateSensitivity: function() {
        this._inputArea.sensitive = this._room != null;

        if (!this._inputArea.sensitive)
            return;

        this._entry.grab_focus();
    }
});
