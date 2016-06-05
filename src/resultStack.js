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

    _addView: function(channel, view) {
        this._results[channel] = view;
        this.add_named(view, channel);
    },

    _resultAdded: function(channel) {
        this._addView(channel, new ResultView.ResultView(channel));
    },

    _resultRemoved: function(row) {
        this._results[row.uid].destroy();
        delete this._results[row.uid];
    },

    _activeResultChanged: function(action, parameter) {
        let [uid, timestamp, channel, keywords, rank] = parameter.deep_unpack();

        if(!this._results[channel])
            this._resultAdded(channel);
        this._results[channel]._insertView(uid, timestamp, rank);
        this.set_visible_child_name(channel);
    }
});
