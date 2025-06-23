// SPDX-FileCopyrightText: 2013 Florian Müllner <fmuellner@gnome.org>
// SPDX-FileCopyrightText: 2016 Kunaal Jain <kunaalus@gmail.com>
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gdk from 'gi://Gdk';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import * as Utils from './utils.js';

Gio._promisify(Gio._LocalFilePrototype,
    'load_contents_async', 'load_contents_finish');
Gio._promisify(Gio._LocalFilePrototype,
    'query_info_async', 'query_info_finish');
Gio._promisify(Gio._LocalFilePrototype, 'read_async', 'read_finish');
Gio._promisify(GdkPixbuf.Pixbuf,
    'new_from_stream_async', 'new_from_stream_finish');

/**
 * Find a supported GType for the formats of a contents exchange
 * that is being negotiated
 *
 * @param {Gdk.ContentFormats} formats - provided formats
 * @returns {GType=} - the matching GType
 */
export function gtypeFromFormats(formats) {
    const builder = new Gdk.ContentFormatsBuilder();
    builder.add_gtype(Gio.File);
    builder.add_gtype(GdkPixbuf.Pixbuf);
    builder.add_gtype(GObject.TYPE_STRING);
    const supportedFormats = builder.to_formats();

    return supportedFormats.match_gtype(formats.union_deserialize_gtypes());
}

export default class PasteManager {
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

        const contentType = fileInfo.get_content_type();
        if (Gio.content_type_is_a(contentType, 'text/plain')) {
            const [contents] = await file.load_contents_async(null);
            return Utils.gpaste(new TextDecoder().decode(contents), title);
        } else if (Gio.content_type_is_a(contentType, 'image/*')) {
            const stream = await file.read_async(GLib.PRIORITY_DEFAULT, null);
            const pixbuf =
                await GdkPixbuf.Pixbuf.new_from_stream_async(stream, null);
            return Utils.imgurPaste(pixbuf, title);
        } else {
            throw new Error('Unhandled content type');
        }
    }
}

export const DropTargetIface = GObject.registerClass(
class DropTargetIface extends GObject.Interface {
    static [GObject.requires] = [GObject.Object];
    static [GObject.properties] = {
        'can-drop': GObject.ParamSpec.boolean(
            'can-drop', null, null,
            GObject.ParamFlags.READABLE,
            false),
    };

    static [GObject.signals] = {
        'text-dropped': {param_types: [GObject.TYPE_STRING]},
        'image-dropped': {param_types: [GdkPixbuf.Pixbuf]},
        'file-dropped': {param_types: [Gio.File]},
    };

    addTargets(widget) {
        const imageTypes = [];
        for (const f of GdkPixbuf.Pixbuf.get_formats())
            imageTypes.push(...f.get_mime_types());

        this._dropTarget = new Gtk.DropTargetAsync({
            actions: Gdk.DragAction.COPY,
            formats: new Gdk.ContentFormats([
                'text/plain',
                'text/uri-list',
                ...imageTypes,
            ]),
        });
        this._dropTarget.connect('drop', (_, drop) => {
            this._handleDrop(drop);
            return true;
        });
        this._dropTarget.connect('accept', (_, drop) => {
            if (!this.can_drop)
                return false;
            return this._dropTarget.formats.match(drop.get_formats());
        });
        widget.add_controller(this._dropTarget);
    }

    async _handleDrop(drop) {
        const type = gtypeFromFormats(drop.formats);
        const value = await this._readDropValue(drop, type);
        let action = Gdk.DragAction.COPY;
        if (typeof value === 'string') {
            this.emit('text-dropped', value);
        } else if (value instanceof GdkPixbuf.Pixbuf) {
            this.emit('image-dropped', value);
        } else if (value instanceof Gio.File) {
            if (await this._canHandleFile(value))
                this.emit('file-dropped', value);
            else
                action = 0;
        } else {
            console.warn(`Unexpected drop value ${value}`);
        }
        drop.finish(action);
    }

    async _canHandleFile(file) {
        let contentType = '';
        try {
            const fileInfo = await file.query_info_async(
                Gio.FILE_ATTRIBUTE_STANDARD_CONTENT_TYPE,
                Gio.FileQueryInfoFlags.NONE,
                GLib.PRIORITY_DEFAULT,
                null);
            contentType = fileInfo.get_content_type();
        } catch (e) {
            console.log(`Failed to determine content type: ${e}`);
        }

        const mimes = this._dropTarget.formats.get_mime_types();
        return mimes.some(mime => Gio.content_type_is_a(contentType, mime));
    }

    _readDropValue(drop, type) {
        return new Promise((resolve, reject) => {
            drop.read_value_async(type, 0, null, (_, res) => {
                try {
                    const value = drop.read_value_finish(res);
                    resolve(value);
                } catch (e) {
                    reject(e);
                }
            });
        });
    }
});
