const Gtk = imports.gi.Gtk;
const Pango = imports.gi.Pango;
const Tp = imports.gi.TelepathyGLib;

const Lang = imports.lang;

const MAX_NICK_CHARS = 8;

const HIGHLIGHT_SCALE = (1.0 / 1.1);

const ChatView = new Lang.Class({
    Name: 'ChatView',

    _init: function(room) {
        this.widget = new Gtk.ScrolledWindow();
        this.widget.hscrollbar_policy = Gtk.PolicyType.NEVER;
        this.widget.resize_mode = Gtk.ResizeMode.QUEUE;

        this._view = new Gtk.TextView({ editable: false, cursor_visible: false,
                                        margin: 6, visible: true,
                                        wrap_mode: Gtk.WrapMode.WORD });
        this.widget.add(this._view);
        this.widget.show_all();

        this.widget.connect('destroy', Lang.bind(this, this._onDestroy));
        this.widget.connect('screen-changed',
                            Lang.bind(this, this._updateIndent));
        this.widget.connect('parent-set', Lang.bind(this, this._onParentSet));
        this.widget.connect('hierarchy-changed',
                            Lang.bind(this, this._onHierarchyChanged));
        this.widget.vadjustment.connect('changed',
                                        Lang.bind(this, this._onAdjustmentChanged));

        this._room = room;
        this._lastNick = null;
        this._stackNotifyVisibleChildId = 0;
        this._scrollBottom = false;
        this._active = false;
        this._toplevelFocus = false;

        let channelSignals = [
            { name: 'message-received',
              handler: Lang.bind(this, this._insertMessage) },
            { name: 'message-sent',
              handler: Lang.bind(this, this._insertMessage) }
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

        let context = this.widget.get_style_context();
        context.save();
        context.add_class('dim-label');
        let color = context.get_color(Gtk.StateFlags.NORMAL);
        context.restore();

        let tagTable = this._view.get_buffer().get_tag_table();
        let tags = [
          { name: 'nick',
            foreground_rgba: color,
            left_margin: 0 },
          { name: 'message',
            indent: 0 },
          { name: 'highlight',
            weight: Pango.Weight.BOLD,
            scale: HIGHLIGHT_SCALE },
          { name: 'status',
            foreground_rgba: color,
            left_margin: 0 }
        ];
        tags.forEach(function(tagProps) {
                tagTable.add(new Gtk.TextTag(tagProps));
            });
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
        tabs.set_tab(0, Pango.TabAlign.LEFT, MAX_NICK_CHARS * pixelWidth);
        this._view.tabs = tabs;
        this._view.indent = -MAX_NICK_CHARS * pixelWidth;
        this._view.left_margin = MAX_NICK_CHARS * pixelWidth;
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

    _onHierarchyChanged: function(w, oldToplevel) {
        if (oldToplevel)
            oldToplevel.disconnect(this._toplevelFocusNotifyId);

        let newToplevel = this.widget.get_toplevel();
        if (!newToplevel)
            return;

        this._toplevelFocusNotifyId =
            newToplevel.connect('notify::has-toplevel-focus',
                                Lang.bind(this, this._updateToplevel));
        this._updateToplevel();
    },

    _updateActive: function() {
        this._active = this.widget.get_parent().get_visible_child() == this.widget;
        this._checkMessages();
    },

    _updateToplevel: function() {
        this._toplevelFocus = this.widget.get_toplevel().has_toplevel_focus;
        this._checkMessages();
    },

    _onAdjustmentChanged: function(adjustment) {
        if (!this._scrollBottom)
            return;

        this._scrollBottom = false;
        adjustment.value = adjustment.upper;
    },

    _checkMessages: function() {
        if (this._active && this._toplevelFocus)
            this._room.channel.ack_all_pending_messages_async(null);
    },

    _onMemberRenamed: function(room, oldMember, newMember) {
        this._insertStatus('%s is now known as %s'.format(oldMember.alias,
                                                          newMember.alias));
    },

    _onMemberDisconnected: function(room, member) {
        this._insertStatus('%s has disconnected'.format(member.alias));
    },

    _onMemberKicked: function(room, member, actor) {
        let message = !actor ? '%s has been kicked'.format(member.alias)
                             : '%s has been kicked by %s'.format(member.alias,
                                                                 actor.alias);
        this._insertStatus(message);
    },

    _onMemberBanned: function(room, member, actor) {
        let message = !actor ? '%s has been banned'.format(member.alias)
                             : '%s has been banned by %s'.format(member.alias,
                                                                 actor.alias);
        this._insertStatus(message);
    },

    _onMemberJoined: function(room, member) {
        this._insertStatus('%s joined'.format(member.alias));
    },

    _onMemberLeft: function(room, member, message) {
        let text = '%s left'.format(member.alias);
        if (message)
            text += ' (%s)'.format(message);
        this._insertStatus(text);
    },

    _insertStatus: function(text) {
        this._lastNick = null;
        this._ensureNewLine();
        this._insertWithTag(text, 'status');
    },

    _insertMessage: function(room, message) {
        let nick = message.sender.alias;
        let [text, flags] = message.to_text();

        this._ensureNewLine();

        let tags = [];
        if (message.get_message_type() == Tp.ChannelTextMessageType.ACTION) {
            text = "%s %s".format(nick, text);
            this._lastNick = null;
            tags.push('status');
        } else {
            if (this._lastNick != nick)
                this._insertWithTag(nick + '\t', 'nick');
            this._lastNick = nick;
            tags.push('message');
        }

        if (this._room.should_highlight_message(message))
            tags.push('highlight');

        this._insertWithTags(text, tags);

        this._checkMessages();
    },

    _ensureNewLine: function() {
        let buffer = this._view.get_buffer();
        let iter = buffer.get_end_iter();
        if (iter.get_line_offset() != 0)
            buffer.insert(iter, '\n', -1);
    },

    _insertWithTag: function(text, tag) {
        this._insertWithTags(text, [tag]);
    },

    _insertWithTags: function(text, tags) {
        let buffer = this._view.get_buffer();
        let iter = buffer.get_end_iter();
        let offset = iter.get_offset();

        buffer.insert(iter, text, -1);
        this._scrollBottom = this._active && this._toplevelFocus;

        let start = buffer.get_iter_at_offset(offset);

        for (let i = 0; i < tags.length; i++)
            buffer.apply_tag_by_name(tags[i], start, iter);
    }
});
