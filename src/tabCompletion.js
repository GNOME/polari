// SPDX-FileCopyrightText: 2013 Florian Müllner <fmuellner@gnome.org>
// SPDX-FileCopyrightText: 2014 Carlos Garnacho <carlosg@gnome.org>
// SPDX-FileCopyrightText: 2016 Kunaal Jain <kunaalus@gmail.com>
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gdk from 'gi://Gdk';
import Gtk from 'gi://Gtk';

import * as IrcParser from './ircParser.js';

export default class TabCompletion {
    constructor(entry) {
        this._entry = entry;
        this._canComplete = false;
        this._key = '';

        this._keyController = new Gtk.EventControllerKey({
            propagation_phase: Gtk.PropagationPhase.CAPTURE,
        });
        this._keyController.connect('key-pressed', this._onKeyPressed.bind(this));
        this._entry.add_controller(this._keyController);

        this._focusController = new Gtk.EventControllerFocus();
        this._focusController.connect('leave', this._cancel.bind(this));
        this._entry.add_controller(this._focusController);

        this._entry.connect('unmap', this._cancel.bind(this));

        this._popup = new Gtk.Popover({
            position: Gtk.PositionType.TOP,
            autohide: false,
        });
        this._popup.set_parent(this._entry);

        this._list = new Gtk.ListBox({selection_mode: Gtk.SelectionMode.SINGLE});
        this._list.set_filter_func(this._filter.bind(this));
        this._list.connect('row-selected', this._onRowSelected.bind(this));
        this._list.connect('row-activated', this._stop.bind(this));
        this._popup.set_child(this._list);

        this._widgetMap = new Map();
        this._previousWasCommand = false;

        let commands = Object.keys(IrcParser.knownCommands);
        for (let i = 0; i < commands.length; i++) {
            let row = new Gtk.ListBoxRow();
            row._text = `/${commands[i]}`;
            row._casefoldedText = row._text.toLowerCase();
            row.set_child(new Gtk.Label({
                label: row._text,
                halign: Gtk.Align.START,
                margin_start: 6,
                margin_end: 6,
            }));
            this._list.append(row);
        }
    }

    _showPopup() {
        const delegate = this._entry.get_delegate();
        const [extents] = delegate.compute_cursor_extents(this._startPos);
        const [, bounds] = this._entry.compute_bounds(delegate);

        this._popup.pointing_to = new Gdk.Rectangle({
            x: extents.get_x() - bounds.get_x(),
        });
        this._popup.popup();
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
                row.set_child(new Gtk.Label({
                    label: row._text,
                    halign: Gtk.Align.START,
                    margin_start: 6,
                    margin_end: 6,
                }));
                widgetMap.set(nick, row);
            }
        }

        this._widgetMap = widgetMap;

        // All remaining rows except those with IRC commands are going unused
        [...this._list].forEach(r => {
            if (r._text.startsWith('/'))
                return;
            this._list.remove(r);
            r.run_dispose();
        });

        for (let i = 0; i < completions.length; i++) {
            let row = this._widgetMap.get(completions[i]);
            this._list.append(row);
        }
        this._canComplete = completions.length > 0;
    }

    _onKeyPressed(controller, keyval) {
        if (this._key.length === 0) {
            if (keyval === Gdk.KEY_Tab) {
                this._start();
                return Gdk.EVENT_STOP;
            }
            return Gdk.EVENT_PROPAGATE;
        }

        switch (keyval) {
        case Gdk.KEY_Tab:
        case Gdk.KEY_Down:
            this._moveSelection(1);
            return Gdk.EVENT_STOP;
        case Gdk.KEY_ISO_Left_Tab:
        case Gdk.KEY_Up:
            this._moveSelection(-1);
            return Gdk.EVENT_STOP;
        case Gdk.KEY_Escape:
            this._cancel();
            return Gdk.EVENT_STOP;
        }

        if (Gdk.keyval_to_unicode(keyval) !== 0) {
            let popupShown = this._popup.visible;
            this._stop();
            // eat keys that would active the entry
            // when showing the popup
            return popupShown &&
                   (keyval === Gdk.KEY_Return ||
                    keyval === Gdk.KEY_KP_Enter ||
                    keyval === Gdk.KEY_ISO_Enter);
        }
        return Gdk.EVENT_PROPAGATE;
    }

    _getRowCompletion(row) {
        this._previousWasCommand = this._isCommand;

        if (this._isCommand)
            return `${row._text} `;
        if (this._startPos === 0 || this._isChained)
            return `${row._text}: `;
        return row._text;
    }

    _onRowSelected(w, row) {
        if (row)
            this._insertCompletion(this._getRowCompletion(row));
    }

    _filter(row) {
        if (this._key.length === 0)
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

        if (this._startPos === 0)
            this._endPos = -1;

        // Chain completions if the current completion directly follows a previous one,
        // except when one of them was for an IRC command
        let previousCompletion = this._endPos === this._startPos;
        this._isChained = previousCompletion && !this._isCommand && !this._previousWasCommand;

        this._list.invalidate_filter();

        let visibleRows = [...this._list].filter(c => c.get_child_visible());
        let nVisibleRows = visibleRows.length;

        if (nVisibleRows === 0)
            return;

        if (this._isChained)
            this._setPreviousCompletionChained(true);
        this._insertCompletion(this._getRowCompletion(visibleRows[0]));
        if (visibleRows.length > 1) {
            this._list.select_row(visibleRows[0]);
            this._showPopup();
        }
    }

    _moveSelection(count) {
        const rows = [...this._list].filter(c => c.get_child_visible());
        const current = this._list.get_selected_row();
        const index = current ? rows.findIndex(r => r === current) : 0;
        const newIndex = (index + rows.length + count) % rows.length;
        const row = rows[newIndex];
        this._list.select_row(row);
    }

    _stop() {
        if (this._key.length === 0)
            return;

        this._popup.popdown();
        this._popup.set_size_request(-1, -1);

        this._key = '';

        this._list.invalidate_filter();
    }

    _cancel() {
        if (this._key.length === 0)
            return;
        if (this._isChained)
            this._setPreviousCompletionChained(false);
        this._insertCompletion('');
        this._stop();
    }
}
