import GLib from 'gi://GLib';

import * as Config from './config.js';
import * as Log from './logging.js';
import { ngettext } from 'gettext';
import { programInvocationName, programArgs } from 'system';

imports.package.init({
    name: Config.PACKAGE_NAME,
    version: Config.PACKAGE_VERSION,
    prefix: Config.PREFIX,
    libdir: Config.LIBDIR,
});

pkg.initFormat();
pkg.initGettext();
globalThis.ngettext = ngettext;

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

Log.init();

import { Application } from './application.js';

let application = new Application();
if (GLib.getenv('POLARI_PERSIST'))
    application.hold();
application.run([programInvocationName, ...programArgs]);
