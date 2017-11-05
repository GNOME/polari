const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Signals = imports.signals;
const Tp = imports.gi.TelepathyGLib;

const AppNotifications = imports.appNotifications;
const {RoomManager} = imports.roomManager;
const Utils = imports.utils;

const N_ = s => s;

var knownCommands = {
    /* commands that would be nice to support: */
    /*
    AWAY: N_("/AWAY [<message>] — sets or unsets away message"),
    LIST: N_("/LIST [<channel>] — lists stats on <channel>, or all channels on the server"),
    MODE: "/MODE <mode> <nick|channel> — ",
    NOTICE: N_("/NOTICE <nick|channel> <message> — sends notice to <nick|channel>"),
    OP: N_("/OP <nick> — gives channel operator status to <nick>"),
    WHOIS: N_("/WHOIS <nick> — requests information on <nick>"),
    */

    CLOSE: N_("/CLOSE [<channel>] [<reason>] — closes <channel>, by default the current one"),
    HELP: N_("/HELP [<command>] — displays help for <command>, or a list of available commands"),
    INVITE: N_("/INVITE <nick> [<channel>] — invites <nick> to <channel>, or the current one"),
    JOIN: N_("/JOIN <channel> — joins <channel>"),
    KICK: N_("/KICK <nick> — kicks <nick> from current channel"),
    ME: N_("/ME <action> — sends <action> to the current channel"),
    MSG: N_("/MSG <nick> [<message>] — sends a private message to <nick>"),
    NAMES: N_("/NAMES — lists users on the current channel"),
    NICK: N_("/NICK <nickname> — sets your nick to <nickname>"),
    PART: N_("/PART [<channel>] [<reason>] — leaves <channel>, by default the current one"),
    QUERY: N_("/QUERY <nick> — opens a private conversation with <nick>"),
    QUIT: N_("/QUIT [<reason>] — disconnects from the current server"),
    SAY: N_("/SAY <text> — sends <text> to the current room/contact"),
    TOPIC: N_("/TOPIC <topic> — sets the topic to <topic>, or shows the current one"),
};
const UNKNOWN_COMMAND_MESSAGE =
    N_("Unknown command — try /HELP for a list of available commands");

