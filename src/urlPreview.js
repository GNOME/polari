/* exported URLPreview */
const { GObject, Gtk } = imports.gi;

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
    }
});
