pkg.initFormat();
pkg.initGettext();
window.ngettext = imports.gettext.ngettext;

pkg.require({ 'Gio': '2.0',
              'GLib': '2.0',
              'Gtk': '3.0',
              'TelepathyGLib': '0.12' });

const Application = imports.application;
const GLib = imports.gi.GLib;

window.debug = imports.utils.debug;

function main(args) {
    let application = new Application.Application();
    if (GLib.getenv('POLARI_PERSIST'))
        application.hold();
    return application.run(args);
}
