// SPDX-FileCopyrightText: 2013 Florian Müllner <fmuellner@gnome.org>
//
// SPDX-License-Identifier: GPL-2.0-or-later

import GLib from 'gi://GLib';

import * as Config from './config.js';
import Polari from 'gi://Polari';
import {ngettext} from 'gettext';
import {programInvocationName, programArgs} from 'system';

imports.package.init({
    name: Config.PACKAGE_NAME,
    version: Config.PACKAGE_VERSION,
    prefix: Config.PREFIX,
    libdir: Config.LIBDIR,
});

pkg.initGettext();
globalThis.ngettext = ngettext;

globalThis.vprintf = (fmt, ...args) => imports.format.vprintf(fmt, args);

pkg.require({
    'GdkPixbuf': '2.0',
    'GObject': '2.0',
    'Gtk': '4.0',
    'Pango': '1.0',
    'PangoCairo': '1.0',
    'Secret': '1',
    'TelepathyGLib': '0.12',
    'Tracker': '3.0',
});
pkg.requireSymbol('Adw', '1', 'ShortcutsDialog');
pkg.checkSymbol('Soup', '3.0');

import Application from './application.js';

let application = new Application();
if (GLib.getenv('POLARI_PERSIST'))
    application.hold();
application.run([programInvocationName, ...programArgs]);
Polari.util_close_tracker_connection();
