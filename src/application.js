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
    Signals: { 'prepare-shutdown': {} },

    _init: function() {
        this.parent({ application_id: 'org.gnome.Polari' });

        GLib.set_application_name('Polari');
        this._window = null;
        this._pendingRequests = {};
    },

    vfunc_startup: function() {
        this.parent();

        this._chatroomManager = ChatroomManager.getDefault();
        this._accountsMonitor = AccountsMonitor.getDefault();
        this._networkMonitor = Gio.NetworkMonitor.get_default();

        this._accountsMonitor.connect('account-removed', Lang.bind(this,
            function(am, account) {
                this._removeSavedChannelsForAccount(account);
            }));

        this._settings = new Gio.Settings({ schema_id: 'org.gnome.Polari' });

        this.pasteManager = new PasteManager.PasteManager();
        this.notificationQueue = new AppNotifications.NotificationQueue();
        this.commandOutputQueue = new AppNotifications.CommandOutputQueue();

        let actionEntries = [
          { name: 'show-join-dialog',
            activate: Lang.bind(this, this._onShowJoinDialog),
            accels: ['<Primary>n'] },
          { name: 'join-room',
            activate: Lang.bind(this, this._onJoinRoom),
            parameter_type: GLib.VariantType.new('(ssu)') },
          { name: 'message-user',
            activate: Lang.bind(this, this._onMessageUser),
            parameter_type: GLib.VariantType.new('(sssu)') },
          { name: 'leave-room',
            activate: Lang.bind(this, this._onLeaveRoom),
            parameter_type: GLib.VariantType.new('(ss)') },
          { name: 'leave-current-room',
            activate: Lang.bind(this, this._onLeaveCurrentRoom),
            create_hook: Lang.bind(this, this._leaveRoomCreateHook),
            accels: ['<Primary>w'] },
          { name: 'authenticate-account',
            parameter_type: GLib.VariantType.new('(os)') },
          { name: 'reconnect-account',
            parameter_type: GLib.VariantType.new('o') },
          { name: 'user-list',
            activate: Lang.bind(this, this._onToggleAction),
            create_hook: Lang.bind(this, this._userListCreateHook),
            state: GLib.Variant.new('b', false),
            accels: ['F9', '<Primary>u'] },
          { name: 'remove-connection',
            activate: Lang.bind(this, this._onRemoveConnection),
            parameter_type: GLib.VariantType.new('o') },
          { name: 'edit-connection',
            activate: Lang.bind(this, this._onEditConnection),
            parameter_type: GLib.VariantType.new('o') },
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
            parameter_type: GLib.VariantType.new('i') },
          { name: 'next-pending-room',
            accels: ['<Alt><Shift>Down', '<Primary><Shift>Page_Down']},
          { name: 'previous-pending-room',
            accels: ['<Alt><Shift>Up', '<Primary><Shift>Page_Up']}
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
            this._window = new MainWindow.MainWindow({ application: this });
            this._window.connect('destroy', Lang.bind(this,
                function() {
                    for (let id in this._pendingRequests)
                        this._pendingRequests[id].cancellable.cancel();
                    this.emit('prepare-shutdown');
            }));
            this._window.show_all();

            this._chatroomManager.lateInit();
        }
        this._window.present();
    },

    _updateAccountAction: function(action) {
        action.enabled = this._accountsMonitor.dupAccounts().filter(
            function(a) {
                return a.enabled;
            }).length > 0;
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

    _onShowJoinDialog: function() {
        this._window.showJoinRoomDialog();
    },

    _savedChannelIndex: function(savedChannels, account, channel) {
        let accountPath = account.get_object_path();
        let matchChannel = channel.toLowerCase();
        for (let i = 0; i < savedChannels.length; i++)
            if (savedChannels[i].account.deep_unpack() == accountPath &&
                savedChannels[i].channel.deep_unpack().toLowerCase() == matchChannel)
                return i;
        return -1;
    },

    _addSavedChannel: function(account, channel) {
        let savedChannels = this._settings.get_value('saved-channel-list').deep_unpack();
        if (this._savedChannelIndex(savedChannels, account, channel) != -1)
            return;
        savedChannels.push({
            account: GLib.Variant.new('s', account.get_object_path()),
            channel: GLib.Variant.new('s', channel)
        });
        this._settings.set_value('saved-channel-list',
                                 GLib.Variant.new('aa{sv}', savedChannels));
    },

    _removeSavedChannel: function(account, channel) {
        let savedChannels = this._settings.get_value('saved-channel-list').deep_unpack();
        let pos = this._savedChannelIndex(savedChannels, account, channel);
        if (pos < 0)
            return;
        savedChannels.splice(pos, 1);
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

    _requestChannel: function(accountPath, targetType, targetId, time, callback) {
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

        if (!this._networkMonitor.network_available)
            return;

        let roomId = Polari.create_room_id(account,  targetId, targetType);

        let requestData = {
          account: account,
          targetHandleType: targetType,
          targetId: targetId,
          roomId: roomId,
          cancellable: new Gio.Cancellable(),
          time: time,
          retry: 0,
          originalNick: account.nickname,
          callback: callback };

        this._pendingRequests[roomId] = requestData;

        this._ensureChannel(requestData);
    },

    _ensureChannel: function(requestData) {
        let account = requestData.account;

        let req = Tp.AccountChannelRequest.new_text(account, requestData.time);
        req.set_target_id(requestData.targetHandleType, requestData.targetId);
        req.set_delegate_to_preferred_handler(true);
        let preferredHandler = Tp.CLIENT_BUS_NAME_BASE + 'Polari';
        req.ensure_and_observe_channel_async(preferredHandler, requestData.cancellable,
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
        let channel = null;

        try {
            channel = req.ensure_and_observe_channel_finish(res);
        } catch (e if e.matches(Tp.Error, Tp.Error.DISCONNECTED)) {
            let error = account.connection_error;
            // If we receive a disconnect error and the network is unavailable,
            // then the error is not specific to polari and polari will
            // just be in offline state.
            if (!this._networkMonitor.network_available)
                return;
            if (error == ConnectionError.ALREADY_CONNECTED &&
                requestData.retry++ < MAX_RETRIES) {
                    this._retryRequest(requestData);
                    return;
            }

            if (error && error != ConnectionError.CANCELLED)
                Utils.debug('Account %s disconnected with error %s'.format(
                            account.get_path_suffix(),
                            error.replace(Tp.ERROR_PREFIX + '.', '')));
        } catch (e if e.matches(Tp.Error, Tp.Error.CANCELLED)) {
            // interrupted by user request, don't log
        } catch (e) {
            Utils.debug('Failed to ensure channel: ' + e.message);
        }

        if (requestData.callback)
            requestData.callback(channel);

        if (requestData.retry > 0)
            this._updateAccountName(account, requestData.originalNick, null);
        delete this._pendingRequests[requestData.roomId];
    },

    _onJoinRoom: function(action, parameter) {
        let [accountPath, channelName, time] = parameter.deep_unpack();
        this._requestChannel(accountPath, Tp.HandleType.ROOM,
                             channelName, time);

        let factory = Tp.AccountManager.dup().get_factory();
        let account = factory.ensure_account(accountPath, []);
        this._addSavedChannel(account, channelName);
    },

    _onMessageUser: function(action, parameter) {
        let [accountPath, contactName, message, time] = parameter.deep_unpack();
        this._requestChannel(accountPath, Tp.HandleType.CONTACT,
                             contactName, time, Lang.bind(this, this._sendMessage, message));
    },

    _sendMessage: function(channel, message) {
        if (!message || !channel)
            return;

        let TpMessage = Tp.ClientMessage.new_text(Tp.ChannelTextMessageType.NORMAL,
                                                  message);
        channel.send_message_async(TpMessage, 0, Lang.bind(this,
            function(c, res) {
            try {
                c.send_message_finish(res);
            } catch(e) {
                // TODO: propagate to user
                logError(e, 'Failed to send message')
            }
        }));
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

    _onRemoveConnection: function(action, parameter){
        let accountPath = parameter.deep_unpack();
        let factory = Tp.AccountManager.dup().get_factory();
        let account = factory.ensure_account(accountPath, []);
        account.set_enabled_async(false, Lang.bind(this,
            function() {
                let label = _("%s removed.").format(account.display_name);
                let n = new AppNotifications.UndoNotification(label);
                this.notificationQueue.addNotification(n);

                n.connect('closed', function() {
                    account.remove_async(function(a, res) {
                        a.remove_finish(res); // TODO: Check for errors
                    });
                });
                n.connect('undo', function() {
                    account.set_enabled_async(true, function(a, res) {
                        a.set_enabled_finish(res); // TODO: Check for errors
                    });
                });
            }));
    },

    _onEditConnection: function(action, parameter) {
        let accountPath = parameter.deep_unpack();
        let factory = Tp.AccountManager.dup().get_factory();
        let account = factory.ensure_account(accountPath, []);
        let dialog = new Connections.ConnectionProperties(account);
        dialog.transient_for = this._window;
        dialog.connect('response', Lang.bind(this,
            function(w, response) {
                w.destroy();
            }));
        dialog.show();
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
                'Jonas Danielsson <jonas.danielsson@threetimestwo.org>',
                'Bastian Ilsø <bastianilso@gnome.org>',
                'Kunaal Jain <kunaalus@gmail.com>',
                'Cody Welsh <codyw@protonmail.com>',
                'Isabella Ribeiro <belinhacbr@gmail.com>',
                'Jonas Danielsson <jonas@threetimestwo.org>',
                'Rares Visalom <rares.visalom@gmail.com>'
            ],
            artists: [
                'Sam Hewitt',
                'Jakub Steiner <jimmac@gmail.com>'
            ],
            translator_credits: _("translator-credits"),
            comments: _("An Internet Relay Chat Client for GNOME"),
            copyright: 'Copyright © 2013-2015 The Polari authors',
            license_type: Gtk.License.GPL_2_0,
            logo_icon_name: 'org.gnome.Polari',
            version: pkg.version,
            website_label: _("Learn more about Polari"),
            website: 'https://wiki.gnome.org/Apps/Polari',

            transient_for: this._window,
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
        this._window.destroy();
    }
});
