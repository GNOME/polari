const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Tp = imports.gi.TelepathyGLib;

const AppNotifications = imports.appNotifications;
const ChatroomManager = imports.chatroomManager;
const Lang = imports.lang;
const Signals = imports.signals;
const Utils = imports.utils;

const N_ = function(s) { return s; };

const knownCommands = {
    /* commands that would be nice to support: */
    /*
    AWAY: N_("/AWAY [<message>] - sets or unsets away message"),
    LIST: N_("/LIST [<channel>] - lists stats on <channel>, or all channels on the server"),
    MODE: "/MODE <mode> <nick|channel> - ",
    NOTICE: N_("/NOTICE <nick|channel> <message> - sends notice to <nick|channel>"),
    OP: N_("/OP <nick> - gives channel operator status to <nick>"),
    WHOIS: N_("/WHOIS <nick> - requests information on <nick>"),
    */

    HELP: N_("/HELP [<command>] - displays help for <command>, or a list of available commands"),
    INVITE: N_("/INVITE <nick> [<channel>] - invites <nick> to <channel>, or the current one"),
    JOIN: N_("/JOIN <channel> - joins <channel>"),
    KICK: N_("/KICK <nick> - kicks <nick> from current channel"),
    ME: N_("/ME <action> - sends <action> to the current channel"),
    NAMES: N_("/NAMES - lists users on the current channel"),
    NICK: N_("/NICK <nickname> - sets your nick to <nickname>"),
    PART: N_("/PART [<channel>] [<reason>] - leaves <channel>, by default the current one"),
    QUERY: N_("/QUERY <nick> - opens a private conversation with <nick>"),
    QUIT: N_("/QUIT [<reason>] - disconnects from the current server"),
    SAY: N_("/SAY <text> - sends <text> to the current room/contact"),
    TOPIC: N_("/TOPIC <topic> - sets the topic to <topic>, or shows the current one"),
};
const UNKNOWN_COMMAND_MESSAGE =
    N_("Unknown command - try /HELP for a list of available commands");

const IrcParser = new Lang.Class({
    Name: 'IrcParser',

    _init: function() {
        this._app = Gio.Application.get_default();
        this._roomManager = ChatroomManager.getDefault();

        this._roomManager.connect('active-changed', Lang.bind(this,
            function(manager, room) {
                this._room = room;
            }));
        this._room = null;
    },

    _createFeedbackLabel: function(text) {
        return new AppNotifications.SimpleOutput(text);
    },

    _createFeedbackUsage: function(cmd) {
        return this._createFeedbackLabel(_("Usage: %s").format(_(knownCommands[cmd])));
    },

    _createFeedbackGrid: function(header, items) {
        return new AppNotifications.GridOutput(header, items);
    },

    process: function(text) {
        if (!this._room || !this._room.channel || !text.length)
            return true;

        if (text[0] != '/') {
            this._sendText(text);
            return true;
        }

        let stripCommand = function(text) {
            return text.substr(text.indexOf(' ')).trimLeft();
        }

        let retval = true;

        let argv = text.substr(1).split(/ +/);
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
                    Lang.bind(this, function(c, res) {
                        let contact;
                        try {
                            contact = c.dup_contact_by_id_finish(res);
                        } catch(e) {
                            logError(e, 'Failed to get contact for ' + nick);
                            return;
                        }
                        this._room.add_member(contact);
                    }));
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
                    Lang.bind(this, function(c, res) {
                        let contact;
                        try {
                            contact = c.dup_contact_by_id_finish(res);
                        } catch(e) {
                            logError(e, 'Failed to get contact for ' + nick);
                            return;
                        }
                        this._room.remove_member(contact);
                    }));
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
            case 'NAMES': {
                let channel = this._room.channel;
                let members = channel.group_dup_members_contacts().map(
                    function(m) { return m.alias; });
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

                this._room.account.set_nickname_async(nick, Lang.bind(this,
                    function(a, res) {
                        try {
                            a.set_nickname_finish(res);
                        } catch(e) {
                            logError(e, 'Failed to update nick');
                        }
                    }));
                break;
            }
            case 'PART': {
                let room = null;;
                let name = argv[0];
                if (name)
                    room = this._roomManager.getRoomByName(name);
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
                action.activate(GLib.Variant.new('(ssu)',
                                                 [ account.get_object_path(),
                                                   nick,
                                                   Utils.getTpEventTime() ]));
                break;
            }
            case 'QUIT': {
                let presence = Tp.ConnectionPresenceType.OFFLINE;
                let message = stripCommand(text);
                this._room.account.request_presence_async(presence, 'offline', message,
                    Lang.bind(this, function(a, res) {
                        try {
                            a.request_presence_finish(res);
                        } catch(e) {
                            logError(e, 'Failed to disconnect');
                        }
                    }));
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
    },

    _sendText: function(text) {
        let type = Tp.ChannelTextMessageType.NORMAL;
        let message = Tp.ClientMessage.new_text(type, text);
        this._sendMessage(message);
    },

    _sendMessage: function(message) {
        this._room.channel.send_message_async(message, 0, Lang.bind(this,
            function(c, res) {
                try {
                     c.send_message_finish(res);
                } catch(e) {
                    // TODO: propagate to user
                    logError(e, 'Failed to send message')
                }
            }));
    }
});
Signals.addSignalMethods(IrcParser.prototype);
