const Gdk = imports.gi.Gdk;
const Gtk = imports.gi.Gtk;

var MessageHistory = class {

    constructor(entry) {
        this._entry = entry;
        this._history = [];
        this._currentEntry = 0;

        this._entry.connect('key-press-event', this._onKeyPress.bind(this));
        this._entry.connect('key-release-event', this._onKeyRelease.bind(this));

    }

    _changeMessage(text) {
        this._entry.delete_text(0, -1);

        this._entry.insert_text(text, -1, 0);

        this._entry.set_position(text.length);
    }

    _newMessage(text) {
        if (text != "") {
            this._history[0] = text;
            this._history.unshift("");
            this._currentEntry = 0;
        }
    }

    // Keep the entry area from unfocusing
    _onKeyPress(w, event){

        if (event.get_keyval()[1] == Gdk.KEY_Up) {
            return Gdk.EVENT_STOP;
        }

        return Gdk.EVENT_PROPAGATE;
    }

    _onKeyRelease(w, event) {
        let [, keyval] = event.get_keyval();

        if (keyval == Gdk.KEY_Up && this._currentEntry < this._history.length-1) {
            this._currentEntry++;
        } else if (keyval == Gdk.KEY_Down && this._currentEntry > 0) {
            this._currentEntry--;
        } else {
            this._history[this._currentEntry] = this._entry.text;
            return Gdk.EVENT_PROPAGATE;
        }

        this._changeMessage(this._history[this._currentEntry]);

        return Gdk.EVENT_STOP;
    }

}
