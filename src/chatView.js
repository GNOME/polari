const Gdk = imports.gi.Gdk;
const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const Gtk = imports.gi.Gtk;
const Pango = imports.gi.Pango;
const Tp = imports.gi.TelepathyGLib;
const Tpl = imports.gi.TelepathyLogger;

const Lang = imports.lang;
const Mainloop = imports.mainloop;
const Utils = imports.utils;

const MAX_NICK_CHARS = 8;
const IGNORE_STATUS_TIME = 5;
const TP_CURRENT_TIME = GLib.MAXUINT32;

const SCROLL_TIMEOUT = 100; // ms

const TIMESTAMP_INTERVAL = 300; // seconds of inactivity after which to
                                // insert a timestamp

const NUM_INITIAL_LOG_EVENTS = 50; // number of log events to fetch on start
const NUM_LOG_EVENTS = 10; // number of log events to fetch when requesting more

const INDICATOR_OFFSET = 5; // TODO: should be based on line spacing

// Workaround for GtkTextView growing horizontally over time when
// added to a GtkScrolledWindow with horizontal scrolling disabled
const TextView = new Lang.Class({
    Name: 'TextView',
    Extends: Gtk.TextView,

    _init: function(params) {
        this.parent(params);

        this.buffer.connect('mark-set', Lang.bind(this, this._onMarkSet));
    },

    vfunc_get_preferred_width: function() {
        return [1, 1];
    },

    vfunc_style_updated: function() {
        let context = this.get_style_context();
        context.save();
        context.add_class('dim-label');
        this._dimColor = context.get_color(Gtk.StateFlags.NORMAL);
        context.restore();
    },

    vfunc_draw: function(cr) {
        this.parent(cr);

        let mark = this.buffer.get_mark('indicator-line');
        if (!mark)
            return;

        let iter = this.buffer.get_iter_at_mark(mark);
        let location = this.get_iter_location(iter);
        let [, y] = this.buffer_to_window_coords(Gtk.TextWindowType.TEXT,
                                                 location.x, location.y);

        Gdk.cairo_set_source_rgba(cr, this._dimColor);
        cr.rectangle(0, y + INDICATOR_OFFSET, this.get_allocated_width(), 1);
        cr.fill();
        cr.$dispose();
    },

    _onMarkSet: function(buffer, iter, mark) {
        if (mark.name == 'indicator-line')
            this.queue_draw();
    }
});