var IrcParser = class {
    constructor(room) {
        this._app = Gio.Application.get_default();
        this._roomManager = RoomManager.getDefault();
        this._room = room;
    }

    _createFeedbackLabel(text) {
        return new AppNotifications.SimpleOutput(text);
    }

    _createFeedbackUsage(cmd) {
        return this._createFeedbackLabel(_("Usage: %s").format(_(knownCommands[cmd])));
    }

    _createFeedbackGrid(header, items) {
        return new AppNotifications.GridOutput(header, items);
    }

    process(text) {
        if (!this._room || !this._room.channel || !text.length)
            return true;

        if (text[0] != '/') {
            this._sendText(text);
            return true;
        }

        let stripCommand = text => text.substr(text.indexOf(' ')).trimLeft();

        let retval = true;

        let argv = text.trimRight().substr(1).split(/ +/);
        let cmd = argv.shift().toUpperCase();
        let output = null;
        switch (cmd) {
            case 'HELP': {
                let command = argv.shift();
                if (command)
                    command = command.toUpperCase();

                retval = (command == null || knownCommands[command] != null);

                if (!retval) //error
                    output = this._createFeedbackLabel(_(UNKNOWN_COMMAND_MESSAGE));
                else if (command)
                    output = this._createFeedbackUsage(command);
                else
                    output = this._createFeedbackGrid(_("Known commands:"),
                                                        Object.keys(knownCommands));
                break;
            }
            case 'INVITE': {
                let nick = argv.shift();
                if (!nick) {
                    this._createFeedbackUsage(cmd);
                    retval = false;
                    break;
                }
                this._room.channel.connection.dup_contact_by_id_async(nick, [],
                    (c, res) => {
                        let contact;
                        try {
                            contact = c.dup_contact_by_id_finish(res);
                        } catch(e) {
                            logError(e, 'Failed to get contact for ' + nick);
                            return;
                        }
                        this._room.add_member(contact);
                    });
                break;
            }
            case 'J':
            case 'JOIN': {
                let room = argv.shift();
                if (!room) {
                    output = this._createFeedbackUsage(cmd);
                    retval = false;
                    break;
                }
                if (argv.length)
                    log('Excess arguments to JOIN command: ' + argv);

                let account = this._room.account;
                let app = Gio.Application.get_default();
                let action = app.lookup_action('join-room');
                action.activate(GLib.Variant.new('(ssu)',
                                                 [ account.get_object_path(),
                                                   room,
                                                   Utils.getTpEventTime() ]));
                break;
            }
            case 'KICK': {
                let nick = argv.shift();
                if (!nick) {
                    output = this._createFeedbackUsage(cmd);
                    retval = false;
                    break;
                }
                this._room.channel.connection.dup_contact_by_id_async(nick, [],
                    (c, res) => {
                        let contact;
                        try {
                            contact = c.dup_contact_by_id_finish(res);
                        } catch(e) {
                            logError(e, 'Failed to get contact for ' + nick);
                            return;
                        }
                        this._room.remove_member(contact);
                    });
                break;
            }
            case 'ME': {
                if (!argv.length) {
                    output = this._createFeedbackUsage(cmd);
                    retval = false;
                    break;
                }
                let action = stripCommand(text);
                let type = Tp.ChannelTextMessageType.ACTION;
                let message = Tp.ClientMessage.new_text(type, action);
                this._sendMessage(message);
                break;
            }
            case 'MSG': {
                let nick = argv.shift();
                let message = argv.join(' ');
                if (!nick || !message) {
                    output = this._createFeedbackUsage(cmd);
                    retval = false;
                    break;
                }

                let account = this._room.account;

                let app = Gio.Application.get_default();
                let action = app.lookup_action('message-user');
                action.activate(GLib.Variant.new('(sssu)',
                                                 [ account.get_object_path(),
                                                   nick,
                                                   message,
                                                   Tp.USER_ACTION_TIME_NOT_USER_ACTION ]));
                break;
            }
            case 'NAMES': {
                let channel = this._room.channel;
                let members = channel.group_dup_members_contacts().map(m => m.alias);
                output = this._createFeedbackGrid(_("Users on %s:").format(channel.identifier),
                                                    members);
                break;
            }
            case 'NICK': {
                let nick = argv.shift();
                if (!nick) {
                    output = this._createFeedbackUsage(cmd);
                    retval = false;
                    break;
                }
                if (argv.length)
                    log('Excess arguments to NICK command: ' + argv);

                this._app.setAccountNick(this._room.account, nick);
                break;
            }
            case 'PART':
            case 'CLOSE': {
                let room = null;;
                let name = argv[0];
                if (name)
                    room = this._roomManager.lookupRoomByName(name, this._room.account);
                if (room)
                    argv.shift(); // first arg was a room name
                else
                    room = this._room;

                let app = Gio.Application.get_default();
                let action = app.lookup_action('leave-room');
                let param = GLib.Variant.new('(ss)', [room.id, argv.join(' ')]);
                action.activate(param);
                break;
            }
            case 'QUERY': {
                let nick = argv.shift();
                if (!nick) {
                    output = this._createFeedbackUsage(cmd);
                    retval = false;
                    break;
                }

                let account = this._room.account;

                let app = Gio.Application.get_default();
                let action = app.lookup_action('message-user');
                action.activate(GLib.Variant.new('(sssu)',
                                                 [ account.get_object_path(),
                                                   nick,
                                                   '',
                                                   Utils.getTpEventTime() ]));
                break;
            }
            case 'QUIT': {
                let presence = Tp.ConnectionPresenceType.OFFLINE;
                let message = stripCommand(text);
                this._room.account.request_presence_async(presence, 'offline', message,
                    (a, res) => {
                        try {
                            a.request_presence_finish(res);
                        } catch(e) {
                            logError(e, 'Failed to disconnect');
                        }
                    });
                break;
            }
            case 'SAY': {
                if (!argv.length) {
                    output = this._createFeedbackUsage(cmd);
                    retval = false;
                    break;
                }
                this._sendText(stripCommand(text));
                break;
            }
            case 'TOPIC': {
                if (argv.length)
                    this._room.set_topic(stripCommand(text));
                else
                    output = this._createFeedbackLabel(this._room.topic || _("No topic set"));
                break;
            }
            default:
                output = this._createFeedbackLabel(_(UNKNOWN_COMMAND_MESSAGE));
                retval = false;
                break;
        }

        if (output)
            this._app.commandOutputQueue.addNotification(output);
        return retval;
    }

    _sendText(text) {
        let type = Tp.ChannelTextMessageType.NORMAL;
        let message = Tp.ClientMessage.new_text(type, text);
        this._sendMessage(message);
    }

    _sendMessage(message) {
        this._room.channel.send_message_async(message, 0, (c, res) => {
            try {
                 c.send_message_finish(res);
            } catch(e) {
                // TODO: propagate to user
                logError(e, 'Failed to send message')
            }
        });
    }
};
Signals.addSignalMethods(IrcParser.prototype);
