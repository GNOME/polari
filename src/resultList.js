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
const Signals = imports.signals;
const Mainloop = imports.mainloop;

const MIN_SEARCH_WIDTH = 0;

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
                // xgetmainStack1text:no-c-format
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
        this._results = [];
        this._widgetMap = {};
        this._channelMap = {};
        //this._keywordsAction = app.lookup_action('search-terms');
        this._app.connect('action-state-changed::search-terms', Lang.bind(this,
                          this._handleSearchChanged));

        this.connect('scroll-bottom-reached', Lang.bind(this, this._loadNextResults));

        this._fetchingResults = false;
        this._keywords = [];
        this._keywordsText = '';
        this._cancellable  = new Gio.Cancellable();
    },

    vfunc_row_selected: function(row) {
        if(!row) return;
        let rowSelectedAction = this._app.lookup_action('active-result-changed');
        rowSelectedAction.activate(new GLib.Variant('(sussu)', [row.uid, row.timestamp, row.channel, this._keywordsText, row.rank]));
        // if (row)
        //     row.selected();
    },

    _clearList: function() {
        this.foreach(r => { r.hide(); });
    },

    _showList: function() {
        this.foreach(r => { r.show(); });
    },

    _handleSearchChanged: function(group, actionName, value) {
        this._cancellable.cancel();
        // this._cancellable.reset();
        this._cancellable  = new Gio.Cancellable();
        let text = value.deep_unpack();
        this._clearList();
        this._results = [];
        this.set_placeholder(null);

        if(text.length < MIN_SEARCH_WIDTH) {
            return;
        }

        this._keywordsText = text;
        this._keywords = text == '' ? [] : text.split(/\s+/);
        log(text);
        let query = ('select ?text as ?mms ?msg as ?id ?chan as ?chan ?timestamp as ?timestamp ' +
                      'where { ?msg a nmo:IMMessage . ?msg nie:plainTextContent ?text . ?msg fts:match "%s*" . ' +
                      '?msg nmo:communicationChannel ?channel. ?channel nie:title ?chan. ' +
                      '?msg nie:contentCreated ?timestamp } order by desc (?timestamp)'
                     ).format(text);
        log(query);
        this._fetchingResults = true;
        this._endQuery = new LogManager.GenericQuery(this._logManager._connection, 20);
        this._endQuery.run(query,this._cancellable,Lang.bind(this, this._handleResults));
        Mainloop.timeout_add(3000, Lang.bind(this,
            function() {
                if(this._fetchingResults) {
                    let placeholder = new Gtk.Box({ halign: Gtk.Align.CENTER,
                                                    valign: Gtk.Align.CENTER,
                                                    orientation: Gtk.Orientation.HORIZONTAL,
                                                    visible: true });
                    let spinner = new Gtk.Spinner({ visible: true });
                    spinner.start();
                    placeholder.add(spinner);
                    placeholder.add(new Gtk.Label({ label: _(" Searching.."),
                                                    visible: true }));

                    placeholder.get_style_context().add_class('dim-label');
                    this.set_placeholder(placeholder);
                }
                // else this.set_placeholder(null);
                return GLib.SOURCE_REMOVE;
            }));
        // this._logManager.query(query,this._cancellable,Lang.bind(this, this._handleResults));
    },

    _loadNextResults: function() {
        print("here");
        if (this._fetchingResults)
            return;
        print("and here");
        this._fetchingResults = true;

        Mainloop.timeout_add(500, Lang.bind(this,
            function() {
                this._endQuery.next(10,this._cancellable,Lang.bind(this, this._handleResults1));
            }));

    },

    _handleResults: function(events) {
        log(events.length);
        if(events.length == 0) {
            let placeholder = new Gtk.Box({ halign: Gtk.Align.CENTER,
                                            valign: Gtk.Align.CENTER,
                                            orientation: Gtk.Orientation.VERTICAL,
                                            visible: true });
            placeholder.add(new Gtk.Image({ icon_name: 'edit-find-symbolic',
                                            pixel_size: 64,
                                            visible: true }));
            placeholder.add(new Gtk.Label({ label: _("No results"),
                                            visible: true }));

            placeholder.get_style_context().add_class('dim-label');
            this.set_placeholder(placeholder);
        }
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
            print(events[i].chan);
            print(this._channelMap[events[i].chan]);
            if( this._channelMap[events[i].chan] != null ) {
                print("XXXXXXXXX");
                this._channelMap[events[i].chan]++;
            } else {
                this._channelMap[events[i].chan] = 0;
            }
            row.rank = this._channelMap[events[i].chan];
            row._content_label.label = message;
        }

        this._widgetMap = widgetMap;

        this.foreach(r => { r.destroy(); })

        for (let i = 0; i < events.length; i++) {
            let row = this._widgetMap[events[i].id];
            this.add(row);
        }

        if(events.length > 0) {
            let row = this._widgetMap[events[0].id];
            this.select_row(row);
        }

        this._showList();
        this._fetchingResults = false;
    },

    _handleResults1: function(events){
        log(events.length);
        for (let i = 0; i < events.length; i++) {
            let message = GLib.markup_escape_text(events[i].mms, -1);
            let uid = events[i].id;
            let row;
            row = new ResultRow(events[i]);
            this._widgetMap[uid] = row;

            if( this._channelMap[events[i].chan] ) {
                this._channelMap[events[i].chan]++;
            } else {
                this._channelMap[events[i].chan] = 0;
            }
            row.rank = this._channelMap[events[i].chan];

            row._content_label.label = message;
            this.add(row);
        }

        this._showList();
        this._fetchingResults = false;
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

const ResultWindow = new Lang.Class({
    Name: 'ResultWindow',
    Extends: Gtk.ScrolledWindow,

    _init: function(params) {
        this.parent(params);

        this._list = new ResultList({ visible: true, selection_mode: Gtk.SelectionMode.BROWSE });
        // this._list.set_placeholder(new ResultPlaceholder());
        this.add(this._list);
        this.show_all();

        this._cancellable  = new Gio.Cancellable();

        this.connect('scroll-event', Lang.bind(this, this._onScroll));

        this.vadjustment.connect('changed',
                                 Lang.bind(this, this._updateScroll));

        let adj = this.vadjustment;
        this._scrollBottom = adj.upper - adj.page_size;
        print(this._scrollBottom);
        this._hoverCursor = Gdk.Cursor.new(Gdk.CursorType.HAND1);
    },

    _updateScroll: function() {
        let adj = this.vadjustment;
        this._scrollBottom = adj.upper - adj.page_size;
    },

    _onScroll: function(w, event) {
        let [hasDir, dir] = event.get_scroll_direction();
        if (hasDir && (dir != Gdk.ScrollDirection.UP || dir != Gdk.ScrollDirection.DOWN) )
            return Gdk.EVENT_PROPAGATE;

        let [hasDeltas, dx, dy] = event.get_scroll_deltas();
        if (hasDeltas)
            this._fetchMoreResults();
    },

    _fetchMoreResults: function() {
        if (this.vadjustment.value != this._scrollBottom )
            return Gdk.EVENT_PROPAGATE;

        this._list.emit('scroll-bottom-reached');

        return Gdk.EVENT_STOP;
    },
});

const ResultPlaceholder = new Lang.Class({
    Name: 'ResultPlaceholder',
    Extends: Gtk.Overlay,

    _init: function() {
        let image = new Gtk.Image({ icon_name: 'org.gnome.Polari-symbolic',
                                      pixel_size: 96, halign: Gtk.Align.END,
                                      margin_end: 14 });

        let title = new Gtk.Label({ use_markup: true, halign: Gtk.Align.START,
                                    margin_start: 14 });
        title.label = '<span letter_spacing="4500">%s</span>'.format(_("Polari"));
        title.get_style_context().add_class('polari-background-title');

        let description = new Gtk.Label({ label: _("Join a room using the + button."),
                                          halign: Gtk.Align.CENTER, wrap: true,
                                          margin_top: 24, use_markup: true });
        description.get_style_context().add_class('polari-background-description');

        let inputPlaceholder = new Gtk.Box({ valign: Gtk.Align.END });
        //sizeGroup.add_widget(inputPlaceholder);

        this.parent();
        let grid = new Gtk.Grid({ column_homogeneous: true, can_focus: false,
                                  column_spacing: 18, hexpand: true, vexpand: true,
                                  valign: Gtk.Align.CENTER });
        grid.get_style_context().add_class('polari-background');
        grid.attach(image, 0, 0, 1, 1);
        grid.attach(title, 1, 0, 1, 1);
        grid.attach(description, 0, 1, 2, 1);
        this.add(grid);
        this.add_overlay(inputPlaceholder);
        this.show_all();
    }
});

const LoadPlaceholder = new Lang.Class({
    Name: 'LoadPlaceholder',
    Extends: Gtk.Overlay,

    _init: function() {
        let image = new Gtk.Image({ icon_name: 'org.gnome.Polari-symbolic',
                                      pixel_size: 96, halign: Gtk.Align.END,
                                      margin_end: 14 });

        let title = new Gtk.Label({ use_markup: true, halign: Gtk.Align.START,
                                    margin_start: 14 });
        title.label = '<span letter_spacing="4500">%s</span>'.format(_("Loading"));
        title.get_style_context().add_class('polari-background-title');

        let description = new Gtk.Label({ label: _("Join a room using the + button."),
                                          halign: Gtk.Align.CENTER, wrap: true,
                                          margin_top: 24, use_markup: true });
        description.get_style_context().add_class('polari-background-description');

        let inputPlaceholder = new Gtk.Box({ valign: Gtk.Align.END });
        //sizeGroup.add_widget(inputPlaceholder);

        this.parent();
        let grid = new Gtk.Grid({ column_homogeneous: true, can_focus: false,
                                  column_spacing: 18, hexpand: true, vexpand: true,
                                  valign: Gtk.Align.CENTER });
        grid.get_style_context().add_class('polari-background');
        let spinner = new Gtk.Spinner({visible: true, active: true});
        spinner.start();
        grid.attach(spinner, 0, 0, 1, 1);
        grid.attach(title, 1, 0, 1, 1);
        // grid.attach(description, 0, 1, 2, 1);
        this.add(grid);
        this.add_overlay(inputPlaceholder);
        this.show_all();
    }
});

Signals.addSignalMethods(ResultList.prototype);
