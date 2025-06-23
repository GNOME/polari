// SPDX-FileCopyrightText: 2013 Florian Müllner <fmuellner@gnome.org>
// SPDX-FileCopyrightText: 2019 Daronion <stefanosdimos.98@gmail.com>
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Polari from 'gi://Polari';
import Tp from 'gi://TelepathyGLib';

import AccountsMonitor from './accountsMonitor.js';
import RoomManager from './roomManager.js';
import UserStatusMonitor from './userTracker.js';
import * as Utils from './utils.js';

Gio._promisify(Gio.DBusConnection.prototype, 'call', 'call_finish');
Gio._promisify(Polari.Room.prototype,
    'send_identify_message_async', 'send_identify_message_finish');
Gio._promisify(Tp.Account.prototype, 'reconnect_async', 'reconnect_finish');
Gio._promisify(Tp.Account.prototype,
    'request_presence_async', 'request_presence_finish');
Gio._promisify(Tp.Account.prototype,
    'set_enabled_async', 'set_enabled_finish');
Gio._promisify(Tp.Account.prototype,
    'update_parameters_vardict_async', 'update_parameters_vardict_finish');
Gio._promisify(Tp.AccountChannelRequest.prototype,
    'ensure_and_observe_channel_async', 'ensure_and_observe_channel_finish');
Gio._promisify(Tp.Channel.prototype, 'leave_async', 'leave_finish');
Gio._promisify(Tp.TextChannel.prototype,
    'send_message_async', 'send_message_finish');

const SHELL_CLIENT_PREFIX = 'org.freedesktop.Telepathy.Client.GnomeShell';
const DEFAULT_GRAPH = 'polari:irc';

const SASLAuthenticationIface = `
<node>
<interface name="org.freedesktop.Telepathy.Channel.Interface.SASLAuthentication">
  <method name="StartMechanismWithData">
    <arg type="s" direction="in" name="mechanism" />
    <arg type="ay" direction="in" name="data" />
  </method>
  <method name="AcceptSASL"/>
  <method name="AbortSASL">
    <arg type="u" direction="in" name="reason"/>
    <arg type="s" direction="in" name="debug-message"/>
  </method>
  <signal name="SASLStatusChanged">
    <arg name="status" type="u" />
    <arg name="reason" type="s" />
    <arg name="details" type="a{sv}" />
  </signal>
</interface>
</node>`;
let SASLAuthProxy = Gio.DBusProxy.makeProxyWrapper(SASLAuthenticationIface);

const SASLStatus = {
    NOT_STARTED: 0,
    IN_PROGRESS: 1,
    SERVER_SUCCEEDED: 2,
    CLIENT_ACCEPTED: 3,
    SUCCEEDED: 4,
    SERVER_FAILED: 5,
    CLIENT_FAILED: 6,
};

const SASLAbortReason = {
    INVALID_CHALLENGE: 0,
    USER_ABORT: 1,
};

class SASLAuthHandler {
    constructor(channel) {
        this._channel = channel;
        this._proxy = new SASLAuthProxy(
            Gio.DBus.session,
            channel.bus_name,
            channel.object_path,
            this._onProxyReady.bind(this));
    }

    async _onProxyReady() {
        this._proxy.connectSignal('SASLStatusChanged',
            this._onSASLStatusChanged.bind(this));

        let account = this._channel.connection.get_account();
        try {
            const password = await Utils.lookupAccountPassword(account);
            await this._proxy.StartMechanismWithDataAsync(
                'X-TELEPATHY-PASSWORD', password);
        } catch {
            await this._proxy.AbortSASLAsync(
                SASLAbortReason.USER_ABORT,
                'Password not available');

            let prompt = new GLib.Variant('b', false);
            let params = new GLib.Variant('a{sv}', {'password-prompt': prompt});
            await account.update_parameters_vardict_async(params, []);
            await account.request_presence_async(Tp.ConnectionPresenceType.AVAILABLE,
                'available', '', null);
        }
    }

