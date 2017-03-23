const Gdk = imports.gi.Gdk;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;
const Mainloop = imports.mainloop;
const Polari = imports.gi.Polari;
const Tp = imports.gi.TelepathyGLib;

const {AccountsMonitor} = imports.accountsMonitor;
const {JoinDialog} = imports.joinDialog;
const RoomList = imports.roomList; // used in template
const {RoomManager} = imports.roomManager;
const RoomStack = imports.roomStack; // used in template
const UserList = imports.userList; // used in template
const Utils = imports.utils;


var FixedSizeFrame = GObject.registerClass({
    Properties: {
        height: GObject.ParamSpec.int('height',
                                      'height',
                                      'height',
                                      GObject.ParamFlags.READWRITE,
                                      -1, GLib.MAXINT32, -1),
        width: GObject.ParamSpec.int('width',
                                     'width',
                                     'width',
                                     GObject.ParamFlags.READWRITE,
                                     -1, GLib.MAXINT32, -1)
    },
}, class FixedSizeFrame extends Gtk.Frame {
    _init(params) {
        this._height = -1;
        this._width = -1;

        super._init(params);
    }

    _queueRedraw() {
        let child = this.get_child();
        if (child)
            child.queue_resize();
        this.queue_draw();
    }

    get height() {
        return this._height;
    }

    set height(height) {
        if (height == this._height)
            return;
        this._height = height;
        this.notify('height');
        this.set_size_request(this._width, this._height);
        this._queueRedraw();
    }

    get width() {
        return this._width;
    }

    set width(width) {
        if (width == this._width)
            return;

        this._width = width;
        this.notify('width');
        this.set_size_request(this._width, this._height);
        this._queueRedraw();
    }

    vfunc_get_preferred_width_for_height(forHeight) {
        let [min, nat] = super.vfunc_get_preferred_width_for_height(forHeight);
        return [min, this._width < 0 ? nat : this._width];
    }

    vfunc_get_preferred_height_for_width(forWidth) {
        let [min, nat] = super.vfunc_get_preferred_height_for_width(forWidth);
        return [min, this._height < 0 ? nat : this._height];
    }
});

