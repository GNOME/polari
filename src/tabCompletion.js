const Gdk = imports.gi.Gdk;
const Gtk = imports.gi.Gtk;
const Pango = imports.gi.Pango;

const IrcParser = imports.ircParser;

var TabCompletion = class {
    constructor(entry) {
        this._entry = entry;
        this._canComplete = false;
        this._key = '';

        this._entry.connect('key-press-event', this._onKeyPress.bind(this));
        this._entry.connect('focus-out-event', this._cancel.bind(this));
        this._entry.connect('unmap', this._cancel.bind(this));
        this._entry.connect('realize', () => {
            this._popup.set_transient_for(this._entry.get_toplevel());
        });

        this._popup = new Gtk.Window({ type: Gtk.WindowType.POPUP });

        // HACK: tooltips are the only popup windows that don't require a
        //       grab on wayland
        this._popup.set_type_hint(Gdk.WindowTypeHint.TOOLTIP);

        let frame = new Gtk.Frame({ visible: true });
        this._popup.add(frame);

        this._list = new Gtk.ListBox({ selection_mode: Gtk.SelectionMode.SINGLE });
        this._list.set_filter_func(this._filter.bind(this));
        this._list.connect('row-selected', this._onRowSelected.bind(this));
        this._list.connect('row-activated', this._stop.bind(this));
        this._list.connect('keynav-failed', this._onKeynavFailed.bind(this));
        frame.add(this._list);

        this._widgetMap = new Map();
        this._previousWasCommand = false;

        let commands = Object.keys(IrcParser.knownCommands);
        for (let i = 0; i < commands.length; i++) {
            let row = new Gtk.ListBoxRow();
            row._text = '/' + commands[i];
            row._casefoldedText = row._text.toLowerCase();
            row.add(new Gtk.Label({ label: row._text,
                                    halign: Gtk.Align.START,
                                    margin_start: 6,
                                    margin_end: 6 }));
            this._list.add(row);
        }
    }

    _showPopup() {
        this._list.show_all();

        let [, height] = this._list.get_preferred_height();
        let [, width] = this._list.get_preferred_width();
        this._popup.resize(width, height);

        let win = this._entry.get_window();

        let layout = this._entry.get_layout();
        let layoutIndex = this._entry.text_index_to_layout_index(this._startPos);
        let wordPos = layout.index_to_pos(layoutIndex);
        let [layoutX,] = this._entry.get_layout_offsets();

        let allocation = this._entry.get_allocation();
        let [ret, x, y] = win.get_origin();
        x += allocation.x + Math.min((layoutX + wordPos.x) / Pango.SCALE,
                                     allocation.width - width);
        y += allocation.y - height;
        this._popup.move(x, y);
        this._popup.show();
    }

    setCompletions(completions) {
        if (this._popup.visible) {
            let id = this._popup.connect('unmap', () => {
                this._popup.disconnect(id);
                this.setCompletions(completions);
            });
            return;
        }

        let widgetMap = new Map();

        for (let i = 0; i < completions.length; i++) {
            let nick = completions[i];
            let row = this._widgetMap.get(nick);

            if (row) {
                widgetMap.set(nick, row);
                this._list.remove(row);
            } else {
                row = new Gtk.ListBoxRow();
                row._text = nick;
                row._casefoldedText = row._text.toLowerCase();
                row.add(new Gtk.Label({ label: row._text,
                                        halign: Gtk.Align.START,
                                        margin_start: 6,
                                        margin_end: 6 }));
                widgetMap.set(nick, row);
            }
        }

        this._widgetMap = widgetMap;

        // All remaining rows except those with IRC commands are going unused
        this._list.foreach(r => {
            if (!r._text.startsWith('/'))
                r.destroy();
        });

        for (let i = 0; i < completions.length; i++) {
            let row = this._widgetMap.get(completions[i]);
            this._list.add(row);
        }
        this._canComplete = completions.length > 0;
    }

    _onKeyPress(w, event) {
        let [, keyval] = event.get_keyval();

        if (this._key.length == 0) {
            if (keyval == Gdk.KEY_Tab) {
                this._start();
                return Gdk.EVENT_STOP;
            }
            return Gdk.EVENT_PROPAGATE;
        }

        switch (keyval) {
            case Gdk.KEY_Tab:
            case Gdk.KEY_Down:
                this._moveSelection(Gtk.MovementStep.DISPLAY_LINES, 1);
                return Gdk.EVENT_STOP;
            case Gdk.KEY_ISO_Left_Tab:
            case Gdk.KEY_Up:
                this._moveSelection(Gtk.MovementStep.DISPLAY_LINES, -1);
                return Gdk.EVENT_STOP;
            case Gdk.KEY_Escape:
                this._cancel();
                return Gdk.EVENT_STOP;
        }

        if (Gdk.keyval_to_unicode(keyval) != 0) {
            let popupShown = this._popup.visible;
            this._stop();
            // eat keys that would active the entry
            // when showing the popup
            return popupShown &&
                   (keyval == Gdk.KEY_Return ||
                    keyval == Gdk.KEY_KP_Enter ||
                    keyval == Gdk.KEY_ISO_Enter);
        }
        return Gdk.EVENT_PROPAGATE;
    }

    _getRowCompletion(row) {
        this._previousWasCommand = this._isCommand;

        if (this._isCommand)
            return row._text + ' ';
        if (this._startPos == 0 || this._isChained)
            return row._text + ': ';
        return row._text;
    }

    _onRowSelected(w, row) {
        if (row)
            this._insertCompletion(this._getRowCompletion(row));
    }

    _filter(row) {
        if (this._key.length == 0)
            return false;
        return row._casefoldedText.startsWith(this._key);
    }

    _insertCompletion(completion) {
        let pos = this._entry.get_position();
        this._endPos = this._startPos + completion.length;
        this._entry.delete_text(this._startPos, pos);
        this._entry.insert_text(completion, -1, this._startPos);
        this._entry.set_position(this._endPos);
    }

    _setPreviousCompletionChained(chained) {
        let repl = chained ? ',' : ':';
        let start = this._startPos - 2;
        this._entry.delete_text(start, start + 1);
        this._entry.insert_text(repl, -1, start);
    }

    _start() {
        if (!this._canComplete)
            return;

        let text = this._entry.text.substr(0, this._entry.get_position());
        this._startPos = text.lastIndexOf(' ') + 1;
        this._key = text.toLowerCase().substr(this._startPos);

        this._isCommand = this._key.startsWith('/');

        if (this._startPos == 0)
            this._endPos = -1;

        // Chain completions if the current completion directly follows a previous one,
        // except when one of them was for an IRC command
        let previousCompletion = (this._endPos == this._startPos);
        this._isChained = previousCompletion && !this._isCommand && !this._previousWasCommand;

        this._list.invalidate_filter();

        let visibleRows = this._list.get_children().filter(c => c.get_child_visible());
        let nVisibleRows = visibleRows.length;

        if (nVisibleRows == 0)
            return;

        if (this._isChained)
            this._setPreviousCompletionChained(true);
        this._insertCompletion(this._getRowCompletion(visibleRows[0]));
        if (visibleRows.length > 1) {
            this._list.select_row(visibleRows[0]);
            this._showPopup()
        }
    }

    _onKeynavFailed(w, dir) {
        if (this._inHandler)
            return Gdk.EVENT_PROPAGATE;
        let count = dir == Gtk.DirectionType.DOWN ? -1 : 1;
        this._inHandler = true;
        this._moveSelection(Gtk.MovementStep.BUFFER_ENDS, count);
        this._inHandler = false;
        return Gdk.EVENT_STOP;
    }

    _moveSelection(movement, count) {
        this._list.emit('move-cursor', movement, count);
        let row = this._list.get_focus_child();
        this._list.select_row(row);
    }

    _stop() {
        if (this._key.length == 0)
            return;

        this._popup.hide();
        this._popup.set_size_request(-1, -1);

        this._key = '';

        this._list.invalidate_filter();
    }

    _cancel() {
        if (this._key.length == 0)
            return;
        if (this._isChained)
            this._setPreviousCompletionChained(false);
        this._insertCompletion('');
        this._stop();
    }
};
