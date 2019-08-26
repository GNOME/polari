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
        this._uri = null;
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

    get uri() {
        return this._uri;
    }

    set uri(uri) {
        if (this._uri === uri)
            return;

        this._uri = uri;
        this.notify('uri');
    }

    _onLoadingChanged(view, uri) {
        if (view.is_loading) {
            log(`Thumbnailer.js : ${uri} is loading`);
            return;
        }
        log(`Thumbnailer.js : ${uri} finished loading`);
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            log(`Thumbnailer.js : 1)creatingSnapshot for ${uri}`);
            this._createSnapshot();
            return GLib.SOURCE_REMOVE;
        });
    }

    _createSnapshot() {
        log(`Thumbnailer.js : 2)creatingSnapshot for ${this._uri}`);
        this._view.get_snapshot(
            WebKit2.SnapshotRegion.VISIBLE,
            WebKit2.SnapshotOptions.TRANSPARENT_BACKGROUND,
            null,
            (o, res) => {
                try {
                    log(`Thumbnailer.js : trying snapshot  for ${this._uri}`);
                    this._snapshot = this._view.get_snapshot_finish(res);
                } catch (e) {
                    log(`Getting snapshot failed: ${e.message}`);
                }
                log(`Thumbnailer.js : Emitted snapshot-ready for ${this._uri}`);
                this.emit('snapshot-ready');
            });
    }

    getSnapshot() {
        return this._snapshot;
    }
});

let DetectWindow = GObject.registerClass({
    Properties: {
        'uri': GObject.ParamSpec.string(
            'uri', 'uri', 'uri',
            GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT_ONLY,
            null),
    },
    Signals: {
        'detect-ready': {},
    },
}, class DetectWindow extends Gtk.Window {
    _init(params) {
        this._uri = null;
        this._contentType = null;

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

    get uri() {
        return this._uri;
    }

    set uri(uri) {
        if (this._uri === uri)
            return;

        this._uri = uri;
        this.notify('uri');
    }

    _onLoadingChanged(view) {
        if (view.is_loading)
            return;

        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            this._sniffContentType();
            return GLib.SOURCE_REMOVE;
        });
    }

    _sniffContentType() {
        this._view.run_javascript('document.contentType', null, (o, res) => {
            let contentType = '';
            try {
                let jsResult = this._view.run_javascript_finish(res);
                contentType = jsResult.get_js_value().to_string();
                log(`Thumbnailer.js : Sniffed content type ${contentType}`);
            } catch (e) {
                log(`Thumbnailer.js : Failed to sniff content type: ${e}`);
            }

            if (contentType.startsWith('image')) {
                log('Thumbnailer.js : Image content');
                this._contentType = 'image';
            } else {
                log('Thumbnailer.js : Other than image content.');
                this._contentType = 'other';
            }

            this.emit('detect-ready');
        });
    }

    getContentType() {
        return this._contentType;
    }
});

class App {
    constructor(url, filename) {
        this._uri = url;
        this._filename = filename;
    }

    run() {
        Gtk.init(null);

        let detectWindow = new DetectWindow({ uri: this._uri });
        detectWindow.connect('detect-ready', this._onContentTypeDetected.bind(this));
        detectWindow.realize();

        Gtk.main();
    }

    _onContentTypeDetected(detectWindow) {
        let contentType = detectWindow.getContentType();
        detectWindow.destroy();

        let window;
        log(`Thumbnailer.js : detected contentType for ${this._uri}, now snapshotting...`);
        if (contentType === 'image') {
            window = new PreviewWindow({
                uri: this._uri,
                default_width: PREVIEW_WIDTH,
                default_height: PREVIEW_HEIGHT,
            });
        } else {
            window = new PreviewWindow({
                uri: this._uri,
                default_width: 1200,
                default_height: 900,
            });
        }

        window.realize();
        window.connect('snapshot-ready', this._onSnapshotReady.bind(this));
        window.connect('destroy', () => Gtk.main_quit());
    }

    _onSnapshotReady(window) {
        let surface = window.getSnapshot();
        window.destroy();

        if (!surface) {
            log('Thumbnailer.js : No snapshot :-(');
            return;
        }

        let sourceWidth = surface.getWidth();
        let sourceHeight = surface.getHeight();

        let target;
        if (sourceWidth > PREVIEW_WIDTH || sourceHeight > PREVIEW_HEIGHT) {
            target = new Cairo.ImageSurface(Cairo.Format.ARGB32,
                PREVIEW_WIDTH,
                PREVIEW_HEIGHT);

            let cr = new Cairo.Context(target);
            cr.scale(
                PREVIEW_WIDTH / sourceWidth,
                PREVIEW_HEIGHT / sourceHeight);
            cr.setSourceSurface(surface, 0, 0);
            cr.paint();
        } else {
            target = surface;
        }

        target.writeToPNG(this._filename);
        log(`Thumbnailer.js : ${this._uri} image saved as ${this._filename}`);
    }
}

let [url, filename] = ARGV;
let app = new App(url, filename);
app.run();
