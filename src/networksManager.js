/* exported NetworksManager */

const { Gio, GLib } = imports.gi;
const ByteArray = imports.byteArray;
const Signals = imports.signals;

var NetworksManager = class {
    static getDefault() {
        if (!this._singleton)
            this._singleton = new NetworksManager();
        return this._singleton;
    }

    constructor() {
        this._networks = [];
        this._networksById = new Map();

        let uri = 'resource:///org/gnome/Polari/data/networks.json';
        let file = Gio.File.new_for_uri(uri);
        let data;
        try {
            [, data] = file.load_contents(null);
            this._parseNetworks(ByteArray.toString(data));
        } catch (e) {
            log(`Failed to load network list: ${e.message}`);
        }
    }

    _parseNetworks(data) {
        let networks;
        try {
            networks = JSON.parse(data);
        } catch (e) {
            log(`Failed to parse network list: ${e.message}`);
            return false;
        }

        this._networksById.clear();
        this._networks = networks;
        this._networks.forEach(network => {
            this._networksById.set(network.id, network);
        });
        return true;
    }

    _lookupNetwork(id) {
        let network = this._networksById.get(id);
        if (!network)
            throw new Error('Invalid network ID');
        return network;
    }

    get networks() {
        return this._networks;
    }

    getAccountIsPredefined(account) {
        return account && this._networksById.get(account.service) != null;
    }

    getNetworkName(id) {
        return this._lookupNetwork(id).name;
    }

    getNetworkIsFavorite(id) {
        let network = this._lookupNetwork(id);

        if (network.hasOwnProperty('favorite'))
            return network['favorite'];

        return false;
    }

    getNetworkDetails(id) {
        let network = this._lookupNetwork(id);
        if (!network.servers || !network.servers.length)
            throw new Error(`No servers for network ${id}`);

        let server = this.getNetworkServers(id)[0];
        return {
            'account': new GLib.Variant('s', GLib.get_user_name()),
            'server': new GLib.Variant('s', server.address),
            'port': new GLib.Variant('u', server.port),
            'use-ssl': new GLib.Variant('b', server.ssl)
        };
    }

    getNetworkServers(id) {
        let network = this._lookupNetwork(id);
        let sslServers = network.servers.filter(s => s.ssl);
        return sslServers.length > 0 ? sslServers
                                     : network.servers.slice();
    }

    getNetworkMatchTerms(id) {
        let network = this._lookupNetwork(id);
        let terms = [network.name, network.id, ...network.servers];
        return terms.map(String.toLowerCase);
    }

    findByServer(server) {
        for (let n of this._networks)
            if (n.servers.some(s => s.address == server))
                return n.id;
        return null;
    }
};
Signals.addSignalMethods(NetworksManager.prototype);
