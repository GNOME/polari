const Gdk = imports.gi.Gdk;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Gtk = imports.gi.Gtk;
const Tp = imports.gi.TelepathyGLib;

const AccountsMonitor = imports.accountsMonitor;
const AppNotifications = imports.appNotifications;
const ChatroomManager = imports.chatroomManager;
const JoinDialog = imports.joinDialog;
const Lang = imports.lang;
const Mainloop = imports.mainloop;
const MessageDialog = imports.messageDialog;
const RoomList = imports.roomList;
const RoomStack = imports.roomStack;
const UserList = imports.userList;
const Utils = imports.utils;

const CONFIGURE_TIMEOUT = 100; /* ms */


const MainWindow = new Lang.Class({
    Name: 'MainWindow',

    _init: function(app) {
        this._rooms = {};
        this._entries = {};

        this._room = null;
        this._settings = new Gio.Settings({ schema_id: 'org.gnome.polari' });
        this._gtkSettings = Gtk.Settings.get_default();

        this._displayNameChangedId = 0;
        this._topicChangedId = 0;
        this._membersChangedId = 0;
        this._configureId = 0;

        this._createWidget(app);

        let provider = new Gtk.CssProvider();
        let uri = 'resource:///org/gnome/Polari/application.css';
        let file = Gio.File.new_for_uri(uri);
        try {
            provider.load_from_file(Gio.File.new_for_uri(uri));
        } catch(e) {
            logError(e, "Failed to add application style");
        }
        Gtk.StyleContext.add_provider_for_screen(
            this.window.get_screen(),
            provider,
            Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
        );

        this._accountsMonitor = AccountsMonitor.getDefault();
        this._accountsMonitor.connect('account-status-changed',
                                      Lang.bind(this, this._onAccountChanged));
        this._accountsMonitor.connect('account-added',
                                      Lang.bind(this, this._onAccountChanged));

        this._roomManager = ChatroomManager.getDefault();
        this._roomManager.connect('active-changed',
                                  Lang.bind(this, this._activeRoomChanged));
        this._roomManager.connect('active-state-changed',
                                  Lang.bind(this, this._updateUserListLabel));

        this._updateUserListLabel();

        this._userListAction = app.lookup_action('user-list');

        app.connect('action-state-changed::user-list', Lang.bind(this,
            function(group, actionName, value) {
                this._userListPopover.widget.visible = value.get_boolean();
            }));
        this._userListPopover.widget.connect('notify::visible', Lang.bind(this,
            function() {
                if (!this._userListPopover.widget.visible)
                    this._userListAction.change_state(GLib.Variant.new('b', false));
            }));

        this._selectionModeAction = app.lookup_action('selection-mode');
        this._selectionModeAction.connect('notify::state',
                    Lang.bind(this, this._onSelectionModeChanged));

        this._gtkSettings.connect('notify::gtk-decoration-layout',
                                  Lang.bind(this, this._updateDecorations));
        this._updateDecorations();

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
                this._configureId = 0;
                return GLib.SOURCE_REMOVE;
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
        this._selectionActionBar.visible = enabled;
        this._joinMenuButton.visible = !enabled;
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
        app.mark_busy();

        account._connectingNotification = notification;
        notification.widget.connect('destroy',
            function() {
                app.unmark_busy();
                delete account._connectingNotification;
            });
    },

    _updateDecorations: function() {
        let layoutLeft = null;
        let layoutRight = null;

        let layout = this._gtkSettings.gtk_decoration_layout;
        if (layout) {
            let split = layout.split(':');

            layoutLeft = split[0] + ':';
            layoutRight = ':' + split[1];
        }

        this._titlebarLeft.set_decoration_layout(layoutLeft);
        this._titlebarRight.set_decoration_layout(layoutRight);
    },

    _activeRoomChanged: function(manager, room) {
        if (this._room) {
            this._room.disconnect(this._displayNameChangedId);
            this._room.disconnect(this._topicChangedId);
            this._room.disconnect(this._membersChangedId);
        }
        this._displayNameChangedId = 0;
        this._topicChangedId = 0;
        this._membersChangedId = 0;

        this._room = room;
        this._revealer.reveal_child = room != null;

        this._updateTitlebar();

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
                               Lang.bind(this, this._updateUserListLabel));
    },

    _createWidget: function(app) {
        let builder = new Gtk.Builder();
        builder.add_from_resource('/org/gnome/Polari/main-window.ui');

        this.window = builder.get_object('main_window');
        this.window.application = app;

        let overlay = builder.get_object('overlay');
        let sizeGroup = builder.get_object('bottom_size_group');
        this._roomStack = new RoomStack.RoomStack(sizeGroup);
        overlay.add(this._roomStack.widget);

        overlay.add_overlay(app.notificationQueue.widget);
        overlay.add_overlay(app.commandOutputQueue.widget);

        // command output notifications should not pop up over
        // the input area, but appear to emerge from it, so
        // set up an appropriate margin - this relies on the
        // last widget added to the size group at this point
        // is the room stack's placeholder entry, which will
        // never be destroyed
        sizeGroup.get_widgets()[0].connect('size-allocate',
            function(w, rect) {
                app.commandOutputQueue.widget.margin_bottom = rect.height - 1;
            });

        this._titlebarRight = builder.get_object('titlebar_right');
        this._titlebarLeft = builder.get_object('titlebar_left');

        this._titleLabel = builder.get_object('title_label');
        this._subtitleLabel = builder.get_object('subtitle_label');

        this._selectionActionBar = builder.get_object('selection_action_bar');

        // slightly hackish:
        // add the content of the internal revealer to size group
        sizeGroup.add_widget(this._selectionActionBar.get_child().get_child());

        this._joinMenuButton = builder.get_object('join_menu_button');
        this._showUserListButton = builder.get_object('show_user_list_button');
        this._revealer = builder.get_object('room_list_revealer');

        let scroll = builder.get_object('room_list_scrollview');
        this._roomList = new RoomList.RoomList();
        scroll.add(this._roomList.widget);

        this._userListPopover = new UserList.UserListPopover();
        this._userListPopover.widget.relative_to = this._showUserListButton;
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

    _updateUserListLabel: function() {
        let numMembers = 0;

        if (this._room &&
            this._room.channel &&
            this._room.channel.has_interface(Tp.IFACE_CHANNEL_INTERFACE_GROUP))
            numMembers = this._room.channel.group_dup_members_contacts().length;

        this._showUserListButton.label = '%d'.format(numMembers);
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
    }
});