    _onSASLStatusChanged(proxy, sender, [status]) {
        let name = this._channel.connection.get_account().display_name;
        let statusString = Object.keys(SASLStatus)[status];
        console.info(`Auth status for server ${name}: ${statusString}`);

        switch (status) {
        case SASLStatus.NOT_STARTED:
        case SASLStatus.IN_PROGRESS:
        case SASLStatus.CLIENT_ACCEPTED:
            break;

        case SASLStatus.SERVER_SUCCEEDED:
            this._proxy.AcceptSASLAsync();
            break;

        case SASLStatus.SUCCEEDED:
        case SASLStatus.SERVER_FAILED:
        case SASLStatus.CLIENT_FAILED:
            this._channel.close_async(null);
            break;
        }
    }
}

export default GObject.registerClass(
class TelepathyClient extends Tp.BaseClient {
    _pendingBotPasswords = new Map();
    _pendingRequests = new Map();

    constructor(params) {
        super(params);

        this._app = Gio.Application.get_default();
        this._app.connect('prepare-shutdown', () => {
            [...this._pendingRequests.values()].forEach(r => r.cancel());
            [...this._pendingBotPasswords.keys()].forEach(a => this._discardIdentifyPassword(a));
            this._app.release();
        });
        this._app.hold();

        this.set_handler_bypass_approval(false);
        this.set_observer_recover(true);

        this._roomManager = RoomManager.getDefault();
        this._roomManager.connect('room-added', (mgr, room) => {
            if (room.account.connection)
                this._connectRoom(room);
            room.connect('identify-sent', this._onIdentifySent.bind(this));
        });
        this._accountsMonitor = AccountsMonitor.getDefault();
        this._accountsMonitor.prepare(this._onPrepared.bind(this));

        this._userStatusMonitor = UserStatusMonitor.getDefault();

        this._shellHandlesPrivateChats = false;
        this._monitorShellClient();
    }

    async _monitorShellClient() {
        // Track whether gnome-shell's built-in chat client is
        // running; unfortunately it uses :uniquify-name, so
        // we cannot simply use Gio.watch_bus_name()
        let conn = this._app.get_dbus_connection();
        conn.signal_subscribe(
            'org.freedesktop.DBus', /* sender */
            'org.freedesktop.DBus', /* iface */
            'NameOwnerChanged', /* member */
            '/org/freedesktop/DBus', /* path */
            SHELL_CLIENT_PREFIX, /* arg0 */
            Gio.DBusSignalFlags.MATCH_ARG0_NAMESPACE,
            (_conn, _sender, _path, _iface, _signal, params) => {
                let [name_, oldOwner_, newOwner] = params.deep_unpack();
                this._shellHandlesPrivateChats = newOwner !== '';
            });

        let names = [];
        try {
            const result = await conn.call(
                'org.freedesktop.DBus',
                '/org/freedesktop/DBus',
                'org.freedesktop.DBus',
                'ListNames',
                null, /* params */
                new GLib.VariantType('(as)'),
                Gio.DBusCallFlags.NONE,
                -1,
                null);
            [names] = result.deep_unpack();
        } catch (e) {
            console.info('Failed to list bus names');
            console.debug(e);
        }

        this._shellHandlesPrivateChats =
            names.some(n => n.startsWith(SHELL_CLIENT_PREFIX));
    }

    _onPrepared() {
        let actions = [{
            name: 'message-user',
            handler: this._onQueryActivated.bind(this),
        }, {
            name: 'leave-room',
            handler: this._onLeaveActivated.bind(this),
        }, {
            name: 'reconnect-room',
            handler: this._onReconnectRoomActivated.bind(this),
        }, {
            name: 'connect-account',
            handler: this._onConnectAccountActivated.bind(this),
        }, {
            name: 'disconnect-account',
            handler: this._onDisconnectAccountActivated.bind(this),
        }, {
            name: 'reconnect-account',
            handler: this._onReconnectAccountActivated.bind(this),
        }, {
            name: 'authenticate-account',
            handler: this._onAuthenticateAccountActivated.bind(this),
        }, {
            name: 'save-identify-password',
            handler: this._onSaveIdentifyPasswordActivated.bind(this),
        }, {
            name: 'discard-identify-password',
            handler: this._onDiscardIdentifyPasswordActivated.bind(this),
        }];
        actions.forEach(a => {
            this._app.lookup_action(a.name).connect('activate', a.handler);
        });

        let filters = [];

        let roomFilter = {};
        roomFilter[Tp.PROP_CHANNEL_CHANNEL_TYPE] = Tp.IFACE_CHANNEL_TYPE_TEXT;
        roomFilter[Tp.PROP_CHANNEL_TARGET_HANDLE_TYPE] = Tp.HandleType.ROOM;
        filters.push(roomFilter);

        let contactFilter = {};
        contactFilter[Tp.PROP_CHANNEL_CHANNEL_TYPE] = Tp.IFACE_CHANNEL_TYPE_TEXT;
        contactFilter[Tp.PROP_CHANNEL_TARGET_HANDLE_TYPE] = Tp.HandleType.CONTACT;
        filters.push(contactFilter);

        let authFilter = {};
        authFilter[Tp.PROP_CHANNEL_CHANNEL_TYPE] = Tp.IFACE_CHANNEL_TYPE_SERVER_AUTHENTICATION;
        authFilter[Tp.PROP_CHANNEL_TYPE_SERVER_AUTHENTICATION_AUTHENTICATION_METHOD] = Tp.IFACE_CHANNEL_INTERFACE_SASL_AUTHENTICATION;
        filters.push(authFilter);

        filters.forEach(f => {
            this.add_handler_filter(f);
            this.add_observer_filter(f);
        });
        this.register();

        if (Utils.needsOnetimeAction('mute-bots')) {
            this._accountsMonitor.visibleAccounts.forEach(a => {
                if (a.settings.get_string('identify-username') === null)
                    return;

                const tracker =
                    this._userStatusMonitor.getUserTrackerForAccount(a);
                tracker.muteNick(a.settings.get_string('identify-botname'));
            });
        }

        this._accountsMonitor.connect('account-status-changed',
            this._onAccountStatusChanged.bind(this));
        this._accountsMonitor.connect('account-reachable-changed',
            this._onAccountReachableChanged.bind(this));
        this._accountsMonitor.visibleAccounts.forEach(a => {
            this._onAccountStatusChanged(this._accountsMonitor, a);
        });
    }

    _onAccountReachableChanged(mon, account) {
        let presence = account.reachable
            ? Tp.ConnectionPresenceType.AVAILABLE
            : Tp.ConnectionPresenceType.OFFLINE;
        console.info(`Account ${account.display_name} is now ${account.reachable
            ? 'reachable'
            : 'unreachable'}`);

        this._setAccountPresence(account, presence);
    }

    async _onAccountStatusChanged(mon, account) {
        if (account.connection_status !== Tp.ConnectionStatus.CONNECTED)
            return;

        try {
            const password = await Utils.lookupIdentifyPassword(account);
            await this._sendIdentify(account, password);
        } catch (e) {
            console.debug(e);
            this._connectRooms(account);
        }
    }

    _connectAccount(account) {
        this._setAccountPresence(account, Tp.ConnectionPresenceType.AVAILABLE);
    }

    async _setAccountPresence(account, presence) {
        if (!account.enabled)
            return;

        let statuses = Object.keys(Tp.ConnectionPresenceType)
            .map(s => s.replace(/_/g, '-').toLowerCase());
        let status = statuses[presence];
        let msg = account.requested_status_message;
        let accountName = account.display_name;

        console.info(`Setting presence of account "${accountName}" to ${status}`);
        try {
            await account.request_presence_async(presence, status, msg);
        } catch (e) {
            console.warn(`Failed to change presence of account "${
                accountName}" to ${status}`);
            console.debug(e);
        }
    }

    _connectRooms(account) {
        this._roomManager.rooms.forEach(room => {
            if (!account || room.account === account)
                this._connectRoom(room);
        });
    }

    async _connectRoom(room) {
        try {
            await this._requestChannel(
                room.account, room.type, room.channel_name, null);
        } catch {}
    }

    async _requestChannel(account, targetType, targetId) {
        if (!account || !account.enabled)
            return null;

        let roomId = Polari.create_room_id(account,  targetId, targetType);

        let cancellable = new Gio.Cancellable();
        this._pendingRequests.set(roomId, cancellable);

        // Always use a timestamp of 0 for channels we request - rooms that
        // the users requests are focused when handling the corresponding
        // action, so presenting the room after the requests completes has
        // no effect at best, but could steal the focus when the user switched
        // to a different room in the meantime
        let req = Tp.AccountChannelRequest.new_text(account, 0);
        req.set_target_id(targetType, targetId);
        req.set_delegate_to_preferred_handler(true);

        const preferredHandler = `${Tp.CLIENT_BUS_NAME_BASE}Polari`;
        let channel = null;
        let channelError = '';
        try {
            channel = await req.ensure_and_observe_channel_async(
                preferredHandler, cancellable);
        } catch (e) {
            console.warn(`Failed to ensure channel ${
                targetId} for account ${account.displayName}`);
            console.debug(e);
            channelError = Tp.error_get_dbus_name(e.code);
            throw e;
        } finally {
            const room = this._roomManager.lookupRoom(roomId);
            if (room)
                room.set({channelError});
            this._pendingRequests.delete(roomId);
        }

        return channel;
    }

    async _sendIdentify(account, password) {
        let {settings} = account;

        let params = account.dup_parameters_vardict().deep_unpack();
        let username = settings.get_string('identify-username') ||
                       params.username.deep_unpack();
        let alwaysSendUsername = settings.get_boolean('identify-username-supported');
        let contactName = settings.get_string('identify-botname');
        let command = settings.get_string('identify-command');

        let channel = null;
        try {
            channel = await this._requestChannel(
                account, Tp.HandleType.CONTACT, contactName);
        } catch {
            return;
        }

        const room = this._roomManager.lookupRoomByChannel(channel);
        const activeNick = room.channel.connection.self_contact.alias;
        // Omit username parameter when it matches the default, to
        // support NickServ bots that don't support the parameter at all
        if (!alwaysSendUsername && activeNick === username)
            username = null;

        try {
            await room.send_identify_message_async(command, username, password);
        } catch (e) {
            console.warn(`Failed to send identify message for ${
                username} to ${contactName} on ${account.displayName}`);
            console.debug(e);
        }
        this._connectRooms(account);
    }

    _onConnectAccountActivated(action, parameter) {
        let accountPath = parameter.deep_unpack();
        let account = this._accountsMonitor.lookupAccount(accountPath);
        if (account.enabled)
            this._connectAccount(account);
        else
            account.set_enabled_async(true);
    }

    async _onDisconnectAccountActivated(action, parameter) {
        let accountPath = parameter.deep_unpack();
        let account = this._accountsMonitor.lookupAccount(accountPath);
        await account.set_enabled_async(false);
        this._setAccountPresence(account, Tp.ConnectionPresenceType.OFFLINE);
    }

    _onReconnectAccountActivated(action, parameter) {
        let accountPath = parameter.deep_unpack();
        let account = this._accountsMonitor.lookupAccount(accountPath);
        account.reconnect_async();
    }

    async _onAuthenticateAccountActivated(action, parameter) {
        let [accountPath, password] = parameter.deep_unpack();
        let account = this._accountsMonitor.lookupAccount(accountPath);

        let prompt = new GLib.Variant('b', password.length > 0);
        let params = GLib.Variant.new('a{sv}', {'password-prompt': prompt});
        await account.update_parameters_vardict_async(params, []);
        await Utils.storeAccountPassword(account, password);
        await account.reconnect_async();
    }

    async _onQueryActivated(action, parameter) {
        let [accountPath, channelName, message, present_] = parameter.deep_unpack();
        let account = this._accountsMonitor.lookupAccount(accountPath);

        if (!account || !account.enabled)
            return;

        try {
            let channel = await this._requestChannel(
                account, Tp.HandleType.CONTACT, channelName);

            if (!message)
                return;

            let type = Tp.ChannelTextMessageType.NORMAL;
            let tpMessage = Tp.ClientMessage.new_text(type, message);
            await channel.send_message_async(tpMessage, 0);
        } catch (e) {
            if (!message)
                return; // already logged by _requestChannel()
            console.warn(`Failed to send message to ${channelName} on ${
                account.displayName}`);
            console.debug(e);
        }
    }

    async _onLeaveActivated(action, parameter) {
        let [id, message] = parameter.deep_unpack();

        let request = this._pendingRequests.get(id);
        if (request)
            request.cancel();

        let room = this._roomManager.lookupRoom(id);
        if (!room.channel)
            return;

        // This is a user action, so acknowledge messages to prevent
        // mission-control from popping up the channel again
        room.channel.dup_pending_messages().forEach(m => {
            // The room is about to be removed and will gone when the
            // ::pending-message-removed signal is emitted, so just
            // withdraw pending notifications now
            this._onPendingMessageRemoved(room.channel, m);
            room.channel.ack_message_async(m, null);
        });

        let reason = Tp.ChannelGroupChangeReason.NONE;
        message = message || _('Good Bye');
        try {
            await room.channel.leave_async(reason, message);
        } catch (e) {
            console.warn(`Failed to leave channel ${
                room.channelName} on ${room.account.displayName}`);
            console.debug(e);
        }
    }

    async _onSaveIdentifyPasswordActivated(action, parameter) {
        let accountPath = parameter.deep_unpack();
        let account = this._accountsMonitor.lookupAccount(accountPath);
        if (!account)
            return;

        let data = this._pendingBotPasswords.get(account.object_path);
        if (!data)
            return;

        try {
            await Utils.storeIdentifyPassword(account, data.password);
            this._saveIdentifySettings(account, data);
        } finally {
            this._pendingBotPasswords.delete(account.object_path);
        }
    }

    _saveIdentifySettings(account, data) {
        let {settings} = account;

        if (data.botname === 'NickServ')
            settings.reset('identify-botname');
        else
            settings.set_string('identify-botname', data.botname);

        if (data.command === 'identify')
            settings.reset('identify-command');
        else
            settings.set_string('identify-command', data.command);

        settings.set_string('identify-username', data.username);
        settings.set_boolean('identify-username-supported', data.usernameSupported);

        // We know it's a bot, mute it by default!
        let tracker = this._userStatusMonitor.getUserTrackerForAccount(account);
        tracker.muteNick(data.botname);
    }

    _onDiscardIdentifyPasswordActivated(action, parameter) {
        let accountPath = parameter.deep_unpack();
        this._discardIdentifyPassword(accountPath);
    }

    _discardIdentifyPassword(accountPath) {
        this._pendingBotPasswords.delete(accountPath);
        this._app.withdraw_notification(this._getIdentifyNotificationID(accountPath));
    }

    _onReconnectRoomActivated(action, parameter) {
        let roomId = parameter.deep_unpack();
        let room = this._roomManager.lookupRoom(roomId);
        this._connectRoom(room);
    }

    _isAuthChannel(channel) {
        let channelType = channel.get_channel_type();
        return channelType === Tp.IFACE_CHANNEL_TYPE_SERVER_AUTHENTICATION;
    }

    _processRequest(context, connection, channels, processChannel) {
        if (connection.protocol_name !== 'irc') {
            let message = 'Not implementing non-IRC protocols';
            context.fail(new Tp.Error({
                code: Tp.Error.NOT_IMPLEMENTED,
                message,
            }));
            return;
        }

        if (this._isAuthChannel(channels[0]) && channels.length > 1) {
            let message = 'Only one authentication channel per connection allowed';
            context.fail(new Tp.Error({
                code: Tp.Error.INVALID_ARGUMENT,
                message,
            }));
            return;
        }

        for (let i = 0; i < channels.length; i++) {
            if (channels[i].get_invalidated())
                continue;
            processChannel.call(this, channels[i]);
        }
        context.accept();
    }

    vfunc_observe_channels(...args) {
        let [account_, connection, channels, op_, requests_, context] = args;
        this._processRequest(context, connection, channels, channel => {
            if (this._isAuthChannel(channel))
                return;

            if (channel.has_interface(Tp.IFACE_CHANNEL_INTERFACE_GROUP)) {
                let [invited] = channel.group_get_local_pending_contact_info(channel.group_self_contact);
                if (invited)
                    // this is an invitation - only add it in handleChannel
                    // if accepted
                    return;
            }

            this._roomManager.ensureRoomForChannel(channel, false);

            channel.connect('message-sent',
                this._onMessageSent.bind(this));
            channel.connect('message-received',
                this._onMessageReceived.bind(this));
            channel.connect('pending-message-removed',
                this._onPendingMessageRemoved.bind(this));

            channel.dup_pending_messages().forEach(
                m => this._onMessageReceived(channel, m));
        });
    }

    vfunc_handle_channels(...args) {
        let [account_, connection, channels, satisfied_, time, context] = args;
        let [present] = Tp.user_action_time_should_present(time);

        this._processRequest(context, connection, channels, channel => {
            if (this._isAuthChannel(channel)) {
                new SASLAuthHandler(channel);
                return;
            }

            if (present)
                this._app.activate();

            this._roomManager.ensureRoomForChannel(channel, present);
            // channel.join_async('', null);
        });
    }

    _getPendingNotificationID(room, id) {
        return `pending-message-${room.id}-${id}`;
    }

    _getIdentifyNotificationID(accountPath) {
        return `identify-password-${accountPath}`;
    }

    _createNotification(room, summary, body) {
        let notification = new Gio.Notification();
        notification.set_title(summary);
        notification.set_body(body);

        let params = [
            room.account.object_path,
            room.channel_name,
            true,
        ];

        let actionName, paramFormat;
        if (room.type === Tp.HandleType.ROOM) {
            actionName = 'app.join-room';
            paramFormat = '(ssb)';
        } else {
            actionName = 'app.message-user';
            paramFormat = '(sssb)';
            params.splice(2, 0, '');
        }

        let param = GLib.Variant.new(paramFormat, params);
        notification.set_default_action_and_target(actionName, param);
        return notification;
    }

    _onIdentifySent(room, command, username, password) {
        let accountPath = room.account.object_path;

        let data = {
            botname: room.channel.target_contact.alias,
            command,
            username: username || room.channel.connection.self_contact.alias,
            usernameSupported: !!username,
            password,
        };
        this._pendingBotPasswords.set(accountPath, data);

        if (this._app.isRoomFocused(room))
            return;

        let accountName = room.account.display_name;
        /* Translators: Those are a botname and an accountName, e.g.
           "Save NickServ password for Libera" */
        let summary = vprintf(_('Save %s password for %s?'), data.botname, accountName);
        let text = vprintf(
            _('Identification will happen automatically the next time you connect to %s'), accountName);
        let notification = this._createNotification(room, summary, text);

        notification.add_button_with_target(_('Save'),
            'app.save-identify-password',
            new GLib.Variant('o', accountPath));

        this._app.send_notification(this._getIdentifyNotificationID(accountPath), notification);
    }

    _logMessage(tpMessage, channel) {
        if (this._app.isTestInstance)
            return;

        const connection = Polari.util_get_tracker_connection();

        const accountId = channel.connection.get_account().get_path_suffix();
        const isRoom = channel.handle_type === Tp.HandleType.ROOM;
        const channelName = channel.identifier;

        const message = Polari.Message.new_from_tp_message(tpMessage);
        const resource = message.to_tracker_resource(accountId, channelName, isRoom);

        connection.update_resource_async(DEFAULT_GRAPH, resource, null, (o, res) => {
            try {
                connection.update_resource_finish(res);
            } catch (e) {
                log(`Failed to log message: ${e.message}`);
            }
        });
    }

    _onMessageSent(channel, msg) {
        this._logMessage(msg, channel);
    }

    _onMessageReceived(channel, msg) {
        this._logMessage(msg, channel);

        let [id] = msg.get_pending_message_id();
        let room = this._roomManager.lookupRoomByChannel(channel);

        // Rooms are removed instantly when the user requests it, but closing
        // the corresponding channel may take a bit; it would be surprising
        // to get notifications for a "closed" room, so just bail out
        if (!room || this._app.isRoomFocused(room))
            return;

        let [text] = msg.to_text();
        let nick = msg.sender.alias;
        if (!room.should_highlight_message(nick, text))
            return;

        if (this._shellHandlesPrivateChats && room.type === Tp.HandleType.CONTACT)
            return;

        const tracker = this._userStatusMonitor.getUserTrackerForAccount(room.account);
        if (tracker.isMuted(msg.sender.identifier))
            return;

        let summary;

        if (room.type === Tp.HandleType.CONTACT) {
            summary = vprintf('%s', nick);
        } else {
            /* Translators: This is the title of the notification announcing a newly
               received message, in the form "user-nickname in room-display-name" */
            summary = vprintf(_('%s in %s'), nick, room.display_name);
        }

        let notification = this._createNotification(room, summary, text);
        this._app.send_notification(this._getPendingNotificationID(room, id), notification);
    }

    _onPendingMessageRemoved(channel, msg) {
        let [id, valid] = msg.get_pending_message_id();
        if (!valid)
            return;

        let room = this._roomManager.lookupRoomByChannel(channel);
        if (!room)
            return;

        this._app.withdraw_notification(this._getPendingNotificationID(room, id));
    }
});
