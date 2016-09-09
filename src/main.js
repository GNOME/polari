pkg.initFormat();
pkg.initGettext();
window.ngettext = imports.gettext.ngettext;

pkg.require({ 'Gio': '2.0',
              'GLib': '2.0',
              'Gtk': '3.0',
              'TelepathyGLib': '0.12' });

const Application = imports.application;
const GLib = imports.gi.GLib;

const LOG_DOMAIN = 'Polari';

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

    let application = new Application.Application();
    if (GLib.getenv('POLARI_PERSIST'))
        application.hold();
    return application.run(args);
}
