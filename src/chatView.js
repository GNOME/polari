const Gdk = imports.gi.Gdk;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;
const Mainloop = imports.mainloop;
const Pango = imports.gi.Pango;
const PangoCairo = imports.gi.PangoCairo;
const Polari = imports.gi.Polari;
const Tp = imports.gi.TelepathyGLib;
const Tpl = imports.gi.TelepathyLogger;

const {DropTargetIface} = imports.pasteManager;
const {UserPopover} = imports.userList;
const {UserStatusMonitor} = imports.userTracker;
const Utils = imports.utils;

var MAX_NICK_CHARS = 8;
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
const TextView = GObject.registerClass(
class TextView extends Gtk.TextView {
    _init(params) {
        super._init(params);

        this.buffer.connect('mark-set', this._onMarkSet.bind(this));
        this.connect('screen-changed', this._updateLayout.bind(this));
    }

    vfunc_get_preferred_width() {
        return [1, 1];
    }

    vfunc_style_updated() {
        let context = this.get_style_context();
        context.save();
        context.add_class('dim-label');
        context.set_state(Gtk.StateFlags.NORMAL);
        this._dimColor = _getColor(context);
        context.restore();

        super.vfunc_style_updated();
    }

    vfunc_draw(cr) {
        super.vfunc_draw(cr);

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
        let pixelsAbove = tags.reduce((prev, current) => {
                return Math.max(prev, current.pixels_above_lines);
            }, this.get_pixels_above_lines());
        let pixelsBelow = tags.reduce((prev, current) => {
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
    }

    _onMarkSet(buffer, iter, mark) {
        if (mark.name == 'indicator-line')
            this.queue_draw();
    }

    _updateLayout() {
        this._layout = this.create_pango_layout(null);
        this._layout.set_markup('<small><b>%s</b></small>'.format(_("New Messages")), -1);
    }
});

var ButtonTag = GObject.registerClass({
    Properties: {
        'hover': GObject.ParamSpec.boolean('hover',
                                           'hover',
                                           'hover',
                                           GObject.ParamFlags.READWRITE,
                                           false)
    },
    Signals: {
        'clicked': { },
        'popup-menu': { }
    },
}, class ButtonTag extends Gtk.TextTag {
    _init(params) {
        this._hover = false;

        this._gesture = null;

        super._init(params);
    }

    get hover() {
        return this._hover;
    }

    set hover(hover) {
        if (this._hover == hover)
            return;

        this._hover = hover;
        this.notify('hover');
    }

    vfunc_event(object, event, iter) {
        this._ensureGesture(object);

        if (this._gesture.handle_event(event) ||
            this._gesture.is_recognized())
            return Gdk.EVENT_STOP;

        return Gdk.EVENT_PROPAGATE;
    }

    _ensureGesture(widget) {
        if (this._gesture)
            return;

        this._gesture = new Gtk.GestureMultiPress({ widget,
                                                    button: 0,
                                                    exclusive: true });

        this._gesture.connect('pressed', (gesture, nPress) => {
            if (!this._hover || nPress > 1)
                return;

            let button = this._gesture.get_current_button();
            if (button == Gdk.BUTTON_SECONDARY)
                this.emit('popup-menu');
        });
        this._gesture.connect('released', (gesture, nPress) => {
            if (!this._hover || nPress > 1)
                return;

            let button = this._gesture.get_current_button();
            if (button == Gdk.BUTTON_PRIMARY)
                this.emit('clicked');
        });
    }
});

var HoverFilterTag = GObject.registerClass({
    Properties: {
        'filtered-tag': GObject.ParamSpec.object('filtered-tag',
                                                 'filtered-tag',
                                                 'filtered-tag',
                                                 GObject.ParamFlags.READWRITE |
                                                 GObject.ParamFlags.CONSTRUCT_ONLY,
                                                 Gtk.TextTag.$gtype),
        'hover-opacity': GObject.ParamSpec.double('hover-opacity',
                                                  'hover-opacity',
                                                  'hover-opacity',
                                                  GObject.ParamFlags.READWRITE,
                                                  0.0, 1.0, 1.0)
    }
}, class HoverFilterTag extends ButtonTag {
    _init(params) {
        this._filteredTag = null;
        this._hoverOpacity = 1.;

        super._init(params);

        this.connect('notify::hover', () => { this._updateColor(); });
    }

    _updateColor() {
        if (!this._filteredTag)
            return;

        let color = this._filteredTag.foreground_rgba;
        if (this.hover)
            color.alpha *= this._hoverOpacity;
        this.foreground_rgba = color;
    }

    set filtered_tag(value) {
        this._filteredTag = value;
        this.notify('filtered-tag');

        this._filteredTag.connect('notify::foreground-rgba', () => {
            this._updateColor();
        });
        this._updateColor();
    }

    get filtered_tag() {
        return this._filteredTag;
    }

    set hover_opacity(value) {
        if (this._hoverOpacity == value)
            return;
        this._hoverOpacity = value;
        this.notify('hover-opacity');

        if (this.hover)
            this._updateColor();
    }

    get hover_opacity() {
        return this._hoverOpacity;
    }
});

var ChatView = GObject.registerClass({
    Implements: [DropTargetIface],
    Properties: {
        'can-drop': GObject.ParamSpec.override('can-drop', DropTargetIface),
        'max-nick-chars': GObject.ParamSpec.uint('max-nick-chars',
                                                 'max-nick-chars',
                                                 'max-nick-chars',
                                                 GObject.ParamFlags.READABLE,
                                                 0, GLib.MAXUINT32, 0)
    }
}, class ChatView extends Gtk.ScrolledWindow {
    _init(room) {
        super._init({ hscrollbar_policy: Gtk.PolicyType.NEVER, vexpand: true });

        this.get_style_context().add_class('polari-chat-view');

        this._view = new TextView({ editable: false, cursor_visible: false,
                                    wrap_mode: Gtk.WrapMode.WORD_CHAR,
                                    right_margin: MARGIN });
        this._view.add_events(Gdk.EventMask.LEAVE_NOTIFY_MASK |
                              Gdk.EventMask.ENTER_NOTIFY_MASK);
        this.add(this._view);
        this.show_all();

        this._createTags();

        this.connect('style-updated', this._onStyleUpdated.bind(this));
        this._onStyleUpdated();

        this.connect('destroy', this._onDestroy.bind(this));
        this.connect('screen-changed', this._updateIndent.bind(this));
        this.connect('scroll-event', this._onScroll.bind(this));
        this.connect('edge-reached', (w, pos) => {
            if (pos == Gtk.PositionType.BOTTOM)
                this._autoscroll = true;
        });

        this.vadjustment.connect('value-changed',
                                 this._onValueChanged.bind(this));
        this.vadjustment.connect('changed', this._updateScroll.bind(this));

        this._view.connect('key-press-event', this._onKeyPress.bind(this));
        this._view.connect('motion-notify-event',
                           this._handleButtonTagsHover.bind(this));
        this._view.connect('enter-notify-event',
                           this._handleButtonTagsHover.bind(this));
        this._view.connect('leave-notify-event',
                           this._handleButtonTagsHover.bind(this));
        /* pick up DPI changes (e.g. via the 'text-scaling-factor' setting):
           the default handler calls pango_cairo_context_set_resolution(), so
           update the indent after that */
        this._view.connect_after('style-updated',
                                 this._updateIndent.bind(this));

        this._room = room;
        this._state = { lastNick: null, lastTimestamp: 0, lastStatusGroup: 0 };
        this._joinTime = 0;
        this._maxNickChars = MAX_NICK_CHARS;
        this._hoveredButtonTags = [];
        this._needsIndicator = true;
        this._pending = new Map();
        this._pendingLogs = [];
        this._initialPending = [];
        this._backlogTimeoutId = 0;
        this._statusCount = { left: 0, joined: 0, total: 0 };

        let statusMonitor = UserStatusMonitor.getDefault();
        this._userTracker = statusMonitor.getUserTrackerForAccount(room.account);

        this._room.account.connect('notify::nickname', () => {
            this._updateMaxNickChars(this._room.account.nickname.length);
        });
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
                                         this._onLogEventsReady.bind(this));

        this._autoscroll = true;

        this._app = Gio.Application.get_default();
        DropTargetIface.addTargets(this, this._view);

        this._roomFocusChangedId =
            this._app.connect('room-focus-changed',
                              this._checkMessages.bind(this));

        this._hoverCursor = Gdk.Cursor.new_from_name(this.get_display(),
                                                     'pointer');

        this._channelSignals = [];
        this._channel = null;

        let roomSignals = [
            { name: 'notify::channel',
              handler: this._onChannelChanged.bind(this) },
            { name: 'member-renamed',
              handler: this._onMemberRenamed.bind(this) },
            { name: 'member-disconnected',
              handler: this._onMemberDisconnected.bind(this) },
            { name: 'member-kicked',
              handler: this._onMemberKicked.bind(this) },
            { name: 'member-banned',
              handler: this._onMemberBanned.bind(this) },
            { name: 'member-joined',
              handler: this._onMemberJoined.bind(this) },
            { name: 'member-left',
              handler: this._onMemberLeft.bind(this) }
        ];
        this._roomSignals = [];
        roomSignals.forEach(signal => {
            this._roomSignals.push(room.connect(signal.name, signal.handler));
        });
        this._onChannelChanged();

        this._nickStatusChangedId = this._userTracker.watchRoomStatus(this._room,
                                    null,
                                    this._onNickStatusChanged.bind(this));
    }

    _createTags() {
        let buffer = this._view.get_buffer();
        let tagTable = buffer.get_tag_table();
        let tags = [
          { name: 'nick',
            left_margin: MARGIN,
            weight: Pango.Weight.BOLD },
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
            justification: Gtk.Justification.RIGHT },
          { name: 'action',
            left_margin: MARGIN,
            style: Pango.Style.ITALIC },
          { name: 'url',
            underline: Pango.Underline.SINGLE },
          { name: 'indicator-line',
            pixels_above_lines: 24 },
          { name: 'loading',
            left_margin: MARGIN,
            justification: Gtk.Justification.CENTER }
        ];
        tags.forEach(tagProps => { tagTable.add(new Gtk.TextTag(tagProps)); });
    }

    _onStyleUpdated() {
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
          { name: 'url',
            foreground_rgba: linkColor }
        ];
        tags.forEach(tagProps => {
            let tag = tagTable.lookup(tagProps.name);
            for (let prop in tagProps) {
                if (prop == 'name')
                    continue;
                tag[prop] = tagProps[prop];
            }
        });

        tagTable.foreach(tag => {
            if(!tag.name)
                return;

            let nickname = this._getNickFromTagName(tag.name);

            if (!nickname)
                return;

            let status = this._userTracker.getNickRoomStatus(nickname, this._room);
            this._updateNickTag(tag, status);
        });
    }

    _onDestroy() {
        for (let i = 0; i < this._channelSignals.length; i++)
            this._channel.disconnect(this._channelSignals[i]);
        this._channelSignals = [];

        for (let i = 0; i < this._roomSignals.length; i++)
            this._room.disconnect(this._roomSignals[i]);
        this._roomSignals = [];

        if (this._roomFocusChangedId)
            this._app.disconnect(this._roomFocusChangedId);
        this._roomFocusChangedId = 0;

        if (this._backlogTimeoutId)
            Mainloop.source_remove(this._backlogTimeoutId);
        this._backlogTimeoutId = 0;

        if (this._nickStatusChangedId)
            this._userTracker.unwatchRoomStatus(this._room,
                                                this._nickStatusChangedId);
        this._nickStatusChangedId = 0;
        this._userTracker = null;

        this._logWalker.run_dispose();
        this._logWalker = null;
    }

    _onLogEventsReady(lw, res) {
        this._hideLoadingIndicator();
        this._fetchingBacklog = false;

        let [, events] = lw.get_events_finish(res);
        let messages = events.map(e => this._createMessage(e));
        this._pendingLogs = messages.concat(this._pendingLogs);
        this._insertPendingLogs();
    }

    _createMessage(source) {
        if (source instanceof Tp.Message) {
            let [text, ] = source.to_text();
            let [id, valid] = source.get_pending_message_id();
            return { nick: source.sender.alias,
                     text: text,
                     timestamp: source.get_sent_timestamp() ||
                                source.get_received_timestamp(),
                     messageType: source.get_message_type(),
                     pendingId: valid ? id : undefined };
        } else if (source instanceof Tpl.Event) {
            return { nick: source.sender.alias,
                     text: source.message,
                     timestamp: source.timestamp,
                     messageType: source.get_message_type() };
        }

        throw new Error('Cannot create message from source ' + source);
    }

    _getReadyLogs() {
        if (this._logWalker.is_end())
            return this._pendingLogs.splice(0);

        let nick = this._pendingLogs[0].nick;
        let type = this._pendingLogs[0].messageType;
        let maxNum = this._pendingLogs.length - this._initialPending.length;
        for (let i = 0; i < maxNum; i++)
            if (this._pendingLogs[i].nick != nick ||
                this._pendingLogs[i].messageType != type)
                return this._pendingLogs.splice(i);
        return [];
    }

    _appendInitialPending(logs) {
        let pending = this._initialPending.splice(0);
        let firstPending = pending[0];

        let numLogs = logs.length;
        let pos;
        for (pos = numLogs - pending.length; pos < numLogs; pos++)
            if (logs[pos].nick == firstPending.nick &&
                logs[pos].text == firstPending.text &&
                logs[pos].timestamp == firstPending.timestamp &&
                logs[pos].messageType == firstPending.messageType)
                break;
        // Remove entries that are also in pending (if any), then
        // add the entries from pending
        logs.splice.apply(logs, [pos, numLogs, ...pending]);
    }

    _insertPendingLogs() {
        let pending = this._getReadyLogs();

        if (!pending.length) {
            this._fetchBacklog();
            return;
        }

        let numInitialPending = this._initialPending.length;
        if (numInitialPending)
            this._appendInitialPending(pending);

        let indicatorIndex = pending.length - numInitialPending;

        let state = { lastNick: null, lastTimestamp: 0 };
        let iter = this._view.buffer.get_start_iter();

        for (let i = 0; i < pending.length; i++) {
            this._insertMessage(iter, pending[i], state);

            if (i == indicatorIndex)
                this._setIndicatorMark(iter);

            if (!iter.is_end() || i < pending.length - 1)
                this._view.buffer.insert(iter, '\n', -1);
        }

        if (!this._channel)
            return;
    }

    get max_nick_chars() {
        return this._maxNickChars;
    }

    get can_drop() {
        return this._channel != null;
    }

    _updateMaxNickChars(length) {
        if (length <= this._maxNickChars)
            return;

        this._maxNickChars = length;
        this.notify('max-nick-chars');
        this._updateIndent();
    }

    _updateIndent() {
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
    }

    _updateScroll() {
        if (!this._autoscroll)
            return;

        if (this._pending.size == 0) {
            this._view.emit('move-cursor',
                            Gtk.MovementStep.BUFFER_ENDS, 1, false);
        } else {
            this._autoscroll = false;
            let mark = [...this._pending.values()].shift();
            this._view.scroll_mark_onscreen(mark);
        }
    }

    _onScroll(w, event) {
        let [hasDir, dir] = event.get_scroll_direction();
        if (hasDir && dir != Gdk.ScrollDirection.UP)
            return Gdk.EVENT_PROPAGATE;

        let [hasDeltas, dx, dy] = event.get_scroll_deltas();
        if (hasDeltas && dy >= 0)
            return Gdk.EVENT_PROPAGATE;

        this._autoscroll = false;

        return this._fetchBacklog();
    }

    _onKeyPress(w, event) {
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

        this._autoscroll = false;

        return this._fetchBacklog();
    }

    _fetchBacklog() {
        if (this.vadjustment.value != 0 ||
            this._logWalker.is_end())
            return Gdk.EVENT_PROPAGATE;

        if (this._fetchingBacklog)
            return Gdk.EVENT_STOP;

        this._fetchingBacklog = true;
        this._showLoadingIndicator();
        this._backlogTimeoutId = Mainloop.timeout_add(500, () => {
            this._logWalker.get_events_async(NUM_LOG_EVENTS,
                                             this._onLogEventsReady.bind(this));
            this._backlogTimeoutId = 0;
            return GLib.SOURCE_REMOVE;
        });
        return Gdk.EVENT_STOP;
    }

    _onValueChanged() {
        if (this._valueChangedId)
            return;

        this._valueChangedId = Mainloop.timeout_add(SCROLL_TIMEOUT, () => {
            this._checkMessages();
            this._valueChangedId = 0;
            return GLib.SOURCE_REMOVE;
        });
    }

    _pendingMessageRemoved(channel, message) {
        let [id, valid] = message.get_pending_message_id();
        if (!valid || !this._pending.has(id))
            return;
        this._removePendingMark(id);
    }

    _removePendingMark(id) {
        let mark = this._pending.get(id);
        // Re-enable auto-scrolling if this is the most recent message
        if (this._view.buffer.get_iter_at_mark(mark).is_end())
            this._autoscroll = true;
        this._view.buffer.delete_mark(mark);
        this._pending.delete(id);
    }

    _showUrlContextMenu(url) {
        let menu = new Gtk.Menu();

        let item = new Gtk.MenuItem({ label: _("Open Link") });
        item.connect('activate', () => {
            Utils.openURL(url, Gtk.get_current_event_time());
        });
        menu.append(item);

        item = new Gtk.MenuItem({ label: _("Copy Link Address") });
        item.connect('activate', () => {
            let clipboard = Gtk.Clipboard.get_default(item.get_display());
            clipboard.set_text(url, -1);
        });
        menu.append(item);

        menu.show_all();
        menu.popup_at_pointer(null);
    }

    _handleButtonTagsHover(view, event) {
        let [, eventX, eventY] = event.get_coords();
        let [x, y] = view.window_to_buffer_coords(Gtk.TextWindowType.WIDGET,
                                                  eventX, eventY);
        let [inside, iter] = view.get_iter_at_location(x, y);

        let hoveredButtonTags;
        if (inside)
            hoveredButtonTags = iter.get_tags().filter(t => t instanceof ButtonTag);
        else
            hoveredButtonTags = [];

        hoveredButtonTags.forEach(t => { t.hover = true; });
        this._hoveredButtonTags.forEach(t => {
            t.hover = hoveredButtonTags.includes(t);
        });

        let isHovering = hoveredButtonTags.length > 0;
        let wasHovering = this._hoveredButtonTags.length > 0;

        if (isHovering != wasHovering) {
            let cursor = isHovering ? this._hoverCursor : null;
            this._view.get_window(Gtk.TextWindowType.TEXT).set_cursor(cursor);
        }

        this._hoveredButtonTags = hoveredButtonTags;

        return Gdk.EVENT_PROPAGATE;
    }

    _showLoadingIndicator() {
        let indicator = new Gtk.Image({ icon_name: 'content-loading-symbolic',
                                        visible: true });
        indicator.get_style_context().add_class('dim-label');

        let buffer = this._view.buffer;
        let iter = buffer.get_start_iter();
        let anchor = buffer.create_child_anchor(iter);
        this._view.add_child_at_anchor(indicator, anchor);
        buffer.insert(iter, '\n', -1);

        let start = buffer.get_start_iter();
        buffer.remove_all_tags(start, iter);
        buffer.apply_tag(this._lookupTag('loading'), start, iter);
    }

    _hideLoadingIndicator() {
        let buffer = this._view.buffer;
        let iter = buffer.get_start_iter();

        if (!iter.get_child_anchor())
            return;

        iter.forward_line();
        buffer.delete(buffer.get_start_iter(), iter);
    }

    _setIndicatorMark(iter) {
        let lineStart = iter.copy();
        lineStart.set_line_offset(0);

        let buffer = this._view.buffer;
        let mark = buffer.get_mark('indicator-line');
        if (mark) {
            let [start, end] = this._getLineIters(buffer.get_iter_at_mark(mark));
            buffer.remove_tag(this._lookupTag('indicator-line'), start, end);

            buffer.move_mark(mark, lineStart);
        } else {
            buffer.create_mark('indicator-line', lineStart, true);
        }

        let [start, end] = this._getLineIters(lineStart);
        buffer.apply_tag(this._lookupTag('indicator-line'), start, end);

        this._needsIndicator = false;
    }

    _checkMessages() {
        if (!this._app.isRoomFocused(this._room) || !this._channel)
            return;

        this._needsIndicator = true;

        let pending = this._channel.dup_pending_messages();
        if (pending.length == 0)
            return;

        let rect = this._view.get_visible_rect();
        let buffer = this._view.get_buffer();
        for (let i = 0; i < pending.length; i++) {
            let [id,] = pending[i].get_pending_message_id();
            let mark = this._pending.get(id);
            if (!mark) {
                this._channel.ack_message_async(pending[i], null);
                continue;
            }
            let iter = buffer.get_iter_at_mark(mark);
            let iterRect = this._view.get_iter_location(iter);
            if (rect.y <= iterRect.y && rect.y + rect.height > iterRect.y)
                this._channel.ack_message_async(pending[i], null);
        }
    }

    _getNickTagName(nick) {
        return NICKTAG_PREFIX + Polari.util_get_basenick(nick);
    }

    _getNickFromTagName(tagName) {
        if (tagName.startsWith(NICKTAG_PREFIX))
            return tagName.replace(NICKTAG_PREFIX, '');
        return null;
    }

    _onChannelChanged() {
        if (this._channel == this._room.channel)
            return;

        // Pending IDs are invalidated by channel changes, so
        // remove marks to not get stuck on highlighted messages
        for (let id of this._pending.keys())
            this._removePendingMark(id);

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
              handler: this._onMessageReceived.bind(this) },
            { name: 'message-sent',
              handler: this._onMessageSent.bind(this) },
            { name: 'pending-message-removed',
              handler: this._pendingMessageRemoved.bind(this) }
        ];
        channelSignals.forEach(signal => {
            this._channelSignals.push(this._channel.connect(signal.name, signal.handler));
        });

        let pending = this._channel.dup_pending_messages();
        this._initialPending = pending.map(p => this._createMessage(p));
    }

    _onMemberRenamed(room, oldMember, newMember) {
        let text = _("%s is now known as %s").format(oldMember.alias, newMember.alias);
        this._insertStatus(text, oldMember.alias, 'renamed');
    }

    _onMemberDisconnected(room, member, message) {
        let text = _("%s has disconnected").format(member.alias);
        if (message)
            text += ' (%s)'.format(message);
        this._insertStatus(text, member.alias, 'left');
    }

    _onMemberKicked(room, member, actor) {
        let message =
            actor ? _("%s has been kicked by %s").format(member.alias,
                                                         actor.alias)
                  : _("%s has been kicked").format(member.alias);
        this._insertStatus(message, member.alias, 'left');
    }

    _onMemberBanned(room, member, actor) {
        let message =
            actor ? _("%s has been banned by %s").format(member.alias,
                                                         actor.alias)
                  : _("%s has been banned").format(member.alias)
        this._insertStatus(message, member.alias, 'left');
    }

    _onMemberJoined(room, member) {
        let text = _("%s joined").format(member.alias);
        this._insertStatus(text, member.alias, 'joined');
    }

    _onMemberLeft(room, member, message) {
        let text = _("%s left").format(member.alias);

        if (message)
            text += ' (%s)'.format(message);

        this._insertStatus(text, member.alias, 'left');
    }

    _onMessageReceived(channel, tpMessage) {
        this._insertTpMessage(tpMessage);
        this._resetStatusCompressed();
        let nick = tpMessage.sender.alias;
        let nickTag = this._lookupTag('nick' + nick);
        if (!nickTag)
           return;
        nickTag._lastActivity = GLib.get_monotonic_time();
    }

    _onMessageSent(channel, tpMessage) {
        this._insertTpMessage(tpMessage);
        this._resetStatusCompressed();
    }

    _resetStatusCompressed() {
        let markStart = this._view.buffer.get_mark('idle-status-start');
        if (!markStart)
            return;

        this._view.buffer.delete_mark(markStart);
        this._statusCount =  { left: 0, joined: 0, total: 0 };
        this._state.lastStatusGroup++;
    }

    _shouldShowStatus(nick) {
        let nickTag = this._lookupTag('nick' + nick);

        if (!nickTag || !nickTag._lastActivity)
            return false;

        let time = GLib.get_monotonic_time();
        return (time - nickTag._lastActivity) / (1000 * 1000) < INACTIVITY_THRESHOLD;
    }

    _updateStatusHeader() {
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

            headerTag.connect('clicked', () => {
                groupTag.invisible = !groupTag.invisible;
            });

            headerTag.connect('notify::hover', () => {
                headerTag.foreground_rgba = headerTag.hover ? this._statusHeaderHoverColor : null;
            });

            this._ensureNewLine();
            headerMark = buffer.create_mark('idle-status-start', buffer.get_end_iter(), true);
        } else {
            headerTag = this._lookupTag(headerTagName);
            headerArrowTag = this._lookupTag(headerArrowTagName);
            groupTag = this._lookupTag(groupTagName);

            let start = buffer.get_iter_at_mark(headerMark);
            let end = start.copy();
            end.forward_to_line_end();
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
    }

    _insertStatus(text, member, type) {
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
    }

    _formatTimestamp(timestamp) {
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
    }

    _insertTpMessage(tpMessage) {
        let message = this._createMessage(tpMessage);

        this._ensureNewLine();

        let iter = this._view.buffer.get_end_iter();
        this._insertMessage(iter, message, this._state);

        if (message.pendingId == undefined /* outgoing */ ||
            (this._app.isRoomFocused(this._room) && this._pending.size == 0))
            this._channel.ack_message_async(tpMessage, null);
        else if (this._needsIndicator)
            this._setIndicatorMark(this._view.buffer.get_end_iter());
    }

    _insertMessage(iter, message, state) {
        let isAction = message.messageType == Tp.ChannelTextMessageType.ACTION;
        let needsGap = message.nick != state.lastNick || isAction;
        let highlight = this._room.should_highlight_message(message.nick,
                                                            message.text);

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
                    nickTag = new ButtonTag({ name: nickTagName });
                    nickTag.connect('clicked', this._onNickTagClicked.bind(this));

                    let status = this._userTracker.getNickRoomStatus(message.nick, this._room);
                    this._updateNickTag(nickTag, status);

                    buffer.get_tag_table().add(nickTag);
                }
                tags.push(nickTag);

                let hoverTag = new HoverFilterTag({ filtered_tag: nickTag,
                                                    hover_opacity: 0.8 });
                buffer.get_tag_table().add(hoverTag);

                tags.push(hoverTag);

                if (needsGap)
                    tags.push(this._lookupTag('gap'));
                this._insertWithTags(iter, message.nick, tags);
                buffer.insert(iter, '\t', -1);
            }
            state.lastNick = message.nick;
            tags.push(this._lookupTag('message'));
        }

        if (highlight)
            tags.push(this._lookupTag('highlight'));

        let params = this._room.account.dup_parameters_vardict().deep_unpack();
        let server = params.server.deep_unpack();

        let text = message.text;

        // mask identify passwords in private chats
        if (this._room.type == Tp.HandleType.CONTACT) {
            let [isIdentify, command, username, password] =
                Polari.util_match_identify_message(text);

            if (isIdentify)
                text = text.replace(password, (p) => p.replace(/./g, '●'));
        }

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

        if (highlight && message.pendingId)
            this._pending.set(message.pendingId,
                              this._view.buffer.create_mark(null, iter, true));
    }

    _onNickStatusChanged(baseNick, status) {
        if (this._room.type == Tp.HandleType.CONTACT &&
            status == Tp.ConnectionPresenceType.OFFLINE &&
            this._room.channel)
            this._room.channel.ack_all_pending_messages_async(() => {
                this._room.channel.close_async(null);
            });

        let nickTagName = this._getNickTagName(baseNick);
        let nickTag = this._lookupTag(nickTagName);

        if (!nickTag)
            return;

        this._updateNickTag(nickTag, status);
    }

    _updateNickTag(tag, status) {
        if (status == Tp.ConnectionPresenceType.AVAILABLE)
            tag.foreground_rgba = this._activeNickColor;
        else
            tag.foreground_rgba = this._inactiveNickColor;
    }

    _onNickTagClicked(tag) {
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

        let actualNickName = view.get_buffer().get_slice(start, end, false);

        if (!tag._popover)
            tag._popover = new UserPopover({ relative_to: this._view,
                                             userTracker: this._userTracker,
                                             room: this._room });

        tag._popover.nickname = actualNickName;

        tag._popover.pointing_to = rect1;
        tag._popover.show();
    }

    _createUrlTag(url) {
        if (!url.includes(':'))
            url = 'http://' + url;

        let tag = new ButtonTag();
        tag.connect('notify::hover', () => {
            tag.foreground_rgba = tag.hover ? this._hoveredLinkColor : null;
        });
        tag.connect('clicked', () => {
            Utils.openURL(url, Gtk.get_current_event_time());
        });
        tag.connect('popup-menu', () => {
            this._showUrlContextMenu(url);
        });
        return tag;
    }

    _ensureNewLine() {
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
    }

    _getLineIters(iter) {
        let start = iter.copy();
        start.backward_line();
        start.forward_to_line_end();

        let end = iter.copy();
        end.forward_to_line_end();

        return [start, end];
    }

    _lookupTag(name) {
        return this._view.get_buffer().tag_table.lookup(name);
    }

    _insertWithTagName(iter, text, name) {
        this._insertWithTags(iter, text, [this._lookupTag(name)]);
    }

    _insertWithTags(iter, text, tags) {
        let buffer = this._view.get_buffer();
        let offset = iter.get_offset();

        buffer.insert(iter, text, -1);

        let start = buffer.get_iter_at_offset(offset);

        buffer.remove_all_tags(start, iter);
        for (let i = 0; i < tags.length; i++)
            buffer.apply_tag(tags[i], start, iter);
    }
});
