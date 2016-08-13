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
const LogManager = imports.logManager;
const Mainloop = imports.mainloop;
const PasteManager = imports.pasteManager;
const Signals = imports.signals;
const Utils = imports.utils;

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


const ResultTextView = new Lang.Class({
    Name: 'ResultTextView',
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
        this._dimColor = context.get_color(context.get_state());
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

const ResultView = new Lang.Class({
    Name: 'ResultView',
    Extends: Gtk.ScrolledWindow,

    _init: function(channel) {
        //this.parent();
        print("HELLO");
        this.parent({ hscrollbar_policy: Gtk.PolicyType.NEVER, vexpand: true });

        this._view = new ResultTextView({ editable: false, cursor_visible: false,
                                    wrap_mode: Gtk.WrapMode.WORD_CHAR,
                                    right_margin: MARGIN });
        print(this._view);
        this._view.add_events(Gdk.EventMask.LEAVE_NOTIFY_MASK |
                              Gdk.EventMask.ENTER_NOTIFY_MASK);
        this.add(this._view);
        this.show_all();

        this._logManager = LogManager.getDefault();
        this._cancellable  = new Gio.Cancellable();

        // this._keywords = keywordsText == '' ? [] : keywordsText.split(/\s+/);
        // this._keyregExp = new RegExp( '(' + this._keywords.join('|')+ ')', 'gi');
        // print(this._keyregExp);
        this._active = false;
        this._toplevelFocus = false;
        this._fetchingBacklog = false;
        this._joinTime = 0;
        this._maxNickChars = MAX_NICK_CHARS;
        this._needsIndicator = true;
        this._pending = {};
        this._pendingLogs = [];
        this._logWalker = null;

        this._channelName = channel;
        this._resultsAvailable = [];

        this._createTags();

        this.connect('style-updated',
                     Lang.bind(this, this._onStyleUpdated));
        this._onStyleUpdated();

        this.connect('screen-changed',
                     Lang.bind(this, this._updateIndent));
        this.connect('scroll-event', Lang.bind(this, this._onScroll));
        // this.connect('edge-reached', Lang.bind(this, this._onEdgeReached));

        this.vadjustment.connect('changed',
                                 Lang.bind(this, this._updateScroll));

        this._view.connect('key-press-event', Lang.bind(this, this._onKeyPress));
        /* pick up DPI changes (e.g. via the 'text-scaling-factor' setting):
           the default handler calls pango_cairo_context_set_resolution(), so
           update the indent after that */
        this._view.connect_after('style-updated',
                                 Lang.bind(this, this._updateIndent));

        let adj = this.vadjustment;
        this._scrollBottom = adj.upper - adj.page_size;

        this._hoverCursor = Gdk.Cursor.new(Gdk.CursorType.HAND1);
        // this._rowactivated(uid, channel, timestamp);
    },

    _insertView: function(uid, timestamp, rank) {
        let found = false;
        let exists = false;
        let startIndex = 0;
        print(this._resultsAvailable.length);
        for(let i = 0; i < this._resultsAvailable.length; i++) {
            print(this._resultsAvailable[i].rank);
            print(rank);
            if(this._resultsAvailable[i].rank > rank) {
                found = true;
                startIndex = i;
            } else if(this._resultsAvailable[i].rank == rank) {
                exists = true;
                startIndex = i;
            }
        }

        print(startIndex);

        let buffer = this._view.buffer;
        let iter = buffer.get_start_iter();
        if(exists) {
            let lastMark = buffer.get_mark('view-start' + this._resultsAvailable[startIndex].rank);
            iter = buffer.get_iter_at_mark(lastMark);
        } else if(found) {
            let lastMark = buffer.get_mark('view-end' + this._resultsAvailable[startIndex].rank);
            iter = buffer.get_iter_at_mark(lastMark);
        }
        // if(!exists)

        if(!exists) {
            buffer.insert(iter, '\n', -1);
            buffer.create_mark('view-start' + rank, iter, true);
            let obj = { top_query: null,
                        bottom_query: null,
                        rank: rank };
            // print(this._resultsAvailable.push(obj));
            // print(this._resultsAvailable.toString());
            // print(this._resultsAvailable.splice(startIndex, 0, obj).toString());
            this._resultsAvailable.splice(startIndex + 1, 0, obj);
            print(this._resultsAvailable.length);
        }
        // buffer.insert(iter, String(rank), -1);
        // buffer.insert(iter, '\n', -1);
        if(exists)
            buffer.move_mark_by_name('view-end'+rank, iter);
        else
            buffer.create_mark('view-end' + rank, iter, false);

        let index;
        for(let i = 0; i < this._resultsAvailable.length; i++) {
            if(this._resultsAvailable[i].rank == rank) {
                index = i;
                break;
            }
        }
        this._rank = rank;
        this._rowactivated(uid, this._channelName, timestamp, rank);
    },

    _rowactivated: function(uid, channel, timestamp, rank) {
        this._uid = uid;
        this._cancellable.cancel();
        this._cancellable.reset();
        let sparql = (
            'select nie:plainTextContent(?msg) as ?message ' +
            '?msg as ?id ' +
            '       if (nmo:from(?msg) = nco:default-contact-me,' +
            '           "%s", nco:nickname(nmo:from(?msg))) as ?sender ' +
            // FIXME: how do we handle the "real" message type?
            '       %d as ?messageType ' +
            '       ?timestamp ' +
            '{ ?msg a nmo:IMMessage; ' +
            '       nie:contentCreated ?timestamp; ' +
            '       nmo:communicationChannel ?chan . ' +
            'BIND( ?timestamp - %s as ?timediff ) . ' +
            // FIXME: filter by account
            '  filter (nie:title (?chan) = "%s" && ?timediff >= 0) ' +
            '} order by asc (?timediff)'
        ).format(channel,
                 Tp.ChannelTextMessageType.NORMAL,
                 timestamp,
                 channel);
        // log(sparql);
        let sparql1 = (
            'select nie:plainTextContent(?msg) as ?message ' +
            '?msg as ?id ' +
            '       if (nmo:from(?msg) = nco:default-contact-me,' +
            '           "%s", nco:nickname(nmo:from(?msg))) as ?sender ' +
            // FIXME: how do we handle the "real" message type?
            '       %d as ?messageType ' +
            '       ?timestamp ' +
            '{ ?msg a nmo:IMMessage; ' +
            '       nie:contentCreated ?timestamp; ' +
            '       nmo:communicationChannel ?chan . ' +
            'BIND( %s - ?timestamp as ?timediff ) . ' +
            // FIXME: filter by account
            '  filter (nie:title (?chan) = "%s" && ?timediff > 0) ' +
            '} order by asc (?timediff)'
        ).format(channel,
                 Tp.ChannelTextMessageType.NORMAL,
                 timestamp,
                 channel);
        // let logManager = LogManager.getDefault();
        // this._logWalker = logManager.walkEvents(row,
        //                                         row.channel);
        //
        // this._fetchingBacklog = true;
        // this._logWalker.getEvents(10,
        //                           Lang.bind(this, this._onLogEventsReady));
        // this._logManager.query(sparql,this._cancellable,Lang.bind(this, this._onLogEventsReady));
        // this._logManager.query(sparql1,this._cancellable,Lang.bind(this, this._onLogEventsReady1));
        // let buffer = this._view.get_buffer();
        // let iter = buffer.get_end_iter();
        // buffer.set_text("",-1);
        this._endQuery = new LogManager.GenericQuery(this._logManager._connection, 2);
        // this._endQuery.run(sparql,this._cancellable,Lang.bind(this, this._onLogEventsReady1, index));
        // log("!");
        this._startQuery = new LogManager.GenericQuery(this._logManager._connection, 2);
        // Mainloop.timeout_add(500, Lang.bind(this,
        //     function() {
        //         query.run(sparql1,this._cancellable,Lang.bind(this, this._onLogEventsReady1));
        //         return GLib.SOURCE_REMOVE;
        //     }));
        this._startQuery.run(sparql1,this._cancellable,Lang.bind(this, this._onLogEventsReady, rank));
        //print(this._endQuery.isClosed());

        // Mainloop.timeout_add(5000, Lang.bind(this,
        //     function() {
        //         query.next(200,this._cancellable,Lang.bind(this, this._onLogEventsReady1));
        //     }));
        // query.next(20,this._cancellable,Lang.bind(this, this._onLogEventsReady1));

        //this._resultStack.buffer.insert(iter,row._content_label.label, -1);
        // this._resultStack.label = row._content_label.label;
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
        let dimColor = context.get_color(context.get_state());
        context.restore();

        context.save();
        context.set_state(Gtk.StateFlags.LINK);
        let linkColor = context.get_color(context.get_state());
        this._activeNickColor = context.get_color(context.get_state());

        context.set_state(Gtk.StateFlags.LINK | Gtk.StateFlags.PRELIGHT);
        this._hoveredLinkColor = context.get_color(context.get_state());
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
        this._statusHeaderHoverColor = context.get_color(context.get_state());
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

        let offset = NICKTAG_PREFIX.length;
        tagTable.foreach(Lang.bind(this, function(tag) {
            if (tag._status)
                this._setNickStatus(tag.name.substring(offset), tag._status);
        }));
    },

    vfunc_destroy: function() {
        this.parent();
    },

    _onLogEventsReady: function(events, rank) {
        print("AA"+rank);
        events = events.reverse();
        this._hideLoadingIndicator();

        this._pendingLogs = events.concat(this._pendingLogs);
        this._insertPendingLogs(rank);
        this._fetchingBacklog = false;
    },

    _onLogEventsReady1: function(events, parent, index) {
        // print(events);
        //events = events.reverse();
        this._hideLoadingIndicator1();

        this._pendingLogs = events.concat(this._pendingLogs);
        this._insertPendingLogs1(index);
        let buffer = this._view.get_buffer();
        let mark = buffer.get_mark('centre');
        this._view.scroll_to_mark(mark, 0.0, true, 0, 0.5);
        this._fetchingBacklog = false;
    },

    _insertPendingLogs: function(rank) {
        if (this._pendingLogs.length == 0)
            return;

        // let index = -1;
        let nick = this._pendingLogs[0].sender;
        let type = this._pendingLogs[0].messageType;
    /*    if (!this._query.isClosed()) {
            for (let i = 0; i < this._pendingLogs.length; i++)
                if (this._pendingLogs[i].sender != nick ||
                    this._pendingLogs[i].messageType != type) {
                    index = i;
                    break;
                }
        } else {
            index = 0;
        }

        if (index < 0)
            return;*/
            // index = 0;
        // print(this._pendingLogs);
        let pending = this._pendingLogs.splice(0);
        // print(this._pendingLogs);
        // print(pending);
        let buffer = this._view.buffer;
        let startMark = buffer.get_mark('view-start' + rank);
        let iter = buffer.get_iter_at_mark(startMark);
        let state = { lastNick: null, lastTimestamp: 0 };
        // let iter = this._view.buffer.get_start_iter();
        for (let i = 0; i < pending.length; i++) {
            let message = { nick: pending[i].sender,
                            text: pending[i].message,
                            timestamp: pending[i].timestamp,
                            messageType: pending[i].messageType,
                            shouldHighlight: false,
                            id: pending[i].id};
            this._insertMessage(iter, message, state);
            this._setNickStatus(message.nick, Tp.ConnectionPresenceType.OFFLINE);

            if (!iter.is_end() || i < pending.length - 1)
                this._view.buffer.insert(iter, '\n', -1);
        }
        buffer.move_mark_by_name('view-end'+rank, iter);

        if (!this._channel)
            return;

        if (this._room.type == Tp.HandleType.ROOM) {
            let members = this._channel.group_dup_members_contacts();
            for (let j = 0; j < members.length; j++)
                this._setNickStatus(members[j].get_alias(),
                                    Tp.ConnectionPresenceType.AVAILABLE);
        } else {
                this._setNickStatus(this._channel.connection.self_contact.get_alias(),
                                    Tp.ConnectionPresenceType.AVAILABLE);
                this._setNickStatus(this._channel.target_contact.get_alias(),
                                    Tp.ConnectionPresenceType.AVAILABLE);
        }
    },

    _insertPendingLogs1: function() {
        if (this._pendingLogs.length == 0)
            return;

        let index = -1;
        let nick = this._pendingLogs[0].sender;
        let type = this._pendingLogs[0].messageType;
    /*    if (!this._query.isClosed()) {
            for (let i = 0; i < this._pendingLogs.length; i++)
                if (this._pendingLogs[i].sender != nick ||
                    this._pendingLogs[i].messageType != type) {
                    index = i;
                    break;
                }
        } else {
            index = 0;
        }

        if (index < 0)
            return;*/
            index = 0;
        // print(this._pendingLogs);
        let pending = this._pendingLogs.splice(index);
        // print(this._pendingLogs);
        // print(pending);
        let state = { lastNick: null, lastTimestamp: 0 };
        let iter = this._view.buffer.get_end_iter();
        for (let i = 0; i < pending.length; i++) {
            let message = { nick: pending[i].sender,
                            text: pending[i].message,
                            timestamp: pending[i].timestamp,
                            messageType: pending[i].messageType,
                            shouldHighlight: false,
                            id: pending[i].id};
            this._insertMessage(iter, message, state);
            this._setNickStatus(message.nick, Tp.ConnectionPresenceType.OFFLINE);

            //if (!iter.is_end() || i < pending.length - 1)
                this._view.buffer.insert(iter, '\n', -1);
        }

        if (!this._channel)
            return;

        if (this._room.type == Tp.HandleType.ROOM) {
            let members = this._channel.group_dup_members_contacts();
            for (let j = 0; j < members.length; j++)
                this._setNickStatus(members[j].get_alias(),
                                    Tp.ConnectionPresenceType.AVAILABLE);
        } else {
                this._setNickStatus(this._channel.connection.self_contact.get_alias(),
                                    Tp.ConnectionPresenceType.AVAILABLE);
                this._setNickStatus(this._channel.target_contact.get_alias(),
                                    Tp.ConnectionPresenceType.AVAILABLE);
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

        let totalWidth = this._maxNickChars * pixelWidth + NICK_SPACING;

        let tabs = Pango.TabArray.new(1, true);
        tabs.set_tab(0, Pango.TabAlign.LEFT, totalWidth);
        this._view.tabs = tabs;
        this._view.indent = -totalWidth;
        this._view.left_margin = MARGIN + totalWidth;
    },

    _ensureLogWalker: function() {
        if (this._logWalker)
            return;

        let logManager = LogManager.getDefault();
        this._logWalker = logManager.walkEvents(this._room.account,
                                                this._room.channel_name);

        this._fetchingBacklog = true;
        this._logWalker.getEvents(NUM_INITIAL_LOG_EVENTS,
                                  Lang.bind(this, this._onLogEventsReady));
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
        print("was onscroll" +this.vadjustment.value);
        let [hasDir, dir] = event.get_scroll_direction();
        if (hasDir && (dir != Gdk.ScrollDirection.UP || dir != Gdk.ScrollDirection.DOWN) )
            return Gdk.EVENT_PROPAGATE;

        let [hasDeltas, dx, dy] = event.get_scroll_deltas();
        // print(dx, dy);
        if (hasDeltas)
            this._fetchBacklog();
        // if (dir == Gdk.ScrollDirection.UP )
        //     print("UP");
        // else if (dir == Gdk.ScrollDirection.DOWN)
        //     print("DOWN");

        //return this._fetchBacklog();
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
        print("was at backlog" + this.vadjustment.value + this._fetchingBacklog);
        if (this.vadjustment.value != 0 &&
            this.vadjustment.value != this._scrollBottom)
            return Gdk.EVENT_PROPAGATE;

        if (this._fetchingBacklog)
            return Gdk.EVENT_STOP;

        this._fetchingBacklog = true;

        if (this.vadjustment.value == 0) {
            this._showLoadingIndicator();
            Mainloop.timeout_add(500, Lang.bind(this,
                function() {
                    this._startQuery.next(10,this._cancellable,Lang.bind(this, this._onLogEventsReady, this._rank));
                }));
        } else {
            this._fetchingBacklog = false;
            return Gdk.EVENT_STOP;
            this._showLoadingIndicator1();
            Mainloop.timeout_add(500, Lang.bind(this,
                function() {
                    this._endQuery.next(10,this._cancellable,Lang.bind(this, this._onLogEventsReady1));
                }));
        }
        return Gdk.EVENT_STOP;
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

    _showLoadingIndicator1: function() {
        let indicator = new Gtk.Image({ icon_name: 'content-loading-symbolic',
                                        visible: true });

        let buffer = this._view.buffer;
        let iter = buffer.get_end_iter();
        buffer.insert(iter, '\n', -1);
        let anchor = buffer.create_child_anchor(iter);
        this._view.add_child_at_anchor(indicator, anchor);

        let end = buffer.get_end_iter();
        iter.backward_line();
        buffer.remove_all_tags(iter, end);
        buffer.apply_tag(this._lookupTag('loading'), iter, end);
    },

    _hideLoadingIndicator1: function() {
        let buffer = this._view.buffer;
        let iter = buffer.get_end_iter();
        // if (!iter.get_child_anchor())
        //     return;

        iter.backward_line();
        buffer.delete(iter, buffer.get_end_iter());
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

    _insertMessage: function(iter, message, state) {
        let isAction = message.messageType == Tp.ChannelTextMessageType.ACTION;
        let needsGap = message.nick != state.lastNick || isAction;
        let isCentre = message.id == this._uid;

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

//        this._updateMaxNickChars(message.nick.length);

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

                if (!nickTag) {
                    nickTag = new Gtk.TextTag({ name: nickTagName });
                    this._view.get_buffer().get_tag_table().add(nickTag);
                }
                tags.push(nickTag);
                if (needsGap)
                    tags.push(this._lookupTag('gap'));
                this._insertWithTags(iter, message.nick + '\t', tags);
            }
            state.lastNick = message.nick;
            tags.push(this._lookupTag('message'));
        }

        if (message.shouldHighlight)
            tags.push(this._lookupTag('highlight'));

        if (isCentre) {
            let buffer = this._view.get_buffer();
            buffer.create_mark('centre', iter, true);
        }


        // let params = this._room.account.dup_parameters_vardict().deep_unpack();
        // let server = params.server.deep_unpack();

        let text = message.text;
        let res = [], match;
        // while ((match = this._keyregExp.exec(text))){
        //     res.push({ keyword: match[0], pos: match.index});
        // }
        // let channels = Utils.findChannels(text, server);
        // let urls = Utils.findUrls(text).concat(channels).sort((u1,u2) => u1.pos - u2.pos);
        let pos = 0;
         for (let i = 0; i < res.length; i++) {
            let cur = res[i];
            this._insertWithTags(iter, text.substr(pos, cur.pos - pos), tags);

            // let tag = this._createUrlTag(url.url);
            // this._view.get_buffer().tag_table.add(tag);

            // let name = url.name ? url.name : url.url;
            this._insertWithTags(iter, cur.keyword,
                                 tags.concat(this._lookupTag('highlight')));

            pos = cur.pos + cur.keyword.length;
        }
        this._insertWithTags(iter, text.substr(pos), tags);
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
    },

    _getNickTagName: function(nick) {
        return NICKTAG_PREFIX + Polari.util_get_basenick(nick);
    },

    _setNickStatus: function(nick, status) {
        let nickTag = this._lookupTag(this._getNickTagName(nick));
        if (!nickTag)
           return;

        if (status == Tp.ConnectionPresenceType.AVAILABLE)
           nickTag.foreground_rgba = this._activeNickColor;
        else
           nickTag.foreground_rgba = this._inactiveNickColor;

        nickTag._status = status;
    }
});
