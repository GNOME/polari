imports.gi.versions.Gio = '2.0';
imports.gi.versions.GLib = '2.0';
imports.gi.versions.Gtk = '3.0';
imports.gi.versions.TelepathyGLib = '0.12';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Gtk = imports.gi.Gtk;
const Polari = imports.gi.Polari;
const Tp = imports.gi.TelepathyGLib;

const AccountsMonitor = imports.accountsMonitor;
const AppNotifications = imports.appNotifications;
const ChatroomManager = imports.chatroomManager;
const Connections = imports.connections;
const Lang = imports.lang;
const MainWindow = imports.mainWindow;
const PasteManager = imports.pasteManager;
const Utils = imports.utils;


const MAX_RETRIES = 3;

const ConnectionError = {
    CANCELLED: Tp.error_get_dbus_name(Tp.Error.CANCELLED),
    ALREADY_CONNECTED: Tp.error_get_dbus_name(Tp.Error.ALREADY_CONNECTED)
};

const Application = new Lang.Class({
    Name: 'Application',
    Extends: Gtk.Application,

    _init: function() {
        this.parent({ application_id: 'org.gnome.Polari' });

        GLib.set_prgname('org.gnome.Polari');
        GLib.set_application_name('Polari');
        this._window = null;
        this._pendingRequests = {};
    },

    vfunc_startup: function() {
        let resource = Gio.Resource.load(pkg.pkgdatadir + '/polari.gresource');
        resource._register();

        this.parent();

        let w = new Polari.FixedSizeFrame(); // register gtype
        w.destroy();

        this._chatroomManager = ChatroomManager.getDefault();
        this._accountsMonitor = AccountsMonitor.getDefault();

        this._accountsMonitor.connect('account-removed', Lang.bind(this,
            function(am, account) {
                this._removeSavedChannelsForAccount(account);
            }));

        this._settings = new Gio.Settings({ schema_id: 'org.gnome.Polari' });

        this.pasteManager = new PasteManager.PasteManager();
        this.notificationQueue = new AppNotifications.NotificationQueue();
        this.commandOutputQueue = new AppNotifications.CommandOutputQueue();

        let actionEntries = [
          { name: 'room-menu',
            activate: Lang.bind(this, this._onToggleAction),
            state: GLib.Variant.new('b', false) },
          { name: 'show-join-dialog',
            activate: Lang.bind(this, this._onShowJoinDialog),
            accels: ['<Primary>n'] },
          { name: 'show-message-user-dialog',
            activate: Lang.bind(this, this._onShowMessageUserDialog),
            create_hook: Lang.bind(this, this._accountActionsCreateHook),
            accels: ['<Primary>m'] },
          { name: 'join-room',
            activate: Lang.bind(this, this._onJoinRoom),
            parameter_type: GLib.VariantType.new('(ssu)') },
          { name: 'message-user',
            activate: Lang.bind(this, this._onMessageUser),
            parameter_type: GLib.VariantType.new('(ssu)') },
          { name: 'leave-room',
            activate: Lang.bind(this, this._onLeaveRoom),
            parameter_type: GLib.VariantType.new('(ss)') },
          { name: 'leave-current-room',
            activate: Lang.bind(this, this._onLeaveCurrentRoom),
            create_hook: Lang.bind(this, this._leaveRoomCreateHook),
            accels: ['<Primary>w'] },
          { name: 'leave-selected-rooms' },
          { name: 'user-list',
            activate: Lang.bind(this, this._onToggleAction),
            create_hook: Lang.bind(this, this._userListCreateHook),
            state: GLib.Variant.new('b', false),
            accels: ['F9', '<Primary>u'] },
          { name: 'selection-mode',
            activate: Lang.bind(this, this._onToggleAction),
            create_hook: Lang.bind(this, this._selectionModeHook),
            state: GLib.Variant.new('b', false) },
          { name: 'connections',
            activate: Lang.bind(this, this._onListConnections) },
          { name: 'preferences',
            activate: Lang.bind(this, this._onShowPreferences) },
          { name: 'about',
            activate: Lang.bind(this, this._onShowAbout) },
          { name: 'quit',
            activate: Lang.bind(this, this._onQuit),
            accels: ['<Primary>q'] },
          { name: 'next-room',
            accels: ['<Primary>Page_Down', '<Alt>Down'] },
          { name: 'previous-room',
            accels: ['<Primary>Page_Up', '<Alt>Up'] },
          { name: 'first-room',
            accels: ['<Primary>Home'] },
          { name: 'last-room',
            accels: ['<Primary>End'] },
          { name: 'nth-room',
            parameter_type: GLib.VariantType.new('i') }
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
                if (actionEntry.accels)
                    this.set_accels_for_action('app.' + actionEntry.name,
                                               actionEntry.accels);
                this.add_action(action);
        }));

        for (let i = 1; i < 10; i++)
            this.set_accels_for_action('app.nth-room(%d)'.format(i), ['<Alt>' + i]);
    },

    vfunc_activate: function() {
        if (!this._window) {
            this._window = new MainWindow.MainWindow(this);
            this._window.window.connect('destroy', Lang.bind(this,
                function() {
                    for (let id in this._pendingRequests)
                        this._pendingRequests[id].cancellable.cancel();
                    this.emitJS('prepare-shutdown');
            }));
            this._window.window.show_all();
        }
        this._window.window.present();
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

    _leaveRoomCreateHook: function(action) {
        this._chatroomManager.connect('active-changed', Lang.bind(this,
            function() {
                action.enabled = this._chatroomManager.getActiveRoom() != null;
            }));
        action.enabled = this._chatroomManager.getActiveRoom() != null;
    },

    _updateUserListAction: function(action) {
        let room = this._chatroomManager.getActiveRoom();
        action.enabled = room && room.type == Tp.HandleType.ROOM && room.channel;
    },

    _userListCreateHook: function(action) {
        this._chatroomManager.connect('active-state-changed', Lang.bind(this,
            function() {
                this._updateUserListAction(action);
            }));
        action.connect('notify::enabled', function() {
            if (!action.enabled)
                action.change_state(GLib.Variant.new('b', false));
        });
        this._updateUserListAction(action);
    },

    _updateSelectionModeAction: function(action) {
        action.enabled = this._chatroomManager.getActiveRoom() != null;
    },

    _selectionModeHook: function(action) {
        this._chatroomManager.connect('active-changed', Lang.bind(this,
            function() {
                this._updateSelectionModeAction(action);
            }));
        action.connect('notify::enabled', function() {
            if (!action.enabled)
                action.change_state(GLib.Variant.new('b', false));
        });
        this._updateSelectionModeAction(action);
    },

    _onShowJoinDialog: function() {
        this._window.showJoinRoomDialog();
    },

    _onShowMessageUserDialog: function() {
        this._window.showMessageUserDialog();
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

    _removeSavedChannelsForAccount: function(account) {
        let savedChannels = this._settings.get_value('saved-channel-list').deep_unpack();
        let accountPath = GLib.Variant.new('s', account.get_object_path());

        let savedChannels = savedChannels.filter(function(a) {
            return !a.account.equal(accountPath);
        });
        this._settings.set_value('saved-channel-list',
                                 GLib.Variant.new('aa{sv}', savedChannels));
    },

    _updateAccountName: function(account, name, callback) {
        let sv = { account: GLib.Variant.new('s', name) };
        let asv = GLib.Variant.new('a{sv}', sv);
        account.update_parameters_vardict_async(asv, [], callback);
    },

    _requestChannel: function(accountPath, targetType, targetId, time) {
        // have this in AccountMonitor?
        let factory = Tp.AccountManager.dup().get_factory();
        let account = factory.ensure_account(accountPath, []);

        if (!account.enabled) {
            // if we are requesting a channel for a disabled account, we
            // are restoring saved channels; if the account has also never
            // been online, it was removed since the channel was saved
            if (!account.has_been_online)
                this._removeSavedChannelsForAccount(account);
            return;
        }

        let roomId = Polari.create_room_id(account,  targetId, targetType);

        let requestData = {
          account: account,
          targetHandleType: targetType,
          targetId: targetId,
          roomId: roomId,
          cancellable: new Gio.Cancellable(),
          time: time,
          retry: 0,
          originalNick: account.nickname };

        this._pendingRequests[roomId] = requestData;

        this._ensureChannel(requestData);
    },

    _ensureChannel: function(requestData) {
        let account = requestData.account;

        let req = Tp.AccountChannelRequest.new_text(account, requestData.time);
        req.set_target_id(requestData.targetHandleType, requestData.targetId);
        req.set_delegate_to_preferred_handler(true);
        let preferredHandler = Tp.CLIENT_BUS_NAME_BASE + 'Polari';
        req.ensure_channel_async(preferredHandler, requestData.cancellable,
                                 Lang.bind(this,
                                           this._onEnsureChannel, requestData));
    },

    _retryRequest: function(requestData) {
        let account = requestData.account;

        // Try again with a different nick
        let params = account.dup_parameters_vardict().deep_unpack();
        let oldNick = params['account'].deep_unpack();
        let nick = oldNick + '_';
        this._updateAccountName(account, nick, Lang.bind(this,
            function() {
                this._ensureChannel(requestData);
            }));
    },

    _onEnsureChannel: function(req, res, requestData) {
        let account = req.account;

        try {
            req.ensure_channel_finish(res);

            if (requestData.targetHandleType == Tp.HandleType.ROOM)
                this._addSavedChannel(account, requestData.targetId);
        } catch (e if e.matches(Tp.Error, Tp.Error.DISCONNECTED)) {
            let error = account.connection_error;
            if (error == ConnectionError.ALREADY_CONNECTED &&
                requestData.retry++ < MAX_RETRIES) {
                    this._retryRequest(requestData);
                    return;
            }

            if (error && error != ConnectionError.CANCELLED)
                logError(e);
        } catch (e if e.matches(Tp.Error, Tp.Error.CANCELLED)) {
            // interrupted by user request, don't log
        } catch (e) {
            logError(e, 'Failed to ensure channel');
        }

        if (requestData.retry > 0)
            this._updateAccountName(account, requestData.originalNick, null);
        delete this._pendingRequests[requestData.roomId];
    },

    _onJoinRoom: function(action, parameter) {
        let [accountPath, channelName, time] = parameter.deep_unpack();
        this._requestChannel(accountPath, Tp.HandleType.ROOM,
                             channelName, time);
    },

    _onMessageUser: function(action, parameter) {
        let [accountPath, contactName, time] = parameter.deep_unpack();
        this._requestChannel(accountPath, Tp.HandleType.CONTACT,
                             contactName, time);
    },

    _onLeaveRoom: function(action, parameter) {
        let [roomId, message] = parameter.deep_unpack();
        let reason = Tp.ChannelGroupChangeReason.NONE;
        let room = this._chatroomManager.getRoomById(roomId);
        if (!room)
            return;
        if (this._pendingRequests[roomId]) {
            this._pendingRequests[roomId].cancellable.cancel();
        } else if (room.channel) {
            if (!message.length)
                message = _("Good Bye"); // TODO - our first setting?
            room.channel.leave_async(reason, message, Lang.bind(this,
                function(c, res) {
                    try {
                        c.leave_finish(res);
                    } catch(e) {
                        logError(e, 'Failed to leave channel');
                    }
                }));
        }
        this._removeSavedChannel(room.account, room.channel_name);
    },

    _onLeaveCurrentRoom: function() {
        let room = this._chatroomManager.getActiveRoom();
        if (!room)
            return;
        let action = this.lookup_action('leave-room');
        action.activate(GLib.Variant.new('(ss)', [room.id, '']));
    },

    _onToggleAction: function(action) {
        let state = action.get_state();
        action.change_state(GLib.Variant.new('b', !state.get_boolean()));
    },

    _onListConnections: function() {
        if (this._connectionsDialog) {
            this._connectionsDialog.widget.present();
            return;
        }

        this._connectionsDialog = new Connections.ConnectionsDialog();
        this._connectionsDialog.widget.show();
        this._connectionsDialog.widget.connect('response',
            Lang.bind(this, function(widget) {
                widget.destroy();
                this._connectionsDialog = null;
            }));
    },

    _onShowPreferences: function() {
    },

    _onShowAbout: function() {
        if (this._aboutDialog) {
            this._aboutDialog.present();
            return;
        }
        let aboutParams = {
            authors: [
                'Florian Müllner <fmuellner@gnome.org>',
                'William Jon McCann <william.jon.mccann@gmail.com>',
                'Carlos Soriano <carlos.soriano89@gmail.com>',
                'Giovanni Campagna <gcampagna@src.gnome.org>',
                'Carlos Garnacho <carlosg@gnome.org>',
                'Jonas Danielsson <jonas.danielsson@threetimestwo.org>'
            ],
            artists: [
                'Sam Hewitt',
                'Jakub Steiner <jimmac@gmail.com>'
            ],
            translator_credits: _("translator-credits"),
            comments: _("An Internet Relay Chat Client for GNOME"),
            copyright: 'Copyright ' + String.fromCharCode(0x00A9) // ©
                                    + ' 2013 Red Hat, Inc.',
            license_type: Gtk.License.GPL_2_0,
            logo_icon_name: 'polari',
            wrap_license: true,
            version: pkg.version,

            transient_for: this._window.window,
            modal: true
        };

        this._aboutDialog = new Gtk.AboutDialog(aboutParams);
        this._aboutDialog.show();
        this._aboutDialog.connect('response', Lang.bind(this, function() {
            this._aboutDialog.destroy();
            this._aboutDialog = null;
        }));
    },

    _onQuit: function() {
        this._window.window.destroy();
    }
});
Utils.addJSSignalMethods(Application.prototype);
