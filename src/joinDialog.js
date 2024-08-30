// SPDX-FileCopyrightText: 2013 Florian Müllner <fmuellner@gnome.org>
// SPDX-FileCopyrightText: 2016 Kunaal Jain <kunaalus@gmail.com>
// SPDX-FileCopyrightText: 2016 Isabella Ribeiro <belinhacbr@gmail.com>
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import AccountsMonitor from './accountsMonitor.js';

export default GObject.registerClass(
class JoinDialog extends Adw.Dialog {
    static [Gtk.template] = 'resource:///org/gnome/Polari/ui/join-room-dialog.ui';
    static [Gtk.internalChildren] = [
        'joinButton',
        'navView',
        'mainPage',
        'connectionPage',
        'customPage',
        'connectionCombo',
        'filterEntry',
        'connectionsList',
        'serverRoomList',
        'details',
        'addButton',
    ];

    constructor(params) {
        super(params);

        this._setupMainPage();
        this._setupConnectionPage();

        this._accountsMonitor = AccountsMonitor.getDefault();

        this._accounts = new Map();
        this._accountsMonitor.visibleAccounts.forEach(a => {
            this._accounts.set(a.display_name, a);
        });
        this._accountAddedId =
            this._accountsMonitor.connect('account-added', (am, account) => {
                this._accounts.set(account.display_name, account);
                this._onAccountsChanged();
            });
        this._accountRemovedId =
            this._accountsMonitor.connect('account-removed', (am, account) => {
                this._accounts.delete(account.display_name);
                this._onAccountsChanged();
            });

        this._joinButton.connect('clicked',
            () => this._joinRoom());

        this.connect('destroy', () => {
            this._accountsMonitor.disconnect(this._accountAddedId);
            this._accountsMonitor.disconnect(this._accountRemovedId);
        });

        if (!this._hasAccounts)
            this._navView.push(this._connectionPage);

        this._navView.connect('notify::visible-page',
            () => this._onPageChanged());

        this._onAccountsChanged();
        this._onPageChanged();

        const app = Gio.Application.get_default();
        const action = app.lookup_action('show-join-dialog');

        // disable while showing
        this.connect('map',
            () => (action.enabled = false));
        this.connect('unmap',
            () => (action.enabled = true));
    }

    get _hasAccounts() {
        return this._accounts.size > 0;
    }

    _setupMainPage() {
        this._connectionCombo.connect('changed',
            this._onAccountChanged.bind(this));
        this._connectionCombo.sensitive = false;

        this._serverRoomList.connect('notify::can-join',
            this._updateCanJoin.bind(this));
    }

    _setupConnectionPage() {
        this._connectionsList.connect('account-selected', () => {
            this._navView.pop_to_page(this._mainPage);
        });
        this._addButton.connect('clicked', () => {
            this._details.save();
            this._navView.pop_to_page(this._mainPage);
        });

        this._connectionsList.connect('account-created',
            this._onAccountCreated.bind(this));
        this._details.connect('account-created',
            this._onAccountCreated.bind(this));

        this._filterEntry.connect('search-changed', () => {
            this._connectionsList.setFilter(this._filterEntry.text);
        });
        this._filterEntry.connect('stop-search', () => {
            if (this._filterEntry.text.length > 0)
                this._filterEntry.text = '';
            else
                this._navView.pop();
        });
        this._filterEntry.connect('activate', () => {
            if (this._filterEntry.text.length > 0)
                this._connectionsList.activateSelected();
        });
    }

    _onAccountChanged() {
        let selected = this._connectionCombo.get_active_text();
        let account = this._accounts.get(selected);
        if (!account)
            return;

        this._serverRoomList.setAccount(account);
    }

    _onAccountCreated(w, account) {
        this._connectionCombo.set_active_id(account.display_name);
    }

    _joinRoom() {
        this.hide();

        let selected = this._connectionCombo.get_active_text();
        let account = this._accounts.get(selected);

        let toJoinRooms = this._serverRoomList.selectedRooms;
        toJoinRooms.forEach(room => {
            if (room[0] !== '#')
                room = `#${room}`;

            let app = Gio.Application.get_default();
            let action = app.lookup_action('join-room');
            action.activate(GLib.Variant.new('(ssb)', [
                account.get_object_path(),
                room,
                true,
            ]));
        });

        this.close();
    }

    _onAccountsChanged() {
        this._connectionCombo.remove_all();

        let names = [...this._accounts.keys()].sort((a, b) => {
            return a.localeCompare(b);
        });
        for (let i = 0; i < names.length; i++)
            this._connectionCombo.append(names[i], names[i]);
        this._connectionCombo.sensitive = names.length > 1;

        let activeRoom = this.transient_for
            ? this.transient_for.active_room : null;
        let activeIndex = 0;
        if (activeRoom)
            activeIndex = Math.max(names.indexOf(activeRoom.account.display_name), 0);
        this._connectionCombo.set_active(activeIndex);

        this._connectionPage.set_can_pop(this._hasAccounts);
    }

    _updateCanJoin() {
        let sensitive = false;

        if (this._navView.visible_page === this._mainPage) {
            sensitive = this._connectionCombo.get_active() > -1  &&
                        this._serverRoomList.can_join;
        }

        this._joinButton.sensitive = sensitive;
    }

    _onPageChanged() {
        if (this._navView.visible_page === this._mainPage) {
            this._serverRoomList.focusEntry();
        } else if (this._navView.visible_page === this._customPage) {
            this.set_default_widget(this._addButton);
            this._details.reset();
        }
        this._updateCanJoin();
    }
});
