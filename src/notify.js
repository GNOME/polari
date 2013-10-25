const Gio = imports.gi.Gio;

const Lang = imports.lang;
const Signals = imports.signals;

const NotificationDaemonIface = '<node> \
<interface name="org.freedesktop.Notifications"> \
    <method name="Notify"> \
      <arg type="s" direction="in"/> \
      <arg type="u" direction="in"/> \
      <arg type="s" direction="in"/> \
      <arg type="s" direction="in"/> \
      <arg type="s" direction="in"/> \
      <arg type="as" direction="in"/> \
      <arg type="a{sv}" direction="in"/> \
      <arg type="i" direction="in"/> \
      <arg type="u" direction="out"/> \
    </method> \
    <signal name="NotificationClosed"> \
      <arg type="u"/> \
      <arg type="u"/> \
    </signal> \
    <signal name="ActionInvoked"> \
      <arg type="u"/> \
      <arg type="s"/> \
    </signal> \
</interface> \
</node>';

const NotificationDaemon = Gio.DBusProxy.makeProxyWrapper(NotificationDaemonIface);

let _proxy = null;

const Notification = new Lang.Class({
    Name: 'Notification',

    _init: function(summary, body) {
        this._summary = summary;
        this._body = body;
        this._icon = 'polari';
        this._id = 0;

        this._actions = [];
        this._hints = {};

        if (_proxy == null)
            _proxy = new NotificationDaemon(Gio.DBus.session,
                                            'org.freedesktop.Notifications',
                                            '/org/freedesktop/Notifications');
        this._closedId = _proxy.connectSignal('NotificationClosed',
                                              Lang.bind(this, this._onClosed));
        this._actionInvokedId = _proxy.connectSignal('ActionInoked',
                                                     Lang.bind(this, this._onActionInvoked));
    },

    show: function() {
        _proxy.NotifyRemote('polari', this._id, this._icon, this._summary,
                            this._body, this._actions, this._hints, -1,
            Lang.bind(this, function(result, error) {
                if (error)
                    logError(error, 'Failed to send notification');
                else
                    this._id = result[0];
            }));
    },

    addAction: function(action, label) {
        this._actions.push(action, label);
    },

    setHint: function(key, value) {
        this._hints[key] = value;
    },

    _onClosed: function(proxy, sender, [id, reason]) {
        if (this._id != id)
            return;
        this.emit('closed');

        proxy.disconnectSignal(this._closedId);
        proxy.disconnectSignal(this._actionInvokedId);
    },

    _onActionInvoked: function(proxy, sender, [id, action]) {
        if (this._id != id)
            return;
        this.emit('action-invoked', action);
    }
});
Signals.addSignalMethods(Notification.prototype);
