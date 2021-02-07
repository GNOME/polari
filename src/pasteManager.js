export {
    PasteManager,
    DropTargetIface
};

import Gdk from 'gi://Gdk';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';
import Polari from 'gi://Polari';

import * as Utils from './utils.js';

Gio._promisify(Gio._LocalFilePrototype,
    'load_contents_async', 'load_contents_finish');
Gio._promisify(Gio._LocalFilePrototype,
    'query_info_async', 'query_info_finish');
Gio._promisify(Gio._LocalFilePrototype, 'read_async', 'read_finish');
Gio._promisify(GdkPixbuf.Pixbuf.prototype,
    'new_from_stream_async', 'new_from_stream_finish');

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


const PasteManager = class {
    pasteContent(content, title) {
        if (typeof content === 'string')
            return Utils.gpaste(content, title);
        else if (content instanceof GdkPixbuf.Pixbuf)
            return Utils.imgurPaste(content, title);
        else if (content.query_info_async)
            return this._pasteFile(content, title);
        else
            throw new Error('Unhandled content type');
    }

    async _pasteFile(file, title) {
        const fileInfo = await file.query_info_async(
            Gio.FILE_ATTRIBUTE_STANDARD_CONTENT_TYPE,
            Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT, null);

        let contentType = fileInfo.get_content_type();
        let targetType = _getTargetForContentType(contentType);

        if (targetType === DndTargetType.TEXT) {
            const [, contents] = await file.load_contents_async(null);
            return Utils.gpaste(contents.toString(), title);
        } else if (targetType === DndTargetType.IMAGE) {
            const stream = await file.read_async(GLib.PRIORITY_DEFAULT, null);
            const pixbuf =
                await GdkPixbuf.Pixbuf.new_from_stream_async(stream, null);
            return Utils.imgurPaste(pixbuf, title);
        } else {
            throw new Error('Unhandled content type');
        }
    }
};

const DropTargetIface = GObject.registerClass({
    Requires: [GObject.Object],
    Properties: {
        'can-drop': GObject.ParamSpec.boolean(
            'can-drop', 'can-drop', 'can-drop',
            GObject.ParamFlags.READABLE,
            false),
    },
    Signals: {
        'text-dropped': { param_types: [GObject.TYPE_STRING] },
        'image-dropped': { param_types: [GdkPixbuf.Pixbuf.$gtype] },
        'file-dropped': { param_types: [Gio.File.$gtype] },
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

    _onDragDrop(widget, context, _x, _y, time) {
        if (!this.can_drop)
            return Gdk.EVENT_PROPAGATE;

        if (!Polari.drag_dest_supports_target(widget, context))
            return Gdk.EVENT_PROPAGATE;

        Polari.drag_dest_request_data(widget, context, time);
        return Gdk.EVENT_STOP;
    }

    _onDragLeave(widget, _context, _time) {
        widget.drag_unhighlight();
        this._dragHighlight = false;
    }

    _onDragMotion(widget, context, _x, _y, time) {
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


    async _onDragDataReceived(_widget, context, _x, _y, data, info, time) {
        if (info === DndTargetType.URI_LIST) {
            let uris = data.get_uris();
            if (!uris) {
                Gtk.drag_finish(context, false, false, time);
                return;
            }

            // TODO: handle multiple files ...
            const file = Gio.File.new_for_uri(uris[0]);
            const attr = Gio.FILE_ATTRIBUTE_STANDARD_CONTENT_TYPE;
            const flags = Gio.FileQueryInfoFlags.NONE;
            const priority = GLib.PRIORITY_DEFAULT;
            try {
                const fileInfo =
                    await file.query_info_async(attr, flags, priority, null);
                const contentType = fileInfo.get_content_type();
                const targetType = _getTargetForContentType(contentType);
                const canHandle = targetType !== 0;
                if (canHandle)
                    this.emit('file-dropped', file);
                Gtk.drag_finish(context, canHandle, false, time);
            } catch (e) {
                Gtk.drag_finish(context, false, false, time);
            }
        } else {
            let success = false;
            switch (info) {
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
});
