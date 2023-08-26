// SPDX-FileCopyrightText: 2013 Florian Müllner <fmuellner@gnome.org>
// SPDX-FileCopyrightText: 2016 Kunaal Jain <kunaalus@gmail.com>
// SPDX-FileCopyrightText: 2020 Roberto Sánchez Fernández <robertosanchez_9@hotmail.com>
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';
import Tp from 'gi://TelepathyGLib';

const Signals = imports.signals;

import RoomManager from './roomManager.js';
import * as Utils from './utils.js';

Gio._promisify(Tp.Account.prototype,
    'request_presence_async', 'request_presence_finish');
Gio._promisify(Tp.Connection.prototype,
    'dup_contact_by_id_async', 'dup_contact_by_id_finish');
Gio._promisify(Tp.Contact.prototype,
    'request_contact_info_async', 'request_contact_info_finish');

const N_ = s => s;

export const knownCommands = {
    /* commands that would be nice to support: */
    /*
    AWAY: N_("/AWAY [<message>] — sets or unsets away message"),
    LIST: N_("/LIST [<channel>] — lists stats on <channel>, or all channels on the server"),
    MODE: "/MODE <mode> <nick|channel> — ",
    NOTICE: N_("/NOTICE <nick|channel> <message> — sends notice to <nick|channel>"),
    OP: N_("/OP <nick> — gives channel operator status to <nick>"),

    */
    CLOSE: N_('/CLOSE [<channel>] [<reason>] — closes <channel>, by default the current one'),
    HELP: N_('/HELP [<command>] — displays help for <command>, or a list of available commands'),
    INVITE: N_('/INVITE <nick> [<channel>] — invites <nick> to <channel>, or the current one'),
    JOIN: N_('/JOIN <channel> — joins <channel>'),
    KICK: N_('/KICK <nick> — kicks <nick> from current channel'),
    ME: N_('/ME <action> — sends <action> to the current channel'),
    MSG: N_('/MSG <nick> [<message>] — sends a private message to <nick>'),
    NAMES: N_('/NAMES — lists users on the current channel'),
    NICK: N_('/NICK <nickname> — sets your nick to <nickname>'),
    PART: N_('/PART [<channel>] [<reason>] — leaves <channel>, by default the current one'),
    QUERY: N_('/QUERY <nick> — opens a private conversation with <nick>'),
    QUIT: N_('/QUIT [<reason>] — disconnects from the current server'),
    SAY: N_('/SAY <text> — sends <text> to the current room/contact'),
    TOPIC: N_('/TOPIC <topic> — sets the topic to <topic>, or shows the current one'),
    WHOIS: N_('/WHOIS <nick> — requests information on <nick>'),
};
const UNKNOWN_COMMAND_MESSAGE =
    N_('Unknown command — try /HELP for a list of available commands');

const ROOM_PREFIXES = ['#', '&', '+', '!'];

export default class IrcParser {
    constructor(entry, room) {
        this._app = Gio.Application.get_default();
        this._roomManager = RoomManager.getDefault();
        this._room = room;
        this._entry = entry;

        this._entry.connect('activate', async () => {
            if (await this._process(this._entry.text)) {
                this._entry.text = '';
            } else {
                this._entry.add_css_class('error');
                this._entry.grab_focus(); // select text
            }
        });

        this._feedback = new FeedbackPopover();
        this._feedback.set_parent(this._entry);
    }

