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

const MARGIN = 14;

const ResultTextView = new Lang.Class({
    Name: 'ResultTextView',
    Extends: Gtk.TextView,

    _init: function(params) {
        this.parent(params);
    }
});

const ResultView = new Lang.Class({
    Name: 'ResultView',
    Extends: Gtk.ScrolledWindow,

    _init: function() {
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
    }
});
