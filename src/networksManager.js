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
        this._networksById = new Map();

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
        this._networks.forEach(Lang.bind(this,
            function(network) {
                this._networksById.set(network.id, network);
            }));
        this.emit('changed');
    },

    _lookupNetwork: function(id) {
        let network = this._networksById.get(id);
        if (!network)
            throw new Error('Invalid network ID');
        return network;
    },

    get networks() {
        return this._networks;
    },

    getAccountIsPredefined: function(account) {
        return account && this._networksById.get(account.service) != null;
    },

    getNetworkName: function(id) {
        return this._lookupNetwork(id).name;
    },

    getNetworkDetails: function(id) {
        let network = this._lookupNetwork(id);
        if (!network.servers || !network.servers.length)
            throw new Error('No servers for network ' + id);

        let sslServers = network.servers.filter(s => s.ssl);
        let server = sslServers.length > 0 ? sslServers[0]
                                           : network.servers[0];
        return {
            'account': new GLib.Variant('s', GLib.get_user_name()),
            'server': new GLib.Variant('s', server.address),
            'port': new GLib.Variant('u', server.port),
            'use-ssl': new GLib.Variant('b', server.ssl)
        };
    },

    getNetworkMatchTerms: function(id) {
        let network = this._lookupNetwork(id);
        let servers = network.servers.map(function(s) {
            return s.address.toLowerCase();
        });
        return [network.name.toLowerCase(),
                network.id.toLowerCase()].concat(servers);
    },

    getServers: function(account) {
        if (!account)
            throw new Error('Missing account argument');
        return this._lookupNetwork(account.service).servers;
    }

});
Signals.addSignalMethods(NetworksManager.prototype);
