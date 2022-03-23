// SPDX-FileCopyrightText: 2016 Florian Müllner <fmuellner@gnome.org>
// SPDX-FileCopyrightText: 2016 raresv <rares.visalom@gmail.com>
// SPDX-FileCopyrightText: 2016 Kunaal Jain <kunaalus@gmail.com>
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const Signals = imports.signals;

export default class NetworksManager {
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
            this._parseNetworks(new TextDecoder().decode(data));
        } catch (e) {
            console.warn('Failed to load network list');
            console.debug(e);
        }
    }

    _parseNetworks(data) {
        let networks;
        try {
            networks = JSON.parse(data);
        } catch (e) {
            console.warn('Failed to parse network list');
            console.debug(e);
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
        return account && this._networksById.has(account.service);
    }

    getNetworkName(id) {
        return this._lookupNetwork(id).name;
    }

    getNetworkIsFavorite(id) {
        let network = this._lookupNetwork(id);

        if (Object.prototype.hasOwnProperty.call(network, 'favorite'))
            return network['favorite'];

        return false;
    }

    getNetworkDetails(id) {
        let network = this._lookupNetwork(id);
        if (!network.servers || !network.servers.length)
            throw new Error(`No servers for network ${id}`);

        let server = this.getNetworkServers(id)[0];
        let details = {
            'account': new GLib.Variant('s', GLib.get_user_name()),
            'server': new GLib.Variant('s', server.address),
            'port': new GLib.Variant('u', server.port),
            'use-ssl': new GLib.Variant('b', server.ssl),
        };

        if (server.charset)
            details['charset'] = new GLib.Variant('s', server.charset);

        return details;
    }

    getNetworkServers(id) {
        let network = this._lookupNetwork(id);
        let sslServers = network.servers.filter(s => s.ssl);
        return sslServers.length > 0 ? sslServers : network.servers.slice();
    }

    getNetworkMatchTerms(id) {
        let network = this._lookupNetwork(id);
        let servers = network.servers.map(s => s.address);
        let terms = [network.name, network.id, ...servers];
        return terms.map(t => t.toLowerCase());
    }

    findByServer(server) {
        let network = this._networks.find(n => {
            return n.servers.some(s => s.address === server);
        });
        return network ? network.id : null;
    }
}
Signals.addSignalMethods(NetworksManager.prototype);
