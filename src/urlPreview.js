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
        super._init(params);

        this.set({
            margin: 12,
            margin_start: 0,
        });

        let styleContext = this.get_style_context();
        styleContext.add_class('url-preview');
        styleContext.add_class(Gtk.STYLE_CLASS_BACKGROUND);

        this._image = new Gtk.Image({
            icon_name: 'image-loading-symbolic',
            visible: true,
        });
        this.add(this._image);
    }
});
