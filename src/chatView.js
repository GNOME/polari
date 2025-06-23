// SPDX-FileCopyrightText: 2013 Florian Müllner <fmuellner@gnome.org>
// SPDX-FileCopyrightText: 2014 Carlos Soriano <carlos.soriano89@gmail.com>
// SPDX-FileCopyrightText: 2015 Bastian Ilso <bastianilso@gnome.org>
// SPDX-FileCopyrightText: 2016 raresv <rares.visalom@gmail.com>
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Graphene from 'gi://Graphene';
import Gtk from 'gi://Gtk';
import Pango from 'gi://Pango';
import Polari from 'gi://Polari';
import Tp from 'gi://TelepathyGLib';

import {DropTargetIface} from './pasteManager.js';
import {LogWalker} from './logger.js';
import {UserPopover} from './userList.js';
import UserStatusMonitor from './userTracker.js';
import URLPreview from './urlPreview.js';
import * as Utils from './utils.js';

export const MAX_NICK_CHARS = 8;
const IGNORE_STATUS_TIME = 5;

const SCROLL_TIMEOUT = 100; // ms

// seconds of inactivity after which to insert a timestamp
const TIMESTAMP_INTERVAL = 300;

// a threshold in seconds used to control
// the visibility of status messages
const INACTIVITY_THRESHOLD = 300;
const STATUS_NOISE_MAXIMUM = 4;

// number of log events to fetch on start
const NUM_INITIAL_LOG_EVENTS = 50;
// number of log events to fetch when requesting more
const NUM_LOG_EVENTS = 10;

const MARGIN = 14;
// space after nicks, matching the following elements
// of the nick button in the entry area:
// 8px padding + 6px spacing
const NICK_SPACING = 14;

const NICKTAG_PREFIX = 'nick';

// Workaround for GtkTextView growing horizontally over time when
// added to a GtkScrolledWindow with horizontal scrolling disabled
const TextView = GObject.registerClass(
class TextView extends Gtk.TextView {
    static [GObject.properties] = {
        'indent-width-chars': GObject.ParamSpec.uint(
            'indent-width-chars', null, null,
            GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT,
            0, GLib.MAXUINT32, 0),
        'indent-spacing': GObject.ParamSpec.uint(
            'indent-spacing', null, null,
            GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT,
            0, GLib.MAXUINT32, 0),
    };

    constructor(params) {
        super(params);

        this.buffer.connect('mark-set', this._onMarkSet.bind(this));
        this.connect('notify::root', this._onScreenChanged.bind(this));
    }

    get indent_width_chars() {
        return this._indentWidthChars;
    }

    set indent_width_chars(value) {
        if (this._indentWidthChars === value)
            return;

        this._indentWidthChars = value;
        this.notify('indent-width-chars');

        this._updateIndent();
    }

    get indent_spacing() {
        return this._indentSpacing;
    }

    set indent_spacing(value) {
        if (this._indentSpacing === value)
            return;

        this._indentSpacing = value;
        this.notify('indent-spacing');
        this._updateIndent();
    }

    _updateIndent() {
        const context = this.get_pango_context();
        const metrics = context.get_metrics(null, null);
        const charWidth = Math.max(
            metrics.get_approximate_char_width(),
            metrics.get_approximate_digit_width());
        const pixelWidth = Pango.units_to_double(charWidth);

        const totalWidth =
            this._indentWidthChars * pixelWidth + this._indentSpacing;

        const tabs = Pango.TabArray.new(1, true);
        tabs.set_tab(0, Pango.TabAlign.LEFT, totalWidth);

        this.set({
            tabs,
            indent: -totalWidth,
        });
    }

    vfunc_measure(orientation, forSize) {
        const [min, nat] = orientation === Gtk.Orientation.HORIZONTAL
            ? [1, 1] : super.vfunc_measure(orientation, forSize);
        return [min, nat, -1, -1];
    }

    vfunc_css_changed(change) {
        super.vfunc_css_changed(change);

        const context = this.get_style_context();
        [, this._dimColor] = context.lookup_color('inactive_nick_color');

        /* pick up DPI changes (e.g. via the 'text-scaling-factor' setting):
           the default handler calls pango_cairo_context_set_resolution(), so
           update the indent after that */
        this._updateIndent();
    }

    vfunc_snapshot(snapshot) {
        super.vfunc_snapshot(snapshot);

        let mark = this.buffer.get_mark('indicator-line');
        if (!mark)
            return;

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

        snapshot.save();

        snapshot.translate(new Graphene.Point({x: layoutX, y: layoutY}));
        snapshot.append_layout(this._layout, this._dimColor);

        snapshot.restore();

        const [, color] = this.get_style_context().lookup_color('borders');

        const rect = new Graphene.Rect();

        rect.init(MARGIN, y, layoutX - 2 * MARGIN, 1);
        snapshot.append_color(color, rect);

        rect.init(layoutX + layoutWidth + MARGIN, y, width - layoutX - layoutWidth, 1);
        snapshot.append_color(color, rect);
    }

    _onMarkSet(buffer, iter, mark) {
        if (mark.name === 'indicator-line')
            this.queue_draw();
    }

    _onScreenChanged() {
        this._layout = this.create_pango_layout(null);
        this._layout.set_markup(`<small><b>${_('New Messages')}</b></small>`, -1);

        this._updateIndent();
    }
});

