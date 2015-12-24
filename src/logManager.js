const Gio = imports.gi.Gio;
const Lang = imports.lang;
const Tracker = imports.gi.Tracker;

let _logManager = null;

function getDefault() {
    if (!_logManager)
        _logManager = new _LogManager();
    return _logManager;
}

const GenericQuery = new Lang.Class({
    Name: 'GenericQuery',

    _init: function(connection) {
        this._connection = connection;
        this._results = [];
        this._task = null;
    },

    run: function(sparql, cancellable, callback) {
        this._task = Gio.Task.new(this._connection, cancellable, Lang.bind(this,
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

        this._connection.query_async(sparql, cancellable, Lang.bind(this,
            function(c, res) {
                let cursor;
                try {
                    cursor = this._connection.query_finish(res);
                } catch(e) {
                    this._task.return_error(e);
                    return;
                }

                cursor.next_async(cancellable,
                                  Lang.bind(this, this._onCursorNext));
            }));
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
            cursor.next_async(this._task.get_cancellable(),
                              Lang.bind(this, this._onCursorNext));
        } else {
            cursor.close();
            if (!this._task.had_error())
                this._task.return_boolean(true);
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

const _LogManager = new Lang.Class({
    Name: 'LogManager',

    _init: function() {
        this._connection = Tracker.SparqlConnection.get(null);
    },

    query: function(sparql, cancellable, callback) {
        let query = new GenericQuery(this._connection);
        query.run(sparql, cancellable, callback);
     }
});
