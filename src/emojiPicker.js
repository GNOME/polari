const Gdk = imports.gi.Gdk;
const Gio = imports.gi.Gio;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;

const modifierBlacklist = [
    'child',
    'adult',
    'older adult',
    'woman with headscarf',
    'bearded person',
    'breast-feeding',
    'mage',
    'fairy',
    'vampire',
    'merperson',
    'merman',
    'mermaid',
    ' elf',
    'genie',
    'zombie',
    'in steamy room',
    'climbing',
    'in lotus position',
    'person in bed',
    'man in suit levitating',
    'horse racing',
    'snowboarder',
    'golfing',
    'love-you gesture',
    'palms up together',
];

let _emojis = null;

function getEmojis() {
    if (_emojis != null)
        return _emojis;

    let uri = 'resource:///org/gnome/Polari/data/emoji.json';
    let file = Gio.file_new_for_uri(uri);
    try {
        let [success, data] = file.load_contents(null);
        _emojis = JSON.parse(data).filter(e => {
            if (e.name == 'world map')
                return false; // too wide

            if (!e.code.includes(' '))
                return true; // no modifiers

            // FIXME: Figure out programmatically where modifiers
            // don't work (yet) instead of relying on a blacklist
            return !modifierBlacklist.some(n => e.name.includes(n));
        });
    } catch(e) {
        log('Failed to load emoji definitions: ' + e.message);
        _emojis = [];
    }

    return _emojis;
}

const Emoji = GObject.registerClass(
class Emoji extends Gtk.FlowBoxChild {
    _init(emojiData) {
        this._name = emojiData.name;
        this._matchName = this._name.toLowerCase();
        this._char = emojiData.char;

        super._init();

        this.get_style_context().add_class('emoji');

        let box = new Gtk.EventBox();
        box.add_events(Gdk.EventMask.ENTER_NOTIFY_MASK |
                       Gdk.EventMask.LEAVE_NOTIFY_MASK);
        this.add(box);

        box.connect('enter-notify-event', () => {
            this.set_state_flags(Gtk.StateFlags.PRELIGHT, false);
        });
        box.connect('leave-notify-event', () => {
            let state = this.get_state_flags();
            this.unset_state_flags(Gtk.StateFlags.PRELIGHT);
        });

        box.add(new Gtk.Label({ label: this._char }));
        box.show_all();
    }

    match(terms) {
        return terms.every(t => this._matchName.includes(t));
    }

    get emoji() {
        return this._char;
    }
});

const SectionIndicator = GObject.registerClass(
class SectionIndicator extends Gtk.Button {
    _init(labelCode, from, to) {
        this._from = from;
        this._to = to;

        super._init({ relief: Gtk.ReliefStyle.NONE });

        this.get_style_context().add_class('emoji-section');

        this.add(new Gtk.Label({ label: String.fromCodePoint(labelCode, 0xfe0e),
                                 visible: true }));
    }

    updateForIndex(index) {
        if (this._from <= index && index <= this._to)
            this.set_state_flags(Gtk.StateFlags.CHECKED, false);
        else
            this.unset_state_flags(Gtk.StateFlags.CHECKED);
    }
});

var EmojiPicker = GObject.registerClass({
    Signals: { 'emoji-picked': { param_types: [GObject.TYPE_STRING] } },
}, class EmojiPicker extends Gtk.Popover {
    _init(params) {
        this._terms = [];

        let sections = {
            people:  { labelCode: 0x1f642,
                       fromNo: 1, toNo: 1232 },
            body:    { labelCode: 0x1f44d,
                       fromNo: 1238, toNo: 1507 },
            nature:  { labelCode: 0x1f33c,
                       fromNo: 1508, toNo: 1620 },
            food:    { labelCode: 0x1f374,
                       fromNo: 1621, toNo: 1722 },
            travel:  { labelCode: 0x1f698,
                       fromNo: 1723, toNo: 1846 },
            symbols: { labelCode: 0x2665,
                       fromNo: 1847, toNo: 2356 },
            flags:   { labelCode: 0x1f3f4,
                       fromNo: 2357, toNo: 2623 }
        };

        super._init(params);

        this.get_style_context().add_class('emoji-picker');

        let box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
        this.add(box);

        let entry = new Gtk.SearchEntry();
        box.add(entry);

        let scrolled = new Gtk.ScrolledWindow({ min_content_height: 250 });
        scrolled.hscrollbar_policy = Gtk.PolicyType.NEVER;
        this._adjustment = scrolled.vadjustment;
        box.add(scrolled);

        this._flowBox = new Gtk.FlowBox({ max_children_per_line: 6,
                                          min_children_per_line: 6,
                                          border_width: 8,
                                          selection_mode: Gtk.SelectionMode.NONE,
                                          halign: Gtk.Align.START,
                                          valign: Gtk.Align.START });
        scrolled.add(this._flowBox);

        getEmojis().forEach(e => {
            let emoji = new Emoji(e);
            this._flowBox.add(emoji);

            for (let name in sections) {
                if (e.no == sections[name].fromNo)
                    sections[name].from = emoji.get_index();
                else if (e.no == sections[name].toNo)
                    sections[name].to = emoji.get_index();
            }
        });

        this._sectionBox = new Gtk.Box();
        for (let name in sections) {
            let { labelCode, to, from } = sections[name];
            let section = new SectionIndicator(labelCode, from, to);
            section.connect('clicked', () => {
                let child = this._flowBox.get_child_at_index(from);
                let alloc = child.get_allocation();
                this._adjustment.value = alloc.y;
            });

            this._sectionBox.add(section);
        }
        box.add(this._sectionBox);

        box.show_all();

        this._flowBox.set_filter_func(c => c.match(this._terms));

        this._flowBox.connect('child-activated', (box, child) => {
            this.emit('emoji-picked', child.emoji);
            this.popdown();
        });

        entry.connect('search-changed', () => {
            let trimmedText = entry.text.toLowerCase().trim();
            if (trimmedText)
                this._terms = trimmedText.split(' ');
            else
                this._terms = [];
            this._flowBox.invalidate_filter();
            this._updateIndicators();
        });

        this._adjustment.connect('value-changed',
                                 this._updateIndicators.bind(this));

        this.connect('map', () => {
            entry.text = '';
            this._adjustment.value = 0;
            this._updateIndicators();
        });
    }

    _updateIndicators() {
        let child = null;

        if (this._terms.length == 0) {
            let alloc = this._flowBox.get_allocation();

            let x, y = this._adjustment.value;
            if (this._flowBox.get_direction() == Gtk.TextDirection.LTR)
                x = alloc.width - alloc.x;
            else
                x = alloc.x;

            child = this._flowBox.get_child_at_pos(x, y);
        }

        let i = child ? child.get_index() : -1;
        this._sectionBox.get_children().forEach(c => { c.updateForIndex(i); });
    }
});
