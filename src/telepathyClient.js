const Gdk = imports.gi.Gdk;
const GLib = imports.gi.GLib;
const Polari = imports.gi.Polari;
const Tp = imports.gi.TelepathyGLib;

const ChatroomManager = imports.chatroomManager;
const Lang = imports.lang;
const Signals = imports.signals;

const TP_ERROR_PREFIX = 'org.freedesktop.Telepathy.Error.'
const TP_ERROR_ALREADY_CONNECTED = TP_ERROR_PREFIX + 'AlreadyConnected';

const TelepathyClient = new Lang.Class({
    Name: 'TelepathyClient',

    _init: function() {
        this._connMgrs = {};

        this._roomMgr = ChatroomManager.getDefault();
        this._accountMgr = Tp.AccountManager.dup();
        this._accountMgr.prepare_async(null, Lang.bind(this, this._onPrepared));

        let factory = this._accountMgr.get_factory();
        factory.add_account_features([Tp.Account.get_feature_quark_connection()]);
        factory.add_connection_features([Tp.Connection.get_feature_quark_capabilities()]);
        factory.add_channel_features([Tp.Channel.get_feature_quark_group()]);

        this._observer = Tp.SimpleObserver.new_with_am(this._accountMgr, true,
            'Polari', true, Lang.bind(this, this._observeChannels));

        this._handler = Tp.SimpleHandler.new_with_am(this._accountMgr, false,
            false, 'Polari', true, Lang.bind(this, this._handleChannels));

        let filters = [];

        let roomFilter = {};
        roomFilter[Tp.PROP_CHANNEL_CHANNEL_TYPE] = Tp.IFACE_CHANNEL_TYPE_TEXT;
        roomFilter[Tp.PROP_CHANNEL_TARGET_HANDLE_TYPE] = Tp.HandleType.ROOM;
        filters.push(roomFilter);

        let contactFilter = {};
        contactFilter[Tp.PROP_CHANNEL_CHANNEL_TYPE] = Tp.IFACE_CHANNEL_TYPE_TEXT;
        contactFilter[Tp.PROP_CHANNEL_TARGET_HANDLE_TYPE] = Tp.HandleType.CONTACT;
        filters.push(contactFilter);

        filters.forEach(Lang.bind(this,
            function(f) {
                this._handler.add_handler_filter(f);
                this._observer.add_observer_filter(f);
            }));
        this._handler.register();
        this._observer.register();
    },

    _onPrepared: function() {
        Tp.list_connection_managers_async(null,
            Lang.bind(this, function (o, res) {
                let mgrs = Tp.list_connection_managers_finish(res);
                for (let i = 0; i < mgrs.length; i++)
                    this._connMgrs[mgrs[i].cm_name] = mgrs[i];
            }));
    },

    getAccounts: function() {
        return this._accountMgr.dup_valid_accounts().filter(Lang.bind(this,
            function(a) {
                if (!a.enabled)
                    return false;

                if (a.connection)
                    return a.connection.capabilities.supports_text_chatrooms();

                if (!this._connMgrs[a.cm_name])
                    return false;

                let proto = this._connMgrs[a.cm_name].get_protocol_object(a.protocol_name);
                //return proto.capabilities.supports_text_chatrooms();
                return proto != null;
            }));
    },

    _updateAccountName: function(account, name, callback) {
        let params = GLib.Variant.new('a{sv}', { account: GLib.Variant.new('s', name) });
        account.update_parameters_vardict_async(params, [], callback);
    },

    joinRoom: function(account, name) {
        let channelRequest = Tp.AccountChannelRequest.new_text(account,
                                                               Gdk.CURRENT_TIME);
        channelRequest.set_target_id(Tp.HandleType.ROOM, name);
        channelRequest.set_delegate_to_preferred_handler(true);
        let preferredHandler = Tp.CLIENT_BUS_NAME_BASE + 'Polari';
        channelRequest.ensure_channel_async(preferredHandler, null,
            Lang.bind(this, function(req, res) {
                try {
                    req.ensure_channel_finish(res);

                    if (account._originalNick)
                        this._updateAccountName(account, account._originalNick,
                            function() {
                                delete account._originalNick;
                            });
                } catch (e if e.matches(Tp.Error, Tp.Error.DISCONNECTED)) {
                    let [error,] = account.dup_detailed_error_vardict();
                    if (error != TP_ERROR_ALREADY_CONNECTED)
                        throw(e);

                    // Try again with a different nick
                    if (!account._originalNick)
                        account._originalNick = account.nickname;
                    let params = account.dup_parameters_vardict().deep_unpack();
                    let oldNick = params['account'].deep_unpack();
                    let nick = oldNick + '_';
                    this._updateAccountName(account, nick, Lang.bind(this,
                        function() {
                            this.joinRoom(account, name);
                        }));
                } catch (e) {
                    logError(e, "Failed to create channel");
                }
            }));
    },

    _observeChannels: function(observer, account, conn, channels, op, requests, context) {
        if (conn.protocol_name != 'irc') {
            let message = 'Not implementing non-IRC protocols';
            context.fail(new Tp.Error({ code: Tp.Error.NOT_IMPLEMENTED,
                                        message: message }));
            return;
        }

        for (let i = 0; i < channels.length; i++) {
            if (channels[i].get_invalidated())
                continue;

            // this is an invitation - only add it in handleChannel if accepted
            if (channels[i].has_interface(Tp.IFACE_CHANNEL_INTERFACE_GROUP) &&
                channels[i].group_self_contact != null)
                continue;

            let room = new Polari.Room({ channel: channels[i] });
            room.channel.connect('invalidated', Lang.bind(this,
                function() {
                    this._roomMgr.removeRoom(room);
                }));
            this._roomMgr.addRoom(room);
        }
        context.accept();
    },

    _handleChannels: function(handler, account, conn, channels, satisfied, user_time, context) {
        if (conn.protocol_name != 'irc') {
            let message = 'Not implementing non-IRC protocols';
            context.fail(new Tp.Error({ code: Tp.Error.NOT_IMPLEMENTED,
                                        message: message }));
            return;
        }

        for (let i = 0; i < channels.length; i++) {
            if (channels[i].get_invalidated())
                continue;

            let room = this._roomMgr._rooms[channels[i].get_object_path()];
            if (room)
                continue; // already added from observer

            room = new Polari.Room({ channel: channels[i] });
            room.channel.connect('invalidated', Lang.bind(this,
                function() {
                    this._roomMgr.removeRoom(room);
                }));
            this._roomMgr.addRoom(room);
            channels[i].join_async('', null);
        }
        context.accept();
    }
});
