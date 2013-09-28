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
const MessageDialog = imports.messageDialog;
const RoomList = imports.roomList;
const TabCompletion = imports.tabCompletion;
const UserList = imports.userList;
const Utils = imports.utils;

const MAX_NICK_UPDATE_TIME = 5; /* s */
const CONFIGURE_TIMEOUT = 100; /* ms */


const MainWindow = new Lang.Class({
    Name: 'MainWindow',

    _init: function(app) {
        let builder = new Gtk.Builder();
        builder.add_from_resource('/org/gnome/polari/main-window.ui');

        this.window = builder.get_object('main_window');
        this.window.application = app;

        let overlay = builder.get_object('overlay');

        overlay.add_overlay(app.notificationQueue.widget);
        overlay.add_overlay(app.commandOutputQueue.widget);

        this._ircParser = new IrcParser.IrcParser();

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

        this._rooms = {};

        this._room = null;
        this._settings = new Gio.Settings({ schema: 'org.gnome.polari' });

        this._displayNameChangedId = 0;
        this._topicChangedId = 0;
        this._nicknameChangedId = 0;
        this._configureId = 0;

        this._titlebarRight = builder.get_object('titlebar_right');
        this._titlebarLeft = builder.get_object('titlebar_left');

        this._titleLabel = builder.get_object('title_label');
        this._subtitleLabel = builder.get_object('subtitle_label');

        this._selectionRevealer = builder.get_object('selection_toolbar_revealer');
        this._showUserListButton = builder.get_object('show_user_list_button');
        this._revealer = builder.get_object('room_list_revealer');
        this._chatStack = builder.get_object('chat_stack');
        this._inputArea = builder.get_object('main_input_area');
        this._nickEntry = builder.get_object('nick_entry');
        this._entry = builder.get_object('message_entry');

        this._nickEntry.width_chars = ChatView.MAX_NICK_CHARS
        this._completion = new TabCompletion.TabCompletion(this._entry);

        let scroll = builder.get_object('room_list_scrollview');
        this._roomList = new RoomList.RoomList();
        scroll.add(this._roomList.widget);

        let sidebar = builder.get_object('user_list_sidebar');
        this._userListSidebar = new UserList.UserListSidebar();
        sidebar.add(this._userListSidebar.widget);

        let revealer = builder.get_object('user_list_revealer');
        app.connect('action-state-changed::user-list', Lang.bind(this,
            function(group, actionName, value) {
                revealer.reveal_child = value.get_boolean();
            }));
        revealer.connect('notify::child-revealed', Lang.bind(this,
            function() {
                this._userListSidebar.animateEntry = revealer.child_revealed;
            }));

        this._selectionModeAction = app.lookup_action('selection-mode');
        this._selectionModeAction.connect('notify::state',
                    Lang.bind(this, this._onSelectionModeChanged));

        this._userListAction = app.lookup_action('user-list');

        this._entry.connect('activate', Lang.bind(this,
            function() {
                this._ircParser.process(this._entry.text);
                this._entry.text = '';
            }));
        this._entry.connect('notify::is-focus', Lang.bind(this,
            function() {
                // HACK: force focus to the entry unless it was
                //       moved by keynav or moved to another entry
                if (this.window.get_focus() instanceof Gtk.Entry)
                    return;
                let device = Gtk.get_current_event_device();
                if (!device || device.get_source() == Gdk.InputSource.KEYBOARD)
                    return;
                this._entry.grab_focus();
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
        this.window.connect_after('key-press-event', Lang.bind(this,
            function(w, event) {
                let [, keyval] = event.get_keyval();
                if (keyval == Gdk.KEY_Escape) {
                    this._selectionModeAction.change_state(GLib.Variant.new('b', false));
                }
            }));
        this.window.connect('window-state-event',
                            Lang.bind(this, this._onWindowStateEvent));
        this.window.connect('configure-event',
                            Lang.bind(this, this._onConfigureEvent));
        this.window.connect('delete-event',
                            Lang.bind(this, this._onDelete));

        let size = this._settings.get_value('window-size');
        if (size.n_children() == 2) {
            let width = size.get_child_value(0);
            let height = size.get_child_value(1);
            this.window.set_default_size(width.get_int32(), height.get_int32());
        }

        let position = this._settings.get_value('window-position');
        if (position.n_children() == 2) {
            let x = position.get_child_value(0);
            let y = position.get_child_value(1);
            this.window.move(x.get_int32(), y.get_int32());
        }

        if (this._settings.get_boolean('window-maximized'))
            this.window.maximize();

        this._updateSensitivity();

        this.window.show_all();
    },

    _onWindowStateEvent: function(widget, event) {
        let window = widget.get_window();
        let state = window.get_state();

        if (state & Gdk.WindowState.FULLSCREEN)
            return;

        let maximized = (state & Gdk.WindowState.MAXIMIZED);
        this._settings.set_boolean('window-maximized', maximized);
    },

    _saveGeometry: function() {
        let window = this.window.get_window();
        let state = window.get_state();

        if (state & Gdk.WindowState.MAXIMIZED)
            return;

        let size = this.window.get_size();
        this._settings.set_value('window-size', GLib.Variant.new('ai', size));

        let position = this.window.get_position();
        this._settings.set_value('window-position',
                                 GLib.Variant.new('ai', position));
    },

    _onConfigureEvent: function(widget, event) {
        let window = widget.get_window();
        let state = window.get_state();

        if (state & Gdk.WindowState.FULLSCREEN)
            return;

        if (this._configureId != 0) {
            Mainloop.source_remove(this._configureId);
            this._configureId = 0;
        }

        this._configureId = Mainloop.timeout_add(CONFIGURE_TIMEOUT,
            Lang.bind(this, function() {
                this._saveGeometry();
                return false;
            }));
    },

    _onDelete: function(widget, event) {
        if (this._configureId != 0) {
            Mainloop.source_remove(this._configureId);
            this._configureId = 0;
        }

        this._saveGeometry();
    },

    _onSelectionModeChanged: function() {
        let enabled = this._selectionModeAction.state.get_boolean();
        this._selectionRevealer.reveal_child = enabled;
        this._showUserListButton.visible = !enabled;
        this._userListAction.enabled = !enabled;

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
        let chatView = new ChatView.ChatView(room);
        this._rooms[room.id] = chatView;

        this._chatStack.add_named(chatView.widget, room.id);
    },

    _roomRemoved: function(roomManager, room) {
        this._rooms[room.id].widget.destroy();
        delete this._rooms[room.id];
    },

    _activeRoomChanged: function(manager, room) {
        if (this._room) {
            this._room.disconnect(this._displayNameChangedId);
            this._room.disconnect(this._topicChangedId);
            this._room.disconnect(this._membersChangedId);
            this._room.channel.connection.disconnect(this._nicknameChangedId);
        }
        this._displayNameChangedId = 0;
        this._topicChangedId = 0;
        this._nicknameChangedId = 0;

        this._room = room;
        this._revealer.reveal_child = room != null;

        this._updateTitlebar();
        this._updateNick();
        this._updateSensitivity();
        this._updateCompletions();

        if (!this._room)
            return; // finished

        this._displayNameChangedId =
            this._room.connect('notify::display-name',
                               Lang.bind(this, this._updateTitlebar));
        this._topicChangedId =
            this._room.connect('notify::topic',
                               Lang.bind(this, this._updateTitlebar));
        this._membersChangedId =
            this._room.connect('members-changed',
                               Lang.bind(this, this._updateCompletions));
        this._nicknameChangedId =
            this._room.channel.connection.connect('notify::self-contact',
                                                  Lang.bind(this,
                                                            this._updateNick));

        this._chatStack.set_visible_child_name(this._room.id);
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
        let dialog = new JoinDialog.JoinDialog();
        dialog.widget.transient_for = this.window;
        dialog.widget.show();
        dialog.widget.connect('response',
            function(widget) {
                widget.destroy();
            });
    },

    showMessageUserDialog: function() {
        let dialog = new MessageDialog.MessageDialog();
        dialog.widget.transient_for = this.window;
        dialog.widget.show();
        dialog.widget.connect('response',
            function(widget) {
                widget.destroy();
            });
    },

    _updateCompletions: function() {
        let nicks = [];

        if (this._room &&
            this._room.channel.has_interface(Tp.IFACE_CHANNEL_INTERFACE_GROUP)) {
            let members = this._room.channel.group_dup_members_contacts();
            nicks = members.map(function(member) { return member.alias; });
        }
        this._completion.setCompletions(nicks);
    },

    _updateTitlebar: function() {
        let subtitle = '';
        if (this._room && this._room.topic) {
            let urls = Utils.findUrls(this._room.topic);
            let pos = 0;
            for (let i = 0; i < urls.length; i++) {
                let url = urls[i];
                let text = this._room.topic.substr(pos, url.pos - pos);
                let urlText = GLib.markup_escape_text(url.url, -1);
                subtitle += GLib.markup_escape_text(text, -1) +
                            '<a href="%s">%s</a>'.format(urlText, urlText);
                pos = url.pos + url.url.length;
            }
            subtitle += GLib.markup_escape_text(this._room.topic.substr(pos), -1);
        }
        this._subtitleLabel.label = subtitle;
        this._subtitleLabel.visible = subtitle.length > 0;

        this._titleLabel.label = this._room ? this._room.display_name : null;
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
