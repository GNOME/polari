const Gdk = imports.gi.Gdk;
const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;
const Pango = imports.gi.Pango;
const PangoCairo = imports.gi.PangoCairo;
const Polari = imports.gi.Polari;
const Tp = imports.gi.TelepathyGLib;
const Tpl = imports.gi.TelepathyLogger;

const Lang = imports.lang;
const Mainloop = imports.mainloop;
const PasteManager = imports.pasteManager;
const Signals = imports.signals;
const Utils = imports.utils;
const UserTracker = imports.userTracker;
const UserList = imports.userList;
const ChatroomManager = imports.chatroomManager;

const MAX_NICK_CHARS = 8;
const IGNORE_STATUS_TIME = 5;

const SCROLL_TIMEOUT = 100; // ms

const TIMESTAMP_INTERVAL = 300; // seconds of inactivity after which to
                                // insert a timestamp

const INACTIVITY_THRESHOLD = 300; // a threshold in seconds used to control
                                  // the visibility of status messages
const STATUS_NOISE_MAXIMUM = 4;

const NUM_INITIAL_LOG_EVENTS = 50; // number of log events to fetch on start
const NUM_LOG_EVENTS = 10; // number of log events to fetch when requesting more

const MARGIN = 14;
const NICK_SPACING = 14; // space after nicks, matching the following elements
                         // of the nick button in the entry area:
                         // 8px padding + 6px spacing

const NICKTAG_PREFIX = 'nick';

function _getColor(context) {
    let color = context.get_color(context.get_state());
    color.alpha *= context.get_property('opacity', context.get_state());
    return color;
}

// Workaround for GtkTextView growing horizontally over time when
// added to a GtkScrolledWindow with horizontal scrolling disabled
const TextView = new Lang.Class({
    Name: 'TextView',
    Extends: Gtk.TextView,

    _init: function(params) {
        this.parent(params);

        this.buffer.connect('mark-set', Lang.bind(this, this._onMarkSet));
        this.connect('screen-changed', Lang.bind(this, this._updateLayout));
    },

    vfunc_get_preferred_width: function() {
        return [1, 1];
    },

    vfunc_style_updated: function() {
        let context = this.get_style_context();
        context.save();
        context.add_class('dim-label');
        context.set_state(Gtk.StateFlags.NORMAL);
        this._dimColor = _getColor(context);
        context.restore();

        this.parent();
    },

    vfunc_draw: function(cr) {
        this.parent(cr);

        let mark = this.buffer.get_mark('indicator-line');
        if (!mark) {
            cr.$dispose();
            return Gdk.EVENT_PROPAGATE;
        }

        let iter = this.buffer.get_iter_at_mark(mark);
        let location = this.get_iter_location(iter);
        let [, y] = this.buffer_to_window_coords(Gtk.TextWindowType.TEXT,
                                                 location.x, location.y);

        let tags = iter.get_tags();
        let pixelsAbove = tags.reduce(function(prev, current) {
                return Math.max(prev, current.pixels_above_lines);
            }, this.get_pixels_above_lines());
        let pixelsBelow = tags.reduce(function(prev, current) {
                return Math.max(prev, current.pixels_below_lines);
            }, this.get_pixels_below_lines());

        let lineSpace = Math.floor((pixelsAbove + pixelsBelow) / 2);
        y = y - lineSpace + 0.5;

        let width = this.get_allocated_width() - 2 * MARGIN;

        let [, extents] = this._layout.get_pixel_extents();
        let layoutWidth = extents.width + 0.5;
        let layoutX = extents.x + Math.floor((width - extents.width) / 2) + 0.5;
        let layoutHeight = extents.height;
        let baseline = Math.floor(this._layout.get_baseline() / Pango.SCALE);
        let layoutY = y - baseline + Math.floor((layoutHeight - baseline) / 2) + 0.5;

        let [hasClip, clip] = Gdk.cairo_get_clip_rectangle(cr);
        if (hasClip &&
            clip.y <= layoutY + layoutHeight &&
            clip.y + clip.height >= layoutY) {

            Gdk.cairo_set_source_rgba(cr, this._dimColor);

            cr.moveTo(layoutX, layoutY);
            PangoCairo.show_layout(cr, this._layout);

            let [, color] = this.get_style_context().lookup_color('borders');
            Gdk.cairo_set_source_rgba(cr, color);

            cr.setLineWidth(1);
            cr.moveTo(MARGIN, y);
            cr.lineTo(layoutX - MARGIN, y);
            cr.moveTo(layoutX + layoutWidth + MARGIN, y);
            cr.lineTo(MARGIN + width, y);
            cr.stroke();
        }
        cr.$dispose();

        return Gdk.EVENT_PROPAGATE;
    },

    _onMarkSet: function(buffer, iter, mark) {
        if (mark.name == 'indicator-line')
            this.queue_draw();
    },

    _updateLayout: function() {
        this._layout = this.create_pango_layout(null);
        this._layout.set_markup('<small><b>%s</b></small>'.format(_("New Messages")), -1);
    }
});

