const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const Lang = imports.lang;
const Polari = imports.gi.Polari;
const Tracker = imports.gi.Tracker;

var GenericQuery = new Lang.Class({
    Name: 'GenericQuery',

    _init: function(limit = -1) {
        this._connection = Polari.util_get_tracker_connection();
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

var LogWalker = new Lang.Class({
    Name: 'LogWalker',

    _init: function(room) {
        this._room = room;
        this._query = null;
    },

    getEvents: function(numEvents, callback) {
        let returnFunc = r => {
            callback(r.reverse().map(m => {
                let { text, sender, isAction, isSelf } = m;
                let timestamp = new Date(m.time).toLocaleFormat('%s');
                let dt = GLib.DateTime.new_from_unix_utc(timestamp);
                return new Polari.Message(text, sender, dt, isAction, isSelf);
            }));
        };

        if (!this._query) {
            this._query = new GenericQuery(numEvents);

            let sparql = `
                select polari:text(?msg) as ?text
                       polari:nick(?sender) as ?sender
                       polari:time(?msg) as ?time
                       (exists { ?msg a polari:ActionMessage }) as ?isAction
                       (exists { ?sender a polari:SelfContact }) as ?isSelf
                { ?msg a polari:Message;
                       polari:sender ?sender;
                       polari:channel ?chan .
                  ?chan polari:account ?account;
                        polari:name "${this._room.channel_name}" .
                  ?account polari:id "${this._room.account.get_path_suffix()}"
                } order by desc(?time) desc(tracker:id(?msg))
            `
            this._query.run(sparql, null, returnFunc);
        } else {
            this._query.next(numEvents, null, returnFunc);
        }
    },

    isEnd: function() {
        if (this._query)
            return this._query.isClosed();
        return false;
    }
});
