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
const Utils = imports.utils;

const MIN_SEARCH_WIDTH = 0;

const ResultRow = new Lang.Class({
    Name: 'ResultRow',
    Extends: Gtk.ListBoxRow,
    Template: 'resource:///org/gnome/Polari/ui/result-list-row.ui',
    InternalChildren: ['box1', 'source_name', 'short_time_label', 'content_label'],

    _init: function(event) {
        this.parent();
        this._source_name.label = event.chan.substring(1);
        this._short_time_label.label = Utils.formatTimestamp(event.timestamp);
        this.uid = event.id;
        this.channel = event.chan;
        this.nickname = event.chan;
        this.timestamp = event.timestamp;
        this.rawmessage = event.mms;

        this.connect('key-press-event',
                     Lang.bind(this, this._onKeyPress));

    },

    _onButtonRelease: function(w, event) {
        let [, button] = event.get_button();
        if (button != Gdk.BUTTON_SECONDARY)
            return Gdk.EVENT_PROPAGATE;

        return Gdk.EVENT_STOP;
    },

    _onKeyPress: function(w, event) {
        let [, keyval] = event.get_keyval();
        let [, mods] = event.get_state();
        if (keyval != Gdk.KEY_Menu &&
            !(keyval == Gdk.KEY_F10 &&
              mods & Gdk.ModifierType.SHIFT_MASK))
            return Gdk.EVENT_PROPAGATE;


        return Gdk.EVENT_STOP;
    }
});

const ResultList = new Lang.Class({
    Name: 'ResultList',
    Extends: Gtk.ListBox,

    _init: function(params) {
        this.parent(params);
        this._app = Gio.Application.get_default();
        this._logManager = LogManager.getDefault();

        this._results = [];
        this._widgetMap = {};
        this._channelMap = {};

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

    },

    _clearList: function() {
        this.foreach(r => { r.hide(); });
    },

    _showList: function() {
        this.foreach(r => { r.show(); });
    },

    _handleSearchChanged: function(group, actionName, value) {
        this._cancellable.cancel();

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

                return GLib.SOURCE_REMOVE;
            }));

    },

    _loadNextResults: function() {

        if (this._fetchingResults)
            return;

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

            if (row) {
                widgetMap[uid] = row;
                this.remove(row);
            } else {
                row = new ResultRow(events[i]);
                widgetMap[uid] = row;
            }

            if( this._channelMap[events[i].chan] != null ) {

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

        // Select first result
        if(events.length > 0) {
            let row = this._widgetMap[events[0].id];
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
    }
});

const ResultWindow = new Lang.Class({
    Name: 'ResultWindow',
    Extends: Gtk.ScrolledWindow,

    _init: function(params) {
        this.parent(params);

        this._list = new ResultList({ visible: true, selection_mode: Gtk.SelectionMode.BROWSE });

        this.add(this._list);
        this.show_all();

        this._cancellable  = new Gio.Cancellable();

        this.connect('scroll-event', Lang.bind(this, this._onScroll));

        this.vadjustment.connect('changed',
                                 Lang.bind(this, this._updateScroll));

        let adj = this.vadjustment;
        this._scrollBottom = adj.upper - adj.page_size;

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


        this.parent();
        let grid = new Gtk.Grid({ column_homogeneous: true, can_focus: false,
                                  column_spacing: 18, hexpand: true, vexpand: true,
                                  valign: Gtk.Align.CENTER });
        grid.get_style_context().add_class('polari-background');
        let spinner = new Gtk.Spinner({visible: true, active: true});
        spinner.start();
        grid.attach(spinner, 0, 0, 1, 1);
        grid.attach(title, 1, 0, 1, 1);

        this.add(grid);
        this.add_overlay(inputPlaceholder);
        this.show_all();
    }
});

Signals.addSignalMethods(ResultList.prototype);
