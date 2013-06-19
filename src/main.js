const Application = imports.application;
const GLib = imports.gi.GLib;

function start() {
    let application = new Application.Application();
    if (GLib.getenv('POLARI_PERSIST'))
        application.hold();
    return application.run(ARGV);
}
