const Gdk = imports.gi.Gdk;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;
const Pango = imports.gi.Pango;
const Tp = imports.gi.TelepathyGLib;

const LogManager = imports.logManager;
const AccountsMonitor = imports.accountsMonitor;
const ChatroomManager = imports.chatroomManager;
const Lang = imports.lang;

const ResultRow = new Lang.Class({
    Name: 'ResultRow',
    Extends: Gtk.ListBoxRow,
    Template: 'resource:///org/gnome/Polari/ui/result-list-row.ui',
    InternalChildren: ['box1', 'source_name', 'short_time_label', 'content_label'],

    _init: function(event) {
        this.parent();
        this._source_name.label = event.chan.substring(1);
        this._short_time_label.label = this._formatTimestamp(event.timestamp);
        this.uid = event.id;
        this.channel = event.chan;
        this.nickname = event.chan;
        this.timestamp = event.timestamp;
        this.rawmessage = event.mms;

        // this._icon.gicon = room.icon;
        // this._icon.visible = room.icon != null;
        this.connect('key-press-event',
                     Lang.bind(this, this._onKeyPress));

        // room.connect('notify::channel', Lang.bind(this,
        //     function() {
        //         if (!room.channel)
        //             return;
        //         room.channel.connect('message-received',
        //                              Lang.bind(this, this._updatePending));
        //         room.channel.connect('pending-message-removed',
        //                              Lang.bind(this, this._updatePending));
        //     }));
        // room.bind_property('display-name', this._roomLabel, 'label',
        //                    GObject.BindingFlags.SYNC_CREATE);
        //
        // this._updatePending();
    },

    _onButtonRelease: function(w, event) {
        let [, button] = event.get_button();
        if (button != Gdk.BUTTON_SECONDARY)
            return Gdk.EVENT_PROPAGATE;

        // this._showPopover();

        return Gdk.EVENT_STOP;
    },

    _onKeyPress: function(w, event) {
        let [, keyval] = event.get_keyval();
        let [, mods] = event.get_state();
        if (keyval != Gdk.KEY_Menu &&
            !(keyval == Gdk.KEY_F10 &&
              mods & Gdk.ModifierType.SHIFT_MASK))
            return Gdk.EVENT_PROPAGATE;

        // this._showPopover();

        return Gdk.EVENT_STOP;
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
    }
});

const ResultList = new Lang.Class({
    Name: 'ResultList',
    Extends: Gtk.ListBox,

    _init: function(params) {
        this.parent(params);
        this._app = Gio.Application.get_default();
        this._logManager = LogManager.getDefault();

        //this.connect('row-activated', Lang.bind(this, this._rowactivated));
        this._resultRows = {};
        this._widgetMap = {};
        //this._keywordsAction = app.lookup_action('search-terms');
        this._app.connect('action-state-changed::search-terms', Lang.bind(this,
                          this._handleSearchChanged));

        this._keywords = [];
        this._cancellable  = new Gio.Cancellable();
    },

    vfunc_row_selected: function(row) {
        if(!row) return;
        let rowSelectedAction = this._app.lookup_action('active-result-changed');
        rowSelectedAction.activate(new GLib.Variant('(sus)', [row.uid, row.timestamp, row.channel]));
        // if (row)
        //     row.selected();
    },

    _handleSearchChanged: function(group, actionName, value) {
        let text = value.deep_unpack();

        if(text == '') return;

        this._cancellable.cancel();
        this._cancellable.reset();

        this._keywords = text == '' ? [] : text.split(/\s+/);
        log(text);
        let query = ('select ?text as ?mms ?msg as ?id ?chan as ?chan ?timestamp as ?timestamp ' +
                      'where { ?msg a nmo:IMMessage . ?msg nie:plainTextContent ?text . ?msg fts:match "%s*" . ' +
                      '?msg nmo:communicationChannel ?channel. ?channel nie:title ?chan. ' +
                      '?msg nie:contentCreated ?timestamp }'
                     ).format(text);
        log(query);
        this._logManager.query(query,this._cancellable,Lang.bind(this, this._handleResults));
    },

    _handleResults: function(events) {
        log(events.length);
        let widgetMap = {};
        let markup_message = '';
        for (let i = 0; i < events.length; i++) {
            let message = GLib.markup_escape_text(events[i].mms, -1);
            let uid = events[i].id;
            let row;
            row = this._widgetMap[uid];
            for (let j = 0; j < this._keywords.length; j++) {
                // log(this._keywords[j]);
            //    index = Math.min(index, message.indexOf(this._keywords[j]));
            //    message = message.replace( new RegExp( "(" + this._keywords[j] + ")" , 'gi' ),"<span font_weight='bold'>$1</span>");
                // print(message);
            }

            if (row) {
                widgetMap[uid] = row;
                this.remove(row);
            } else {
                row = new ResultRow(events[i]);
                widgetMap[uid] = row;
            }
            row._content_label.label = message;
        }

        this._widgetMap = widgetMap;

        this.foreach(r => { r.destroy(); })

        for (let i = 0; i < events.length; i++) {
            let row = this._widgetMap[events[i].id];
            this.add(row);
        }
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
    }
});
