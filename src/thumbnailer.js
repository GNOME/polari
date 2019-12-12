imports.gi.versions.Gtk = '3.0';

const { Gio, GLib, GObject, Gtk, WebKit2 } = imports.gi;
const Cairo = imports.cairo;

Gio._promisify(WebKit2.WebView.prototype, 'get_snapshot', 'get_snapshot_finish');

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
        'snapshot-failed': {},
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

        this._view.connect('authenticate', (view, request) => {
            request.cancel();
            return true;
        });

        this._view.connect('notify::is-loading',
            this._onLoadingChanged.bind(this));
        this._view.connect('load-failed', () => this.emit('snapshot-failed'));
        this._view.load_uri(this.uri);

        GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 60, () => {
            this._view.stop_loading();
            return GLib.SOURCE_REMOVE;
        });
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

    async _createSnapshot() {
        let snapshotOp = this._view.get_snapshot(
            WebKit2.SnapshotRegion.VISIBLE,
            WebKit2.SnapshotOptions.NONE,
            null);

        try {
            this._snapshot = await snapshotOp;
        } catch (e) {
            log(`Creating snapshot failed: ${e}`);
            this.emit('snapshot-failed');
            return;
        }

        this.emit('snapshot-ready');
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
        window.connect('snapshot-failed', () => window.destroy());
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
        let ratio = sourceWidth / sourceHeight;

        let targetWidth, targetHeight;
        if (ratio >= PREVIEW_WIDTH / PREVIEW_HEIGHT) {
            targetWidth = Math.min(sourceWidth, PREVIEW_WIDTH);
            targetHeight = targetWidth / ratio;
        } else {
            targetHeight = Math.min(sourceHeight, PREVIEW_HEIGHT);
            targetWidth = targetHeight * ratio;
        }

        let target = new Cairo.ImageSurface(Cairo.Format.ARGB32,
            targetWidth,
            targetHeight);

        let cr = new Cairo.Context(target);
        cr.scale(
            targetWidth / sourceWidth,
            targetHeight / sourceHeight);
        cr.setSourceSurface(surface, 0, 0);
        cr.paint();

        target.writeToPNG(this._filename);
    }
}

let [url, filename] = ARGV;
let app = new App(url, filename);
app.run();
