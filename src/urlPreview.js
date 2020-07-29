/* exported URLPreview */
const { Gio, GLib, GObject, Gtk, Pango } = imports.gi;

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

    getThumbnail(uri) {
        return new Promise((resolve, reject) => {
            const filename = this._generateFilename(uri);
            const data = { uri, filename, resolve, reject };

            this._processData(data);
        });
    }

    async _processData(data) {
        if (await this._thumbExists(data))
            this._generationDone(data);
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

    async _generateThumbnail(data) {
        let { filename, uri } = data;
        this._subProc = Gio.Subprocess.new(
            ['gjs', `${pkg.pkgdatadir}/thumbnailer.js`, uri, filename],
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
        } catch (e) {
            return false;
        }
    }

    _generateFilename(url) {
        let checksum = GLib.Checksum.new(GLib.ChecksumType.MD5);
        checksum.update(url);

        return `${this._thumbnailsDir}${checksum.get_string()}.png`;
    }
}

var URLPreview = GObject.registerClass({
    Properties: {
        'uri': GObject.ParamSpec.string(
            'uri', 'uri', 'uri',
            GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT_ONLY,
            null),
    },
}, class URLPreview extends Gtk.Box {
    _init(params) {
        super._init(params);

        this.set({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 6,
        });

        let styleContext = this.get_style_context();
        styleContext.add_class('url-preview');
        styleContext.add_class(Gtk.STYLE_CLASS_BACKGROUND);

        this._imageLoaded = false;
        this._image = new Gtk.Image({
            visible: true,
        });
        this._image.get_style_context().add_class('dim-label');
        this.add(this._image);

        this._label = new Gtk.Label({
            halign: Gtk.Align.START,
            ellipsize: Pango.EllipsizeMode.END,
            visible: true,
        });
        this._label.get_style_context().add_class(Gtk.STYLE_CLASS_DIM_LABEL);
        this.add(this._label);
    }

    async _maybeLoadImage() {
        if (this._imageLoaded)
            return;

        this._imageLoaded = true;
        this._image.set({
            icon_name: 'image-loading-symbolic',
            pixel_size: 16,
        });
        const thumbnailer = Thumbnailer.getDefault();

        try {
            const filename = await thumbnailer.getThumbnail(this.uri);
            this._image.set_from_file(filename);
        } catch (e) {
            log(`Thumbnail generation for ${this.uri} failed: ${e}`);
            this._image.set({
                icon_name: 'image-x-generic-symbolic',
                pixel_size: 64,
            });
        }

        let title = null;
        if (this._image.pixbuf)
            title = this._image.pixbuf.get_option('tEXt::Title');

        if (title) {
            this._label.set_label(title);
            this.tooltip_text = title;
        }
    }

    vfunc_map() {
        this._maybeLoadImage();
        super.vfunc_map();
    }
});
