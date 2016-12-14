const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Gtk = imports.gi.Gtk;

const Lang = imports.lang;
const Utils = imports.utils;

const SetupPage = {
    CONNECTION: 0,
    ROOM: 1
};

var InitialSetupWindow = new Lang.Class({
    Name: 'InitialSetupWindow',
    Extends: Gtk.Window,
    Template: 'resource:///org/gnome/Polari/ui/initial-setup-window.ui',
    InternalChildren: ['contentStack',
                       'connectionsList',
                       'nextButton',
                       'prevButton',
                       'serverRoomList'],

    _init: function(params) {

        this.parent(params);

        this._currentAccount = null;

        this._connectionsList.connect('account-created', (w, account) => {
            this._setPage(SetupPage.ROOM);
            this._currentAccount = account;
            this._serverRoomList.setAccount(account);
        });

        this.connect('destroy', () => { this._unsetAccount(); });

        this._serverRoomList.connect('notify::can-join',
                                     Lang.bind(this, this._updateNextSensitivity));

        this._nextButton.connect('clicked', () => {
            if (this._page == SetupPage.CONNECTION) {
                this._connectionsList.activateSelected();
            } else {
                this._joinRooms();
                this._currentAccount = null;
                this.destroy();
            }
        });

        this._prevButton.connect('clicked', () => {
            if (this._page == SetupPage.ROOM) {
                this._setPage(SetupPage.CONNECTION);
                this._unsetAccount();
            } else {
                this.destroy();
            }
        });

        this._setPage(SetupPage.CONNECTION);
    },

    _setPage: function(page) {
        let isLastPage = page == SetupPage.ROOM;

        this._contentStack.visible_child_name = isLastPage ? 'rooms'
                                                           : 'connections';

        this._prevButton.label = isLastPage ? _("_Back") : _("_Cancel");
        this._nextButton.label = isLastPage ? _("_Done") : _("_Next");

        let context = this._nextButton.get_style_context();
        if (isLastPage)
            context.add_class(Gtk.STYLE_CLASS_SUGGESTED_ACTION);
        else
            context.remove_class(Gtk.STYLE_CLASS_SUGGESTED_ACTION);

        this._nextButton.grab_default();
        this._updateNextSensitivity();
    },

    _unsetAccount: function() {
        if (!this._currentAccount)
            return;

        this._currentAccount.remove_async((a, res) => {
            a.remove_finish(res);
        });
        this._currentAccount = null;
    },

    get _page() {
        if (this._contentStack.visible_child_name == 'rooms')
            return SetupPage.ROOM;
        else
            return SetupPage.CONNECTION;
    },

    _updateNextSensitivity: function() {
        let sensitive = true;

        if (this._page == SetupPage.ROOM)
            sensitive = this._serverRoomList.can_join;

        this._nextButton.sensitive = sensitive;
    },

    _joinRooms: function() {
        this.hide();

        let toJoinRooms = this._serverRoomList.selectedRooms;

        let accountPath = this._currentAccount.get_object_path();
        let time = Utils.getTpEventTime();
        toJoinRooms.forEach(room => {
            if (room[0] != '#')
                room = '#' + room;

            let app = Gio.Application.get_default();
            let action = app.lookup_action('join-room');
            action.activate(GLib.Variant.new('(ssu)', [accountPath, room, time]));
        });
    }
});
