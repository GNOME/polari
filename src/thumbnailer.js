imports.gi.versions.Gtk = '3.0';

const { GLib, GObject, Gtk, WebKit2 } = imports.gi;
const Cairo = imports.cairo;

const PREVIEW_WIDTH = 120;
const PREVIEW_HEIGHT = 90;

let PreviewWindow = GObject.registerClass({
    Properties: {
        'uri': GObject.ParamSpec.string(
            'uri', 'uri', 'uri',
            GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT_ONLY,
            null),
    },
    Signals: {
        'snapshot-ready': {},
    },
}, class PreviewWindow extends Gtk.Window {
    _init(params) {
        this._snapshot = null;

        super._init(params);

        this._view = new WebKit2.WebView({
            is_ephemeral: true,
            visible: true,
        });
        this.add(this._view);

        this._view.connect('notify::is-loading',
            this._onLoadingChanged.bind(this));
        this._view.load_uri(this.uri);
    }

    _onLoadingChanged() {
        if (this._view.is_loading)
            return;

        /* Hopefully wait long enough for a meaningful snapshot,
           see https://bugs.webkit.org/show_bug.cgi?id=164180 */
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
            this._createSnapshot();
            return GLib.SOURCE_REMOVE;
        });
    }

    _createSnapshot() {
        this._view.get_snapshot(
            WebKit2.SnapshotRegion.VISIBLE,
            WebKit2.SnapshotOptions.TRANSPARENT_BACKGROUND,
            null,
            (o, res) => {
                try {
                    this._snapshot = this._view.get_snapshot_finish(res);
                } catch (e) {
                    log(`Creating snapshot failed: ${e}`);
                }
                this.emit('snapshot-ready');
            });
    }

    getSnapshot() {
        return this._snapshot;
    }
});

class App {
    constructor(url, filename) {
        this._uri = url;
        this._filename = filename;
    }

    run() {
        Gtk.init(null);

        let window = new PreviewWindow({
            uri: this._uri,
            default_width: 10 * PREVIEW_WIDTH,
            default_height: 10 * PREVIEW_HEIGHT,
        });

        window.realize();
        window.connect('snapshot-ready', this._onSnapshotReady.bind(this));
        window.connect('destroy', () => Gtk.main_quit());

        Gtk.main();
    }

    _onSnapshotReady(window) {
        let surface = window.getSnapshot();
        window.destroy();

        if (!surface)
            return;

        let sourceWidth = surface.getWidth();
        let sourceHeight = surface.getHeight();

        let target = new Cairo.ImageSurface(Cairo.Format.ARGB32,
            PREVIEW_WIDTH,
            PREVIEW_HEIGHT);

        let cr = new Cairo.Context(target);
        cr.scale(
            PREVIEW_WIDTH / sourceWidth,
            PREVIEW_HEIGHT / sourceHeight);
        cr.setSourceSurface(surface, 0, 0);
        cr.paint();

        target.writeToPNG(this._filename);
    }
}

let [url, filename] = ARGV;
let app = new App(url, filename);
app.run();
