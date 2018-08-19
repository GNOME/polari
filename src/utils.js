/* exported isFlatpakSandbox touchFile needsOnetimeAction getTpEventTime
            findUrls findChannels openURL updateTerms gpaste imgurPaste
            storeAccountPassword storeIdentifyPassword
            lookupAccountPassword lookupIdentifyPassword
            clearAccountPassword clearIdentifyPassword
            updateTerms gpaste imgurPaste formatTimePassed*/

/*
 * Copyright (c) 2011 Red Hat, Inc.
 *
 * Polari is free software; you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by the
 * Free Software Foundation; either version 2 of the License, or (at your
 * option) any later version.
 *
 * Polari is distributed in the hope that it will be useful, but
 * WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
 * or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU General Public License
 * for more details.
 *
 * You should have received a copy of the GNU General Public License along
 * with Polari; if not, write to the Free Software Foundation,
 * Inc., 51 Franklin St, Fifth Floor, Boston, MA  02110-1301  USA
 *
 * Authors: Cosimo Cecchi <cosimoc@redhat.com>
 *          Florian Müllner <fmuellner@gnome.org>
 *
 */

const { Gdk, Gio, GLib, Gtk, Secret, Soup, TelepathyGLib: Tp }  = imports.gi;

const AppNotifications = imports.appNotifications;

Gio._promisify(Secret, 'password_store', 'password_store_finish');
Gio._promisify(Secret, 'password_lookup', 'password_lookup_finish');
Gio._promisify(Secret, 'password_clear', 'password_clear_finish');

const SECRET_SCHEMA_ACCOUNT = new Secret.Schema(
    'org.gnome.Polari.Account',
    Secret.SchemaFlags.NONE,
    { 'account-id': Secret.SchemaAttributeType.STRING });
const SECRET_SCHEMA_IDENTIFY = new Secret.Schema(
    'org.gnome.Polari.Identify',
    Secret.SchemaFlags.NONE,
    { 'account-id': Secret.SchemaAttributeType.STRING });

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

function isFlatpakSandbox() {
    if (_inFlatpakSandbox === undefined)
        _inFlatpakSandbox = GLib.file_test('/.flatpak-info', GLib.FileTest.EXISTS);
    return _inFlatpakSandbox;
}

function touchFile(file) {
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

function needsOnetimeAction(name) {
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
        log(`Failed to mark onetime action ${name} as completed: ${e.message}`);
    }
    return true;
}

function getTpEventTime() {
    let time = Gtk.get_current_event_time();
    if (time === 0)
        return GLib.MAXUINT32;
    return Tp.user_action_time_from_x11(time);
}

function storeAccountPassword(account, password) {
    let label = _('Polari server password for %s').format(account.display_name);
    _storePassword(SECRET_SCHEMA_ACCOUNT, label, account, password);
}

function storeIdentifyPassword(account, password) {
    let label = _('Polari NickServ password for %s').format(account.display_name);
    _storePassword(SECRET_SCHEMA_IDENTIFY, label, account, password);
}

async function _storePassword(schema, label, account, password) {
    let attr = { 'account-id': account.get_path_suffix() };
    let coll = Secret.COLLECTION_DEFAULT;
    try {
        await Secret.password_store(schema, attr, coll, label, password, null);
    } catch (e) {
        const name = account.display_name;
        log(`Failed to store password for account ${name}: ${e.message}`);
        throw e;
    }
}

function lookupAccountPassword(account) {
    return _lookupPassword(SECRET_SCHEMA_ACCOUNT, account);
}

function lookupIdentifyPassword(account) {
    return _lookupPassword(SECRET_SCHEMA_IDENTIFY, account);
}

async function _lookupPassword(schema, account) {
    let attr = { 'account-id': account.get_path_suffix() };
    let password = null;
    try {
        password = await Secret.password_lookup(schema, attr, null);
    } catch (e) {
        const name = account.display_name;
        log(`Failed to lookup password for account "${name}": ${e.message}`);
        throw e;
    }

    return password;
}

function clearAccountPassword(account) {
    _clearPassword(SECRET_SCHEMA_ACCOUNT, account);
}

function clearIdentifyPassword(account) {
    _clearPassword(SECRET_SCHEMA_IDENTIFY, account);
}

async function _clearPassword(schema, account) {
    let attr = { 'account-id': account.get_path_suffix() };
    try {
        await Secret.password_clear(schema, attr, null);
    } catch (e) {
        const name = account.display_name;
        log(`Failed to clear password for account "${name}": ${e.message}`);
        throw e;
    }
}

