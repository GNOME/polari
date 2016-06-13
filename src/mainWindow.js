const Gdk = imports.gi.Gdk;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;
const Tp = imports.gi.TelepathyGLib;

const AccountsMonitor = imports.accountsMonitor;
const AppNotifications = imports.appNotifications;
const ChatroomManager = imports.chatroomManager;
const LogManager = imports.logManager;
const JoinDialog = imports.joinDialog;
const Lang = imports.lang;
const Mainloop = imports.mainloop;
const RoomList = imports.roomList;
const RoomStack = imports.roomStack;
const UserList = imports.userList;
const Utils = imports.utils;
const Pango = imports.gi.Pango;

const CONFIGURE_TIMEOUT = 100; /* ms */


const FixedSizeFrame = new Lang.Class({
    Name: 'FixedSizeFrame',
    Extends: Gtk.Frame,
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

    _init: function(params) {
        this._height = -1;
        this._width = -1;

        this.parent(params);
    },

    _queueRedraw: function() {
        let child = this.get_child();
        if (child)
            child.queue_resize();
        this.queue_draw();
    },

    get height() {
        return this._height;
    },

    set height(height) {
        if (height == this._height)
            return;
        this._height = height;
        this.notify('height');
        this.set_size_request(this._width, this._height);
        this._queueRedraw();
    },

    get width() {
        return this._width;
    },

    set width(width) {
        if (width == this._width)
            return;

        this._width = width;
        this.notify('width');
        this.set_size_request(this._width, this._height);
        this._queueRedraw();
    },

    vfunc_get_preferred_width_for_height: function(forHeight) {
        let [min, nat] = this.parent(forHeight);
        return [min, this._width < 0 ? nat : this._width];
    },

    vfunc_get_preferred_height_for_width: function(forWidth) {
        let [min, nat] = this.parent(forWidth);
        return [min, this._height < 0 ? nat : this._height];
    }
});

