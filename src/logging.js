import GLib from 'gi://GLib';

const LOG_DOMAIN = 'Polari';

function log(level, message) {
    const { stack } = new Error();
    let [, caller] = stack.split('\n');

    // Map from resource- to source location
    caller = caller.replace('resource:///org/gnome/Polari/js', 'src');

    const [code, line] = caller.split(':');
    const [func, file] = code.split(/\W*@/);
    GLib.log_structured(LOG_DOMAIN, level, {
        'MESSAGE': `${message}`,
        'SYSLOG_IDENTIFIER': 'org.gnome.Polari',
        'CODE_FILE': file,
        'CODE_FUNC': func,
        'CODE_LINE': line,
    });
}

/** initialize logging */
export function init() {
    const { LogLevelFlags } = GLib;
    globalThis.log      = msg => log(LogLevelFlags.LEVEL_MESSAGE, msg);
    globalThis.debug    = msg => log(LogLevelFlags.LEVEL_DEBUG, msg);
    globalThis.info     = msg => log(LogLevelFlags.LEVEL_INFO, msg);
    globalThis.warning  = msg => log(LogLevelFlags.LEVEL_WARNING, msg);
    globalThis.critical = msg => log(LogLevelFlags.LEVEL_CRITICAL, msg);
    globalThis.error    = msg => log(LogLevelFlags.LEVEL_ERROR, msg);

    // Log all messages when connected to the journal
    if (GLib.log_writer_is_journald(2))
        GLib.setenv('G_MESSAGES_DEBUG', LOG_DOMAIN, false);
}
