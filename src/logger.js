// SPDX-FileCopyrightText: 2015 Florian Müllner <fmuellner@gnome.org>
// SPDX-FileCopyrightText: 2015 Carlos Garnacho <carlosg@gnome.org>
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Polari from 'gi://Polari';
import Tracker from 'gi://Tracker';

Gio._promisify(Tracker.SparqlStatement.prototype, 'execute_async');
Gio._promisify(Tracker.SparqlCursor.prototype, 'next_async');
Gio._promisify(Tracker.Batch.prototype, 'execute_async');
Gio._promisify(Polari.TplImporter.prototype, 'collect_files_async');
Gio._promisify(Polari.TplImporter.prototype, 'import_async');

class GenericQuery {
    constructor(query) {
        this._connection = Polari.util_get_tracker_connection();
        this._results = [];
        this._closed = false;

        this._statement =
            this._connection.load_statement_from_gresource(query, null);
    }

    async execute(args, cancellable = null) {
        for (const name in args) {
            if (typeof args[name] === 'number')
                this._statement.bind_int(name, args[name]);
            else
                this._statement.bind_string(name, args[name]);
        }

        // eslint-disable-next-line no-return-await
        return await this._statement.execute_async(cancellable);
    }

    async next(cursor, cancellable = null) {
        if (!await cursor.next_async(cancellable)) {
            cursor.close();
            return null;
        }

        return this._getRow(cursor);
    }

    _getColumnValue(cursor, col) {
        switch (cursor.get_value_type(col)) {
        case Tracker.SparqlValueType.STRING:
        case Tracker.SparqlValueType.URI:
        case Tracker.SparqlValueType.BLANK_NODE:
            return cursor.get_string(col)[0];
        case Tracker.SparqlValueType.INTEGER:
            return cursor.get_integer(col);
        case Tracker.SparqlValueType.DOUBLE:
            return cursor.get_double(col);
        case Tracker.SparqlValueType.BOOLEAN:
            return cursor.get_boolean(col);
        case Tracker.SparqlValueType.DATETIME:
            return cursor.get_datetime(col);
        case Tracker.SparqlValueType.UNBOUND:
            return null;
        default:
            throw new Error('Unhandled result type');
        }
    }

    _getRow(cursor) {
        const nCols = cursor.get_n_columns();
        if (nCols === 1)
            return this._getColumnValue(cursor, 0);

        let value = {};
        for (let i = 0; i < nCols; i++) {
            const name = cursor.get_variable_name(i);
            value[name] = this._getColumnValue(cursor, i);
        }
        return value;
    }
}

export class LogWalker {
    constructor(room) {
        this._room = room;
        this._query = null;
        this._isEnd = false;
        // Start with a date in the slight future
        this._lastTime = GLib.DateTime.new_now_utc().add_days(1);

        const accountId = this._room.account.get_path_suffix();
        const roomName = this._room.channel_name;
        this._channelIri = `urn:channel:${accountId}:${roomName}`;
    }

    async getEvents(numEvents) {
        if (this._isEnd)
            return [];

        if (!this._query) {
            const query = '/org/gnome/Polari/sparql/get-room-events.rq';
            this._query = new GenericQuery(query);
        }

        const channel = this._channelIri;
        const lastTime = this._lastTime.format_iso8601();
        let cursor =
            await this._query.execute({channel, numEvents: numEvents * 2, lastTime}, null);
        let results = [];
        let event;
        let i = 0;

        // eslint-disable-next-line no-await-in-loop
        while ((event = await this._query.next(cursor)) !== null) {
            // Cluster events with the same time together, even if
            // we are at the numEvents limit.
            if (i > numEvents &&
                event.time !== results[results.length - 1].time)
                break;

            i++;
            results.push(event);
        }

        this._isEnd = results.length < numEvents;

        if (!this._isEnd)
            this._lastTime = results[results.length - 1].time;

        return results.reverse().map(m => {
            const {text, senderNick, time, isAction, isSelf} = m;
            return new Polari.Message(text, senderNick, time, isAction, isSelf);
        });
    }

    isEnd() {
        return this._isEnd;
    }
}

export class LogImporter {
    constructor() {
        this._connection = Polari.util_get_tracker_connection();
        this._importer = new Polari.TplImporter();
    }

    async init() {
        this._files = await this._importer.collect_files_async(null);
        return this._files.length;
    }

    async importNext() {
        try {
            const file = this._files.pop();
            if (!file)
                return false;

            let batch = await this._importer.import_async(file, null);

            return await batch.execute_async(null);
        } catch (e) {
            console.debug(e);
            return true;
        }
    }
}
