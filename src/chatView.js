const Gdk = imports.gi.Gdk;
const Gio = imports.gi.Gio;
const Gtk = imports.gi.Gtk;
const Pango = imports.gi.Pango;
const Tp = imports.gi.TelepathyGLib;

const Lang = imports.lang;
const Notify = imports.notify;
const Utils = imports.utils;

const MAX_NICK_CHARS = 8;

// Workaround for GtkTextView growing horizontally over time when
// added to a GtkScrolledWindow with horizontal scrolling disabled
const TextView = new Lang.Class({
    Name: 'TextView',
    Extends: Gtk.TextView,

    vfunc_get_preferred_width: function() {
        return [1, 1];
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
        this._lastNick = null;
        this._stackNotifyVisibleChildId = 0;
        this._active = false;
        this._toplevelFocus = false;
        this._maxNickChars = MAX_NICK_CHARS;
        this._hoveringLink = false;
        this._pending = [];

        let adj = this.widget.vadjustment;
        this._scrollBottom = adj.upper - adj.page_size;

        let app = Gio.Application.get_default();
        app.pasteManager.addWidget(this._view);

        this._linkCursor = Gdk.Cursor.new(Gdk.CursorType.HAND1);

        let channelSignals = [
            { name: 'message-received',
              handler: Lang.bind(this, this._insertMessage) },
            { name: 'message-sent',
              handler: Lang.bind(this, this._insertMessage) },
            { name: 'pending-message-removed',
              handler: Lang.bind(this, this._pendingMessageRemoved) }
        ];
        this._channelSignals = [];
        channelSignals.forEach(Lang.bind(this, function(signal) {
            this._channelSignals.push(room.channel.connect(signal.name, signal.handler));
        }));

        let roomSignals = [
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

        room.channel.dup_pending_messages().forEach(Lang.bind(this,
            function(message) {
                this._insertMessage(room, message);
            }));
        this._checkMessages();
    },

    _createTags: function() {
        let buffer = this._view.get_buffer();
        let tagTable = buffer.get_tag_table();
        let tags = [
          { name: 'nick',
            left_margin: 0 },
          { name: 'message',
            indent: 0 },
          { name: 'highlight',
            weight: Pango.Weight.BOLD },
          { name: 'status',
            left_margin: 0,
            indent: 0 },
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
            foreground_rgba: dimColor },
          { name: 'status',
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
        this.widget = new Gtk.ScrolledWindow();
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
        this.widget.connect('parent-set', Lang.bind(this, this._onParentSet));
        this.widget.connect('state-flags-changed',
                            Lang.bind(this, this._updateToplevel));
        this.widget.vadjustment.connect('value-changed',
                                 Lang.bind(this, this._checkMessages));
        this.widget.vadjustment.connect('changed',
                                 Lang.bind(this, this._updateScroll));
        this._view.connect('button-release-event',
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

    _onParentSet: function(widget, oldParent) {
        if (oldParent)
            oldParent.disconnect(this._stackNotifyVisibleChildId);

        let newParent = this.widget.get_parent();
        if (!newParent)
            return;

        this._stackNotifyVisibleChildId =
            newParent.connect('notify::visible-child',
                              Lang.bind(this, this._updateActive));
        this._updateActive();
    },

    _updateActive: function() {
        this._active = this.widget.get_parent().get_visible_child() == this.widget;
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
        if (this._pending.length == 0) {
            if (adj.value == this._scrollBottom)
                adj.value = adj.upper - adj.page_size;
        } else if (!this._active) {
            this._view.scroll_mark_onscreen(this._pending[0].mark);
        }
        this._scrollBottom = adj.upper - adj.page_size;
    },

    _pendingMessageRemoved: function(channel, message) {
        for (let i = 0; i < this._pending.length; i++) {
            if (this._pending[i].message != message)
                continue;

            this._pending.splice(i, 1);
            this._updateScroll();
            break;
        }
    },

    _handleLinkClicks: function(view, event) {
        let [, button] = event.get_button();
        if (button != Gdk.BUTTON_PRIMARY)
            return false;

        let [, eventX, eventY] = event.get_coords();
        let [x, y] = view.window_to_buffer_coords(Gtk.TextWindowType.WIDGET,
                                                  eventX, eventY);

        let iter = view.get_iter_at_location(x, y);
        let tags = iter.get_tags();
        for (let i = 0; i < tags.length; i++) {
            let url = tags[i]._url;
            if (url) {
                if (url.indexOf(':') == -1)
                    url = 'http://' + url;
                Gio.AppInfo.launch_default_for_uri(url, null);
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
        if (!this._pending.length)
            return;

        if (!this._active || !this._toplevelFocus)
            return;

        let rect = this._view.get_visible_rect();
        let buffer = this._view.get_buffer();
        for (let i = 0; i < this._pending.length; i++) {
            let pending = this._pending[i];
            let iter = buffer.get_iter_at_mark(pending.mark);
            let iterRect = this._view.get_iter_location(iter);
            if (rect.y <= iterRect.y && rect.y + rect.height > iterRect.y)
                this._room.channel.ack_message_async(pending.message, null);
        }
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
        this._lastNick = null;
        this._ensureNewLine();
        this._insertWithTagName(text, 'status');
    },

    _insertMessage: function(room, message) {
        let nick = message.sender.alias;
        let [text, flags] = message.to_text();

        this._ensureNewLine();

        if (nick.length > this._maxNickChars) {
            this._maxNickChars = nick.length;
            this._updateIndent();
        }

        let tags = [];
        if (message.get_message_type() == Tp.ChannelTextMessageType.ACTION) {
            text = "%s %s".format(nick, text);
            this._lastNick = null;
            tags.push(this._lookupTag('status'));
        } else {
            if (this._lastNick != nick)
                this._insertWithTagName(nick + '\t', 'nick');
            this._lastNick = nick;
            tags.push(this._lookupTag('message'));
        }

        if (this._room.should_highlight_message(message)) {
            tags.push(this._lookupTag('highlight'));

            if (!this._toplevelFocus) {
                let summary = this._lastNick ? '%s: %s'.format(nick, text)
                                             : text;
                let notification = new Notify.Notification(summary, '');
                notification.show();
            }
        }

        let urls = Utils.findUrls(text);
        let pos = 0;
        for (let i = 0; i < urls.length; i++) {
            let url = urls[i];
            this._insertWithTags(text.substr(pos, url.pos - pos), tags);

            let tag = new Gtk.TextTag();
            tag._url = url.url;
            this._view.get_buffer().tag_table.add(tag);

            this._insertWithTags(url.url,
                                 tags.concat(this._lookupTag('url'), tag));

            pos = url.pos + url.url.length;
        }
        this._insertWithTags(text.substr(pos), tags);


        let buffer = this._view.get_buffer();
        if (message.get_pending_message_id() == 0 /* outgoing */ ||
            (this._active && this._toplevelFocus && this._pending.length == 0)) {
            this._room.channel.ack_message_async(message, null);
        } else {
            let mark = buffer.create_mark(null, buffer.get_end_iter(), true);
            this._pending.push({ message: message, mark: mark });
        }
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

    _insertWithTagName: function(text, name) {
        this._insertWithTags(text, [this._lookupTag(name)]);
    },

    _insertWithTags: function(text, tags) {
        let buffer = this._view.get_buffer();
        let iter = buffer.get_end_iter();
        let offset = iter.get_offset();

        buffer.insert(iter, text, -1);

        let start = buffer.get_iter_at_offset(offset);

        for (let i = 0; i < tags.length; i++)
            buffer.apply_tag(tags[i], start, iter);
    }
});
