// SPDX-FileCopyrightText: 2013 Cosimo Cecchi <cosimoc@redhat.com>
// SPDX-FileCopyrightText: 2013 Florian Müllner <fmuellner@gnome.org>
// SPDX-FileCopyrightText: 2015 Jonas Danielsson <jonas@threetimestwo.org>
// SPDX-FileCopyrightText: 2016 Kunaal Jain <kunaalus@gmail.com>
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import Secret from 'gi://Secret';
import Soup from 'gi://Soup?version=3.0';

Gio._promisify(Secret, 'password_store', 'password_store_finish');
Gio._promisify(Secret, 'password_lookup', 'password_lookup_finish');
Gio._promisify(Secret, 'password_clear', 'password_clear_finish');
Gio._promisify(Soup.Session.prototype,
    'send_and_read_async', 'send_and_read_finish');

const SECRET_SCHEMA_ACCOUNT = new Secret.Schema(
    'org.gnome.Polari.Account',
    Secret.SchemaFlags.NONE,
    {'account-id': Secret.SchemaAttributeType.STRING});
const SECRET_SCHEMA_IDENTIFY = new Secret.Schema(
    'org.gnome.Polari.Identify',
    Secret.SchemaFlags.NONE,
    {'account-id': Secret.SchemaAttributeType.STRING});

const GPASTE_BASEURL = 'https://paste.gnome.org/';

// Silly paste.gnome.org limitation:
// http://sayakb.github.io/sticky-notes/pages/api/#create-return-values-on-error
// The visible title is even more limited than the 30-character hard limit ...
const MAX_PASTE_TITLE_LENGTH = 25;

const IMGUR_CLIENT_ID = '4109e59177ec95e';

// http://daringfireball.net/2010/07/improved_regex_for_matching_urls
const _balancedParens = '\\([^\\s()<>]+\\)';
const _leadingJunk = '[\\s`(\\[{\'\\"<\u00AB\u201C\u2018]';
const _notTrailingJunk = '[^\\s`!()\\[\\]{};:\'\\".,<>?\u00AB\u00BB\u201C\u201D\u2018\u2019]';

// schemes that only use a colon cannot be matched generically without producing
// a lot of false positives, so whitelist some useful ones and hope nobody complains :-)
const _schemeWhitelist = ['geo', 'mailto', 'man', 'info', 'ghelp', 'help'];

const _urlRegexp = new RegExp(
    `(^|${_leadingJunk})` +
    '(' +
        '(?:' +
            '(?:[a-z]+)://' +                     // scheme://
            '|' +
            '(?:' +
               `${_schemeWhitelist.join('|')}` + // scheme:
            '):' +
            '|' +
            'www\\d{0,3}[.]' +                    // www.
            '|' +
            '[a-z0-9.\\-]+[.][a-z]{2,4}/' +       // foo.xx/
        ')' +
        '(?:' +                                   // one or more:
            '[^\\s()<>]+' +                       // run of non-space non-()
            '|' +                                 // or
            `${_balancedParens}` +                // balanced parens
        ')+' +
        '(?:' +                                   // end with:
            `${_balancedParens}` +                // balanced parens
            '|' +                                 // or
            `${_notTrailingJunk}` +               // last non-junk char
        ')' +
    ')', 'gi');

const _channelRegexp = new RegExp('(^| )#([\\w\\+\\.-]+)', 'g');

let _gpasteExpire;

let _inFlatpakSandbox;

/**
 * @returns {bool}
 */
export function isFlatpakSandbox() {
    if (_inFlatpakSandbox === undefined)
        _inFlatpakSandbox = GLib.file_test('/.flatpak-info', GLib.FileTest.EXISTS);
    return _inFlatpakSandbox;
}

/**
 * @param {Gio.File} file - file to touch
 * @throws
 */
export function touchFile(file) {
    try {
        file.get_parent().make_directory_with_parents(null);
    } catch (e) {
        if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
            throw e;
        // not an error, carry on
    }

    let stream = file.create(0, null);
    stream.close(null);
}

/**
 * @param {string} name - name of the one-time action
 * @returns {bool}
 */
export function needsOnetimeAction(name) {
    let path = GLib.build_filenamev([
        GLib.get_user_data_dir(),
        'polari',
        `${name}-completed`,
    ]);
    let file = Gio.File.new_for_path(path);
    try {
        touchFile(file);
    } catch (e) {
        if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
            return false;
        console.warn(`Failed to mark onetime action ${
            name} as completed`);
        console.debug(e);
    }
    return true;
}

