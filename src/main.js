/* exported main */

pkg.initFormat();
pkg.initGettext();
globalThis.ngettext = imports.gettext.ngettext;

pkg.require({
    'GdkPixbuf': '2.0',
    'GObject': '2.0',
    'Pango': '1.0',
    'PangoCairo': '1.0',
    'Secret': '1',
    'Soup': '2.4',
    'TelepathyGLib': '0.12',
    'TelepathyLogger': '0.2',
});
pkg.requireSymbol('Gio', '2.0', 'Application.send_notification');
pkg.requireSymbol('GLib', '2.0', 'log_variant');
pkg.requireSymbol('Gspell', '1', 'Entry');
pkg.requireSymbol('Gtk', '3.0', 'ScrolledWindow.propagate_natural_width');

const { GLib } = imports.gi;

const { Application } = imports.application;

var LOG_DOMAIN = 'Polari';

function _makeLogFunction(level) {
    return message => {
        let { stack } = new Error();
        let [, caller] = stack.split('\n');

        // Map from resource- to source location
        caller = caller.replace('resource:///org/gnome/Polari/js', 'src');

        let [code, line] = caller.split(':');
        let [func, file] = code.split(/\W*@/);
        GLib.log_structured(LOG_DOMAIN, level, {
            'MESSAGE': `${message}`,
            'SYSLOG_IDENTIFIER': 'org.gnome.Polari',
            'CODE_FILE': file,
            'CODE_FUNC': func,
            'CODE_LINE': line,
        });
    };
}

globalThis.log      = _makeLogFunction(GLib.LogLevelFlags.LEVEL_MESSAGE);
globalThis.debug    = _makeLogFunction(GLib.LogLevelFlags.LEVEL_DEBUG);
globalThis.info     = _makeLogFunction(GLib.LogLevelFlags.LEVEL_INFO);
globalThis.warning  = _makeLogFunction(GLib.LogLevelFlags.LEVEL_WARNING);
globalThis.critical = _makeLogFunction(GLib.LogLevelFlags.LEVEL_CRITICAL);
globalThis.error    = _makeLogFunction(GLib.LogLevelFlags.LEVEL_ERROR);

function main(args) {
    // Log all messages when connected to the journal
    if (GLib.log_writer_is_journald(2))
        GLib.setenv('G_MESSAGES_DEBUG', LOG_DOMAIN, false);

    let application = new Application();
    if (GLib.getenv('POLARI_PERSIST'))
        application.hold();
    return application.run(args);
}