const ChatView = new Lang.Class({
    Name: 'ChatView',

    _init: function(room) {
        this._createWidget();
        this._createTags();

        this.widget.connect('style-updated',
                            Lang.bind(this, this._onStyleUpdated));

        this._room = room;
        this._state = { lastNick: null, lastTimestamp: 0 };
        this._active = false;
        this._toplevelFocus = false;
        this._joinTime = GLib.DateTime.new_now_utc().to_unix();
        this._maxNickChars = MAX_NICK_CHARS;
        this._hoveringLink = false;
        this._needsIndicator = true;
        this._pending = {};
        this._pendingLogs = [];

        let isRoom = room.type == Tp.HandleType.ROOM;
        let target = new Tpl.Entity({ type: isRoom ? Tpl.EntityType.ROOM
                                                   : Tpl.EntityType.CONTACT,
                                      identifier: room.channel_name });
        let logManager = Tpl.LogManager.dup_singleton();
        this._logWalker =
            logManager.walk_filtered_events(room.account, target,
                                            Tpl.EventTypeMask.TEXT, null);

        this._fetchingBacklog = true;
        this._logWalker.get_events_async(NUM_INITIAL_LOG_EVENTS,
                                         Lang.bind(this, this._onLogEventsReady));

        let adj = this.widget.vadjustment;
        this._scrollBottom = adj.upper - adj.page_size;

        this._app = Gio.Application.get_default();
        this._app.pasteManager.addWidget(this._view);

        this._linkCursor = Gdk.Cursor.new(Gdk.CursorType.HAND1);

        this._channelSignals = [];

        let roomSignals = [
            { name: 'notify::channel',
              handler: Lang.bind(this, this._onChannelChanged) },
            { name: 'member-renamed',
              handler: Lang.bind(this, this._onMemberRenamed) },
            { name: 'member-disconnected',
              handler: Lang.bind(this, this._onMemberDisconnected) },
            { name: 'member-kicked',
              handler: Lang.bind(this, this._onMemberKicked) },
            { name: 'member-banned',
              handler: Lang.bind(this, this._onMemberBanned) },
            { name: 'member-joined',
              handler: Lang.bind(this, this._onMemberJoined) },
            { name: 'member-left',
              handler: Lang.bind(this, this._onMemberLeft) }
        ];
        this._roomSignals = [];
        roomSignals.forEach(Lang.bind(this, function(signal) {
            this._roomSignals.push(room.connect(signal.name, signal.handler));
        }));
    },

    _createTags: function() {
        let buffer = this._view.get_buffer();
        let tagTable = buffer.get_tag_table();
        let tags = [
          { name: 'nick',
            left_margin: 0 },
          { name: 'gap',
            pixels_above_lines: 10 },
          { name: 'message',
            indent: 0 },
          { name: 'highlight',
            weight: Pango.Weight.BOLD },
          { name: 'status',
            left_margin: 0,
            indent: 0,
            justification: Gtk.Justification.RIGHT },
          { name: 'timestamp',
            left_margin: 0,
            indent: 0,
            weight: Pango.Weight.BOLD,
            justification: Gtk.Justification.RIGHT },
          { name: 'action',
            left_margin: 0 },
          { name: 'url',
            underline: Pango.Underline.SINGLE
          }
        ];
        tags.forEach(function(tagProps) {
            tagTable.add(new Gtk.TextTag(tagProps));
        });
    },

    _onStyleUpdated: function() {
        let context = this.widget.get_style_context();
        context.save();
        context.add_class('dim-label');
        let dimColor = context.get_color(Gtk.StateFlags.NORMAL);
        let selectedColor = context.get_background_color(Gtk.StateFlags.SELECTED);
        context.restore();

        let [found, linkColor] = context.lookup_color("link_color");
        if (!found) {
            linkColor = new Gdk.RGBA();
            linkColor.parse('blue');
        }

        let buffer = this._view.get_buffer();
        let tagTable = buffer.get_tag_table();
        let tags = [
          { name: 'nick',
            foreground_rgba: selectedColor },
          { name: 'status',
            foreground_rgba: dimColor },
          { name: 'timestamp',
            foreground_rgba: dimColor },
          { name: 'action',
            foreground_rgba: dimColor },
          { name: 'url',
            foreground_rgba: linkColor }
        ];
        tags.forEach(function(tagProps) {
            let tag = tagTable.lookup(tagProps.name);
            for (let prop in tagProps) {
                if (prop == 'name')
                    continue;
                tag[prop] = tagProps[prop];
            }
        });
    },

    _createWidget: function() {
        this.widget = new Gtk.ScrolledWindow({ vexpand: true });
        this.widget.hscrollbar_policy = Gtk.PolicyType.NEVER;
        this.widget.resize_mode = Gtk.ResizeMode.QUEUE;

        this._view = new TextView({ editable: false, cursor_visible: false,
                                    visible: true,
                                    wrap_mode: Gtk.WrapMode.WORD_CHAR });
        this._view.set_border_window_size(Gtk.TextWindowType.TOP, 6);
        this._view.set_border_window_size(Gtk.TextWindowType.BOTTOM, 6);
        this._view.set_border_window_size(Gtk.TextWindowType.LEFT, 6);
        this._view.set_border_window_size(Gtk.TextWindowType.RIGHT, 6);

        this.widget.add(this._view);
        this.widget.show_all();

        this.widget.connect('destroy', Lang.bind(this, this._onDestroy));
        this.widget.connect('screen-changed',
                            Lang.bind(this, this._updateIndent));
        this.widget.connect('map', Lang.bind(this, this._updateActive));
        this.widget.connect('unmap', Lang.bind(this, this._updateActive));
        this.widget.connect('state-flags-changed',
                            Lang.bind(this, this._updateToplevel));
        this.widget.connect('scroll-event', Lang.bind(this ,this._onScroll));
        this.widget.vadjustment.connect('value-changed',
                                        Lang.bind(this, this._onValueChanged));
        this.widget.vadjustment.connect('changed',
                                 Lang.bind(this, this._updateScroll));
        this._view.connect('button-release-event',
                           Lang.bind(this, this._handleLinkClicks));
        this._view.connect('button-press-event',
                           Lang.bind(this, this._handleLinkClicks));
        this._view.connect('motion-notify-event',
                           Lang.bind(this, this._handleLinkHovers));
    },

    _onDestroy: function() {
        for (let i = 0; i < this._channelSignals.length; i++)
            this._room.channel.disconnect(this._channelSignals[i]);
        this._channelSignals = [];

        for (let i = 0; i < this._roomSignals.length; i++)
            this._room.disconnect(this._roomSignals[i]);
        this._roomSignals = [];
    },

    _onLogEventsReady: function(lw, res) {
        let [, events] = lw.get_events_finish(res);
        this._pendingLogs = events.concat(this._pendingLogs);
        this._insertPendingLogs();
        this._fetchingBacklog = false;
    },

    _insertPendingLogs: function() {
        if (this._pendingLogs.length == 0)
            return;

        let index = -1;
        let nick = this._pendingLogs[0].sender.alias;
        let type = this._pendingLogs[0].message_type;
        if (!this._logWalker.is_end()) {
            for (let i = 0; i < this._pendingLogs.length; i++)
                if (this._pendingLogs[i].sender.alias != nick ||
                    this._pendingLogs[i].message_type != type) {
                    index = i;
                    break;
                }
        } else {
            index = 0;
        }

        if (index < 0)
            return;

        let pending = this._pendingLogs.splice(index);
        let state = { lastNick: null, lastTimestamp: 0 };
        let iter = this._view.buffer.get_start_iter();
        for (let i = 0; i < pending.length; i++) {
            let message = { nick: pending[i].sender.alias,
                            text: pending[i].message,
                            timestamp: pending[i].timestamp,
                            messageType: pending[i].get_message_type(),
                            shouldHighlight: false };
            this._insertMessage(iter, message, state);
            if (!iter.is_end() || i < pending.length - 1)
                this._view.buffer.insert(iter, '\n', -1);
        }
    },

    get _nPending() {
        return Object.keys(this._pending).length;
    },

    _updateIndent: function() {
        let context = this._view.get_pango_context();
        let metrics = context.get_metrics(null, null);
        let charWidth = Math.max(metrics.get_approximate_char_width(),
                                 metrics.get_approximate_digit_width());
        let pixelWidth = Pango.units_to_double(charWidth);

        let tabs = Pango.TabArray.new(1, true);
        tabs.set_tab(0, Pango.TabAlign.LEFT, this._maxNickChars * pixelWidth);
        this._view.tabs = tabs;
        this._view.indent = -this._maxNickChars * pixelWidth;
        this._view.left_margin = this._maxNickChars * pixelWidth;
    },

    _updateActive: function() {
        let active = this.widget.get_mapped();
        if (this._active == active)
            return;
        this._active = active;
        this._checkMessages();
    },

    _updateToplevel: function() {
        let flags = this.widget.get_state_flags();
        let toplevelFocus = !(flags & Gtk.StateFlags.BACKDROP);
        if (this._toplevelFocus == toplevelFocus)
            return;
        this._toplevelFocus = toplevelFocus;
        this._checkMessages();
    },

    _updateScroll: function() {
        let adj = this.widget.vadjustment;
        if (adj.value == this._scrollBottom) {
            if (this._nPending == 0) {
                adj.value = adj.upper - adj.page_size;
            } else {
                let id = Object.keys(this._pending).sort(function(a, b) {
                    return a - b;
                })[0];
                this._view.scroll_mark_onscreen(this._pending[id]);
            }
        }
        this._scrollBottom = adj.upper - adj.page_size;
    },

    _onScroll: function(w, event) {
        let [, dir] = event.get_scroll_direction();

        if (this._fetchingBacklog ||
            this.widget.vadjustment.value != 0 ||
            dir != Gdk.ScrollDirection.UP ||
            this._logWalker.is_end())
            return false;

        this._fetchingBacklog = true;
        Mainloop.timeout_add(500, Lang.bind(this,
            function() {
                this._logWalker.get_events_async(NUM_LOG_EVENTS,
                                                 Lang.bind(this, this._onLogEventsReady));
                return false;
            }));
        return false;
    },

    _onValueChanged: function() {
        if (this._valueChangedId)
            return;

        this._valueChangedId = Mainloop.timeout_add(SCROLL_TIMEOUT, Lang.bind(this,
            function() {
                this._checkMessages();
                this._valueChangedId = 0;
                return false;
            }));
    },

    _pendingMessageRemoved: function(channel, message) {
        let [id,] = message.get_pending_message_id();
        if (this._pending[id])
            this._view.buffer.delete_mark(this._pending[id]);
        this._app.withdraw_notification('pending-message-' + id);
        delete this._pending[id];
    },

    _handleLinkClicks: function(view, event) {
        let [, button] = event.get_button();
        if (button != Gdk.BUTTON_PRIMARY)
            return false;

        let isPress = event.get_event_type() == Gdk.EventType.BUTTON_PRESS;

        if (isPress)
            this._clickedUrl = null;

        let [, eventX, eventY] = event.get_coords();
        let [x, y] = view.window_to_buffer_coords(Gtk.TextWindowType.WIDGET,
                                                  eventX, eventY);

        let iter = view.get_iter_at_location(x, y);
        let tags = iter.get_tags();
        for (let i = 0; i < tags.length; i++) {
            let url = tags[i]._url;
            if (url) {
                if (isPress) {
                    this._clickedUrl = url;
                    return true;
                } else if (this._clickedUrl == url) {
                    if (url.indexOf(':') == -1)
                        url = 'http://' + url;
                    Gio.AppInfo.launch_default_for_uri(url, null);
                    return true;
                }
                break;
            }
        }
        return false;
    },

    _handleLinkHovers: function(view, event) {
        let [, eventX, eventY] = event.get_coords();
        let [x, y] = view.window_to_buffer_coords(Gtk.TextWindowType.WIDGET,
                                                  eventX, eventY);
        let iter = view.get_iter_at_location(x, y);
        let tags = iter.get_tags();
        let hovering = false;
        for (let i = 0; i < tags.length && !hovering; i++)
            if (tags[i]._url)
                hovering = true;

        if (this._hoveringLink != hovering) {
            this._hoveringLink = hovering;
            let cursor = this._hoveringLink ? this._linkCursor : null;
            this._view.get_window(Gtk.TextWindowType.TEXT).set_cursor(cursor);
        }
        return false;
    },

    _checkMessages: function() {
        if (!this._active || !this._toplevelFocus || !this._room.channel)
            return;

        this._needsIndicator = true;

        let pending = this._room.channel.dup_pending_messages();
        if (pending.length == 0)
            return;

        let rect = this._view.get_visible_rect();
        let buffer = this._view.get_buffer();
        for (let i = 0; i < pending.length; i++) {
            let [id,] = pending[i].get_pending_message_id();
            let mark = this._pending[id];
            if (!mark) {
                this._room.channel.ack_message_async(pending[i], null);
                continue;
            }
            let iter = buffer.get_iter_at_mark(mark);
            let iterRect = this._view.get_iter_location(iter);
            if (rect.y <= iterRect.y && rect.y + rect.height > iterRect.y)
                this._room.channel.ack_message_async(pending[i], null);
        }
    },

    _onChannelChanged: function() {
        if (!this._room.channel) {
            this._channelSignals = [];
            return;
        }

        for (let i = 0; i < this._channelSignals.length; i++)
            this._room.channel.disconnect(this._channelSignals[i]);
        this._channelSignals = [];

        let channelSignals = [
            { name: 'message-received',
              handler: Lang.bind(this, this._insertTpMessage) },
            { name: 'message-sent',
              handler: Lang.bind(this, this._insertTpMessage) },
            { name: 'pending-message-removed',
              handler: Lang.bind(this, this._pendingMessageRemoved) }
        ];
        channelSignals.forEach(Lang.bind(this, function(signal) {
            this._channelSignals.push(this._room.channel.connect(signal.name, signal.handler));
        }));

        this._room.channel.dup_pending_messages().forEach(Lang.bind(this,
            function(message) {
                this._insertTpMessage(this._room, message);
            }));
        this._checkMessages();
    },

    _onMemberRenamed: function(room, oldMember, newMember) {
        this._insertStatus(_("%s is now known as %s").format(oldMember.alias,
                                                             newMember.alias));
    },

    _onMemberDisconnected: function(room, member, message) {
        let text = _("%s has disconnected").format(member.alias);
        if (message)
            text += ' (%s)'.format(message);
        this._insertStatus(text);
    },

    _onMemberKicked: function(room, member, actor) {
        let message =
            actor ? _("%s has been kicked by %s").format(member.alias,
                                                         actor.alias)
                  : _("%s has been kicked").format(member.alias);
        this._insertStatus(message);
    },

    _onMemberBanned: function(room, member, actor) {
        let message =
            actor ? _("%s has been banned by %s").format(member.alias,
                                                         actor.alias)
                  : _("%s has been banned").format(member.alias)
        this._insertStatus(message);
    },

    _onMemberJoined: function(room, member) {
        this._insertStatus(_("%s joined").format(member.alias));
    },

    _onMemberLeft: function(room, member, message) {
        let text = _("%s left").format(member.alias);
        if (message)
            text += ' (%s)'.format(message);
        this._insertStatus(text);
    },

    _insertStatus: function(text) {
        let time = GLib.DateTime.new_now_utc().to_unix();
        if (time - this._joinTime < IGNORE_STATUS_TIME)
            return;
        this._state.lastNick = null;
        this._ensureNewLine();
        let iter = this._view.buffer.get_end_iter();
        this._insertWithTagName(iter, text, 'status');
    },

    _formatTimestamp: function(timestamp) {
        let date = GLib.DateTime.new_from_unix_local(timestamp);
        let now = GLib.DateTime.new_now_local();

        let daysAgo = now.difference(date) / GLib.TIME_SPAN_DAY;

        let format;
        let desktopSettings = new Gio.Settings({ schema: 'org.gnome.desktop.interface' });
        let clockFormat = desktopSettings.get_string('clock-format');

        switch (clockFormat) {
            case '24h':
                if(daysAgo < 1) { // today
                    /* Translators: Time in 24h format */
                    format = _("%H\u2236%M");
                } else if(daysAgo <2) { // yesterday
                    /* Translators: this is the word "Yesterday" followed by a
                     time string in 24h format. i.e. "Yesterday, 14:30" */
                    // xgettext:no-c-format
                    format = _("Yesterday, %H\u2236%M");
                } else if (daysAgo < 7) { // this week
                    /* Translators: this is the week day name followed by a time
                     string in 24h format. i.e. "Monday, 14:30" */
                    // xgettext:no-c-format
                    format = _("%A, %H\u2236%M");
                } else if (date.get_year() == now.get_year()) { // this year
                    /* Translators: this is the month name and day number
                     followed by a time string in 24h format.
                     i.e. "May 25, 14:30" */
                    // xgettext:no-c-format
                    format = _("%B %d, %H\u2236%M");
                } else { // before this year
                    /* Translators: this is the month name, day number, year
                     number followed by a time string in 24h format.
                     i.e. "May 25 2012, 14:30" */
                    // xgettext:no-c-format
                    format = _("%B %d %Y, %H\u2236%M");
                }
                break;
        default:
            // explicit fall-through
            case '12h':
                if(daysAgo < 1) { // today
                    /* Translators: Time in 12h format */
                    format = _("%l\u2236%M %p");
                } else if(daysAgo <2) { // yesterday
                    /* Translators: this is the word "Yesterday" followed by a
                     time string in 12h format. i.e. "Yesterday, 2:30 pm" */
                    // xgettext:no-c-format
                    format = _("Yesterday, %l\u2236%M %p");
                } else if (daysAgo < 7) { // this week
                    /* Translators: this is the week day name followed by a time
                     string in 12h format. i.e. "Monday, 2:30 pm" */
                    // xgettext:no-c-format
                    format = _("%A, %l\u2236%M %p");
                } else if (date.get_year() == now.get_year()) { // this year
                    /* Translators: this is the month name and day number
                     followed by a time string in 12h format.
                     i.e. "May 25, 2:30 pm" */
                    // xgettext:no-c-format
                    format = _("%B %d, %l\u2236%M %p");
                } else { // before this year
                    /* Translators: this is the month name, day number, year
                     number followed by a time string in 12h format.
                     i.e. "May 25 2012, 2:30 pm"*/
                    // xgettext:no-c-format
                    format = _("%B %d %Y, %l\u2236%M %p");
                }
                break;
        }

        return date.format(format);
    },

    _insertTpMessage: function(room, tpMessage) {
        let [text, flags] = tpMessage.to_text();

        let message = { nick: tpMessage.sender.alias,
                        text: text,
                        messageType: tpMessage.get_message_type() };

        let timestamp = tpMessage.get_sent_timestamp();
        if (!timestamp)
            timestamp = tpMessage.get_received_timestamp();
        message.timestamp = timestamp;

        message.shouldHighlight = this._room.should_highlight_message(tpMessage);

        this._ensureNewLine();

        let iter = this._view.buffer.get_end_iter();
        this._insertMessage(iter, message, this._state);

        let [id, valid] = tpMessage.get_pending_message_id();

        if (message.shouldHighlight && !this._toplevelFocus) {
            let summary = '%s %s'.format(this._room.display_name, message.nick);
            let notification = new Gio.Notification();
            notification.set_title(summary);
            notification.set_body(message.text);

            let account = this._room.account;
            let param = GLib.Variant.new('(ssu)',
                                         [ account.get_object_path(),
                                           this._room.channel_name,
                                           TP_CURRENT_TIME ]);
            notification.set_default_action_and_target('app.join-room', param);
            this._app.send_notification('pending-message-' + id, notification);
        }

        let buffer = this._view.get_buffer();
        if (!valid /* outgoing */ ||
            (this._active && this._toplevelFocus && this._nPending == 0)) {
            this._room.channel.ack_message_async(tpMessage, null);
        } else if (message.shouldHighlight || this._needsIndicator) {
            let iter = buffer.get_end_iter();

            if (message.shouldHighlight) {
                let mark = buffer.create_mark(null, iter, true);
                this._pending[id] = mark;
            }

            if (this._needsIndicator) {
                iter.set_line_offset(0);

                let mark = buffer.get_mark('indicator-line');
                if (!mark)
                    buffer.create_mark('indicator-line', iter, true);
                else
                    buffer.move_mark(mark, iter);
                this._needsIndicator = false;
            }
        }
    },

    _insertMessage: function(iter, message, state) {
        let isAction = message.messageType == Tp.ChannelTextMessageType.ACTION;
        let needsGap = message.nick != state.lastNick || isAction;

        if (message.timestamp - TIMESTAMP_INTERVAL > state.lastTimestamp) {
            let tags = [this._lookupTag('timestamp')];
            if (needsGap)
                tags.push(this._lookupTag('gap'));
            needsGap = false;
            this._insertWithTags(iter,
                                 this._formatTimestamp(message.timestamp) + '\n',
                                 tags);
        }
        state.lastTimestamp = message.timestamp;

        if (message.nick.length > this._maxNickChars) {
            this._maxNickChars = message.nick.length;
            this._updateIndent();
        }

        let tags = [];
        if (isAction) {
            message.text = "%s %s".format(message.nick, message.text);
            state.lastNick = null;
            tags.push(this._lookupTag('action'));
            if (needsGap)
                tags.push(this._lookupTag('gap'));
        } else {
            if (state.lastNick != message.nick) {
                let tags = [this._lookupTag('nick')];
                if (needsGap)
                    tags.push(this._lookupTag('gap'));
                this._insertWithTags(iter, message.nick + '\t', tags);
            }
            state.lastNick = message.nick;
            tags.push(this._lookupTag('message'));
        }

        if (message.shouldHighlight)
            tags.push(this._lookupTag('highlight'));

        let text = message.text;
        let urls = Utils.findUrls(text);
        let pos = 0;
        for (let i = 0; i < urls.length; i++) {
            let url = urls[i];
            this._insertWithTags(iter, text.substr(pos, url.pos - pos), tags);

            let tag = new Gtk.TextTag();
            tag._url = url.url;
            this._view.get_buffer().tag_table.add(tag);

            this._insertWithTags(iter, url.url,
                                 tags.concat(this._lookupTag('url'), tag));

            pos = url.pos + url.url.length;
        }
        this._insertWithTags(iter, text.substr(pos), tags);
    },

    _ensureNewLine: function() {
        let buffer = this._view.get_buffer();
        let iter = buffer.get_end_iter();
        if (iter.get_line_offset() != 0)
            buffer.insert(iter, '\n', -1);
    },

    _lookupTag: function(name) {
        return this._view.get_buffer().tag_table.lookup(name);
    },

    _insertWithTagName: function(iter, text, name) {
        this._insertWithTags(iter, text, [this._lookupTag(name)]);
    },

    _insertWithTags: function(iter, text, tags) {
        let buffer = this._view.get_buffer();
        let offset = iter.get_offset();

        buffer.insert(iter, text, -1);

        let start = buffer.get_iter_at_offset(offset);

        buffer.remove_all_tags(start, iter);
        for (let i = 0; i < tags.length; i++)
            buffer.apply_tag(tags[i], start, iter);
    }
});
