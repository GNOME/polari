// SPDX-FileCopyrightText: 2019 daronion <stefanosdimos.98@gmail.com>
// SPDX-FileCopyrightText: 2019 Florian Müllner <fmuellner@gnome.org>
// SPDX-FileCopyrightText: 2020 Philip Withnall <withnall@endlessm.com>
//
// SPDX-License-Identifier: GPL-2.0-or-later

import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';
import Pango from 'gi://Pango';

Gio._promisify(Gio._LocalFilePrototype, 'query_info_async', 'query_info_finish');
Gio._promisify(Gio.Subprocess.prototype, 'wait_async', 'wait_finish');

class Thumbnailer {
    static getDefault() {
        if (!this._singleton)
            this._singleton = new Thumbnailer();
        return this._singleton;
    }

    constructor() {
        this._urlQueue = [];
        this._subProc = null;
        this._thumbnailsDir = `${GLib.get_user_cache_dir()}/polari/thumbnails/`;

        GLib.mkdir_with_parents(this._thumbnailsDir, 0o755);
    }

    get _hasNetwork() {
        const monitor = Gio.NetworkMonitor.get_default();
        return monitor.state_valid && monitor.network_available && !monitor.network_metered;
    }

    getThumbnail(uri) {
        return new Promise((resolve, reject) => {
            const filename = this._generateFilename(uri);
            const data = {uri, filename, resolve, reject};

            this._processData(data);
        });
    }

    async _processData(data) {
        if (await this._thumbExists(data))
            this._generationDone(data);
        else if (!this._hasNetwork)
            this._generationUnavailable(data);
        else if (!this._subProc)
            this._generateThumbnail(data);
        else
            this._urlQueue.push(data);
    }

    _generationDone(data, error = null) {
        if (error)
            data.reject(error);
        else
            data.resolve(data.filename);

        let nextData = this._urlQueue.shift();
        if (nextData)
            this._processData(nextData);
    }

    _generationUnavailable(data) {
        this._generationDone(data, new Gio.IOErrorEnum({
            code: Gio.IOErrorEnum.NETWORK_UNREACHABLE,
            message: 'Network unreachable',
        }));
    }

    async _generateThumbnail(data) {
        let {filename, uri} = data;
        this._subProc = Gio.Subprocess.new(
            ['gjs', '--module', `${pkg.pkgdatadir}/thumbnailer.js`, uri, filename],
            Gio.SubprocessFlags.NONE);
        try {
            await this._subProc.wait_async(null);
            this._generationDone(data);
        } catch (e) {
            this._generationDone(data, e);
        }
        this._subProc = null;
    }

    async _thumbExists(data) {
        const file = Gio.File.new_for_path(`${data.filename}`);
        try {
            await file.query_info_async(Gio.FILE_ATTRIBUTE_STANDARD_TYPE,
                Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, null);
            return true;
        } catch {
            return false;
        }
    }

    _generateFilename(url) {
        let checksum = GLib.Checksum.new(GLib.ChecksumType.MD5);
        checksum.update(url);

        return `${this._thumbnailsDir}${checksum.get_string()}.png`;
    }
}

export default GObject.registerClass(
class URLPreview extends Gtk.Box {
    static [GObject.properties] = {
        'uri': GObject.ParamSpec.string(
            'uri', null, null,
            GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT_ONLY,
            null),
    };

    constructor(params) {
        super(params);

        this.set({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 6,
        });

        this.add_css_class('url-preview');
        this.add_css_class('background');

        this._imageLoaded = false;
        this._image = new Gtk.Image();
        this._image.add_css_class('dim-label');
        this.append(this._image);

        this._label = new Gtk.Label({
            halign: Gtk.Align.START,
            ellipsize: Pango.EllipsizeMode.END,
        });
        this._label.add_css_class('dim-label');
        this.append(this._label);

        this._networkMonitor = Gio.NetworkMonitor.get_default();
        this._networkChangedId = this._networkMonitor.connect('network-changed',
            this._maybeLoadImage.bind(this));

        this.connect('destroy', this._onDestroy.bind(this));
    }

    _onDestroy() {
        if (this._networkChangedId)
            this._networkMonitor.disconnect(this._networkChangedId);
        this._networkChangedId = 0;
    }

    async _maybeLoadImage() {
        if (this._imageLoaded || !this.get_mapped())
            return;

        this._imageLoaded = true;
        this._image.set({
            icon_name: 'image-loading-symbolic',
            pixel_size: 16,
        });
        const thumbnailer = Thumbnailer.getDefault();

        let title;
        try {
            const filename = await thumbnailer.getThumbnail(this.uri);
            const pixbuf = GdkPixbuf.Pixbuf.new_from_file(filename);

            title = pixbuf.get_option('tEXt::Title');
            this._image.set_from_pixbuf(pixbuf);
            this._image.remove_css_class('dim-label');
        } catch (e) {
            if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NETWORK_UNREACHABLE)) {
                this._imageLoaded = false;
            } else {
                console.info(`Failed to generate thumbnail for ${this.uri}`);
                console.debug(e);
            }
            this._image.set({
                icon_name: 'image-x-generic-symbolic',
                pixel_size: 64,
            });
        }

        if (title) {
            this._label.set_label(title);
            this.tooltip_text = title;
        }
    }

    vfunc_map() {
        super.vfunc_map();
        this._maybeLoadImage();
    }
});