// findUrls:
// @str: string to find URLs in
//
// Searches @str for URLs and returns an array of objects with %url
// properties showing the matched URL string, and %pos properties indicating
// the position within @str where the URL was found.
//
// Return value: the list of match objects, as described above
function findUrls(str) {
    let res = [], match;
    while ((match = _urlRegexp.exec(str))) {
        let name = match[2];
        let url = GLib.uri_parse_scheme(name) ? name : `http://${name}`;
        res.push({ name, url, pos: match.index + match[1].length });
    }
    return res;
}

function findChannels(str, server) {
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

function openURL(url, timestamp) {
    let app = Gio.Application.get_default();
    try {
        if (app.active_window)
            Gtk.show_uri_on_window(app.active_window, url, timestamp);
        else
            Gtk.show_uri(Gdk.Screen.get_default(), url, timestamp);
    } catch (e) {
        let n = new AppNotifications.SimpleOutput(_('Failed to open link'));
        app.notificationQueue.addNotification(n);
        debug(`Failed to open ${url}: ${e.message}`);
    }
}

function updateTerms(terms, str) {
    let normalized = str.trim().toLowerCase().replace(/\s+/g, ' ');
    let newTerms = normalized ? normalized.split(' ') : [];

    let changed = newTerms.length !== terms.length;
    for (let i = 0; i < terms.length && !changed; i++)
        changed = terms[i] !== newTerms[i];

    if (changed)
        terms.splice(0, terms.length, ...newTerms);

    return changed;
}

function _queueSoupMessage(session, message) {
    return new Promise((resolve, reject) => {
        session.queue_message(message, () => {
            const { statusCode } = message;
            if (statusCode === Soup.KnownStatusCode.OK)
                resolve(message.responseBody.data);
            else
                reject(new Error(`Got unexpected response ${statusCode}`));
        });
    });
}

async function _getGpasteExpire() {
    let session = new Soup.Session();
    let paramUrl = `${GPASTE_BASEURL}api/json/parameter/expire`;
    let message = Soup.form_request_new_from_hash('GET', paramUrl, {});

    const json = await _queueSoupMessage(session, message);
    const info = JSON.parse(json);

    const values = info.result?.values;
    if (!values)
        throw new Error('Returned data is missing expected fields');

    const day = 24 * 60 * 60;
    return values.reduce((acc, val) => {
        return Math.abs(day - acc) < Math.abs(day - val) ? acc : val;
    }, 0).toString();
}

async function gpaste(text, title) {
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

    let session = new Soup.Session();
    let createUrl = `${GPASTE_BASEURL}api/json/create`;
    let message = Soup.form_request_new_from_hash('POST', createUrl, params);

    const json = await _queueSoupMessage(session, message);
    const info = JSON.parse(json);

    if (!info.result?.id)
        throw new Error('Paste server did not return a URL');
    return `${GPASTE_BASEURL}${info.result.id}`;
}

async function imgurPaste(pixbuf, title) {
    let [success, buffer] = pixbuf.save_to_bufferv('png', [], []);
    if (!success)
        throw new Error('Failed to create image buffer');

    let params = {
        title,
        image: GLib.base64_encode(buffer),
    };

    let session = new Soup.Session();
    let createUrl = 'https://api.imgur.com/3/image';
    let message = Soup.form_request_new_from_hash('POST', createUrl, params);

    let requestHeaders = message.request_headers;
    requestHeaders.append('Authorization', `Client-ID ${IMGUR_CLIENT_ID}`);

    const json = await _queueSoupMessage(session, message);
    const info = JSON.parse(json);

    if (!info.success)
        throw new Error('Failed to upload image to paste service');

    return info.data.link;
}

function formatTimePassed(seconds) {
    if (seconds === 0)
        return _('Now');

    if (!seconds)
        return _('Unavailable');

    if (seconds < 60) {
        return ngettext(
            '%d second ago',
            '%d seconds ago', seconds).format(seconds);
    }

    let minutes = seconds / 60;
    if (minutes < 60) {
        return ngettext(
            '%d minute ago',
            '%d minutes ago', minutes).format(minutes);
    }

    let hours = minutes / 60;
    if (hours < 24) {
        return ngettext(
            '%d hour ago',
            '%d hours ago', hours).format(hours);
    }

    let days = hours / 24;
    if (days < 7) {
        return ngettext(
            '%d day ago',
            '%d days ago', days).format(days);
    }

    let weeks = days / 7;
    if (days < 30) {
        return ngettext(
            '%d week ago',
            '%d weeks ago', weeks).format(weeks);
    }

    let months = days / 30;
    return ngettext(
        '%d month ago',
        '%d months ago', months).format(months);
}