const ButtonTag = GObject.registerClass(
class ButtonTag extends Gtk.TextTag {
    static [GObject.properties] = {
        'hover': GObject.ParamSpec.boolean(
            'hover', null, null,
            GObject.ParamFlags.READWRITE,
            false),
    };

    static [GObject.signals] = {
        'clicked': {param_types: [GObject.TYPE_DOUBLE, GObject.TYPE_DOUBLE]},
        'popup-menu': {param_types: [GObject.TYPE_DOUBLE, GObject.TYPE_DOUBLE]},
    };

    clicked(...coords) {
        this.emit('clicked', ...coords);
    }

    popupMenu(...coords) {
        this.emit('popup-menu', ...coords);
    }
});

const HoverFilterTag = GObject.registerClass(
class HoverFilterTag extends ButtonTag {
    static [GObject.properties] = {
        'filtered-tag': GObject.ParamSpec.object(
            'filtered-tag', null, null,
            GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT_ONLY,
            Gtk.TextTag.$gtype),
        'hover-opacity': GObject.ParamSpec.double(
            'hover-opacity', null, null,
            GObject.ParamFlags.READWRITE,
            0.0, 1.0, 1.0),
    };

    constructor(params) {
        super(params);

        this.connect('notify::hover', () => this._updateColor());
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
        if (this._hoverOpacity === value)
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

export default GObject.registerClass(
class ChatView extends Gtk.ScrolledWindow {
    static [GObject.interfaces] = [DropTargetIface];
    static [GObject.properties] = {
        'can-drop': GObject.ParamSpec.override('can-drop', DropTargetIface),
        'max-nick-chars': GObject.ParamSpec.uint(
            'max-nick-chars', null, null,
            GObject.ParamFlags.READABLE,
            0, GLib.MAXUINT32, 0),
    };

    constructor(room) {
        super({hscrollbar_policy: Gtk.PolicyType.NEVER, vexpand: true});

        this.add_css_class('polari-chat-view');

        this._actionGroup = new Gio.SimpleActionGroup();
        this.insert_action_group('chatlog', this._actionGroup);
        this._actionGroup.add_action_entries([
            {
                name: 'open-url',
                parameter_type: 's',
                activate: (a, params) => Utils.openURL(params.unpack()),
            },
            {
                name: 'copy-url',
                parameter_type: 's',
                activate: (a, params) =>
                    this.get_clipboard().set(params.unpack()),
            },
        ]);

        this._view = new TextView({
            editable: false, cursor_visible: false,
            wrap_mode: Gtk.WrapMode.WORD_CHAR,
            right_margin: MARGIN,
            bottom_margin: MARGIN,
            indent_width_chars: MAX_NICK_CHARS,
            indent_spacing: NICK_SPACING,
        });
        this._view.bind_property_full('indent',
            this._view, 'left-margin',
            GObject.BindingFlags.SYNC_CREATE,
            (v, source) => [true, MARGIN - source],
            null);
        this.set_child(this._view);

        this._createTags();

        this.connect('destroy', this._onDestroy.bind(this));
        this.connect('edge-reached', (w, pos) => {
            if (pos === Gtk.PositionType.BOTTOM)
                this._autoscroll = true;
        });

        this._queriedInitialBacklog = false;
        this.connect('map', () => {
            if (this._app.importingLogs)
                return;

            if (!this._queriedInitialBacklog) {
                this._queriedInitialBacklog = true;
                this._fetchingBacklog = true;
                this._getLogEvents(NUM_INITIAL_LOG_EVENTS);
            }
        });

        this.vadjustment.connect('value-changed',
            this._onValueChanged.bind(this));
        this.vadjustment.connect('changed', this._updateScroll.bind(this));
        this.vadjustment.connect('notify::upper',
            this._onUpperChanged.bind(this));

        this._scrollController = new Gtk.EventControllerScroll({
            flags: Gtk.EventControllerScrollFlags.VERTICAL,
        });
        this._scrollController.connect('scroll', this._onScroll.bind(this));
        this.add_controller(this._scrollController);

        this._keyController = new Gtk.EventControllerKey();
        this._keyController.connect('key-pressed', this._onKeyPressed.bind(this));
        this._view.add_controller(this._keyController);

        this._motionController = new Gtk.EventControllerMotion();
        this._motionController.connect('motion',
            this._handleButtonTagsHover.bind(this));
        this._motionController.connect('enter',
            this._handleButtonTagsHover.bind(this));
        this._motionController.connect('leave',
            this._handleButtonTagsHover.bind(this));
        this._view.add_controller(this._motionController);

        this._clickGesture = new Gtk.GestureClick({
            propagation_phase: Gtk.PropagationPhase.CAPTURE,
            button: 0,
        });
        this._clickGesture.connect('pressed',
            this._handleButtonTagPressed.bind(this));
        this._clickGesture.connect('released',
            this._handleButtonTagReleased.bind(this));
        this._view.add_controller(this._clickGesture);

        this._room = room;
        this._state = {lastNick: null, lastTimestamp: 0, lastStatusGroup: 0};
        this._joinTime = 0;
        this._hoveredButtonTags = [];
        this._needsIndicator = true;
        this._pending = new Map();
        this._pendingLogs = [];
        this._initialPending = [];
        this._statusCount = {left: 0, joined: 0, total: 0};

        this._activeNickColor = new Gdk.RGBA();
        this._inactiveNickColor = new Gdk.RGBA();
        this._hoveredLinkColor = new Gdk.RGBA();
        this._statusHeaderHoverColor = new Gdk.RGBA();

        let statusMonitor = UserStatusMonitor.getDefault();
        this._userTracker = statusMonitor.getUserTrackerForAccount(room.account);

        this._room.account.connect('notify::nickname', () => {
            this._updateMaxNickChars(this._room.account.nickname.length);
        });
        this._updateMaxNickChars(this._room.account.nickname.length);

        this._logWalker = new LogWalker(this._room);

        this._autoscroll = true;
        this._originalUpper = this.vadjustment.get_upper();

        this._app = Gio.Application.get_default();
        this.addTargets(this._view);

        this._roomFocusChangedId = this._app.connect('room-focus-changed',
            this._checkMessages.bind(this));

        this._channelSignals = [];
        this._channel = null;

        let roomSignals = [{
            name: 'notify::channel',
            handler: this._onChannelChanged.bind(this),
        }, {
            name: 'member-renamed',
            handler: this._onMemberRenamed.bind(this),
        }, {
            name: 'member-disconnected',
            handler: this._onMemberDisconnected.bind(this),
        }, {
            name: 'member-kicked',
            handler: this._onMemberKicked.bind(this),
        }, {
            name: 'member-banned',
            handler: this._onMemberBanned.bind(this),
        }, {
            name: 'member-joined',
            handler: this._onMemberJoined.bind(this),
        }, {
            name: 'member-left',
            handler: this._onMemberLeft.bind(this),
        }];
        this._roomSignals = [];
        roomSignals.forEach(signal => {
            this._roomSignals.push(room.connect(signal.name, signal.handler));
        });
        this._onChannelChanged();

        this._nickStatusChangedId = this._userTracker.watchRoomStatus(
            this._room, null, this._onNickStatusChanged.bind(this));
    }

    _createTags() {
        let buffer = this._view.get_buffer();
        let tagTable = buffer.get_tag_table();
        let tags = [{
            name: 'nick',
            left_margin: MARGIN,
            weight: Pango.Weight.BOLD,
        }, {
            name: 'gap',
            pixels_above_lines: 10,
        }, {
            name: 'message',
            indent: 0,
        }, {
            name: 'highlight',
            weight: Pango.Weight.BOLD,
        }, {
            name: 'status',
            left_margin: MARGIN,
            indent: 0,
        }, {
            name: 'timestamp',
            left_margin: MARGIN,
            indent: 0,
            justification: Gtk.Justification.RIGHT,
        }, {
            name: 'action',
            left_margin: MARGIN,
            style: Pango.Style.ITALIC,
        }, {
            name: 'url',
            underline: Pango.Underline.SINGLE,
        }, {
            name: 'indicator-line',
            pixels_above_lines: 24,
        }, {
            name: 'loading',
            left_margin: MARGIN,
            justification: Gtk.Justification.CENTER,
        }];
        tags.forEach(tagProps => tagTable.add(new Gtk.TextTag(tagProps)));
    }

    vfunc_css_changed(change) {
        super.vfunc_css_changed(change);

        const context = this.get_style_context();
        const [, activeColor] =
            context.lookup_color('active_nick_color');
        const [, activeHoverColor] =
            context.lookup_color('active_nick_hover_color');
        const [, inactiveColor] =
            context.lookup_color('inactive_nick_color');
        const [, inactiveHoverColor] =
            context.lookup_color('inactive_nick_hover_color');

        this._activeNickColor = activeColor;
        this._inactiveNickColor = inactiveColor;
        this._hoveredLinkColor = activeHoverColor;
        this._statusHeaderHoverColor = inactiveHoverColor;

        let buffer = this._view.get_buffer();
        let tagTable = buffer.get_tag_table();
        let tags = [{
            name: 'status',
            foreground_rgba: inactiveColor,
        }, {
            name: 'timestamp',
            foreground_rgba: inactiveColor,
        }, {
            name: 'url',
            foreground_rgba: activeColor,
        }];
        tags.forEach(tagProps => {
            let tag = tagTable.lookup(tagProps.name);
            for (let prop in tagProps) {
                if (prop === 'name')
                    continue;
                tag[prop] = tagProps[prop];
            }
        });

        tagTable.foreach(tag => {
            if (!tag.name)
                return;

            let nickname = this._getNickFromTagName(tag.name);

            if (!nickname)
                return;

            let status = this._userTracker.getNickRoomStatus(nickname, this._room);
            this._updateNickTag(tag, status);
        });
    }

    _onDestroy() {
        this._channelSignals.forEach(id => this._channel.disconnect(id));
        this._channelSignals = [];

        this._roomSignals.forEach(id => this._room.disconnect(id));
        this._roomSignals = [];

        if (this._roomFocusChangedId)
            this._app.disconnect(this._roomFocusChangedId);
        this._roomFocusChangedId = 0;

        if (this._nickStatusChangedId) {
            this._userTracker.unwatchRoomStatus(
                this._room, this._nickStatusChangedId);
        }
        this._nickStatusChangedId = 0;
        this._userTracker = null;

        this._logWalker = null;
    }

    async _getLogEvents(num) {
        try {
            const events = await this._logWalker.getEvents(num);

            this._hideLoadingIndicator();
            this._fetchingBacklog = false;

            this._pendingLogs = events.concat(this._pendingLogs);
            this._insertPendingLogs();
        } catch (e) {
            console.debug(e);
        }
    }

    _createMessage(source) {
        if (source instanceof Tp.Message) {
            const [id, valid] = source.get_pending_message_id();
            const msg = Polari.Message.new_from_tp_message(source);
            msg.pendingId = valid ? id : undefined;
            return msg;
        }

        throw new Error(`Cannot create message from source ${source}`);
    }

    _getReadyLogs() {
        if (this._logWalker.isEnd())
            return this._pendingLogs.splice(0);

        const nick = this._pendingLogs[0].get_sender();
        const isAction = this._pendingLogs[0].is_action();
        const maxNum = this._pendingLogs.length - this._initialPending.length;
        for (let i = 0; i < maxNum; i++) {
            if (this._pendingLogs[i].get_sender() !== nick ||
                this._pendingLogs[i].is_action() !== isAction)
                return this._pendingLogs.splice(i);
        }
        return [];
    }

    _appendInitialPending(logs) {
        let pending = this._initialPending.splice(0);
        let firstPending = pending[0];

        let numLogs = logs.length;
        let pos;
        for (pos = numLogs - pending.length; pos < numLogs; pos++) {
            if (logs[pos].get_sender() === firstPending.get_sender() &&
                logs[pos].get_text() === firstPending.get_text() &&
                logs[pos].is_action() === firstPending.is_action() &&
                logs[pos].get_time().equal(firstPending.get_time()))
                break;
        }
        // Remove entries that are also in pending (if any), then
        // add the entries from pending
        logs.splice(pos, numLogs, ...pending);
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

        let state = {lastNick: null, lastTimestamp: 0};
        let iter = this._view.buffer.get_start_iter();

        for (let i = 0; i < pending.length; i++) {
            // Workaround https://gitlab.gnome.org/GNOME/gtk/merge_requests/395
            this.set_kinetic_scrolling(false);
            this._insertingBacklog = true;

            this._insertMessage(iter, pending[i], state);

            if (i === indicatorIndex)
                this._setIndicatorMark(iter);

            if (!iter.is_end() || i < pending.length - 1)
                this._view.buffer.insert(iter, '\n', -1);
        }
    }

    get max_nick_chars() {
        return this._view.indent_width_chars;
    }

    get can_drop() {
        return this._channel !== null;
    }

    _updateMaxNickChars(length) {
        if (length <= this._view.indent_width_chars)
            return;

        this._view.indent_width_chars = length;
        this.notify('max-nick-chars');
    }

    _updateScroll() {
        if (!this._autoscroll)
            return;

        if (this._pending.size === 0) {
            this._view.emit('move-cursor',
                Gtk.MovementStep.BUFFER_ENDS, 1, false);
        } else {
            this._autoscroll = false;
            let mark = [...this._pending.values()].shift();
            this._view.scroll_mark_onscreen(mark);
        }
    }

    _onScroll(w, dx, dy) {
        if (dy >= 0)
            return Gdk.EVENT_PROPAGATE;

        this._autoscroll = false;

        return this._fetchBacklog();
    }

    _onKeyPressed(c, keyval) {
        if (keyval === Gdk.KEY_Home ||
            keyval === Gdk.KEY_KP_Home) {
            this._view.emit('move-cursor',
                Gtk.MovementStep.BUFFER_ENDS, -1, false);
            return Gdk.EVENT_STOP;
        } else if (keyval === Gdk.KEY_End ||
                   keyval === Gdk.KEY_KP_End) {
            this._view.emit('move-cursor',
                Gtk.MovementStep.BUFFER_ENDS, 1, false);
            return Gdk.EVENT_STOP;
        }

        if (keyval !== Gdk.KEY_Up &&
            keyval !== Gdk.KEY_KP_Up &&
            keyval !== Gdk.KEY_Page_Up &&
            keyval !== Gdk.KEY_KP_Page_Up)
            return Gdk.EVENT_PROPAGATE;

        this._autoscroll = false;

        return this._fetchBacklog();
    }

    _fetchBacklog() {
        if (this._app.importingLogs)
            return Gdk.EVENT_PROPAGATE;

        if (this.vadjustment.value !== 0 ||
            this._logWalker.isEnd())
            return Gdk.EVENT_PROPAGATE;

        if (this._fetchingBacklog)
            return Gdk.EVENT_STOP;

        this._fetchingBacklog = true;
        this._showLoadingIndicator();
        this._getLogEvents(NUM_LOG_EVENTS);
        return Gdk.EVENT_STOP;
    }

    _onValueChanged() {
        if (this._valueChangedId)
            return;

        this._valueChangedId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SCROLL_TIMEOUT, () => {
            this._checkMessages();
            this._valueChangedId = 0;
            return GLib.SOURCE_REMOVE;
        });
    }

    _onUpperChanged() {
        const newUpper = this.vadjustment.get_upper();
        const diff = newUpper - this._originalUpper;

        if (diff !== 0.0) {
            this._originalUpper = newUpper;
            if (this._insertingBacklog) {
                this.vadjustment.set_value(this.vadjustment.get_value() + diff);
                this.set_kinetic_scrolling(true);
                this._insertingBacklog = false;
            }
        }
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

    _showUrlContextMenu(url, x, y) {
        const section = new Gio.Menu();

        section.append(
            _('Open Link'), `chatlog.open-url("${url}")`);
        section.append(
            _('Copy Link Address'), `chatlog.copy-url("${url}")`);

        const menu = new Gtk.PopoverMenu({
            position: Gtk.PositionType.BOTTOM,
            pointing_to: new Gdk.Rectangle({x, y}),
            menu_model: section,
            has_arrow: false,
        });
        menu.set_parent(this._view);
        menu.popup();
    }

    _getHoveredButtonTags(coords) {
        let inside, iter;

        if (coords.length > 0) {
            const [eventX, eventY] = coords;
            const [x, y] = this._view.window_to_buffer_coords(
                Gtk.TextWindowType.WIDGET, eventX, eventY);
            [inside, iter] = this._view.get_iter_at_location(x, y);
        }

        return inside
            ? iter.get_tags().filter(t => t instanceof ButtonTag) : [];
    }

    _handleButtonTagsHover(controller, ...coords) {
        const hoveredButtonTags = this._getHoveredButtonTags(coords);

        hoveredButtonTags.forEach(t => (t.hover = true));
        this._hoveredButtonTags.forEach(t => {
            t.hover = hoveredButtonTags.includes(t);
        });

        let isHovering = hoveredButtonTags.length > 0;
        let wasHovering = this._hoveredButtonTags.length > 0;

        if (isHovering !== wasHovering)
            this._view.set_cursor_from_name(isHovering ? 'pointer' : 'text');

        this._hoveredButtonTags = hoveredButtonTags;
    }

    _handleButtonTagPressed(gesture, nPress, ...coords) {
        const event = gesture.get_current_event();

        if (nPress > 1 || !event.triggers_context_menu())
            return;

        const hoveredButtonTags = this._getHoveredButtonTags(coords);
        hoveredButtonTags.forEach(t => t.popupMenu(...coords));

        if (hoveredButtonTags.length > 0)
            gesture.set_state(Gtk.EventSequenceState.CLAIMED);
    }

    _handleButtonTagReleased(gesture, nPress, ...coords) {
        const button = gesture.get_current_button();

        if (nPress > 1 || button !== Gdk.BUTTON_PRIMARY)
            return;

        const hoveredButtonTags = this._getHoveredButtonTags(coords);
        hoveredButtonTags.forEach(t => t.clicked(...coords));

        if (hoveredButtonTags.length > 0)
            gesture.set_state(Gtk.EventSequenceState.CLAIMED);
    }

    _showLoadingIndicator() {
        let indicator = new Gtk.Image({
            icon_name: 'content-loading-symbolic',
        });
        indicator.add_css_class('dim-label');

        let {buffer} = this._view;
        let iter = buffer.get_start_iter();
        let anchor = buffer.create_child_anchor(iter);
        this._view.add_child_at_anchor(indicator, anchor);
        buffer.insert(iter, '\n', -1);

        let start = buffer.get_start_iter();
        buffer.remove_all_tags(start, iter);
        buffer.apply_tag(this._lookupTag('loading'), start, iter);
    }

    _hideLoadingIndicator() {
        let {buffer} = this._view;
        let iter = buffer.get_start_iter();

        if (!iter.get_child_anchor())
            return;

        iter.forward_line();
        buffer.delete(buffer.get_start_iter(), iter);
    }

    _setIndicatorMark(iter) {
        let lineStart = iter.copy();
        lineStart.set_line_offset(0);

        let {buffer} = this._view;
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
        if (pending.length === 0)
            return;

        let rect = this._view.get_visible_rect();
        let buffer = this._view.get_buffer();
        for (let i = 0; i < pending.length; i++) {
            let [id] = pending[i].get_pending_message_id();
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
        return `${NICKTAG_PREFIX}${Polari.util_get_basenick(nick)}`;
    }

    _getNickFromTagName(tagName) {
        if (tagName.startsWith(NICKTAG_PREFIX))
            return tagName.replace(NICKTAG_PREFIX, '');
        return null;
    }

    _onChannelChanged() {
        if (this._channel === this._room.channel)
            return;

        // Pending IDs are invalidated by channel changes, so
        // remove marks to not get stuck on highlighted messages
        for (let id of this._pending.keys())
            this._removePendingMark(id);

        if (this._channel) {
            this._channelSignals.forEach(id => this._channel.disconnect(id));
            this._channelSignals = [];
        }

        this._channel = this._room.channel;

        let nick = this._channel
            ? this._channel.connection.self_contact.alias
            : this._room.account.nickname;
        this._updateMaxNickChars(nick.length);

        if (!this._channel)
            return;

        this._joinTime = GLib.DateTime.new_now_utc().to_unix();

        let channelSignals = [{
            name: 'message-received',
            handler: this._onMessageReceived.bind(this),
        }, {
            name: 'message-sent',
            handler: this._onMessageSent.bind(this),
        }, {
            name: 'pending-message-removed',
            handler: this._pendingMessageRemoved.bind(this),
        }];
        channelSignals.forEach(signal => {
            this._channelSignals.push(this._channel.connect(signal.name, signal.handler));
        });

        let pending = this._channel.dup_pending_messages();
        this._initialPending = pending.map(p => this._createMessage(p));
    }

    _onMemberRenamed(room, oldMember, newMember) {
        let text = vprintf(_('%s is now known as %s'), oldMember.alias, newMember.alias);
        this._insertStatus(text, oldMember.alias, 'renamed');
    }

    _onMemberDisconnected(room, member, message) {
        let text = vprintf(_('%s has disconnected'), member.alias);
        if (message)
            text += ` (${message})`;
        this._insertStatus(text, member.alias, 'left');
    }

    _onMemberKicked(room, member, actor) {
        let [kicked, kicker] = [member.alias, actor ? actor.alias : null];
        let msg = kicker
            ? vprintf(_('%s has been kicked by %s'), kicked, kicker)
            : vprintf(_('%s has been kicked'), kicked);
        this._insertStatus(msg, kicked, 'left');
    }

    _onMemberBanned(room, member, actor) {
        let [banned, banner] = [member.alias, actor ? actor.alias : null];
        let msg = banner
            ? vprintf(_('%s has been banned by %s'), banned, banner)
            : vprintf(_('%s has been banned'), banned);
        this._insertStatus(msg, banned, 'left');
    }

    _onMemberJoined(room, member) {
        let text = vprintf(_('%s joined'), member.alias);
        this._insertStatus(text, member.alias, 'joined');
    }

    _onMemberLeft(room, member, message) {
        let text = vprintf(_('%s left'), member.alias);

        if (message)
            text += ` (${message})`;

        this._insertStatus(text, member.alias, 'left');
    }

    _onMessageReceived(channel, tpMessage) {
        this._insertTpMessage(tpMessage);
        this._resetStatusCompressed();
        let nick = tpMessage.sender.alias;
        let nickTag = this._lookupTag(`nick${nick}`);
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
        this._statusCount =  {left: 0, joined: 0, total: 0};
        this._state.lastStatusGroup++;
    }

    _shouldShowStatus(nick) {
        let nickTag = this._lookupTag(`nick${nick}`);

        if (!nickTag || !nickTag._lastActivity)
            return false;

        let time = GLib.get_monotonic_time();
        return (time - nickTag._lastActivity) / (1000 * 1000) < INACTIVITY_THRESHOLD;
    }

    _updateStatusHeader() {
        let {buffer} = this._view;
        let headerMark = buffer.get_mark('idle-status-start');

        let headerTagName = `status-compressed${this._state.lastStatusGroup}`;
        let headerArrowTagName = `status-arrow-compressed${this._state.lastStatusGroup}`;
        let groupTagName = `status${this._state.lastStatusGroup}`;

        let headerTag, headerArrowTag, groupTag;
        if (!headerMark) {
            // we are starting a new group
            headerTag = new ButtonTag({name: headerTagName, invisible: true});
            headerArrowTag = new Gtk.TextTag({name: headerArrowTagName, invisible: true});
            groupTag = new Gtk.TextTag({name: groupTagName});
            buffer.tag_table.add(headerTag);
            buffer.tag_table.add(headerArrowTag);
            buffer.tag_table.add(groupTag);

            groupTag.bind_property('invisible',
                headerArrowTag, 'invisible',
                GObject.BindingFlags.INVERT_BOOLEAN);

            headerTag.connect('clicked', () => {
                groupTag.invisible = !groupTag.invisible;
            });

            headerTag.connect('notify::hover', () => {
                headerTag.foreground_rgba = headerTag.hover ? this._statusHeaderHoverColor : null;
            });

            this._ensureNewLine();
            headerMark = buffer.create_mark('idle-status-start',
                buffer.get_end_iter(), true);
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
        if (this._statusCount.joined > 0) {
            stats.push(vprintf(
                ngettext(
                    '%d user joined',
                    '%d users joined', this._statusCount.joined),
                this._statusCount.joined));
        }
        if (this._statusCount.left > 0) {
            stats.push(vprintf(
                ngettext(
                    '%d user left',
                    '%d users left', this._statusCount.left),
                this._statusCount.left));
        }
        // TODO: How do we update the arrow direction when text direction change?
        let iter = buffer.get_iter_at_mark(headerMark);
        let tags = [this._lookupTag('gap'), this._lookupTag('status'), headerTag];
        let headerText = stats.join(', ');
        let baseDir = Pango.find_base_dir(headerText, -1);
        this._insertWithTags(iter, `${headerText}\u00A0`, tags);
        this._insertWithTags(iter,
            baseDir === Pango.Direction.LTR ? '\u25B6' : '\u25C0',
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
            if (this._statusCount[type] !== undefined) {
                this._statusCount[type]++;
                this._statusCount.total++;
            }
            this._updateStatusHeader();

            groupTag = this._lookupTag(`status${this._state.lastStatusGroup}`);
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
        let todayMidnight = GLib.DateTime.new_local(
            now.get_year(),
            now.get_month(),
            now.get_day_of_month(),
            0, 1, 0);
        let dateMidnight = GLib.DateTime.new_local(
            date.get_year(),
            date.get_month(),
            date.get_day_of_month(),
            0, 1, 0);
        let daysAgo = todayMidnight.difference(dateMidnight) / GLib.TIME_SPAN_DAY;

        let format;
        let desktopSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        let clockFormat = desktopSettings.get_string('clock-format');
        let hasAmPm = date.format('%p') !== '';

        if (clockFormat === '24h' || !hasAmPm) {
            if (daysAgo < 1) { // today
                /* Translators: Time in 24h format */
                format = _('%H\u2236%M');
            } else if (daysAgo < 2) { // yesterday
                /* Translators: this is the word "Yesterday" followed by a
                 time string in 24h format. i.e. "Yesterday, 14:30" */
                // xgettext:no-c-format
                format = _('Yesterday, %H\u2236%M');
            } else if (daysAgo < 7) { // this week
                /* Translators: this is the week day name followed by a time
                 string in 24h format. i.e. "Monday, 14:30" */
                // xgettext:no-c-format
                format = _('%A, %H\u2236%M');
            } else if (date.get_year() === now.get_year()) { // this year
                /* Translators: this is the month name and day number
                 followed by a time string in 24h format.
                 i.e. "May 25, 14:30" */
                // xgettext:no-c-format
                format = _('%B %d, %H\u2236%M');
            } else { // before this year
                /* Translators: this is the month name, day number, year
                 number followed by a time string in 24h format.
                 i.e. "May 25 2012, 14:30" */
                // xgettext:no-c-format
                format = _('%B %d %Y, %H\u2236%M');
            }
        } else {
            // eslint-disable-next-line no-lonely-if
            if (daysAgo < 1) { // today
                /* Translators: Time in 12h format */
                format = _('%l\u2236%M %p');
            } else if (daysAgo < 2) { // yesterday
                /* Translators: this is the word "Yesterday" followed by a
                 time string in 12h format. i.e. "Yesterday, 2:30 pm" */
                // xgettext:no-c-format
                format = _('Yesterday, %l\u2236%M %p');
            } else if (daysAgo < 7) { // this week
                /* Translators: this is the week day name followed by a time
                 string in 12h format. i.e. "Monday, 2:30 pm" */
                // xgettext:no-c-format
                format = _('%A, %l\u2236%M %p');
            } else if (date.get_year() === now.get_year()) { // this year
                /* Translators: this is the month name and day number
                 followed by a time string in 12h format.
                 i.e. "May 25, 2:30 pm" */
                // xgettext:no-c-format
                format = _('%B %d, %l\u2236%M %p');
            } else { // before this year
                /* Translators: this is the month name, day number, year
                 number followed by a time string in 12h format.
                 i.e. "May 25 2012, 2:30 pm"*/
                // xgettext:no-c-format
                format = _('%B %d %Y, %l\u2236%M %p');
            }
        }

        return date.format(format);
    }

    _insertTpMessage(tpMessage) {
        let message = this._createMessage(tpMessage);

        this._ensureNewLine();

        let iter = this._view.buffer.get_end_iter();
        this._insertMessage(iter, message, this._state);

        if (message.is_self() /* outgoing */ ||
            (this._app.isRoomFocused(this._room) && this._pending.size === 0))
            this._channel.ack_message_async(tpMessage, null);
        else if (this._needsIndicator)
            this._setIndicatorMark(this._view.buffer.get_end_iter());
    }

    _insertMessage(iter, message, state) {
        const nick = message.get_sender();
        let text = message.get_text();
        const isAction = message.is_action();
        let needsGap = nick !== state.lastNick || isAction;
        const highlight = this._room.should_highlight_message(nick, text);
        const timestamp = message.get_time().to_unix();

        if (timestamp - TIMESTAMP_INTERVAL > state.lastTimestamp) {
            let tags = [this._lookupTag('timestamp')];
            if (needsGap)
                tags.push(this._lookupTag('gap'));
            needsGap = false;
            this._insertWithTags(iter,
                `${this._formatTimestamp(timestamp)}\n`, tags);
        }
        state.lastTimestamp = timestamp;

        this._updateMaxNickChars(nick.length);

        let tags = [];
        if (isAction) {
            text = `${nick} ${text}`;
            state.lastNick = null;
            tags.push(this._lookupTag('action'));
            if (needsGap)
                tags.push(this._lookupTag('gap'));
        } else {
            if (state.lastNick !== nick) {
                let nickTags = [this._lookupTag('nick')];
                let nickTagName = this._getNickTagName(nick);
                let nickTag = this._lookupTag(nickTagName);
                let buffer = this._view.get_buffer();

                if (!nickTag) {
                    nickTag = new ButtonTag({name: nickTagName});
                    nickTag.connect('clicked', this._onNickTagClicked.bind(this));

                    let status = this._userTracker.getNickRoomStatus(nick, this._room);
                    this._updateNickTag(nickTag, status);

                    buffer.get_tag_table().add(nickTag);
                }
                nickTags.push(nickTag);

                let hoverTag = new HoverFilterTag({
                    filtered_tag: nickTag,
                    hover_opacity: 0.8,
                });
                buffer.get_tag_table().add(hoverTag);

                nickTags.push(hoverTag);

                if (needsGap)
                    nickTags.push(this._lookupTag('gap'));
                this._insertWithTags(iter, nick, nickTags);
                buffer.insert(iter, '\t', -1);
            }
            state.lastNick = nick;
            tags.push(this._lookupTag('message'));
        }

        if (highlight && this._room.type !== Tp.HandleType.CONTACT)
            tags.push(this._lookupTag('highlight'));

        let params = this._room.account.dup_parameters_vardict().deep_unpack();
        let server = params.server.deep_unpack();

        // mask identify passwords in private chats
        if (this._room.type === Tp.HandleType.CONTACT) {
            let [isIdentify, command_, username_, password] =
                Polari.util_match_identify_message(text);

            if (isIdentify)
                text = text.replace(password, p => p.replace(/./g, '●'));
        }

        let channels = Utils.findChannels(text, server);
        let urls = Utils.findUrls(text).concat(channels).sort((u1, u2) => u1.pos - u2.pos);
        let previews = [];
        let pos = 0;
        for (let i = 0; i < urls.length; i++) {
            let url = urls[i];
            this._insertWithTags(iter, text.substr(pos, url.pos - pos), tags);

            let tag = this._createUrlTag(url.url);
            this._view.get_buffer().tag_table.add(tag);

            this._insertWithTags(iter,
                url.name, tags.concat(this._lookupTag('url'), tag));

            if (GLib.uri_parse_scheme(url.url).startsWith('http'))
                previews.push(new URLPreview({uri: url.url}));

            pos = url.pos + url.name.length;
        }
        this._insertWithTags(iter, text.substr(pos), tags);

        if (previews.length) {
            this._view.buffer.insert(iter, '\n', -1);

            for (const preview of previews) {
                this._view.add_child_at_anchor(preview,
                    this._view.buffer.create_child_anchor(iter));
            }

            this._view.buffer.insert(iter, '\n', -1);
        }

        if (highlight && message.pendingId) {
            this._pending.set(
                message.pendingId,
                this._view.buffer.create_mark(null, iter, true));
        }
    }

    _onNickStatusChanged(baseNick, status) {
        if (this._room.type === Tp.HandleType.CONTACT &&
            status === Tp.ConnectionPresenceType.OFFLINE &&
            this._room.channel) {
            this._room.channel.ack_all_pending_messages_async(channel => {
                channel.close_async(null);
            });
        }

        let nickTagName = this._getNickTagName(baseNick);
        let nickTag = this._lookupTag(nickTagName);

        if (!nickTag)
            return;

        this._updateNickTag(nickTag, status);
    }

    _updateNickTag(tag, status) {
        if (status === Tp.ConnectionPresenceType.AVAILABLE)
            tag.foreground_rgba = this._activeNickColor;
        else
            tag.foreground_rgba = this._inactiveNickColor;
    }

    _onNickTagClicked(tag, eventX, eventY) {
        const view = this._view;
        const [x, y] = view.window_to_buffer_coords(Gtk.TextWindowType.WIDGET,
            eventX, eventY);
        const [inside_, start] = view.get_iter_at_location(x, y);
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

        if (!tag._popover) {
            tag._popover = new UserPopover({
                userTracker: this._userTracker,
                room: this._room,
            });
            tag._popover.set_parent(this._view);
        }

        tag._popover.nickname = actualNickName;

        tag._popover.pointing_to = rect1;
        tag._popover.popup();
    }

    _createUrlTag(url) {
        let tag = new ButtonTag();
        tag.connect('notify::hover', () => {
            tag.foreground_rgba = tag.hover ? this._hoveredLinkColor : null;
        });
        tag.connect('clicked', () => {
            const v = new GLib.Variant('s', url);
            this._actionGroup.activate_action('open-url', v);
        });
        tag.connect('popup-menu', (t, ...coords) => {
            this._showUrlContextMenu(url, ...coords);
        });
        return tag;
    }

    _ensureNewLine() {
        let buffer = this._view.get_buffer();
        let iter = buffer.get_end_iter();
        let tags = [];
        let groupTag = this._lookupTag(`status${this._state.lastStatusGroup}`);
        if (groupTag && iter.ends_tag(groupTag))
            tags.push(groupTag);
        let headerTag = this._lookupTag(`status-compressed${this._state.lastStatusGroup}`);
        if (headerTag && iter.ends_tag(headerTag))
            tags.push(headerTag);
        if (iter.get_line_offset() !== 0)
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
