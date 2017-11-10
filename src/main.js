pkg.initFormat();
pkg.initGettext();
window.ngettext = imports.gettext.ngettext;

pkg.require({ 'GdkPixbuf': '2.0',
              'GObject': '2.0',
              'Pango': '1.0',
              'PangoCairo': '1.0',
              'Secret': '1',
              'Soup': '2.4',
              'TelepathyGLib': '0.12',
              'TelepathyLogger': '0.2' });
pkg.requireSymbol('Gio', '2.0', 'Application.send_notification');
pkg.requireSymbol('GLib', '2.0', 'log_variant');
pkg.requireSymbol('Gspell', '1', 'Entry');
pkg.requireSymbol('Gtk', '3.0', 'ScrolledWindow.propagate_natural_width');

const GLib = imports.gi.GLib;

const {Application} = imports.application;

var LOG_DOMAIN = 'Polari';

function _makeLogFunction(level) {
    return message => {
        let stack = (new Error()).stack;
        let caller = stack.split('\n')[1];

        let [, func, file, line] = new RegExp('(.+)?@(.+):(\\d+)').exec(caller);
        GLib.log_variant(LOG_DOMAIN, level, new GLib.Variant('a{sv}', {
            'MESSAGE': new GLib.Variant('s', message),
            'SYSLOG_IDENTIFIER': new GLib.Variant('s', 'org.gnome.Polari'),
            'CODE_FILE': new GLib.Variant('s', file),
            'CODE_FUNC': new GLib.Variant('s', func),
            'CODE_LINE': new GLib.Variant('s', line)
        }));
    };
}

window.log      = _makeLogFunction(GLib.LogLevelFlags.LEVEL_MESSAGE);
window.debug    = _makeLogFunction(GLib.LogLevelFlags.LEVEL_DEBUG);
window.info     = _makeLogFunction(GLib.LogLevelFlags.LEVEL_INFO);
window.warning  = _makeLogFunction(GLib.LogLevelFlags.LEVEL_WARNING);
window.critical = _makeLogFunction(GLib.LogLevelFlags.LEVEL_CRITICAL);
window.error    = _makeLogFunction(GLib.LogLevelFlags.LEVEL_ERROR);

function main(args) {
    // Log all messages when connected to the journal
    if (GLib.log_writer_is_journald(2))
        GLib.setenv('G_MESSAGES_DEBUG', LOG_DOMAIN, false);

    let application = new Application();
    if (GLib.getenv('POLARI_PERSIST'))
        application.hold();
    return application.run(args);
}