const MainWindow = new Lang.Class({
    Name: 'MainWindow',
    Extends: Gtk.ApplicationWindow,
    Template: 'resource:///org/gnome/Polari/ui/main-window.ui',
    InternalChildren: ['titlebarRight',
                       'titlebarLeft',
                       'joinButton',
                       'search-active-button',
                        'search-bar',
                        'search-entry',
                       'showUserListButton',
                       'userListPopover',
                       'roomListRevealer',
                       'overlay',
                       'roomStack',
                       'mainStack',
                       'results'],
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
        'search-active': GObject.ParamSpec.boolean(
            'search-active', '', '',
            GObject.ParamFlags.READABLE | GObject.ParamFlags.WRITABLE, false)
    },

    _init: function(params) {
        this._subtitle = '';
        params.show_menubar = false;

        this.parent(params);

        this._addApplicationStyle();

        this._searchActive = false;

        this._room = null;
        this._settings = new Gio.Settings({ schema_id: 'org.gnome.Polari' });
        this._gtkSettings = Gtk.Settings.get_default();

        this._displayNameChangedId = 0;
        this._topicChangedId = 0;
        this._membersChangedId = 0;

        this._currentSize = [-1, -1];
        this._isMaximized = false;
        this._isFullscreen = false;

        let app = this.application;
        this._overlay.add_overlay(app.notificationQueue);
        this._overlay.add_overlay(app.commandOutputQueue);

        // command output notifications should not pop up over
        // the input area, but appear to emerge from it, so
        // set up an appropriate margin
        this._roomStack.bind_property('entry-area-height',
                                      app.commandOutputQueue, 'margin-bottom',
                                      GObject.BindingFlags.SYNC_CREATE);

        // Make sure user-list button is at least as wide as icon buttons
        this._joinButton.connect('size-allocate', Lang.bind(this,
            function(w, rect) {
                let width = rect.width;
                Mainloop.idle_add(Lang.bind(this, function() {
                    this._showUserListButton.width_request = width;
                    return GLib.SOURCE_REMOVE;
                }));
            }));

        this._accountsMonitor = AccountsMonitor.getDefault();
        this._accountsMonitor.connect('accounts-changed', Lang.bind(this,
            function(am) {
                let accounts = am.dupAccounts();
                this._roomListRevealer.reveal_child = accounts.some(function(a) {
                    return a.enabled;
                });
            }));

        this._roomManager = ChatroomManager.getDefault();
        this._roomManager.connect('active-changed',
                                  Lang.bind(this, this._activeRoomChanged));
        this._roomManager.connect('active-state-changed',
                                  Lang.bind(this, this._updateUserListLabel));

        this._updateUserListLabel();

        this._userListAction = app.lookup_action('user-list');

        app.connect('action-state-changed::user-list', Lang.bind(this,
            function(group, actionName, value) {
                this._userListPopover.visible = value.get_boolean();
            }));
        this._userListPopover.connect('notify::visible', Lang.bind(this,
            function() {
                if (!this._userListPopover.visible)
                    this._userListAction.change_state(GLib.Variant.new('b', false));
            }));

        this._gtkSettings.connect('notify::gtk-decoration-layout',
                                  Lang.bind(this, this._updateDecorations));
        this._updateDecorations();

        this.connect('window-state-event',
                            Lang.bind(this, this._onWindowStateEvent));
        this.connect('size-allocate',
                            Lang.bind(this, this._onSizeAllocate));
        this.connect('delete-event',
                            Lang.bind(this, this._onDelete));
        // this.connect('key-press-event', Lang.bind(this, this._handleKeyPress));

        // search start
        this._keywords = [];
        this._cancellable  = new Gio.Cancellable();
        this._widgetMap = {};
        Utils.initActions(this,
                         [
                          { name: 'search-active',
                            activate: this._toggleSearch,
                            parameter_type: new GLib.VariantType('b'),
                            state: new GLib.Variant('b', false) }
                         ]);
        this.bind_property('search-active', this._search_active_button, 'active',
                           GObject.BindingFlags.SYNC_CREATE |
                           GObject.BindingFlags.BIDIRECTIONAL);
        this.bind_property('search-active',
                           this._search_bar,
                           'search-mode-enabled',
                           GObject.BindingFlags.SYNC_CREATE |
                           GObject.BindingFlags.BIDIRECTIONAL);
        this._search_bar.connect_entry(this._search_entry);
        this._search_entry.connect('search-changed',
                                   Lang.bind(this, this._handleSearchChanged));

        this._search_active_button.connect(
            'toggled',
            Lang.bind(this, function() {
                if (this._mainStack.visible_child_name == 'image')
                    this._mainStack.visible_child_name = 'roomList';
                else
                    this._mainStack.visible_child_name = 'image';
            }));

        //test
        this._logManager = LogManager.getDefault();
        let query = "select ?text as ?mms where { ?msg a nmo:IMMessage; nie:plainTextContent ?text. ?msg nmo:communicationChannel ?channel. ?channel nie:title '#tracker'. ?msg nmo:from ?contact. ?contact nco:nickname 'bijan' . ?msg fts:match 'wonderful' }"
        let query1 = "select ?msg as ?id ?nick as ?name ?text as ?mms where { ?msg a nmo:IMMessage; nie:plainTextContent ?text. ?msg nmo:communicationChannel ?channel. ?channel nie:title '#tracker'. ?msg nmo:from ?contact. ?contact nco:nickname ?nick }"
        //this._logManager.query(query1,null,Lang.bind(this, this._Log));
        log("hello");
        //test
        // search end

        let size = this._settings.get_value('window-size').deep_unpack();
        if (size.length == 2)
            this.set_default_size.apply(this, size);

        if (this._settings.get_boolean('window-maximized'))
            this.maximize();

        this._mainStack.visible_child_name = 'roomList';

        this.show_all();
    },

    _Log: function(events) {
        log(events);
        let widgetMap = {};
        let markup_message = '';
        for (let i = 0; i < events.length; i++) {
            let message = events[i].mms;
            let uid = events[i].id;
            let index = message.indexOf(this._keywords[0]);
            let row = this._widgetMap[uid];
            for (let j = 0; j < this._keywords.length; j++) {
                // log(this._keywords[j]);
                index = Math.min(index, message.indexOf(this._keywords[j]));
                message = message.replace( new RegExp( "(" + this._keywords[j] + ")" , 'gi' ),"<span font_weight='bold'>$1</span>");
                // print(message);
            }

            if (row) {
                log("REUSING!!!");
                widgetMap[uid] = row;
                this._results.remove(row);
            } else {
                let row = new Gtk.ListBoxRow({visible: true});
                let label = new Gtk.Label({ label: message,
                                            halign: Gtk.Align.START,
                                            margin_start: 6,
                                            margin_end: 6,
                                            visible: true,
                                            ellipsize: Pango.EllipsizeMode.END,
                                            max_width_chars: 18,
                                            use_markup: true });
                row.add(label);
                row.uid = events[i].id;
                widgetMap[uid] = row;
            }
            widgetMap[uid].get_children()[0].label = "..." + message.substring(index - 6);
        }

        this._widgetMap = widgetMap;

        this._results.foreach(r => { r.destroy(); })

        for (let i = 0; i < events.length; i++) {
            let row = this._widgetMap[events[i].id];
            // row.get_children()[0].label = markup_message;
            this._results.add(row);
        }
    },

    _Log1: function() {
        this._results.foreach(r => { r.destroy(); })
    },

    get subtitle() {
        return this._subtitle;
    },

    get subtitle_visible() {
        return this._subtitle.length > 0;
    },

    _handleSearchChanged: function(entry) {
        this._cancellable.cancel();
        this._cancellable.reset();
        let text = entry.get_text().replace(/^\s+|\s+$/g, '');
        this._keywords = text == '' ? [] : text.split(/\s+/);
        log(text);
        let query1 = ("select ?text as ?mms ?msg as ?id where { ?msg a nmo:IMMessage . ?msg nie:plainTextContent ?text . ?msg fts:match '%s*' }").format(text);
        log(query1);
        this._logManager.query(query1,this._cancellable,Lang.bind(this, this._Log));
    },

    _onWindowStateEvent: function(widget, event) {
        let state = event.get_window().get_state();

        this._isFullscreen = (state & Gdk.WindowState.FULLSCREEN) != 0;
        this._isMaximized = (state & Gdk.WindowState.MAXIMIZED) != 0;
    },

    _handleKeyPress: function(self, event) {
        return this._search_bar.handle_event(event);
    },

    _onSizeAllocate: function(widget, allocation) {
        if (!this._isFullscreen && !this._isMaximized)
            this._currentSize = this.get_size(this);
    },

    _onDelete: function(widget, event) {
        this._settings.set_boolean ('window-maximized', this._isMaximized);
        this._settings.set_value('window-size',
                                 GLib.Variant.new('ai', this._currentSize));
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

    _addApplicationStyle: function() {
        let provider = new Gtk.CssProvider();
        let uri = 'resource:///org/gnome/Polari/css/application.css';
        let file = Gio.File.new_for_uri(uri);
        try {
            provider.load_from_file(Gio.File.new_for_uri(uri));
        } catch(e) {
            logError(e, "Failed to add application style");
        }
        Gtk.StyleContext.add_provider_for_screen(
            this.get_screen(),
            provider,
            Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
        );
    },

    showJoinRoomDialog: function() {
        let dialog = new JoinDialog.JoinDialog({ transient_for: this });
        dialog.show();
    },

    _updateUserListLabel: function() {
        let numMembers = 0;

        if (this._room &&
            this._room.channel &&
            this._room.channel.has_interface(Tp.IFACE_CHANNEL_INTERFACE_GROUP))
            numMembers = this._room.channel.group_dup_members_contacts().length;

        let accessibleName = ngettext("%d user",
                                      "%d users", numMembers).format(numMembers);
        this._showUserListButton.get_accessible().set_name(accessibleName);
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

        if (this._subtitle != subtitle) {
            this._subtitle = subtitle;
            this.notify('subtitle');
            this.notify('subtitle-visible');
        }

        this.title = this._room ? this._room.display_name : null;
    }
});
