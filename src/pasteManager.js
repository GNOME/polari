const Gdk = imports.gi.Gdk;
const GdkPixbuf = imports.gi.GdkPixbuf;
const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;
const Polari = imports.gi.Polari;
const Tp = imports.gi.TelepathyGLib;

const AppNotifications = imports.appNotifications;
const ChatroomManager = imports.chatroomManager;
const Lang = imports.lang;
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


const PasteManager = new Lang.Class({
    Name: 'PasteManager',

    _init: function() {
    },

    pasteContent: function(content, title, callback) {
        if (typeof content == 'string') {
            Utils.gpaste(content, title, callback);
        } else if (content instanceof GdkPixbuf.Pixbuf) {
            Utils.imgurPaste(content, title, callback);
        } else {
            throw new Error('Unhandled content type');
        }
    }
});

const DropTargetIface = new Lang.Interface({
    Name: 'DropTargetIface',
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

    addTargets: function(widget) {
        this._dragHighlight = false;

        widget.drag_dest_set(0, [], Gdk.DragAction.COPY);

        let targetList = widget.drag_dest_get_target_list();
        if (!targetList)
            targetList = Gtk.TargetList.new([]);

        targetList.add_uri_targets(DndTargetType.URI_LIST);
        targetList.add_text_targets(DndTargetType.TEXT);
        targetList.add_image_targets(DndTargetType.IMAGE, false);

        widget.drag_dest_set_target_list(targetList);

        widget.connect('drag-drop', Lang.bind(this, this._onDragDrop));
        widget.connect('drag-leave', Lang.bind(this, this._onDragLeave));
        widget.connect('drag-motion', Lang.bind(this, this._onDragMotion));
        widget.connect_after('drag-data-received',
                             Lang.bind(this, this._onDragDataReceived));
    },

    _onDragDrop: function(widget, context, x, y, time) {
        if (!this.can_drop)
            return Gdk.EVENT_PROPAGATE;

        if (!Polari.drag_dest_supports_target(widget, context, null))
            return Gdk.EVENT_PROPAGATE;

        Polari.drag_dest_request_data(widget, context, time);
        return Gdk.EVENT_STOP;
    },

    _onDragLeave: function(widget, context, time) {
        widget.drag_unhighlight();
        this._dragHighlight = false;
    },

    _onDragMotion: function(widget, context, x, y, time) {
        if (!this.can_drop)
            return Gdk.EVENT_PROPAGATE;

        if (!Polari.drag_dest_supports_target(widget, context, null))
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
    },


    _onDragDataReceived: function(widget, context, x, y, data, info, time) {
        if (info == DndTargetType.URI_LIST) {
            let uris = data.get_uris();
            if (!uris) {
                Gtk.drag_finish(context, false, false, time);
                return;
            }

            // TODO: handle multiple files ...
            let file = Gio.File.new_for_uri(uris[0]);
            this._lookupFileInfo(file, Lang.bind(this,
                function(targetType) {
                    let canHandle = targetType != 0;
                    if (canHandle)
                        this.emit('file-dropped', file);
                    Gtk.drag_finish(context, canHandle, false, time);
                }));
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
    },

    _lookupFileInfo: function(file, callback) {
        file.query_info_async(Gio.FILE_ATTRIBUTE_STANDARD_CONTENT_TYPE,
                              Gio.FileQueryInfoFlags.NONE,
                              GLib.PRIORITY_DEFAULT,
                              null, Lang.bind(this,
            function(f, res) {
                let fileInfo = null;
                try {
                    fileInfo = file.query_info_finish(res);
                } catch(e) {
                    callback(0);
                    Gtk.drag_finish(context, false, false, time);
                }

                let contentType = fileInfo.get_content_type();
                callback(_getTargetForContentType(contentType));
            }))
    }
});