var MainWindow = GObject.registerClass({
    Template: 'resource:///org/gnome/Polari/ui/main-window.ui',
    InternalChildren: ['titlebarRight',
                       'titlebarLeft',
                       'joinButton',
                       'showUserListButton',
                       'userListPopover',
                       'roomListRevealer',
                       'overlay',
                       'roomStack',
                       'closeConfirmationDialog'],
    Properties: {
        subtitle: GObject.ParamSpec.string('subtitle',
                                           'subtitle',
                                           'subtitle',
                                           GObject.ParamFlags.READABLE,
                                           ''),
        'subtitle-visible': GObject.ParamSpec.boolean('subtitle-visible',
                                                      'subtitle-visible',
                                                      'subtitle-visible',
                                                      GObject.ParamFlags.READABLE,
                                                      false),
        'active-room': GObject.ParamSpec.object('active-room',
                                                'active-room',
                                                'active-room',
                                                GObject.ParamFlags.READWRITE,
                                                Polari.Room.$gtype)
    },
    Signals: { 'active-room-state-changed': {} },
}, class MainWindow extends Gtk.ApplicationWindow {
    _init(params) {
        this._subtitle = '';
        params.show_menubar = false;

        this._room = null;
        this._lastActiveRoom = null;

        this._displayNameChangedId = 0;
        this._topicChangedId = 0;
        this._membersChangedId = 0;
        this._channelChangedId = 0;

        super._init(params);

        this._settings = new Gio.Settings({ schema_id: 'org.gnome.Polari' });
        this._gtkSettings = Gtk.Settings.get_default();

        this._currentSize = [-1, -1];
        this._isMaximized = false;
        this._isFullscreen = false;

        let app = this.application;
        this._overlay.add_overlay(app.notificationQueue);
        this._overlay.add_overlay(app.commandOutputQueue);

        if (app.isTestInstance)
            this.get_style_context().add_class('test-instance');

        // command output notifications should not pop up over
        // the input area, but appear to emerge from it, so
        // set up an appropriate margin
        this._roomStack.bind_property('entry-area-height',
                                      app.commandOutputQueue, 'margin-bottom',
                                      GObject.BindingFlags.SYNC_CREATE);

        // Make sure user-list button is at least as wide as icon buttons
        this._joinButton.connect('size-allocate', (w, rect) => {
            let width = rect.width;
            Mainloop.idle_add(() => {
                this._showUserListButton.width_request = width;
                return GLib.SOURCE_REMOVE;
            });
        });

        this._accountsMonitor = AccountsMonitor.getDefault();
        this._accountsMonitor.connect('accounts-changed',
                                      this._onAccountsChanged.bind(this));
        this._onAccountsChanged(this._accountsMonitor);

        this._roomManager = RoomManager.getDefault();
        this._roomManager.connect('rooms-loaded',
                                  this._onRoomsLoaded.bind(this));
        this._roomManager.connect('room-removed',
                                  this._onRoomRemoved.bind(this));
        this._onRoomsLoaded();

        this._updateUserListLabel();

        this._userListAction = app.lookup_action('user-list');

        app.connect('action-state-changed::user-list', (group, name, value) => {
            this._userListPopover.visible = value.get_boolean();
        });
        this._userListPopover.connect('notify::visible', () => {
            if (!this._userListPopover.visible)
                this._userListAction.change_state(GLib.Variant.new('b', false));
        });

        this._gtkSettings.connect('notify::gtk-decoration-layout',
                                  this._updateDecorations.bind(this));
        this._updateDecorations();

        this._closeConfirmationDialog.transient_for = this;
        this._closeConfirmationDialog.connect('response', (w, r) => {
            if (r == Gtk.ResponseType.DELETE_EVENT)
                return;

            this._settings.set_boolean('run-in-background', r == Gtk.ResponseType.ACCEPT);
            this.destroy();
        });

        this.connect('window-state-event', this._onWindowStateEvent.bind(this));
        this.connect('size-allocate', this._onSizeAllocate.bind(this));
        this.connect('destroy', this._onDestroy.bind(this));
        this.connect('delete-event', this._onDeleteEvent.bind(this));
        this.connect('notify::active-room', () => {
            this._updateUserListLabel();
        });

        let size = this._settings.get_value('window-size').deep_unpack();
        if (size.length == 2)
            this.set_default_size.apply(this, size);

        if (this._settings.get_boolean('window-maximized'))
            this.maximize();
    }

    get subtitle() {
        return this._subtitle;
    }

    get subtitle_visible() {
        return this._subtitle.length > 0;
    }

    _onWindowStateEvent(widget, event) {
        let state = event.get_window().get_state();

        this._isFullscreen = (state & Gdk.WindowState.FULLSCREEN) != 0;
        this._isMaximized = (state & Gdk.WindowState.MAXIMIZED) != 0;
    }

    _onSizeAllocate(widget, allocation) {
        if (!this._isFullscreen && !this._isMaximized)
            this._currentSize = this.get_size();
    }

    _onDestroy(widget) {
        this._settings.set_boolean ('window-maximized', this._isMaximized);
        this._settings.set_value('window-size',
                                 GLib.Variant.new('ai', this._currentSize));

        let serializedChannel = null;
        if (this._lastActiveRoom)
            serializedChannel = new GLib.Variant('a{sv}', {
                account: new GLib.Variant('s', this._lastActiveRoom.account.object_path),
                channel: new GLib.Variant('s', this._lastActiveRoom.channel_name)
            });

        if (serializedChannel)
            this._settings.set_value('last-selected-channel', serializedChannel);
        else
            this._settings.reset('last-selected-channel');

        this.active_room = null;
    }

    _touchFile(file) {
        try {
            file.get_parent().make_directory_with_parents(null);
        } catch(e if e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS)) {
            // not an error, carry on
        }

        let stream = file.create(0, null);
        stream.close(null);
    }

    _onDeleteEvent() {
        let f = Gio.File.new_for_path(GLib.get_user_cache_dir() +
                                      '/polari/close-confirmation-shown');
        try {
            this._touchFile(f);
        } catch(e) {
            if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
                return Gdk.EVENT_PROPAGATE; // the dialog has been shown
            log('Failed to mark confirmation dialog as shown: ' + e.message);
        }

        this._closeConfirmationDialog.show();
        return Gdk.EVENT_STOP;
    }

    _onAccountsChanged(am) {
        let hasAccounts = this._accountsMonitor.visibleAccounts.length > 0;
        this._roomListRevealer.reveal_child = hasAccounts;
    }

    _updateDecorations() {
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
    }

    get active_room() {
        return this._room;
    }

    set active_room(room) {
        if (room == this._room)
            return;

        if (this._room) {
            this._room.disconnect(this._displayNameChangedId);
            this._room.disconnect(this._topicChangedId);
            this._room.disconnect(this._membersChangedId);
            this._room.disconnect(this._channelChangedId);
        }
        this._displayNameChangedId = 0;
        this._topicChangedId = 0;
        this._membersChangedId = 0;
        this._channelChangedId = 0;

        if (room && room.type == Tp.HandleType.ROOM)
            this._lastActiveRoom = room;
        this._room = room;

        this._updateTitlebar();

        this.notify('active-room');
        this.emit('active-room-state-changed');

        if (!this._room)
            return; // finished

        this._displayNameChangedId =
            this._room.connect('notify::display-name',
                               this._updateTitlebar.bind(this));
        this._topicChangedId =
            this._room.connect('notify::topic',
                               this._updateTitlebar.bind(this));
        this._membersChangedId =
            this._room.connect('members-changed',
                               this._updateUserListLabel.bind(this));
        this._channelChangedId =
            this._room.connect('notify::channel', () => {
                this._updateUserListLabel();
                this.emit('active-room-state-changed');
            });
    }

    _onRoomsLoaded(mgr) {
        if (this.active_room)
            return;

        let selectedRoom = this._settings.get_value('last-selected-channel').deep_unpack();
        for (let prop in selectedRoom)
            selectedRoom[prop] = selectedRoom[prop].deep_unpack();

        let roomId = null;
        let account = this._accountsMonitor.lookupAccount(selectedRoom.account);
        let channelName = selectedRoom.channel;
        if (account && account.visible && channelName)
            roomId = Polari.create_room_id(account, channelName, Tp.HandleType.ROOM);

        this.active_room = this._roomManager.lookupRoom(roomId) ||
                           this._roomManager.rooms.shift();
    }

    _onRoomRemoved(mgr, room) {
        if (room == this._lastActiveRoom)
            this._lastActiveRoom = null;
    }

    showJoinRoomDialog() {
        let dialog = new JoinDialog({ transient_for: this });
        dialog.show();
    }

    _updateUserListLabel() {
        let numMembers = 0;

        if (this._room &&
            this._room.channel &&
            this._room.channel.has_interface(Tp.IFACE_CHANNEL_INTERFACE_GROUP))
            numMembers = this._room.channel.group_dup_members_contacts().length;

        let accessibleName = ngettext("%d user",
                                      "%d users", numMembers).format(numMembers);
        this._showUserListButton.get_accessible().set_name(accessibleName);
        this._showUserListButton.label = '%d'.format(numMembers);
    }

    _updateTitlebar() {
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

        if (this._subtitle != subtitle) {
            this._subtitle = subtitle;
            this.notify('subtitle');
            this.notify('subtitle-visible');
        }

        this.title = this._room ? this._room.display_name : null;
    }
});