const ButtonTag = new Lang.Class({
    Name: 'ButtonTag',
    Extends: Gtk.TextTag,
    Properties: {
        'hover': GObject.ParamSpec.boolean('hover',
                                           'hover',
                                           'hover',
                                           GObject.ParamFlags.READWRITE,
                                           false)
    },
    Signals: {
        'button-press-event': {
            flags: GObject.SignalFlags.RUN_LAST,
            param_types: [Gdk.Event.$gtype],
            return_type: GObject.TYPE_BOOLEAN,
            accumulator: GObject.AccumulatorType.TRUE_HANDLED
        },
        'button-release-event': {
            flags: GObject.SignalFlags.RUN_LAST,
            param_types: [Gdk.Event.$gtype],
            return_type: GObject.TYPE_BOOLEAN,
            accumulator: GObject.AccumulatorType.TRUE_HANDLED
        },
        'clicked': { }
    },

    _init: function(params) {
        this.parent(params);

        this._hover = false;
        this._pressed = false;
    },

    get hover() {
        return this._hover;
    },

    set hover(hover) {
        if (this._hover == hover)
            return;

        this._hover = hover;
        this.notify('hover');
    },

    on_notify: function(pspec) {
        if (pspec.name == 'hover' && !this.hover)
            this._pressed = false;
    },

    'on_button-press-event': function(event) {
        let [, button] = event.get_button();
        this._pressed = button == Gdk.BUTTON_PRIMARY;

        return Gdk.EVENT_STOP;
    },

    'on_button-release-event': function(event) {
        let [, button] = event.get_button();
        if (!(button == Gdk.BUTTON_PRIMARY && this._pressed))
            return Gdk.EVENT_PROPAGATE;

        this._pressed = false;
        this.emit('clicked');
        return Gdk.EVENT_STOP;
    },

    vfunc_event: function(object, event, iter) {
        let type = event.get_event_type();

        if (!this._hover)
            return Gdk.EVENT_PROPAGATE;

        if (type != Gdk.EventType.BUTTON_PRESS &&
            type != Gdk.EventType.BUTTON_RELEASE)
            return Gdk.EVENT_PROPAGATE;

        let isPress = type == Gdk.EventType.BUTTON_PRESS;
        return this.emit(isPress ? 'button-press-event'
                                 : 'button-release-event', event);
    }
});

