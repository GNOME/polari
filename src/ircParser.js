const Gdk = imports.gi.Gdk;
const Gtk = imports.gi.Gtk;
const Pango = imports.gi.Pango;
const Tp = imports.gi.TelepathyGLib;

const AppNotifications = imports.appNotifications;
const ChatroomManager = imports.chatroomManager;
const Lang = imports.lang;
const Signals = imports.signals;

const _ = imports.gettext.gettext;

const knownCommands = {
    /* commands that would be nice to support: */
    /*
    AWAY: _("/AWAY [<message>] - sets or unsets away message"),
    LIST: _("/LIST [<channel>] - lists stats on <channel>, or all channels on the server"),
    MODE: "/MODE <mode> <nick|channel> - ",
    NOTICE: _("/NOTICE <nick|channel> <message> - sends notice to <nick|channel>"),
    OP: _("/OP <nick> - gives channel operator status to <nick>"),
    WHOIS: _("/WHOIS <nick> - requests information on <nick>"),
    */

    HELP: _("/HELP [<command>] - displays help for <command>, or a list of available commands"),
    INVITE: _("/INVITE <nick> [<channel>] - invites <nick> to <channel>, or the current one"),
    JOIN: _("/JOIN <channel> - joins <channel>"),
    KICK: _("/KICK <nick> - kicks <nick> from current channel"),
    ME: _("/ME <action> - sends <action> to the current channel"),
    NAMES: _("/NAMES - lists users on the current channel"),
    NICK: _("/NICK <nickname> - sets your nick to <nickname>"),
    PART: _("/PART [<channel>] [<reason>] - leaves <channel>, by default the current one"),
    QUERY: _("</QUERY <nick> - opens a private conversation with <nick>"),
    QUIT: _("</QUIT [<reason>] - disconnects from the current server"),
    SAY: _("</SAY <text> - sends <text> to the current room/contact"),
    TOPIC: _("/TOPIC <topic> - sets the topic to <topic>, or shows the current one"),
};
const UNKNOWN_COMMAND_MESSAGE =
    _("Unknown command - try /HELP for a list of available commands");

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
        return this._createFeedbackLabel(_("Usage: %s").format(knownCommands[cmd]));
    },

    _createFeedbackGrid: function(header, items) {
        return new AppNotifications.GridOutput(header, items);
    },

    process: function(text) {
        if (!this._room || !this._room.channel || !text.length)
            return;

        if (text[0] != '/') {
            let type = Tp.ChannelTextMessageType.NORMAL;
            let message = Tp.ClientMessage.new_text(type, text);
            this._sendMessage(message);
            return;
        }

        let stripCommand = function(text) {
            return text.substr(text.indexOf(' ')).trimLeft();
        }

        let argv = text.substr(1).split(/ +/);
        let cmd = argv.shift().toUpperCase();
        let output = null;
        switch (cmd) {
            case 'HELP': {
                let command = argv.shift();
                if (command)
                    command = command.toUpperCase();

                let help;
                if (command && knownCommands[command])
                    output = this._createFeedbackUsage(command);
                else if (command)
                    output = this._createFeedbackLabel(UNKNOWN_COMMAND_MESSAGE);
                else
                    output = this._createFeedbackGrid(_("Known commands:"),
                                                        Object.keys(knownCommands));

                break;
            }
            case 'INVITE': {
                let nick = argv.shift();
                if (!nick) {
                    this._createFeedbackUsage(cmd);
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
            case 'JOIN': {
                let room = argv.shift();
                if (!room) {
                    output = this._createFeedbackUsage(cmd);
                    break;
                }
                if (argv.length)
                    log('Excess arguments to JOIN command: ' + argv);

                let time = Gdk.CURRENT_TIME;
                let account = this._room.channel.connection.get_account();
                let req = Tp.AccountChannelRequest.new_text(account, time);

                let preferredHandler = Tp.CLIENT_BUS_NAME_BASE + 'Polari';
                req.set_target_id(Tp.HandleType.ROOM, room);
                req.set_delegate_to_preferred_handler(true);
                req.ensure_channel_async(preferredHandler, null, Lang.bind(this,
                    function(req, res) {
                        try {
                            req.ensure_channel_finish(res);
                        } catch(e) {
                            logError(e, 'Failed to join channel');
                        }
                    }));
                break;
            }
            case 'KICK': {
                let nick = argv.shift();
                if (!nick) {
                    output = this._createFeedbackUsage(cmd);
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
                    break;
                }
                if (argv.length)
                    log('Excess arguments to NICK command: ' + argv);

                let account = this._room.channel.connection.get_account();
                account.set_nickname_async(nick, Lang.bind(this,
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
                let reason = Tp.ChannelGroupChangeReason.NONE;
                let message = argv.join(' ') || '';
                room.channel.leave_async(reason, message, Lang.bind(this,
                    function(c, res) {
                        try {
                            c.leave_finish(res);
                        } catch(e) {
                            logError(e, 'Failed to leave channel');
                        }
                    }));
                break;
            }
            case 'QUERY': {
                let nick = argv.shift();
                if (!nick) {
                    output = this._createFeedbackUsage(cmd);
                    break;
                }

                let time = Gdk.CURRENT_TIME;
                let account = this._room.channel.connection.get_account();
                let req = Tp.AccountChannelRequest.new_text(account, time);
                let preferredHandler = Tp.CLIENT_BUS_NAME_BASE + 'Polari';
                req.set_target_id(Tp.HandleType.CONTACT, nick);
                req.set_delegate_to_preferred_handler(true);
                req.ensure_channel_async(preferredHandler, null, Lang.bind(this,
                    function(req, res) {
                        try {
                            req.ensure_channel_finish(res);
                        } catch(e) {
                            logError(e, 'Failed to open private chat');
                        }
                    }));
                break;
            }
            case 'QUIT': {
                let account = this._room.channel.connection.get_account();
                let presence = Tp.ConnectionPresenceType.OFFLINE;
                let message = stripCommand(text);
                account.request_presence_async(presence, '', message,
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
                    break;
                }
                let raw = stripCommand(text);
                let type = Tp.ChannelTextMessageType.NORMAL;
                let message = Tp.ClientMessage.new_text(type, raw);
                this._sendMessage(message);
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
                output = this._createFeedbackLabel(UNKNOWN_COMMAND_MESSAGE);
                break;
        }

        if (output)
            this._app.commandOutputQueue.addNotification(output);
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
