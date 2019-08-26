/* exported URLPreview */
const { Gio, GLib, GObject, Gtk } = imports.gi;

const THUMBNAILS_DIR = `${GLib.get_user_cache_dir()}/polari/thumbnails/`;

GLib.mkdir_with_parents(THUMBNAILS_DIR, 0o755);


class Thumbnailer {
    static getDefault() {
        if (!this._singleton)
            this._singleton = new Thumbnailer();
        return this._singleton;
    }

    constructor() {
        this._urlQueue = [];
        this._subProc = null;
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
        log('Thumbnailer.js : generation Done');

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
                log('thumbnailer exited');
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

        let name = checksum.get_string().concat('.png');

        return THUMBNAILS_DIR.concat(name);
    }

}

let URLPreview = GObject.registerClass({
    Properties: {
        'uri': GObject.ParamSpec.string(
            'uri', 'uri', 'uri',
            GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT_ONLY,
            null),
    },
}, class URLPreview extends Gtk.Box {
    _init(params) {
        this._uri = null;
        this._detect_window = null;

        super._init(params);

        this._image = new Gtk.Image({ icon_name: 'image-loading-symbolic' });
        this.add(this._image);
        this.show_all();

        Thumbnailer.getDefault().getThumbnail(this.uri, filename => {
            this._image.set_from_file(filename);
        });
    }


});
