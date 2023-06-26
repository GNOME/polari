// SPDX-FileCopyrightText: 2013 Florian Müllner <fmuellner@gnome.org>
// SPDX-FileCopyrightText: 2016 Kunaal Jain <kunaalus@gmail.com>
// SPDX-FileCopyrightText: 2016 Isabella Ribeiro <belinhacbr@gmail.com>
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import AccountsMonitor from './accountsMonitor.js';

const DialogPage = {
    MAIN: 0,
    CONNECTION: 1,
};

export default GObject.registerClass(
class JoinDialog extends Gtk.Window {
    static [Gtk.template] = 'resource:///org/gnome/Polari/ui/join-room-dialog.ui';
    static [Gtk.internalChildren] = [
        'cancelButton',
        'joinButton',
        'mainStack',
        'connectionCombo',
        'connectionButton',
        'connectionStack',
        'filterEntry',
        'connectionsList',
        'serverRoomList',
        'details',
        'addButton',
        'customToggle',
        'backButton',
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
                this._updateConnectionCombo();
            });
        this._accountRemovedId =
            this._accountsMonitor.connect('account-removed', (am, account) => {
                this._accounts.delete(account.display_name);
                this._updateConnectionCombo();
            });

        this._joinButton.connect('clicked',
            () => this._joinRoom());

        this.connect('destroy', () => {
            this._accountsMonitor.disconnect(this._accountAddedId);
            this._accountsMonitor.disconnect(this._accountRemovedId);
        });

        if (this._hasAccounts)
            this._setPage(DialogPage.MAIN);
        else
            this._setPage(DialogPage.CONNECTION);

        this._updateConnectionCombo();
        this._updateCanJoin();
    }

    get _hasAccounts() {
        return this._accounts.size > 0;
    }

    _setupMainPage() {
        this._connectionButton.connect('clicked', () => {
            this._setPage(DialogPage.CONNECTION);
        });

        this._connectionCombo.connect('changed',
            this._onAccountChanged.bind(this));
        this._connectionCombo.sensitive = false;

        this._serverRoomList.connect('notify::can-join',
            this._updateCanJoin.bind(this));
    }

    _setupConnectionPage() {
        this._backButton.connect('clicked', () => {
            this._setPage(DialogPage.MAIN);
        });
        this._connectionsList.connect('account-selected', () => {
            this._setPage(DialogPage.MAIN);
        });
        this._addButton.connect('clicked', () => {
            this._details.save();
            this._setPage(DialogPage.MAIN);
        });

        this._connectionsList.connect('account-created',
            this._onAccountCreated.bind(this));
        this._details.connect('account-created',
            this._onAccountCreated.bind(this));

        this._customToggle.connect('notify::active', () => {
            let isCustom = this._customToggle.active;
            let childName = isCustom ? 'custom' : 'predefined';
            this._connectionStack.visible_child_name = childName;
            if (isCustom) {
                this.set_default_widget(this._addButton);
                this._details.reset();
            }
        });

        this._filterEntry.connect('search-changed', () => {
            this._connectionsList.setFilter(this._filterEntry.text);
        });
        this._filterEntry.connect('stop-search', () => {
            if (this._filterEntry.text.length > 0)
                this._filterEntry.text = '';
            else
                this.destroy();
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

        this.destroy();
    }

    _updateConnectionCombo() {
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
    }

    _updateCanJoin() {
        let sensitive = false;

        if (this._page === DialogPage.MAIN) {
            sensitive = this._connectionCombo.get_active() > -1  &&
                        this._serverRoomList.can_join;
        }

        this._joinButton.sensitive = sensitive;
    }

    get _page() {
        if (this._mainStack.visible_child_name === 'connection')
            return DialogPage.CONNECTION;
        else
            return DialogPage.MAIN;
    }

    _setPage(page) {
        let isMain = page === DialogPage.MAIN;
        let isAccountsEmpty = !this._hasAccounts;

        if (isMain)
            this._serverRoomList.focusEntry();
        else
            this._customToggle.active = false;

        this._joinButton.visible = isMain;
        this._cancelButton.visible = isMain || isAccountsEmpty;
        this._backButton.visible = !(isMain || isAccountsEmpty);
        this.title = isMain ? _('Join Chat Room') : _('Add Network');
        this._mainStack.visible_child_name = isMain ? 'main' : 'connection';
        this._updateCanJoin();
    }
});
