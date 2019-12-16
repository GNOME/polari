/* exported URLPreview */
const { Gio, GLib, GObject, Gtk, Pango } = imports.gi;

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

    getThumbnail(uri, callback) {
        let filename = this._generateFilename(uri);
        let data = { uri, filename, callback };

        this._processData(data);
    }

    _processData(data) {
        let check = GLib.file_test(`${data.filename}`, GLib.FileTest.EXISTS);
        if (check)
            this._generationDone(data);
        else if (!this._subProc)
            this._generateThumbnail(data);
        else
            this._urlQueue.push(data);
    }

    _generationDone(data) {
        data.callback(data.filename);

        let nextData = this._urlQueue.shift();
        if (nextData)
            this._processData(nextData);
    }

    _generateThumbnail(data) {
        let { filename, uri } = data;
        this._subProc = Gio.Subprocess.new(
            ['gjs', `${pkg.pkgdatadir}/thumbnailer.js`, uri, filename],
            Gio.SubprocessFlags.NONE);
        this._subProc.wait_async(null, (o, res) => {
            try {
                this._subProc.wait_finish(res);
            } catch (e) {
                log(`Thumbnail generation for ${uri} failed: ${e}`);
            }
            this._subProc = null;
            this._generationDone(data);
        });
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
            margin: 12,
            margin_start: 0,
            spacing: 6,
        });

        let styleContext = this.get_style_context();
        styleContext.add_class('url-preview');
        styleContext.add_class(Gtk.STYLE_CLASS_BACKGROUND);

        this._image = new Gtk.Image({
            icon_name: 'image-loading-symbolic',
            visible: true,
        });
        this.add(this._image);

        this._label = new Gtk.Label({
            halign: Gtk.Align.START,
            ellipsize: Pango.EllipsizeMode.END,
            visible: true,
        });
        this._label.get_style_context().add_class(Gtk.STYLE_CLASS_DIM_LABEL);
        this.add(this._label);

        Thumbnailer.getDefault().getThumbnail(this.uri, filename => {
            this._image.set_from_file(filename);

            let title = null;
            if (this._image.pixbuf)
                title = this._image.pixbuf.get_option('tEXt::Title');

            if (title) {
                this._label.set_label(title);
                this.tooltip_text = title;
            }
        });
    }
});