    async _process(text) {
        if (!this._room || !this._room.channel || !text.length)
            return true;

        if (text[0] !== '/') {
            this._sendText(text);
            return true;
        }

        let stripCommand = txt => txt.substr(txt.indexOf(' ')).trimLeft();

        let retval = true;

        let argv = text.trimRight().substr(1).split(/ +/);
        let cmd = argv.shift().toUpperCase();
        switch (cmd) {
        case 'HELP': {
            let command = argv.shift();
            if (command)
                command = command.toUpperCase();

            retval = !command || knownCommands[command];

            if (!retval) {
                this._feedback.showFeedback(_(UNKNOWN_COMMAND_MESSAGE));
            } else if (command) {
                this._feedback.showUsage(command);
            } else {
                this._feedback.showGrid(
                    _('Known commands:'), Object.keys(knownCommands));
            }
            break;
        }
        case 'INVITE': {
            let nick = argv.shift();
            if (!nick) {
                this._feedback.showUsage(cmd);
                retval = false;
                break;
            }
            try {
                let connection = this._room.channel.connection;
                let contact = await connection.dup_contact_by_id_async(nick);
                this._room.add_member(contact);
            } catch (e) {
                logError(e, `Failed to get contact for ${nick}`);
                retval = false;
            }
            break;
        }
        case 'J':
        case 'JOIN': {
            let room = argv.shift();
            if (!room) {
                this._feedback.showUsage(cmd);
                retval = false;
                break;
            }
            if (argv.length)
                console.warn(`Excess arguments to JOIN command: ${argv}`);
            if (!ROOM_PREFIXES.some(prefix => room.startsWith(prefix)))
                room = `#${room}`;
            let {account} = this._room;
            let app = Gio.Application.get_default();
            let action = app.lookup_action('join-room');
            action.activate(GLib.Variant.new('(ssb)', [
                account.get_object_path(),
                room,
                true,
            ]));
            break;
        }
        case 'KICK': {
            let nick = argv.shift();
            if (!nick) {
                this._feedback.showUsage(cmd);
                retval = false;
                break;
            }
            try {
                let connection = this._room.channel.connection;
                let contact = await connection.dup_contact_by_id_async(nick);
                this._room.remove_member(contact);
            } catch (e) {
                logError(e, `Failed to get contact for ${nick}`);
                retval = false;
            }
            break;
        }
        case 'ME': {
            if (!argv.length) {
                this._feedback.showUsage(cmd);
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
                this._feedback.showUsage(cmd);
                retval = false;
                break;
            }

            let {account} = this._room;

            let app = Gio.Application.get_default();
            let action = app.lookup_action('message-user');
            action.activate(GLib.Variant.new('(sssb)', [
                account.get_object_path(),
                nick,
                message,
                false,
            ]));
            break;
        }
        case 'NAMES': {
            this._app.activate_action('user-list', null);
            break;
        }
        case 'NICK': {
            let nick = argv.shift();
            if (!nick) {
                this._feedback.showUsage(cmd);
                retval = false;
                break;
            }
            if (argv.length)
                console.warn(`Excess arguments to NICK command: ${argv}`);

            this._app.setAccountNick(this._room.account, nick);
            break;
        }
        case 'PART':
        case 'CLOSE': {
            let room = null;
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
                this._feedback.showUsage(cmd);
                retval = false;
                break;
            }

            let {account} = this._room;

            let app = Gio.Application.get_default();
            let action = app.lookup_action('message-user');
            action.activate(GLib.Variant.new('(sssb)', [
                account.get_object_path(),
                nick,
                '',
                true,
            ]));
            break;
        }
        case 'QUIT': {
            let presence = Tp.ConnectionPresenceType.OFFLINE;
            let message = stripCommand(text);
            try {
                await this._room.account.request_presence_async(presence, 'offline', message);
            } catch (e) {
                logError(e, 'Failed to disconnect');
                retval = false;
            }
            break;
        }
        case 'SAY': {
            if (!argv.length) {
                this._feedback.showUsage(cmd);
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
                this._feedback.showFeedback(this._room.topic || _('No topic set'));
            break;
        }
        case 'WHOIS': {
            if (!argv.length) {
                this._feedback.showUsage(cmd);
                retval = false;
                break;
            }

            let nick = stripCommand(text);
            const {connection} = this._room.channel;
            const user = await connection.dup_contact_by_id_async(nick, []);
            const status = await user.request_contact_info_async(null);
            this._feedback.showFeedback(this._formatUserInfo(status, user));
            break;
        }
        default:
            this._feedback.showFeedback(_(UNKNOWN_COMMAND_MESSAGE));
            retval = false;
            break;
        }

        return retval;
    }

    _formatUserInfo(status, user) {
        let fn, last;
        if (status) {
            let info = user.get_contact_info();
            for (let i = 0; i < info.length; i++) {
                if (info[i].field_name === 'fn')
                    [fn] = info[i].field_value;
                else if (info[i].field_name === 'x-idle-time')
                    [last] = info[i].field_value;
            }
        }
        return vprintf(_('User: %s - Last activity: %s'), fn ? fn : user.alias, Utils.formatTimePassed(last));
    }

    _sendText(text) {
        let type = Tp.ChannelTextMessageType.NORMAL;
        let message = Tp.ClientMessage.new_text(type, text);
        this._sendMessage(message);
    }

    async _sendMessage(message) {
        try {
            await this._room.channel.send_message_async(message, 0);
        } catch (e) {
            // TODO: propagate to user
            logError(e, 'Failed to send message');
        }
    }
}
Signals.addSignalMethods(IrcParser.prototype);

const FeedbackPopover = GObject.registerClass(
class FeedbackPopover extends Gtk.Popover {
    constructor() {
        super({
            position: Gtk.PositionType.TOP,
        });

        this._stack = new Gtk.Stack({
            vhomogeneous: false,
        });

        this._feedbackLabel = new Gtk.Label({
            wrap: true,
        });
        this._stack.add_child(this._feedbackLabel);

        this._feedbackGrid = new Gtk.Grid({
            column_homogeneous: true,
            row_spacing: 6,
            column_spacing: 18,
        });
        this._stack.add_child(this._feedbackGrid);

        this.set_child(this._stack);
    }

    showFeedback(label) {
        this._feedbackLabel.set({label});
        this._stack.visible_child = this._feedbackLabel;
        this.popup();
    }

    showUsage(cmd) {
        this.showFeedback(vprintf(_('Usage: %s'), _(knownCommands[cmd])));
    }

    showGrid(header, items) {
        const grid = this._feedbackGrid;
        [...grid].forEach(w => grid.remove(w));

        const numItems = items.length;
        const numCols = Math.min(numItems, 4);
        const numRows = Math.floor(numItems / numCols) + numItems % numCols;

        grid.attach(new Gtk.Label({label: header}), 0, 0, numCols, 1);

        let row = 1;
        for (let i = 0; i < numRows; i++) {
            for (let j = 0; j < numCols; j++) {
                const item = items[i + j * numRows];
                if (!item)
                    continue;
                const w = new Gtk.Label({label: item});
                grid.attach(w, j, row, 1, 1);
            }
            row++;
        }

        this._stack.visible_child = grid;
        this.popup();
    }
});
