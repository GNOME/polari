// SPDX-FileCopyrightText: 2019 daronion <stefanosdimos.98@gmail.com>
// SPDX-FileCopyrightText: 2019 Florian Müllner <fmuellner@gnome.org>
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Cairo from 'cairo';
import Gdk from 'gi://Gdk?version=3.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=3.0';
import WebKit2 from 'gi://WebKit2?version=4.1';

import {setConsoleLogDomain} from 'console';
import {programArgs} from 'system';

Gio._promisify(WebKit2.WebView.prototype, 'get_snapshot', 'get_snapshot_finish');
Gio._promisify(WebKit2.WebView.prototype, 'run_javascript', 'run_javascript_finish');

const PREVIEW_WIDTH = 120;
const PREVIEW_HEIGHT = 90;
const FALLBACK_ICON_SIZE = 64;

let PreviewWindow = GObject.registerClass(
class PreviewWindow extends Gtk.Window {
    static [GObject.properties] = {
        'uri': GObject.ParamSpec.string(
            'uri', null, null,
            GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT_ONLY,
            null),
    };

    static [GObject.signals] = {
        'snapshot-ready': {},
        'snapshot-failed': {},
    };

    _snapshot = null;

    constructor(params) {
        super(params);

        let settings = new WebKit2.Settings({
            hardware_acceleration_policy: WebKit2.HardwareAccelerationPolicy.NEVER,
        });

        this._view = new WebKit2.WebView({
            is_ephemeral: true,
            visible: true,
            settings,
        });
        this.add(this._view);

        this._view.bind_property('title',
            this, 'title', GObject.BindingFlags.SYNC_CREATE);

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
        let getClipOp = this._getImageClip();
        let snapshotOp = this._view.get_snapshot(
            WebKit2.SnapshotRegion.VISIBLE,
            WebKit2.SnapshotOptions.NONE,
            null);
        let clip, snapshot;

        try {
            clip = await getClipOp;
            snapshot = await snapshotOp;
        } catch (e) {
            console.warn(`Failed to create snapshot of ${this.uri}`);
            console.debug(e);
            this.emit('snapshot-failed');
            return;
        }

        if (clip)
            this._snapshot = this._createClippedSurface(snapshot, clip);
        else
            this._snapshot = snapshot;

        this.emit('snapshot-ready');
    }

    async _getImageClip() {
        const script = `
            const img = document.images[0];
            document.contentType.startsWith('image')
                ? [img.x, img.y, img.width, img.height]
                : null;
        `;

        let obj = null;

        try {
            let res = await this._view.run_javascript(script, null);
            obj = res.get_js_value();
        } catch (e) {
            console.warn(`Failed to get clip information from ${this.uri}`);
            console.debug(e);
        }

        if (!obj || obj.is_null())
            return null;

        let [x, y, width, height] = obj.object_enumerate_properties()
            .map(p => obj.object_get_property(p).to_int32());

        if (width === 0 || height === 0)
            throw new Error('Invalid image clip');

        return {x, y, width, height};
    }

    _createClippedSurface(source, clip) {
        let {x, y, width, height} = clip;

        let surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, width, height);

        let cr = new Cairo.Context(surface);
        cr.setSourceSurface(source, -x, -y);
        cr.paint();
        cr.$dispose();

        return surface;
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

        const logDomain = 'Polari Thumbnailer';
        setConsoleLogDomain(logDomain);
        if (GLib.log_writer_is_journald(2))
            GLib.setenv('G_MESSAGES_DEBUG', logDomain, false);

        let window = new PreviewWindow({
            uri: this._uri,
            default_width: 10 * PREVIEW_WIDTH,
            default_height: 10 * PREVIEW_HEIGHT,
        });

        window.realize();
        window.connect('snapshot-ready', this._onSnapshotReady.bind(this));
        window.connect('snapshot-failed', this._onSnapshotFailed.bind(this));
        window.connect('destroy', () => Gtk.main_quit());

        Gtk.main();
    }

    _onSnapshotReady(window) {
        let surface = window.getSnapshot();
        let title = window.title || this._uri;
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
        cr.$dispose();

        let pixbuf = Gdk.pixbuf_get_from_surface(target,
            0, 0, targetWidth, targetHeight);
        pixbuf.savev(this._filename, 'png', ['tEXt::Title'], [title]);
    }

    _onSnapshotFailed(window) {
        const context = window.get_style_context();
        context.set_state(Gtk.StateFlags.BACKDROP);
        const color = context.get_color(context.get_state());
        window.destroy();

        const [type] = Gio.content_type_guess(this._uri, null);
        const icon = Gio.content_type_get_symbolic_icon(type);
        const theme = Gtk.IconTheme.get_default();
        const info = theme.lookup_by_gicon(icon, FALLBACK_ICON_SIZE, 0);
        const [pixbuf] = info.load_symbolic(color, null, null, null);
        pixbuf.savev(this._filename, 'png', [], []);
    }
}

let [url, filename] = programArgs;
let app = new App(url, filename);
app.run();