/**
 * @param {Tp.Account} account - the account
 * @param {string} password - the password
 * @throws
 */
export function storeAccountPassword(account, password) {
    let label = vprintf(_('Polari server password for %s'), account.display_name);
    _storePassword(SECRET_SCHEMA_ACCOUNT, label, account, password);
}

/**
 * @param {Tp.Account} account - the account
 * @param {string} password - the password
 * @throws
 */
export function storeIdentifyPassword(account, password) {
    let label = vprintf(_('Polari NickServ password for %s'), account.display_name);
    _storePassword(SECRET_SCHEMA_IDENTIFY, label, account, password);
}

async function _storePassword(schema, label, account, password) {
    let attr = {'account-id': account.get_path_suffix()};
    let coll = Secret.COLLECTION_DEFAULT;
    try {
        await Secret.password_store(schema, attr, coll, label, password, null);
    } catch (e) {
        const name = account.display_name;
        console.warn(`Failed to store password for account ${name}`);
        console.debug(e);
        throw e;
    }
}

/**
 * @param {Tp.Account} account - the account
 * @returns {string} - the password
 * @throws
 */
export function lookupAccountPassword(account) {
    return _lookupPassword(SECRET_SCHEMA_ACCOUNT, account);
}

/**
 * @param {Tp.Account} account - the account
 * @returns {string}
 * @throws
 */
export function lookupIdentifyPassword(account) {
    return _lookupPassword(SECRET_SCHEMA_IDENTIFY, account);
}

async function _lookupPassword(schema, account) {
    let attr = {'account-id': account.get_path_suffix()};
    let password = null;
    try {
        password = await Secret.password_lookup(schema, attr, null);
    } catch (e) {
        const name = account.display_name;
        console.warn(`Failed to lookup password for account ${name}`);
        console.debug(e);
        throw e;
    }

    return password;
}

/**
 * @param {Tp.Account} account - the account
 * @throws
 */
export function clearAccountPassword(account) {
    _clearPassword(SECRET_SCHEMA_ACCOUNT, account);
}

/**
 * @param {Tp.Account} account - the account
 * @throws
 */
export function clearIdentifyPassword(account) {
    _clearPassword(SECRET_SCHEMA_IDENTIFY, account);
}

async function _clearPassword(schema, account) {
    let attr = {'account-id': account.get_path_suffix()};
    try {
        await Secret.password_clear(schema, attr, null);
    } catch (e) {
        const name = account.display_name;
        console.warn(`Failed to clear password for account ${name}`);
        console.debug(e);
        throw e;
    }
}

/**
 * @typedef {object} UrlMatch
 * @property {string} url - the matched URL
 * @property {string} name - the user-visible name of the URL
 * @property {number} pos - the position of the match
 */

/**
 * @param {string} str - string to find URLs in
 * @returns {UrlMatch}
 */
export function findUrls(str) {
    let res = [], match;
    while ((match = _urlRegexp.exec(str))) {
        let name = match[2];
        let url = GLib.uri_parse_scheme(name) ? name : `http://${name}`;
        res.push({name, url, pos: match.index + match[1].length});
    }
    return res;
}

/**
 * @param {string} str - string to find IRC channel references in
 * @param {string} server - server to use in channel URLs
 * @returns {UrlMatch}
 */
export function findChannels(str, server) {
    let res = [], match;
    while ((match = _channelRegexp.exec(str))) {
        res.push({
            url: `irc://${server}/${match[2]}`,
            name: `#${match[2]}`,
            pos: match.index + match[1].length,
        });
    }
    return res;
}

/**
 * @param {string} url - the url
 */
export function openURL(url) {
    let app = Gio.Application.get_default();
    Gtk.show_uri_full(
        app.active_window, url, Gdk.CURRENT_TIME, null,
        (o, res) => {
            try {
                Gtk.show_uri_full_finish(app.active_window, res);
            } catch (e) {
                const toast = new Adw.Toast({
                    title: _('Failed to open link'),
                });
                app.active_window?.addToast(toast);
                console.debug(`Failed to open ${url}: %o`, e);
            }
        });
}

/**
 * @param {string[]} terms - list of search terms (words) to update
 * @param {string} str - search string
 * @returns {bool} - whether terms changed
 */
export function updateTerms(terms, str) {
    let normalized = str.trim().toLowerCase().replace(/\s+/g, ' ');
    let newTerms = normalized ? normalized.split(' ') : [];

    let changed = newTerms.length !== terms.length;
    for (let i = 0; i < terms.length && !changed; i++)
        changed = terms[i] !== newTerms[i];

    if (changed)
        terms.splice(0, terms.length, ...newTerms);

    return changed;
}

