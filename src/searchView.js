// SPDX-FileCopyrightText: 2023 Carlos Garnacho <carlosg@gnome.org>
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';
import Graphene from 'gi://Graphene';

import * as Utils from './utils.js';
import * as Logger from './logger.js';

const SearchRow = GObject.registerClass(
class SearchRow extends Gtk.ListBoxRow {
    static [Gtk.template] = 'resource:///org/gnome/Polari/ui/search-row.ui';
    static [Gtk.internalChildren] = [
        'date',
        'messages',
    ];

    constructor(ctx) {
        super();

        for (let i = 0; i < ctx.length; i++) {
            const message = ctx[i];
            let nick = new Gtk.Label({
                label: message.senderNick,
                halign: Gtk.Align.START,
                valign: Gtk.Align.START,
                xalign: 0,
                yalign: 0,
            });
            nick.add_css_class('caption-heading');
            this._messages.attach(nick, 0, i, 1, 1);

            let msg = new Gtk.Label({
                label: message.text,
                halign: Gtk.Align.START,
                valign: Gtk.Align.START,
                xalign: 0,
                yalign: 0,
                wrap: true,
            });
            msg.add_css_class('caption');
            this._messages.attach(msg, 1, i, 3, 1);

            if (!this._startTime)
                this._startTime = message.time;
            this._endTime = message.time;
        }

        this._date.label = Utils.formatDateTime(this._startTime);
    }

    get startTime() {
        return this._startTime;
    }

    get endTime() {
        return this._endTime;
    }
});

const SearchSection = GObject.registerClass(
class SearchSection extends Gtk.Box {
    static [Gtk.template] = 'resource:///org/gnome/Polari/ui/search-section.ui';
    static [Gtk.internalChildren] = [
        'list',
        'loadMore',
        'title',
    ];

    static [GObject.properties] = {
        search: GObject.ParamSpec.string(
            'search', null, null,
            GObject.ParamFlags.READWRITE,
            ''),
    };

    constructor(room, searchTerms) {
        super();
        this._logFinder = new Logger.LogFinder();
        this._cancellable = new Gio.Cancellable();
        this._room = room;
        this._title.label = room.display_name;

        this.connect('unmap', () => this._onUnmap());
        this._list.connect('row-activated', (list, row) => {
            if (this._loadMore === row) {
                this._fetchResults();
            } else {
                const toplevel = this.get_root();
                toplevel.showSearchInline(this._room, row.endTime.add_seconds(1));
            }
        });

        this.search = searchTerms;
    }

    _onUnmap() {
        this._cancellable?.cancel();
    }

    async _fetchResults() {
        try {
            this._cancellable = new Gio.Cancellable();

            const results = await this._logFinder.fetchResults(
                this._room, this._searchTerms, 3, this._offset, this._cancellable);

            if (results.length !== 3)
                this._loadMore.hide();

            for (const res of results) {
                const row = new SearchRow(res);
                this._list.insert(row, this._offset);
                this._offset++;
            }
        } catch (error) {
            if (!error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                logError(error);
        }
    }

    set search(search) {
        this._cancellable?.cancel();
        this._cancellable = new Gio.Cancellable();
        this._offset = 0;

        this._list.remove_all();

        this._searchTerms = search;
        this._fetchResults();
        this.notify('search');
    }

    get search() {
        return this._searchTerms;
    }
});

export default GObject.registerClass(
class SearchView extends Gtk.ScrolledWindow {
    static [GObject.properties] = {
        search: GObject.ParamSpec.string(
            'search', 'search', 'search',
            GObject.ParamFlags.READWRITE,
            ''),
    };

    constructor() {
        super({hscrollbar_policy: Gtk.PolicyType.NEVER, vexpand: true});
        this._sections = new Map();
        this._box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL});
        this.set_child(this._box);
    }

    vfunc_realize() {
        super.vfunc_realize();

        const toplevel = this.get_root();
        this._activeRoomId = toplevel.connect(
            'notify::active-room', () => this._scrollTo(toplevel.active_room));
    }

    vfunc_unrealize() {
        super.vfunc_unrealize();

        const toplevel = this.get_root();
        toplevel.disconnect(this._activeRoomId);
    }

    set search(search) {
        this._searchTerms = search;
        this.notify('search');
    }

    get search() {
        return this._searchTerms;
    }

    set rooms(rooms) {
        for (const [roomId, {widget, binding}] of this._sections) {
            if (!rooms.find(r => r.id === roomId)) {
                binding.unbind();
                widget.unparent();
                this._sections.delete(roomId);
            }
        }

        for (const room of rooms) {
            if (!this._sections.has(room.id)) {
                const widget = new SearchSection(room, this._searchTerms);
                const binding = this.bind_property(
                    'search', widget, 'search',
                    GObject.BindingFlags.SYNC_CREATE);
                this._box.append(widget);
                this._sections.set(room.id, {widget, binding});
            }
        }
    }

    _scrollTo(room) {
        const {widget} = this._sections.get(room.id);
        if (!widget)
            return;

        const [, point] = widget.compute_point(
            this._box, new Graphene.Point({x: 0, y: 0}));
        const adj = this.get_vadjustment();
        adj.value = point.y;
    }

    cancel() {
        for (const [id, {widget, binding}] of this._sections) {
            binding.unbind();
            widget.unparent();
            this._sections.delete(id);
        }
    }
});
