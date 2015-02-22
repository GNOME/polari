pkg.initFormat();
pkg.initGettext();
window.ngettext = imports.gettext.ngettext;

const Application = imports.application;
const GLib = imports.gi.GLib;

function main(args) {
    let application = new Application.Application();
    if (GLib.getenv('POLARI_PERSIST'))
        application.hold();
    return application.run(args);
}
