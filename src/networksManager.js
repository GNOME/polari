const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;

const Lang = imports.lang;
const Signals = imports.signals;

let _singleton = null;

function getDefault() {
    if (_singleton == null)
        _singleton = new NetworksManager();
    return _singleton;
}

const NetworksManager = new Lang.Class({
    Name: 'NetworksManager',

    _init: function() {
        this._networks = [];

        let uri = 'resource:///org/gnome/Polari/data/networks.json';
        let file = Gio.File.new_for_uri(uri);
        file.load_contents_async(null, Lang.bind(this, this._onContentsReady));
    },

    _onContentsReady: function(f, res) {
        let data;
        try {
            [success, data, ] = f.load_contents_finish(res);
        } catch(e) {
            log('Failed to load network list: ' + e.message);
            return;
        }

        let networks;
        try {
            networks = JSON.parse(data);
        } catch(e) {
            log('Failed to parse network list: ' + e.message);
            return;
        }

        this._networks = networks;
        this.emit('changed');
    },

    get networks() {
        return this._networks;
    }
});
Signals.addSignalMethods(NetworksManager.prototype);