const ChatView = new Lang.Class({
    Name: 'ChatView',
    Extends: Gtk.ScrolledWindow,
    Implements: [PasteManager.DropTargetIface],
    Properties: {
        'can-drop': GObject.ParamSpec.override('can-drop', PasteManager.DropTargetIface),
        'max-nick-chars': GObject.ParamSpec.uint('max-nick-chars',
                                                 'max-nick-chars',
                                                 'max-nick-chars',
                                                 GObject.ParamFlags.READABLE,
                                                 0, GLib.MAXUINT32, 0)
    },

    _init: function(room) {
        this.parent({ hscrollbar_policy: Gtk.PolicyType.NEVER, vexpand: true });

        this.get_style_context().add_class('polari-chat-view');

        this._view = new TextView({ editable: false, cursor_visible: false,
                                    wrap_mode: Gtk.WrapMode.WORD_CHAR,
                                    right_margin: MARGIN });
        this._view.add_events(Gdk.EventMask.LEAVE_NOTIFY_MASK |
                              Gdk.EventMask.ENTER_NOTIFY_MASK);
        this.add(this._view);
        this.show_all();

        this._createTags();

        this.connect('style-updated',
                     Lang.bind(this, this._onStyleUpdated));
        this._onStyleUpdated();

        this.connect('screen-changed',
                     Lang.bind(this, this._updateIndent));
        this.connect('map', Lang.bind(this, this._updateActive));
        this.connect('unmap', Lang.bind(this, this._updateActive));
        this.connect('parent-set',
                     Lang.bind(this, this._updateToplevel));
        this.connect('state-flags-changed',
                     Lang.bind(this, this._updateToplevel));
        this.connect('scroll-event', Lang.bind(this, this._onScroll));

        this.vadjustment.connect('value-changed',
                                 Lang.bind(this, this._onValueChanged));
        this.vadjustment.connect('changed',
                                 Lang.bind(this, this._updateScroll));

        this._view.connect('key-press-event', Lang.bind(this, this._onKeyPress));
        this._view.connect('motion-notify-event',
                           Lang.bind(this, this._handleButtonTagsHover));
        this._view.connect('enter-notify-event',
                           Lang.bind(this, this._handleButtonTagsHover));
        this._view.connect('leave-notify-event',
                           Lang.bind(this, this._handleButtonTagsHover));
        /* pick up DPI changes (e.g. via the 'text-scaling-factor' setting):
           the default handler calls pango_cairo_context_set_resolution(), so
           update the indent after that */
        this._view.connect_after('style-updated',
                                 Lang.bind(this, this._updateIndent));

        this._room = room;
        this._state = { lastNick: null, lastTimestamp: 0, lastStatusGroup: 0 };
        this._active = false;
        this._toplevelFocus = false;
        this._joinTime = 0;
        this._maxNickChars = MAX_NICK_CHARS;
        this._hoveredButtonTags = [];
        this._needsIndicator = true;
        this._pending = {};
        this._pendingLogs = [];
        this._statusCount = { left: 0, joined: 0, total: 0 };
        this._userStatusMonitor = UserTracker.getUserStatusMonitor();

        this._room.account.connect('notify::nickname', Lang.bind(this,
            function() {
                this._updateMaxNickChars(this._room.account.nickname.length);
            }));
        this._updateMaxNickChars(this._room.account.nickname.length);

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

        let adj = this.vadjustment;
        this._scrollBottom = adj.upper - adj.page_size;

        this._app = Gio.Application.get_default();
        PasteManager.DropTargetIface.addTargets(this, this._view);

        this._hoverCursor = Gdk.Cursor.new(Gdk.CursorType.HAND1);

        this._channelSignals = [];
        this._channel = null;

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
        this._onChannelChanged();

        /*where should we unwatch? int onChannelChanged when we don't have a channel?*/
        this._roomWatchHandler = this._userStatusMonitor.getUserTrackerForAccount(this._room.account).watchUser(this._room, null, Lang.bind(this, this._onStatusChangedCallback));
    },

    _createTags: function() {
        let buffer = this._view.get_buffer();
        let tagTable = buffer.get_tag_table();
        let tags = [
          { name: 'nick',
            left_margin: MARGIN },
          { name: 'gap',
            pixels_above_lines: 10 },
          { name: 'message',
            indent: 0 },
          { name: 'highlight',
            weight: Pango.Weight.BOLD },
          { name: 'status',
            left_margin: MARGIN,
            indent: 0,
            justification: Gtk.Justification.RIGHT },
          { name: 'timestamp',
            left_margin: MARGIN,
            indent: 0,
            weight: Pango.Weight.BOLD,
            justification: Gtk.Justification.RIGHT },
          { name: 'action',
            left_margin: MARGIN },
          { name: 'url',
            underline: Pango.Underline.SINGLE },
          { name: 'indicator-line',
            pixels_above_lines: 24 },
          { name: 'loading',
            justification: Gtk.Justification.CENTER }
        ];
        tags.forEach(function(tagProps) {
            tagTable.add(new Gtk.TextTag(tagProps));
        });
    },

    _onStyleUpdated: function() {
        let context = this.get_style_context();
        context.save();
        context.add_class('dim-label');
        context.set_state(Gtk.StateFlags.NORMAL);
        let dimColor = _getColor(context);
        context.restore();

        context.save();
        context.set_state(Gtk.StateFlags.LINK);
        let linkColor = _getColor(context);
        this._activeNickColor = _getColor(context);

        context.set_state(Gtk.StateFlags.LINK | Gtk.StateFlags.PRELIGHT);
        this._hoveredLinkColor = _getColor(context);
        context.restore();

        let desaturatedNickColor = (this._activeNickColor.red +
                                    this._activeNickColor.blue +
                                    this._activeNickColor.green) / 3;
        this._inactiveNickColor = new Gdk.RGBA ({ red: desaturatedNickColor,
                                                  green: desaturatedNickColor,
                                                  blue: desaturatedNickColor,
                                                  alpha: 1.0 });
        if (this._activeNickColor.equal(this._inactiveNickColor))
            this._inactiveNickColor.alpha = 0.5;

        context.save();
        context.add_class('view');
        context.set_state(Gtk.StateFlags.NORMAL);
        this._statusHeaderHoverColor = _getColor(context);
        context.restore();

        let buffer = this._view.get_buffer();
        let tagTable = buffer.get_tag_table();
        let tags = [
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

    vfunc_destroy: function() {
        this.parent();

        for (let i = 0; i < this._channelSignals.length; i++)
            this._channel.disconnect(this._channelSignals[i]);
        this._channelSignals = [];

        for (let i = 0; i < this._roomSignals.length; i++)
            this._room.disconnect(this._roomSignals[i]);
        this._roomSignals = [];
    },

    _onLogEventsReady: function(lw, res) {
        this._hideLoadingIndicator();

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

        if (!this._channel)
            return;
    },

    get _nPending() {
        return Object.keys(this._pending).length;
    },

    get max_nick_chars() {
        return this._maxNickChars;
    },

    get can_drop() {
        return this._channel != null;
    },

    _updateMaxNickChars: function(length) {
        if (length <= this._maxNickChars)
            return;

        this._maxNickChars = length;
        this.notify('max-nick-chars');
        this._updateIndent();
    },

    _updateIndent: function() {
        let context = this._view.get_pango_context();
        let metrics = context.get_metrics(null, null);
        let charWidth = Math.max(metrics.get_approximate_char_width(),
                                 metrics.get_approximate_digit_width());
        let pixelWidth = Pango.units_to_double(charWidth);

        let totalWidth = this._maxNickChars * pixelWidth + NICK_SPACING;

        let tabs = Pango.TabArray.new(1, true);
        tabs.set_tab(0, Pango.TabAlign.LEFT, totalWidth);
        this._view.tabs = tabs;
        this._view.indent = -totalWidth;
        this._view.left_margin = MARGIN + totalWidth;
    },

    _updateActive: function() {
        let active = this.get_mapped();
        if (this._active == active)
            return;
        this._active = active;
        this._checkMessages();
    },

    _updateToplevel: function() {
        let flags = this.get_state_flags();
        let toplevelFocus = !(flags & Gtk.StateFlags.BACKDROP);
        if (this._toplevelFocus == toplevelFocus)
            return;
        this._toplevelFocus = toplevelFocus;
        this._checkMessages();
    },

    _updateScroll: function() {
        let adj = this.vadjustment;
        if (adj.value == this._scrollBottom) {
            if (this._nPending == 0) {
                this._view.emit('move-cursor',
                                Gtk.MovementStep.BUFFER_ENDS, 1, false);
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
        let [hasDir, dir] = event.get_scroll_direction();
        if (hasDir && dir != Gdk.ScrollDirection.UP)
            return Gdk.EVENT_PROPAGATE;

        let [hasDeltas, dx, dy] = event.get_scroll_deltas();
        if (hasDeltas && dy >= 0)
            return Gdk.EVENT_PROPAGATE;

        return this._fetchBacklog();
    },

    _onKeyPress: function(w, event) {
        let [, keyval] = event.get_keyval();

        if (keyval === Gdk.KEY_Home ||
            keyval === Gdk.KEY_KP_Home) {
            this._view.emit('move-cursor',
                            Gtk.MovementStep.BUFFER_ENDS,
                            -1, false);
            return Gdk.EVENT_STOP;
        } else if (keyval === Gdk.KEY_End ||
                   keyval === Gdk.KEY_KP_End) {
            this._view.emit('move-cursor',
                            Gtk.MovementStep.BUFFER_ENDS,
                            1, false);
            return Gdk.EVENT_STOP;
        }

        if (keyval != Gdk.KEY_Up &&
            keyval != Gdk.KEY_KP_Up &&
            keyval != Gdk.KEY_Page_Up &&
            keyval != Gdk.KEY_KP_Page_Up)
            return Gdk.EVENT_PROPAGATE;

        return this._fetchBacklog();
    },

    _fetchBacklog: function() {
        if (this.vadjustment.value != 0 ||
            this._logWalker.is_end())
            return Gdk.EVENT_PROPAGATE;

        if (this._fetchingBacklog)
            return Gdk.EVENT_STOP;

        this._fetchingBacklog = true;
        this._showLoadingIndicator();
        Mainloop.timeout_add(500, Lang.bind(this,
            function() {
                this._logWalker.get_events_async(NUM_LOG_EVENTS,
                                                 Lang.bind(this, this._onLogEventsReady));
                return GLib.SOURCE_REMOVE;
            }));
        return Gdk.EVENT_STOP;
    },

    _onValueChanged: function() {
        if (this._valueChangedId)
            return;

        this._valueChangedId = Mainloop.timeout_add(SCROLL_TIMEOUT, Lang.bind(this,
            function() {
                this._checkMessages();
                this._valueChangedId = 0;
                return GLib.SOURCE_REMOVE;
            }));
    },

    _pendingMessageRemoved: function(channel, message) {
        let [id,] = message.get_pending_message_id();
        if (this._pending[id])
            this._view.buffer.delete_mark(this._pending[id]);
        this._app.withdraw_notification('pending-message-' + id);
        delete this._pending[id];
    },

    _showUrlContextMenu: function(url, button, time) {
        let menu = new Gtk.Menu();

        let item = new Gtk.MenuItem({ label: _("Open Link") });
        item.connect('activate', function() {
            Utils.openURL(url, Gtk.get_current_event_time());
        });
        menu.append(item);

        item = new Gtk.MenuItem({ label: _("Copy Link Address") });
        item.connect('activate',
            function() {
                let clipboard = Gtk.Clipboard.get_default(item.get_display());
                clipboard.set_text(url, -1);
            });
        menu.append(item);

        menu.show_all();
        menu.popup(null, null, null, button, time);
    },

    _handleButtonTagsHover: function(view, event) {
        let [, eventX, eventY] = event.get_coords();
        let [x, y] = view.window_to_buffer_coords(Gtk.TextWindowType.WIDGET,
                                                  eventX, eventY);
        let [inside, iter] = view.get_iter_at_location(x, y);

        let hoveredButtonTags;
        if (inside)
            hoveredButtonTags = iter.get_tags().filter(
                function(t) {
                    return t instanceof ButtonTag;
                });
        else
            hoveredButtonTags = [];

        hoveredButtonTags.forEach(
            function(t) {
                t.hover = true;
            });
        this._hoveredButtonTags.forEach(
            function(t) {
                t.hover = hoveredButtonTags.indexOf(t) >= 0;
            });

        let isHovering = hoveredButtonTags.length > 0;
        let wasHovering = this._hoveredButtonTags.length > 0;

        if (isHovering != wasHovering) {
            let cursor = isHovering ? this._hoverCursor : null;
            this._view.get_window(Gtk.TextWindowType.TEXT).set_cursor(cursor);
        }

        this._hoveredButtonTags = hoveredButtonTags;

        return Gdk.EVENT_PROPAGATE;
    },

    _showLoadingIndicator: function() {
        let indicator = new Gtk.Image({ icon_name: 'content-loading-symbolic',
                                        visible: true });

        let buffer = this._view.buffer;
        let iter = buffer.get_start_iter();
        let anchor = buffer.create_child_anchor(iter);
        this._view.add_child_at_anchor(indicator, anchor);
        buffer.insert(iter, '\n', -1);

        let start = buffer.get_start_iter();
        buffer.remove_all_tags(start, iter);
        buffer.apply_tag(this._lookupTag('loading'), start, iter);
    },

    _hideLoadingIndicator: function() {
        let buffer = this._view.buffer;
        let iter = buffer.get_start_iter();

        if (!iter.get_child_anchor())
            return;

        iter.forward_line();
        buffer.delete(buffer.get_start_iter(), iter);
    },

    _checkMessages: function() {
        if (!this._active || !this._toplevelFocus || !this._channel)
            return;

        this._needsIndicator = true;

        let pending = this._channel.dup_pending_messages();
        if (pending.length == 0)
            return;

        let rect = this._view.get_visible_rect();
        let buffer = this._view.get_buffer();
        for (let i = 0; i < pending.length; i++) {
            let [id,] = pending[i].get_pending_message_id();
            let mark = this._pending[id];
            if (!mark) {
                this._channel.ack_message_async(pending[i], null);
                continue;
            }
            let iter = buffer.get_iter_at_mark(mark);
            let iterRect = this._view.get_iter_location(iter);
            if (rect.y <= iterRect.y && rect.y + rect.height > iterRect.y)
                this._channel.ack_message_async(pending[i], null);
        }
    },

    _getNickTagName: function(nick) {
        return NICKTAG_PREFIX + Polari.util_get_basenick(nick);
    },

    _onNickStatusChanged: function(tracker, nickName, status) {
        let nickTag = this._lookupTag(this._getNickTagName(nickName));

        if (!nickTag)
            return;

        this._updateNickTag(nickTag, status);
    },

    _onChannelChanged: function() {
        if (this._channel == this._room.channel)
            return;

        if (this._channel) {
            for (let i = 0; i < this._channelSignals.length; i++)
                this._channel.disconnect(this._channelSignals[i]);
            this._channelSignals = [];
        }

        this._channel = this._room.channel;

        let nick = this._channel ? this._channel.connection.self_contact.alias
                                 : this._room.account.nickname;
        this._updateMaxNickChars(nick.length);

        if (!this._channel)
            return;

        this._joinTime = GLib.DateTime.new_now_utc().to_unix();

        let channelSignals = [
            { name: 'message-received',
              handler: Lang.bind(this, this._onMessageReceived) },
            { name: 'message-sent',
              handler: Lang.bind(this, this._onMessageSent) },
            { name: 'pending-message-removed',
              handler: Lang.bind(this, this._pendingMessageRemoved) }
        ];
        channelSignals.forEach(Lang.bind(this, function(signal) {
            this._channelSignals.push(this._channel.connect(signal.name, signal.handler));
        }));

        this._channel.dup_pending_messages().forEach(Lang.bind(this,
            function(message) {
                this._insertTpMessage(this._room, message);
            }));
        this._checkMessages();
    },

    _onMemberRenamed: function(room, oldMember, newMember) {
        let text = _("%s is now known as %s").format(oldMember.alias, newMember.alias);
        this._insertStatus(text, oldMember.alias, 'renamed');
    },

    _onMemberDisconnected: function(room, member, message) {
        let text = _("%s has disconnected").format(member.alias);
        if (message)
            text += ' (%s)'.format(message);
        this._insertStatus(text, member.alias, 'left');
    },

    _onMemberKicked: function(room, member, actor) {
        let message =
            actor ? _("%s has been kicked by %s").format(member.alias,
                                                         actor.alias)
                  : _("%s has been kicked").format(member.alias);
        this._insertStatus(message, member.alias, 'left');
    },

    _onMemberBanned: function(room, member, actor) {
        let message =
            actor ? _("%s has been banned by %s").format(member.alias,
                                                         actor.alias)
                  : _("%s has been banned").format(member.alias)
        this._insertStatus(message, member.alias, 'left');
    },

    _onMemberJoined: function(room, member) {
        let text = _("%s joined").format(member.alias);
        this._insertStatus(text, member.alias, 'joined');
    },

    _onMemberLeft: function(room, member, message) {
        let text = _("%s left").format(member.alias);

        if (message)
            text += ' (%s)'.format(message);

        this._insertStatus(text, member.alias, 'left');
    },

    _onMessageReceived: function(room, tpMessage) {
        this._insertTpMessage(room, tpMessage);
        this._resetStatusCompressed();
        let nick = tpMessage.sender.alias;
        let nickTag = this._lookupTag('nick' + nick);
        if (!nickTag)
           return;
        nickTag._lastActivity = GLib.get_monotonic_time();
    },

    _onMessageSent: function(room, tpMessage) {
        this._insertTpMessage(room, tpMessage);
        this._resetStatusCompressed();
    },

    _resetStatusCompressed: function() {
        let markStart = this._view.buffer.get_mark('idle-status-start');
        if (!markStart)
            return;

        this._view.buffer.delete_mark(markStart);
        this._statusCount =  { left: 0, joined: 0, total: 0 };
        this._state.lastStatusGroup++;
    },

    _shouldShowStatus: function(nick) {
        let nickTag = this._lookupTag('nick' + nick);

        if (!nickTag)
            return false;

        let time = GLib.get_monotonic_time();
        return (time - nickTag._lastActivity) / (1000 * 1000) < INACTIVITY_THRESHOLD;
    },

    _updateStatusHeader: function() {
        let buffer = this._view.buffer;
        let headerMark = buffer.get_mark('idle-status-start');

        let headerTagName = 'status-compressed' + this._state.lastStatusGroup;
        let headerArrowTagName = 'status-arrow-compressed' + this._state.lastStatusGroup;
        let groupTagName = 'status' + this._state.lastStatusGroup;

        let headerTag, headerArrowTag, groupTag;
        if (!headerMark) {
            // we are starting a new group
            headerTag = new ButtonTag({ name: headerTagName, invisible: true });
            headerArrowTag = new Gtk.TextTag({ name: headerArrowTagName, invisible: true });
            groupTag = new Gtk.TextTag({ name: groupTagName });
            buffer.tag_table.add(headerTag);
            buffer.tag_table.add(headerArrowTag);
            buffer.tag_table.add(groupTag);

            groupTag.bind_property('invisible', headerArrowTag, 'invisible',
                                    GObject.BindingFlags.INVERT_BOOLEAN);

            headerTag.connect('clicked',
                function() {
                    groupTag.invisible = !groupTag.invisible;
                });

            headerTag.connect('notify::hover', Lang.bind(this,
                function() {
                    headerTag.foreground_rgba = headerTag.hover ? this._statusHeaderHoverColor : null;
                }));

            this._ensureNewLine();
            headerMark = buffer.create_mark('idle-status-start', buffer.get_end_iter(), true);
        } else {
            headerTag = this._lookupTag(headerTagName);
            headerArrowTag = this._lookupTag(headerArrowTagName);
            groupTag = this._lookupTag(groupTagName);

            let start = buffer.get_iter_at_mark(headerMark);
            let end = start.copy();
            end.forward_to_line_end(headerTag);
            buffer.delete(start, end);
        }

        // we passed the threshold, show the header and collapse the group
        if (this._statusCount.total > STATUS_NOISE_MAXIMUM && headerTag.invisible) {
            headerTag.invisible = false;
            groupTag.invisible = true;
        }

        let stats = [];
        if (this._statusCount.joined > 0)
            stats.push(ngettext("%d user joined",
                                "%d users joined", this._statusCount.joined).format(this._statusCount.joined));
        if (this._statusCount.left > 0)
            stats.push(ngettext("%d user left",
                                "%d users left", this._statusCount.left).format(this._statusCount.left));
        // TODO: How do we update the arrow direction when text direction change?
        let iter = buffer.get_iter_at_mark(headerMark);
        let tags = [this._lookupTag('status'), headerTag];
        let headerText = stats.join(', ');
        let baseDir = Pango.find_base_dir(headerText, -1);
        this._insertWithTags(iter, headerText, tags);
        this._insertWithTags(iter, baseDir == Pango.Direction.LTR ? '\u25B6' : '\u25C0',
                             tags.concat(headerArrowTag));
        this._insertWithTags(iter, '\u25BC', tags.concat(groupTag));
    },

    _insertStatus: function(text, member, type) {
        let time = GLib.DateTime.new_now_utc().to_unix();
        if (time - this._joinTime < IGNORE_STATUS_TIME)
            return;

        let grouped = time - this._state.lastTimestamp > INACTIVITY_THRESHOLD;
        if (!grouped && !this._shouldShowStatus(member))
            return;

        this._state.lastNick = null;

        let tags = [this._lookupTag('status')];
        let groupTag = null;
        if (grouped) {
            if (this._statusCount.hasOwnProperty(type)) {
                this._statusCount[type]++;
                this._statusCount.total++;
            }
            this._updateStatusHeader();

            groupTag = this._lookupTag('status' + this._state.lastStatusGroup);
            tags.push(groupTag);
        } else {
            this._resetStatusCompressed();
        }

        this._ensureNewLine();
        let iter = this._view.buffer.get_end_iter();
        this._insertWithTags(iter, text, tags);
    },

    _formatTimestamp: function(timestamp) {
        let date = GLib.DateTime.new_from_unix_local(timestamp);
        let now = GLib.DateTime.new_now_local();

        // 00:01 actually, just to be safe
        let todayMidnight = GLib.DateTime.new_local(now.get_year(),
                                                    now.get_month(),
                                                    now.get_day_of_month(),
                                                    0, 1, 0);
        let dateMidnight = GLib.DateTime.new_local(date.get_year(),
                                                   date.get_month(),
                                                   date.get_day_of_month(),
                                                   0, 1, 0);
        let daysAgo = todayMidnight.difference(dateMidnight) / GLib.TIME_SPAN_DAY;

        let format;
        let desktopSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });
        let clockFormat = desktopSettings.get_string('clock-format');
        let hasAmPm = date.format('%p') != '';

        if (clockFormat == '24h' || !hasAmPm) {
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
        } else {
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

        if (message.shouldHighlight &&
            !(this._toplevelFocus && this._active)) {
            let summary = '%s %s'.format(this._room.display_name, message.nick);
            let notification = new Gio.Notification();
            notification.set_title(summary);
            notification.set_body(message.text);

            let account = this._room.account;
            let param = GLib.Variant.new('(ssu)',
                                         [ account.get_object_path(),
                                           this._room.channel_name,
                                           Utils.getTpEventTime() ]);
            notification.set_default_action_and_target('app.join-room', param);
            this._app.send_notification('pending-message-' + id, notification);
        }

        let buffer = this._view.get_buffer();
        if (!valid /* outgoing */ ||
            (this._active && this._toplevelFocus && this._nPending == 0)) {
            this._channel.ack_message_async(tpMessage, null);
        } else if (message.shouldHighlight || this._needsIndicator) {
            let iter = buffer.get_end_iter();

            if (message.shouldHighlight) {
                let mark = buffer.create_mark(null, iter, true);
                this._pending[id] = mark;
            }

            if (this._needsIndicator) {
                iter.set_line_offset(0);

                let mark = buffer.get_mark('indicator-line');
                if (mark) {
                    let [start, end] = this._getLineIters(buffer.get_iter_at_mark(mark));
                    buffer.remove_tag(this._lookupTag('indicator-line'), start, end);

                    buffer.move_mark(mark, iter);
                } else {
                    buffer.create_mark('indicator-line', iter, true);
                }

                let [start, end] = this._getLineIters(iter);
                buffer.apply_tag(this._lookupTag('indicator-line'), start, end);

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

        this._updateMaxNickChars(message.nick.length);

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
                let nickTagName = this._getNickTagName(message.nick);
                let nickTag = this._lookupTag(nickTagName);
                let buffer = this._view.get_buffer();

                if (!nickTag) {
                    nickTag = this._createNickTag(nickTagName);
                    buffer.get_tag_table().add(nickTag);

                    this._updateNickTag(nickTag, this._userStatusMonitor.getUserTrackerForAccount(this._room.account).getNickStatus(message.nick));
                }
                tags.push(nickTag);
                if (needsGap)
                    tags.push(this._lookupTag('gap'));
                this._insertWithTags(iter, message.nick, tags);
                buffer.insert(iter, '\t', -1);
            }
            state.lastNick = message.nick;
            tags.push(this._lookupTag('message'));
        }

        if (message.shouldHighlight)
            tags.push(this._lookupTag('highlight'));

        let params = this._room.account.dup_parameters_vardict().deep_unpack();
        let server = params.server.deep_unpack();

        let text = message.text;
        let channels = Utils.findChannels(text, server);
        let urls = Utils.findUrls(text).concat(channels).sort((u1,u2) => u1.pos - u2.pos);
        let pos = 0;
        for (let i = 0; i < urls.length; i++) {
            let url = urls[i];
            this._insertWithTags(iter, text.substr(pos, url.pos - pos), tags);

            let tag = this._createUrlTag(url.url);
            this._view.get_buffer().tag_table.add(tag);

            let name = url.name ? url.name : url.url;
            this._insertWithTags(iter, name,
                                 tags.concat(this._lookupTag('url'), tag));

            pos = url.pos + name.length;
        }
        this._insertWithTags(iter, text.substr(pos), tags);
    },

    /*_createNickTag: function(nickName) {
        let nickTagName = this._getNickTagName(nickName);

        let tag = new Gtk.TextTag({ name: nickTagName });
        //this._updateNickTag(tag, this._userStatusMonitor.getUserTrackerForAccount(this._room.account).getNickRoomStatus(nickName, this._room));
        this._updateNickTag(tag, Tp.ConnectionPresenceType.OFFLINE);

        return tag;
    },*/

    _onStatusChangedCallback: function(nick, status) {
        let nickTagName = this._getNickTagName(nick);
        let nickTag = this._lookupTag(nickTagName);

        if (!nickTag)
            return;

        this._updateNickTag(nickTag, status);
    },

    _updateNickTag: function(tag, status) {
        if (status == Tp.ConnectionPresenceType.AVAILABLE)
            tag.foreground_rgba = this._activeNickColor;
        else
            tag.foreground_rgba = this._inactiveNickColor;
    },

    _createNickTag: function(name) {
        let tag = new ButtonTag({ name: name });
        tag._popover = new UserList.UserPopover({ relative_to: this._view, margin: 0, room: this._room, userTracker: this._userStatusMonitor.getUserTrackerForAccount(this._room.account), width_request: 280 });
        tag.connect('clicked', Lang.bind(this, this._onNickTagClicked));
        return tag;
    },

    _onNickTagClicked: function(tag) {
        let view = this._view;
        let event = Gtk.get_current_event();
        let [, eventX, eventY] = event.get_coords();
        let [x, y] = view.window_to_buffer_coords(Gtk.TextWindowType.WIDGET,
                                                          eventX, eventY);
        let [inside, start] = view.get_iter_at_location(x, y);
        let end = start.copy();

        if (!start.starts_tag(tag))
            start.backward_to_tag_toggle(tag);

        if (!end.ends_tag(tag))
            end.forward_to_tag_toggle(tag);

        let rect1 = view.get_iter_location(start);
        let rect2 = view.get_iter_location(end);

        [rect1.y, rect1.height] = view.get_line_yrange(start);

        [rect1.x, rect1.y] = view.buffer_to_window_coords(Gtk.TextWindowType.WIDGET, rect1.x, rect1.y);
        [rect2.x, rect2.y] = view.buffer_to_window_coords(Gtk.TextWindowType.WIDGET, rect2.x, rect2.y);
        rect1.width = rect2.x - rect1.x;

        //TODO: special chars?
        let actualNickName = view.get_buffer().get_slice(start, end, false);

        tag._popover.nickname = actualNickName;

        tag._popover.pointing_to = rect1;
        tag._popover.show();
    },

    _createUrlTag: function(url) {
        if (url.indexOf(':') == -1)
            url = 'http://' + url;

        let tag = new ButtonTag();
        tag.connect('notify::hover', Lang.bind(this,
            function() {
                tag.foreground_rgba = tag.hover ? this._hoveredLinkColor : null;
            }));
        tag.connect('clicked',
            function() {
                Utils.openURL(url, Gtk.get_current_event_time());
            });
        tag.connect('button-press-event', Lang.bind(this,
            function(tag, event) {
                let [, button] = event.get_button();
                if (button != Gdk.BUTTON_SECONDARY)
                    return Gdk.EVENT_PROPAGATE;

                this._showUrlContextMenu(url, button, event.get_time());
                return Gdk.EVENT_STOP;
            }));
        return tag;
    },

    _ensureNewLine: function() {
        let buffer = this._view.get_buffer();
        let iter = buffer.get_end_iter();
        let tags = [];
        let groupTag = this._lookupTag('status' + this._state.lastStatusGroup);
        if (groupTag && iter.ends_tag(groupTag))
            tags.push(groupTag);
        let headerTag = this._lookupTag('status-compressed' + this._state.lastStatusGroup);
        if (headerTag && iter.ends_tag(headerTag))
            tags.push(headerTag);
        if (iter.get_line_offset() != 0)
            this._insertWithTags(iter, '\n', tags);
    },

    _getLineIters: function(iter) {
        let start = iter.copy();
        start.backward_line();
        start.forward_to_line_end();

        let end = iter.copy();
        end.forward_to_line_end();

        return [start, end];
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
