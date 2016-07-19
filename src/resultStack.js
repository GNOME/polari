const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;

const AccountsMonitor = imports.accountsMonitor;
const ChatroomManager = imports.chatroomManager;
const ResultView = imports.resultView;
const Lang = imports.lang;

const ResultStack = new Lang.Class({
    Name: 'ResultStack',
    Extends: Gtk.Stack,

    _init: function(params) {
        this.parent(params);

        this._results = {};

        this._app = Gio.Application.get_default();
        this._activeResultAction = this._app.lookup_action('active-result-changed');
        this._activeResultAction.connect('activate',
                                          Lang.bind(this, this._activeResultChanged));

    },

    _addView: function(id, view) {
        this._results[id] = view;
        this.add_named(view, id);
    },

    _resultAdded: function(uid, timestamp, channel, keywords) {
        this._addView(uid, new ResultView.ResultView(uid, timestamp, channel, keywords));
    },

    _resultRemoved: function(row) {
        this._results[row.uid].destroy();
        delete this._results[row.uid];
    },

    _activeResultChanged: function(action, parameter) {
        let [uid, timestamp, channel, keywords] = parameter.deep_unpack();
        print(uid);
        if(!this._results[uid])
            this._resultAdded(uid, timestamp, channel, keywords);
        this.set_visible_child_name(uid);
    }
});
