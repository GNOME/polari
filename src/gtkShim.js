import GLib from 'gi://GLib';
import Graphene from 'gi://Graphene';
import Pango from 'gi://Pango';

import gi from 'gi';

/* eslint brace-style: ["error", "1tbs", { "allowSingleLine": true }] */
/* eslint-disable no-invalid-this */

/** @returns {void} */
export function init() {
    let Gtk, Gdk;

    try {
        Gtk = gi.require('Gtk', '3.0');
        Gdk = gi.require('Gdk', '3.0');
    } catch (e) {
        // assume we are already on GTK4
        return;
    }

    Gtk.show_uri_full = function (window, uri, timestamp, cancellable, callback) {
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            callback(window, { uri, timestamp });
            return GLib.SOURCE_REMOVE;
        });
    };
    Gtk.show_uri_full_finish = function (window, result) {
        const { uri, timestamp } = result;
        return Gtk.show_uri_on_window(window, uri, timestamp);
    };

    Gtk.EventController.prototype.get_current_event = function () {
        return Gtk.get_current_event();
    };
    Gtk.EventControllerKey.prototype.forward = function (widget) {
        widget.event(Gtk.get_current_event());
    };
    Gtk.GestureClick = Gtk.GestureMultiPress;

    Gtk.Widget.prototype.add_css_class = function (cssClass) {
        this.get_style_context().add_class(cssClass);
    };
    Gtk.Widget.prototype.remove_css_class = function (cssClass) {
        this.get_style_context().remove_class(cssClass);
    };

    Gtk.StyleContext.add_provider_for_display = function (dsp, ...args) {
        this.add_provider_for_screen(dsp.get_default_screen(), ...args);
    };

    Gtk.AccessibleProperty = { LABEL: 4 };
    Gtk.Widget.prototype.update_property = function (props, values) {
        const label = values[props.findIndex(p => p === 4)];
        if (label)
            this.get_accessible().set_name(label);
    };

    Gtk.Widget.prototype.get_root = Gtk.Widget.prototype.get_toplevel;

    Gtk.Widget.prototype.measure = function (orientation) {
        if (orientation === Gtk.Orientation.HORIZONTAL)
            return this.get_preferred_width();
        else
            return this.get_preferred_height();
    };

    Gtk.Widget.prototype[Symbol.iterator] = function* () {
        const children = this.get_children();
        for (const c of children)
            yield c;
    };
    Gtk.Widget.prototype.get_first_child = function () {
        const [child] = this;
        return child ?? null;
    };
    Gtk.Widget.prototype.get_clipboard = function () {
        return Gtk.Clipboard.get_default(this.get_display());
    };
    Gtk.Clipboard.prototype.set = function (text) {
        this.set_text(text, -1);
    };

    /* Widget-specific container-method replacements */
    Gtk.Box.prototype.append = Gtk.Container.prototype.add;
    Gtk.ListBox.prototype.append = Gtk.Container.prototype.add;

    function setChild(child) {
        if (child)
            this.add(child);
        else if ((child = this.get_first_child()))
            this.remove(child);
    }
    Gtk.Revealer.prototype.set_child = setChild;
    Gtk.Frame.prototype.set_child = setChild;
    Gtk.ScrolledWindow.prototype.set_child = setChild;
    Gtk.ListBoxRow.prototype.set_child = setChild;
    Gtk.Overlay.prototype.set_child = setChild;
    Gtk.Popover.prototype.set_child = setChild;

    /* Other widget-specific replacements */
    Gtk.Entry.prototype.get_delegate = function () {
        return this;
    };
    Gtk.Entry.prototype.compute_cursor_extents = function (pos) {
        const index = this.text_index_to_layout_index(pos);
        const wordPos = this.get_layout().index_to_pos(index);
        const [offX, offY_] = this.get_layout_offsets();
        const extents = new Graphene.Rect();
        extents.init(offX + wordPos.x / Pango.SCALE, 0, 0, 1);
        return [extents, extents];
    };
    Gtk.Entry.prototype.compute_bounds = function () {
        return [true, new Graphene.Rect()];
    };
    Gtk.Popover.prototype.get_parent = Gtk.Popover.prototype.get_relative_to;
    Gtk.Popover.prototype.set_parent = Gtk.Popover.prototype.set_relative_to;
    Gtk.Popover.prototype.unparent = function () {
        this.relative_to = null;
    };

    Gtk.PopoverMenu.prototype.set_menu_model = function (menu) {
        this.bind_model(menu, null);
    };

    Gtk.TextView.prototype.set_cursor_from_name = function (name) {
        const cursor = Gdk.Cursor.new_from_name(this.get_display(), name);
        this.get_window(Gtk.TextWindowType.TEXT).set_cursor(cursor);
    };

    Gtk.ListStore.prototype.insert_with_values = Gtk.ListStore.prototype.insert_with_valuesv;

    /* Properties */
    injectProperty(Gtk.Popover.prototype, 'autohide',
        function () { return this.modal; },
        function (value) { this.modal = value; });

    injectProperty(Gtk.Spinner.prototype, 'spinning',
        function () { return this.active; },
        function (value) { this.active = value; });

    injectProperty(Gtk.Button.prototype, 'has_frame',
        function () { return this.relief !== Gtk.ReliefStyle.NONE; },
        function (value) {
            this.relief = value
                ? Gtk.ReliefStyle.NORMAL : Gtk.ReliefStyle.NONE;
        });

    injectProperty(Gtk.ScrolledWindow.prototype, 'has_frame',
        function () { return this.shadow_type !== Gtk.ShadowType.NONE; },
        function (value) {
            this.shadow_type = value
                ? Gtk.ShadowType.ETCHED_IN : Gtk.ShadowType.NONE;
        });
}

/**
 * @param {prototype} prototype to be patched
 * @param {string} name - property name
 * @param {Function} get - getter funcition
 * @param {Function} set - setter funcition
 * @returns {void}
 */
function injectProperty(prototype, name, get, set) {
    Object.defineProperty(prototype, name, { get, set });

    const realInit = prototype._init;
    prototype._init = function (params = {}) {
        const injected = params[name];
        delete params[name];

        realInit.call(this, params);

        if (injected !== undefined)
            this[name] = injected;
    };
}