async function _getGpasteExpire() {
    const session = new Soup.Session();
    const message = Soup.Message.new('GET',
        `${GPASTE_BASEURL}api/json/parameter/expire`);

    const bytes = await session.send_and_read_async(
        message,
        GLib.PRIORITY_DEFAULT,
        null);
    checkResponse(message);
    const json = new TextDecoder().decode(bytes.get_data());
    const info = JSON.parse(json);

    const values = info.result?.values;
    if (!values)
        throw new Error('Returned data is missing expected fields');

    const day = 24 * 60 * 60;
    return values.reduce((acc, val) => {
        return Math.abs(day - acc) < Math.abs(day - val) ? acc : val;
    }, 0).toString();
}

/**
 * @param {string} text - text to upload
 * @param {string} title - title to use
 * @throws
 * @returns {string} - the paste URL
 */
export async function gpaste(text, title) {
    if (_gpasteExpire === undefined)
        _gpasteExpire = await _getGpasteExpire();

    if (title.length > MAX_PASTE_TITLE_LENGTH)
        title = `${title.substr(0, MAX_PASTE_TITLE_LENGTH - 1)}…`;

    let params = {
        title,
        data: text,
        expire: _gpasteExpire,
        language: 'text',
    };

    const session = new Soup.Session();
    const message = Soup.Message.new_from_encoded_form('POST',
        `${GPASTE_BASEURL}api/json/create`,
        Soup.form_encode_hash(params));

    const bytes = await session.send_and_read_async(
        message,
        GLib.PRIORITY_DEFAULT,
        null);
    checkResponse(message);
    const json = new TextDecoder().decode(bytes.get_data());
    const info = JSON.parse(json);

    if (!info.result?.id)
        throw new Error('Paste server did not return a URL');
    return `${GPASTE_BASEURL}${info.result.id}`;
}

/**
 * @param {GdkPixbuf.Pixbuf} pixbuf - the pixbuf to paste
 * @param {string} title - the title to use
 * @returns {string} - the paste URL
 * @throws
 */
export async function imgurPaste(pixbuf, title) {
    let [success, buffer] = pixbuf.save_to_bufferv('png', [], []);
    if (!success)
        throw new Error('Failed to create image buffer');

    let params = {
        title,
        image: GLib.base64_encode(buffer),
    };

    const session = new Soup.Session();
    const message = Soup.Message.new_from_encoded_form('POST',
        'https://api.imgur.com/3/image',
        Soup.form_encode_hash(params));

    let requestHeaders = message.request_headers;
    requestHeaders.append('Authorization', `Client-ID ${IMGUR_CLIENT_ID}`);

    const bytes = await session.send_and_read_async(
        message,
        GLib.PRIORITY_DEFAULT,
        null);
    checkResponse(message);
    const json = new TextDecoder().decode(bytes.get_data());
    const info = JSON.parse(json);

    if (!info.success)
        throw new Error('Failed to upload image to paste service');

    return info.data.link;
}

function checkResponse(message) {
    const {statusCode} = message;
    const phrase = Soup.Status.get_phrase(statusCode);
    if (statusCode !== Soup.Status.OK)
        throw new Error(`Unexpected response: ${phrase}`);
}

/**
 * @param {number} seconds - time in seconds
 * @returns {string}
 */
export function formatTimePassed(seconds) {
    if (seconds === 0)
        return _('Now');

    if (!seconds)
        return _('Unavailable');

    if (seconds < 60) {
        return vprintf(ngettext(
            '%d second ago',
            '%d seconds ago', seconds), seconds);
    }

    let minutes = seconds / 60;
    if (minutes < 60) {
        return vprintf(ngettext(
            '%d minute ago',
            '%d minutes ago', minutes), minutes);
    }

    let hours = minutes / 60;
    if (hours < 24) {
        return vprintf(ngettext(
            '%d hour ago',
            '%d hours ago', hours), hours);
    }

    let days = hours / 24;
    if (days < 7) {
        return vprintf(ngettext(
            '%d day ago',
            '%d days ago', days), days);
    }

    let weeks = days / 7;
    if (days < 30) {
        return vprintf(ngettext(
            '%d week ago',
            '%d weeks ago', weeks), weeks);
    }

    let months = days / 30;
    return vprintf(ngettext(
        '%d month ago',
        '%d months ago', months), months);
}
