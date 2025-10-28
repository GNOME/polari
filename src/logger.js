// SPDX-FileCopyrightText: 2015 Florian Müllner <fmuellner@gnome.org>
// SPDX-FileCopyrightText: 2015 Carlos Garnacho <carlosg@gnome.org>
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import Polari from 'gi://Polari';
import Tracker from 'gi://Tracker';

Gio._promisify(Tracker.SparqlStatement.prototype, 'execute_async');
Gio._promisify(Tracker.SparqlCursor.prototype, 'next_async');
Gio._promisify(Tracker.Batch.prototype, 'execute_async');
Gio._promisify(Polari.TplImporter.prototype, 'collect_files_async');
Gio._promisify(Polari.TplImporter.prototype, 'import_async');

class GenericQuery {
    constructor(connection, query) {
        this._connection = connection;
        this._results = [];

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
        if (!await cursor.next_async(cancellable))
            return null;

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

        const value = {};
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

        const accountId = this._room.account.get_path_suffix();
        const roomName = this._room.channel_name;
        this._channelIri = `urn:channel:${accountId}:${roomName}`;
    }

    async _getResults(cursor, numEvents) {
        const results = [];
        let event;
        let i = 0;

        // eslint-disable-next-line no-await-in-loop
        while ((event = await this._query.next(cursor)) !== null) {
            if (i > numEvents) {
                const prevEvent = results[results.length - 1];
                // Cluster events with the same user/time together, even if
                // we are at the numEvents limit.
                if (event.time !== prevEvent.time &&
                    (event.senderNick !== prevEvent.senderNick ||
                     event.isAction !== prevEvent.isAction))
                    break;
            }

            i++;
            results.push(event);
        }

        cursor.close();
        return results;
    }

    async getEvents(endTime, numEvents) {
        if (this._isEnd)
            return [];

        const store = Polari.util_get_tracker_connection();

        if (!this._query) {
            const query = '/org/gnome/Polari/sparql/get-room-events.rq';
            this._query = new GenericQuery(store, query);
        }

        const channel = this._channelIri;
        const timeStr = endTime.format_iso8601();
        const cursor =
            await this._query.execute({channel, endTime: timeStr}, null);

        const results = await this._getResults(cursor, numEvents);

        this._isEnd = results.length < numEvents;

        return results.reverse().map(m => {
            const {text, senderNick, time, isAction, isSelf} = m;
            return new Polari.Message(text, senderNick, time, isAction, isSelf);
        });
    }

    async getEventsForward(startTime, numEvents) {
        const store = Polari.util_get_tracker_connection();

        if (!this._forwardQuery) {
            const query = '/org/gnome/Polari/sparql/get-room-events-forward.rq';
            this._forwardQuery = new GenericQuery(store, query);
        }

        const channel = this._channelIri;
        const timeStr = startTime.format_iso8601();
        const cursor =
            await this._forwardQuery.execute({channel, startTime: timeStr}, null);

        const results = await this._getResults(cursor, numEvents);

        return results.map(m => {
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
        this._importer = new Polari.TplImporter({
            store: this._connection,
        });
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

            const batch = await this._importer.import_async(file, null);

            return await batch.execute_async(null);
        } catch (e) {
            console.debug(e);
            return true;
        }
    }
}

export class LogFinder {
    constructor(roomManager) {
        this._roomManager = roomManager;
        this._countQuery = null;
        this._fetchQuery = null;
        this._contextQuery = null;
        this._cancellable = null;
    }

    async countResults(keyword) {
        const store = Polari.util_get_tracker_connection();

        if (!this._countQuery) {
            const query = '/org/gnome/Polari/sparql/count-results.rq';
            this._countQuery = new GenericQuery(store, query);
        }

        this._cancellable?.cancel();
        this._cancellable = new Gio.Cancellable();

        const cursor = await this._countQuery.execute({keyword}, this._cancellable);
        const results = {};
        const roomMap = new Map();
        let row;

        for (const room of this._roomManager.rooms) {
            const accountId = room.account.get_path_suffix();
            const roomName = room.channel_name;
            const uri = `urn:channel:${accountId}:${roomName}`;
            roomMap.set(uri, room);
        }

        // eslint-disable-next-line no-await-in-loop
        while ((row = await this._countQuery.next(cursor, this._cancellable)) !== null) {
            const room = roomMap.get(row.channel);
            if (room)
                results[room] = Number(row.matches);
        }

        cursor.close();

        return results;
    }

    async fetchResults(room, keyword, limit, offset, cancellable) {
        const store = Polari.util_get_tracker_connection();

        if (!this._fetchQuery) {
            const query = '/org/gnome/Polari/sparql/search-messages.rq';
            this._fetchQuery = new GenericQuery(store, query);
        }

        if (!this._contextQuery) {
            const query = '/org/gnome/Polari/sparql/get-context.rq';
            this._contextQuery = new GenericQuery(store, query);
        }

        const accountId = room.account.get_path_suffix();
        const roomName = room.channel_name;
        const channel = `urn:channel:${accountId}:${roomName}`;

        const params = {channel, keyword, limit, offset};
        const cursor = await this._fetchQuery.execute(params, cancellable);

        const results = [];
        let row;

        // eslint-disable-next-line no-await-in-loop
        while ((row = await this._fetchQuery.next(cursor, cancellable)) !== null) {
            // eslint-disable-next-line no-await-in-loop
            const contextCursor = await this._contextQuery.execute(
                {channel, msgTime: row.time.format_iso8601()}, cancellable);
            const ctx = [];
            let item;
            // eslint-disable-next-line no-await-in-loop
            item = await this._contextQuery.next(
                contextCursor, cancellable);
            if (item !== null)
                ctx.push(item);

            // eslint-disable-next-line no-await-in-loop
            item = await this._contextQuery.next(
                contextCursor, cancellable);
            if (item !== null)
                ctx.push(item);

            results.push([row, ...ctx]);
            contextCursor.close();
        }

        cursor.close();

        return results;
    }

    cancel() {
        this._cancellable?.cancel();
    }
}
