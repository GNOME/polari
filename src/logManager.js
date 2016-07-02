const Gio = imports.gi.Gio;
const Lang = imports.lang;
const Tracker = imports.gi.Tracker;
const TrackerControl = imports.gi.TrackerControl;
const Tp = imports.gi.TelepathyGLib;

const Utils = imports.utils;

const CHATLOG_MINER_NAME = Tracker.DBUS_SERVICE + '.Miner.Chatlog';
const CHATLOG_MINER_PATH = '/' + CHATLOG_MINER_NAME.replace('.', '/', 'g');

let _logManager = null;

function getDefault() {
    if (!_logManager)
        _logManager = new _LogManager();
    return _logManager;
}

const GenericQuery = new Lang.Class({
    Name: 'GenericQuery',

    _init: function(connection, limit = -1) {
        this._connection = connection;
        this._results = [];
        this._limit = limit;
        this._count = 0;
        this._closed = false;
        this._cursor = null;
        this._task = null;
    },

    _createTask: function(cancellable, callback) {
        return Gio.Task.new(this._connection, cancellable, Lang.bind(this,
            function(o, res) {
                let success = false;
                try {
                    success = this._task.propagate_boolean();
                } catch(e) {
                    log("Failed to run query: "  + e.message);
                }

                callback(success ? this._results : []);
                this._task = null;
            }));
    },

    run: function(sparql, cancellable, callback) {
        this._task = this._createTask(cancellable, callback);

        this._connection.query_async(sparql, cancellable, Lang.bind(this,
            function(c, res) {
                let cursor;
                try {
                    cursor = this._connection.query_finish(res);
                } catch(e) {
                    this._task.return_error(e);
                    return;
                }

                this._cursor = cursor;
                cursor.next_async(cancellable,
                                  Lang.bind(this, this._onCursorNext));
            }));
    },

    next: function (limit, cancellable, callback) {
        if (this._task)
            return false;

        this._results = [];
        this._count = 0;
        this._limit = limit;
        this._task = this._createTask(cancellable, callback);
        this._cursor.next_async(cancellable, Lang.bind(this, this._onCursorNext));
        return true;
    },

    isClosed: function () {
        return this._closed;
    },

    _onCursorNext: function(cursor, res) {
        let valid = false;
        try {
            valid = cursor.next_finish(res);
        } catch(e) {
            this._task.return_error(e);
        }

        if (valid) {
            this._pushResult(cursor);
            this._count++;

            if (this._limit <= 0 || this._count < this._limit) {
                cursor.next_async(this._task.get_cancellable(),
                                  Lang.bind(this, this._onCursorNext));
            } else {
                this._task.return_boolean(true);
            }
        } else {
            cursor.close();
            if (!this._task.had_error())
                this._task.return_boolean(true);
            this._closed = true;
        }
    },

    _getColumnsValue: function(cursor, col) {
        switch(cursor.get_value_type(col)) {
            case Tracker.SparqlValueType.STRING:
            case Tracker.SparqlValueType.URI:
                return cursor.get_string(col)[0];
            case Tracker.SparqlValueType.INTEGER:
                return cursor.get_integer(col);
            case Tracker.SparqlValueType.DOUBLE:
                return cursor.get_double(col);
            case Tracker.SparqlValueType.BOOLEAN:
                return cursor.get_boolean(col);
            case Tracker.SparqlValueType.DATETIME:
                return Date.parse(cursor.get_string(col)[0]) / 1000;
            case Tracker.SparqlValueType.BLANK_NODE:
            case Tracker.SparqlValueType.UNBOUND:
                return null;
            default:
                throw new Error("Unhandled result type");
        }
    },

    _getValue: function(cursor) {
        let nCols = cursor.get_n_columns();
        if (nCols == 1)
            return this._getColumnsValue(cursor, 0);

        let value = {};
        for (let i = 0; i < nCols; i++) {
            let name = cursor.get_variable_name(i);
            value[name] = this._getColumnsValue(cursor, i);
        }
        return value;
    },

    _pushResult: function(cursor) {
        try {
            this._results.push(this._getValue(cursor));
        } catch(e) {
            log("Error fetching result: " + e.toString());
        }
    }
});

const LogWalker = new Lang.Class({
    Name: 'LogWalker',

    _init: function(connection, room) {
        this._connection = connection;
        this._room = room;
        this._query = null;
    },

    getEvents: function(numEvents, callback) {
        if (!this._query) {
            this._query = new GenericQuery(this._connection, numEvents);

            let roomFilter;
            if (this._room.type == Tp.HandleType.ROOM)
                roomFilter = '  filter (nie:title (?chan) = "%s") ';
            else
                roomFilter = '?chan nmo:hasParticipant ?participant .' +
                             '?participant fts:match "%s"';

            print(this._room.account.nickname);
            let sparql = (
                'select nie:plainTextContent(?msg) as ?message ' +
                '       if (nmo:from(?msg) = nco:default-contact-me,' +
                '           "%s", nco:nickname(nmo:from(?msg))) as ?sender ' +
                // FIXME: how do we handle the "real" message type?
                '       %d as ?messageType ' +
                '       ?timestamp ' +
                '{ ?msg a nmo:IMMessage; ' +
                '       nie:contentCreated ?timestamp; ' +
                '       nmo:communicationChannel ?chan . ' +
                // FIXME: filter by account
                roomFilter +
                '} order by desc (?timestamp)'
            ).format(this._room.account.nickname,
                     Tp.ChannelTextMessageType.NORMAL,
                     this._room.channel_name);
            this._query.run(sparql, null, r => callback(r.reverse()))
        } else {
            this._query.next(numEvents, null, r => callback(r.reverse()));
        }
    },

    isEnd: function() {
        if (this._query)
            return this._query.isClosed();
        return false;
    }
});

const _LogManager = new Lang.Class({
    Name: 'LogManager',

    _init: function() {
        this._ensureChatlogMiner();
        this._connection = Tracker.SparqlConnection.get(null);
    },

    _ensureChatlogMiner: function() {
        let running = false;
        try {
            let manager = TrackerControl.MinerManager.new_full(false);
            [running,] = manager.get_status(CHATLOG_MINER_NAME);
        } catch(e) {
            Utils.debug('Unable to create MinerManager: ' + e.message);
        }

        if (running) {
            Utils.debug('Detected running chatlog miner.');
            return;
        }

       let flags = Gio.DBusProxyFlags.DO_NOT_LOAD_PROPERTIES |
                   Gio.DBusProxyFlags.DO_NOT_CONNECT_SIGNALS;
       Gio.DBusProxy.new_for_bus(Gio.BusType.SESSION, flags, null,
                                 CHATLOG_MINER_NAME, CHATLOG_MINER_PATH,
                                 Tracker.DBUS_SERVICE + '.Miner',
                                 null, (o, res) => {
           let miner = null;
           try {
               miner = Gio.DBusProxy.new_for_bus_finish(res);
               Utils.debug('Started chatlog miner.');
           } catch(e) {
               log('Failed to start chatlog miner: ' + e.message);
           }
       });
    },

    query: function(sparql, cancellable, callback) {
        let query = new GenericQuery(this._connection);
        query.run(sparql, cancellable, callback);
     },

     walkEvents: function(room) {
         return new LogWalker(this._connection, room);
     }
});
