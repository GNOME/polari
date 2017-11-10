const Gdk = imports.gi.Gdk;
const GdkPixbuf = imports.gi.GdkPixbuf;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;
const Polari = imports.gi.Polari;

const Utils = imports.utils;

const DndTargetType = {
    URI_LIST: 1,

    TEXT: 2,
    IMAGE: 3,
};

function _getTargetForContentType(contentType) {
    if (Gio.content_type_is_a(contentType, 'text/plain'))
        return DndTargetType.TEXT;
    else if (Gio.content_type_is_a(contentType, 'image/*'))
        return DndTargetType.IMAGE;
    else
       return 0;
}


var PasteManager = class {
    pasteContent(content, title, callback) {
        if (typeof content == 'string') {
            Utils.gpaste(content, title, callback);
        } else if (content instanceof GdkPixbuf.Pixbuf) {
            Utils.imgurPaste(content, title, callback);
        } else if (content.query_info_async) {
            this._pasteFile(content, title, callback);
        } else {
            throw new Error('Unhandled content type');
        }
    }

    _pasteFile(file, title, callback) {
        file.query_info_async(Gio.FILE_ATTRIBUTE_STANDARD_CONTENT_TYPE,
                              Gio.FileQueryInfoFlags.NONE,
                              GLib.PRIORITY_DEFAULT, null, (file, res) => {
                                  this._onFileQueryFinish(file, res, title, callback);
                              });
    }

    _onFileQueryFinish(file, res, title, callback) {
        let fileInfo = null;
        try {
            fileInfo = file.query_info_finish(res);
        } catch(e) {
            callback(null);
        }

        let contentType = fileInfo.get_content_type();
        let targetType = _getTargetForContentType(contentType);

        if (targetType == DndTargetType.TEXT)
            file.load_contents_async(null, (f, res) => {
                let [, contents, ,] = f.load_contents_finish(res);
                Utils.gpaste(contents.toString(), title, callback);
            });
        else if (targetType == DndTargetType.IMAGE)
            file.read_async(GLib.PRIORITY_DEFAULT, null, (f, res) => {
                let stream = f.read_finish(res);
                GdkPixbuf.Pixbuf.new_from_stream_async(stream, null, (s, res) => {
                    let pixbuf = GdkPixbuf.Pixbuf.new_from_stream_finish(res);
                    Utils.imgurPaste(pixbuf, title, callback);
                });
            });
        else
            callback(null);
    }
};

var DropTargetIface = GObject.registerClass({
    Requires: [GObject.Object],
    Properties: {
        'can-drop': GObject.ParamSpec.boolean('can-drop', '', '',
                                              GObject.ParamFlags.READABLE,
                                              false)
    },
    Signals: {
        'text-dropped': { param_types: [GObject.TYPE_STRING] },
        'image-dropped': { param_types: [GdkPixbuf.Pixbuf.$gtype] },
        'file-dropped': { param_types: [Gio.File.$gtype] }
    },
}, class DropTargetIface extends GObject.Interface {
    addTargets(widget) {
        this._dragHighlight = false;

        widget.drag_dest_set(0, [], Gdk.DragAction.COPY);

        let targetList = widget.drag_dest_get_target_list();
        if (!targetList)
            targetList = Gtk.TargetList.new([]);

        targetList.add_uri_targets(DndTargetType.URI_LIST);
        targetList.add_text_targets(DndTargetType.TEXT);
        targetList.add_image_targets(DndTargetType.IMAGE, false);

        widget.drag_dest_set_target_list(targetList);

        widget.connect('drag-drop', this._onDragDrop.bind(this));
        widget.connect('drag-leave', this._onDragLeave.bind(this));
        widget.connect('drag-motion', this._onDragMotion.bind(this));
        widget.connect_after('drag-data-received',
                             this._onDragDataReceived.bind(this));
    }

    _onDragDrop(widget, context, x, y, time) {
        if (!this.can_drop)
            return Gdk.EVENT_PROPAGATE;

        if (!Polari.drag_dest_supports_target(widget, context))
            return Gdk.EVENT_PROPAGATE;

        Polari.drag_dest_request_data(widget, context, time);
        return Gdk.EVENT_STOP;
    }

    _onDragLeave(widget, context, time) {
        widget.drag_unhighlight();
        this._dragHighlight = false;
    }

    _onDragMotion(widget, context, x, y, time) {
        if (!this.can_drop)
            return Gdk.EVENT_PROPAGATE;

        if (!Polari.drag_dest_supports_target(widget, context))
            return Gdk.EVENT_PROPAGATE;

        let info = Polari.drag_dest_find_target(widget, context);
        switch (info) {
            case DndTargetType.TEXT:
            case DndTargetType.IMAGE:
            case DndTargetType.URI_LIST:
                Gdk.drag_status(context, Gdk.DragAction.COPY, time);
                break;
            default:
                return Gdk.EVENT_PROPAGATE;
        }

        if (!this._dragHighlight) {
            this._dragHighlight = true;
            widget.drag_highlight();
        }

        return Gdk.EVENT_STOP;
    }


    _onDragDataReceived(widget, context, x, y, data, info, time) {
        if (info == DndTargetType.URI_LIST) {
            let uris = data.get_uris();
            if (!uris) {
                Gtk.drag_finish(context, false, false, time);
                return;
            }

            // TODO: handle multiple files ...
            let file = Gio.File.new_for_uri(uris[0]);
            try {
                this._lookupFileInfo(file, targetType => {
                    let canHandle = targetType != 0;
                    if (canHandle)
                        this.emit('file-dropped', file);
                    Gtk.drag_finish(context, canHandle, false, time);
                });
            } catch(e) {
                Gtk.drag_finish(context, false, false, time);
            }
        } else {
            let success = false;
            switch(info) {
                case DndTargetType.TEXT:
                    this.emit('text-dropped', data.get_text());
                    success = true;
                    break;
                case DndTargetType.IMAGE:
                    this.emit('image-dropped', data.get_pixbuf());
                    success = true;
                    break;
            }
            Gtk.drag_finish(context, success, false, time);
        }
    }

    _lookupFileInfo(file, callback) {
        let attr = Gio.FILE_ATTRIBUTE_STANDARD_CONTENT_TYPE;
        let flags = Gio.FileQueryInfoFlags.NONE;
        let priority = GLib.PRIORITY_DEFAULT;
        file.query_info_async(attr, flags, priority, null, (f, res) => {
            let fileInfo = file.query_info_finish(res);
            let contentType = fileInfo.get_content_type();
            callback(_getTargetForContentType(contentType));
        });
    }
});
