import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';
import Polari from 'gi://Polari';
import Tp from 'gi://TelepathyGLib';

import AccountsMonitor from './accountsMonitor.js';
import JoinDialog from './joinDialog.js';
import RoomList_ from './roomList.js'; // used in template
import RoomManager from './roomManager.js';
import RoomStack_ from './roomStack.js'; // used in template
import * as UserList_ from './userList.js'; // used in template
import * as Utils from './utils.js';

export default GObject.registerClass(
class MainWindow extends Adw.ApplicationWindow {
    static [Gtk.template] = 'resource:///org/gnome/Polari/ui/main-window.ui';
    static [Gtk.internalChildren] = [
        'joinButton',
        'splitView',
        'showUserListButton',
        'userListPopover',
        'roomListRevealer',
        'offlineInfoBar',
        'overlay',
        'roomStack',
    ];

    static [GObject.properties] = {
        subtitle: GObject.ParamSpec.string(
            'subtitle', 'subtitle', 'subtitle',
            GObject.ParamFlags.READABLE,
            ''),
        'subtitle-visible': GObject.ParamSpec.boolean(
            'subtitle-visible', 'subtitle-visible', 'subtitle-visible',
            GObject.ParamFlags.READABLE,
            false),
        'active-room': GObject.ParamSpec.object(
            'active-room', 'active-room', 'active-room',
            GObject.ParamFlags.READWRITE,
            Polari.Room.$gtype),
        'view-height': GObject.ParamSpec.uint(
            'view-height', 'view-height', 'view-height',
            GObject.ParamFlags.READABLE,
            0, GLib.MAXUINT32, 0),
    };

    static [GObject.signals] = {
        'active-room-state-changed': {},
    };

    _lastActiveRoom = null;

    _settings = new Gio.Settings({ schema_id: 'org.gnome.Polari' });

    _currentSize = [-1, -1];
    _isMaximized = false;
    _isFullscreen = false;

    _displayNameChangedId = 0;
    _topicChangedId = 0;
    _membersChangedId = 0;
    _channelChangedId = 0;

    constructor(params) {
        super(params);

        this._userListPopover.set_parent(this._showUserListButton);

        const app = this.application;
        if (app.isTestInstance)
            this.add_css_class('test-instance');
        if (GLib.get_application_name().toLowerCase().includes('snapshot'))
            this.add_css_class('snapshot');

        this._roomStack.connect('notify::view-height',
            () => this.notify('view-height'));
        this._roomStack.connect('notify::visible-child', () =>
            this._splitView.activate_action('navigation.push', new GLib.Variant('s', 'content')));

        this._accountsMonitor = AccountsMonitor.getDefault();
        this._accountsChangedId = this._accountsMonitor.connect(
            'accounts-changed', this._onAccountsChanged.bind(this));
        this._onAccountsChanged(this._accountsMonitor);

        this._accountReachableId = this._accountsMonitor.connect(
            'account-reachable-changed', this._onAccountsReachableChanged.bind(this));
        this._onAccountsReachableChanged();

        this._roomManager = RoomManager.getDefault();
        this._roomsLoadedId = this._roomManager.connect('rooms-loaded',
            this._onRoomsLoaded.bind(this));
        this._roomRemovedId = this._roomManager.connect('room-removed',
            this._onRoomRemoved.bind(this));
        this._onRoomsLoaded();

        this._updateUserListLabel();

        this._userListAction = app.lookup_action('user-list');

        app.connect('action-state-changed::user-list', (group, name, value) => {
            if (value.get_boolean())
                this._userListPopover.popup();
            else
                this._userListPopover.popdown();
        });
        this._userListPopover.connect('notify::visible', () => {
            if (!this._userListPopover.visible)
                this._userListAction.change_state(GLib.Variant.new('b', false));
        });

        this.connect('notify::maximized',
            () => (this._isMaximized = this.maximized));
        this.connect('notify::fullscreened',
            () => (this._isFullscreen = this.fullscreened));
        this.connect('notify::default-width',
            () => (this._currentSize = this.get_default_size()));
        this.connect('notify::default-height',
            () => (this._currentSize = this.get_default_size()));
        this.connect('destroy', this._onDestroy.bind(this));
        this.connect('notify::active-room', () => {
            this._updateUserListLabel();
        });

        let size = this._settings.get_value('window-size').deep_unpack();
        if (size.length === 2)
            this.set_default_size(...size);

        if (this._settings.get_boolean('window-maximized'))
            this.maximize();
    }

    get subtitle() {
        return this._subtitle ?? '';
    }

    // eslint-disable-next-line camelcase
    get subtitle_visible() {
        return this.subtitle.length > 0;
    }

    // eslint-disable-next-line camelcase
    get view_height() {
        return this._roomStack.view_height;
    }

    /**
     * @param {Adw.Toast} toast - a toast (cheers!)
     */
    addToast(toast) {
        this._overlay.add_toast(toast);
    }

    _onAccountsReachableChanged() {
        let accounts = this._accountsMonitor.visibleAccounts;
        this._offlineInfoBar.revealed =
            accounts.length > 0 && !accounts.some(a => a.reachable);
    }

    _onDestroy() {
        this._settings.set_boolean('window-maximized', this._isMaximized);
        this._settings.set_value('window-size',
            new GLib.Variant('ai', this._currentSize));

        let serializedChannel = null;
        if (this._lastActiveRoom) {
            serializedChannel = new GLib.Variant('a{sv}', {
                account: new GLib.Variant('s', this._lastActiveRoom.account.object_path),
                channel: new GLib.Variant('s', this._lastActiveRoom.channel_name),
            });
        }

        if (serializedChannel)
            this._settings.set_value('last-selected-channel', serializedChannel);
        else
            this._settings.reset('last-selected-channel');

        this.active_room = null;
        this._userListPopover.unparent();

        this._accountsMonitor.disconnect(this._accountsChangedId);
        this._accountsMonitor.disconnect(this._accountReachableId);

        this._roomManager.disconnect(this._roomsLoadedId);
        this._roomManager.disconnect(this._roomRemovedId);
    }

    _onAccountsChanged() {
        let hasAccounts = this._accountsMonitor.visibleAccounts.length > 0;
        this._roomListRevealer.reveal_child = hasAccounts;
    }

    _filterFallbackAppMenu(layoutStr) {
        return layoutStr.split(',').filter(s => s !== 'menu').join(',');
    }

    // eslint-disable-next-line camelcase
    get active_room() {
        return this._room;
    }

    // eslint-disable-next-line camelcase
    set active_room(room) {
        if (room === this._room)
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

        if (room && room.type === Tp.HandleType.ROOM)
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

    _onRoomsLoaded() {
        if (this.active_room)
            return;

        let selectedRoom = this._settings.get_value('last-selected-channel').deep_unpack();
        for (let prop in selectedRoom)
            selectedRoom[prop] = selectedRoom[prop].deep_unpack();

        if (!selectedRoom.account)
            return;

        let roomId = null;
        let account = this._accountsMonitor.lookupAccount(selectedRoom.account);
        let channelName = selectedRoom.channel;
        if (account && account.visible && channelName)
            roomId = Polari.create_room_id(account, channelName, Tp.HandleType.ROOM);

        this.active_room = this._roomManager.lookupRoom(roomId) ||
                           this._roomManager.rooms.shift();
    }

    _onRoomRemoved(mgr, room) {
        if (room === this._lastActiveRoom)
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

        let accessibleName = vprintf(ngettext(
            '%d user',
            '%d users', numMembers), numMembers);
        this._showUserListButton.update_property(
            [Gtk.AccessibleProperty.LABEL], [accessibleName]);
        this._showUserListButton.child.label = `${numMembers}`;
    }

    _updateTitlebar() {
        let subtitle = '';
        if (this._room && this._room.topic) {
            let urls = Utils.findUrls(this._room.topic);
            let pos = 0;
            for (let i = 0; i < urls.length; i++) {
                let url = urls[i];
                let text = GLib.markup_escape_text(
                    this._room.topic.substr(pos, url.pos - pos), -1);
                let urlText = GLib.markup_escape_text(url.url, -1);
                subtitle += `${text} <a href="${urlText}">${urlText}<${'/'}a>`;
                pos = url.pos + url.url.length;
            }
            subtitle += GLib.markup_escape_text(this._room.topic.substr(pos), -1);
        }

        if (this._subtitle !== subtitle) {
            this._subtitle = subtitle;
            this.notify('subtitle');
            this.notify('subtitle-visible');
        }

        this.title = this._room ? this._room.display_name : null;
    }
});
