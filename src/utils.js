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

const Gdk = imports.gi.Gdk;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Gtk = imports.gi.Gtk;
const Secret = imports.gi.Secret;
const Soup = imports.gi.Soup;
const Tp = imports.gi.TelepathyGLib;

const AppNotifications = imports.appNotifications;

const SECRET_SCHEMA_ACCOUNT = new Secret.Schema(
    'org.gnome.Polari.Account', Secret.SchemaFlags.NONE,
    { 'account-id': Secret.SchemaAttributeType.STRING }
);
const SECRET_SCHEMA_IDENTIFY = new Secret.Schema(
    'org.gnome.Polari.Identify', Secret.SchemaFlags.NONE,
    { 'account-id': Secret.SchemaAttributeType.STRING }
);

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
    '(^|' + _leadingJunk + ')' +
    '(' +
        '(?:' +
            '(?:[a-z]+)://' +                     // scheme://
            '|' +
            '(?:' +
                _schemeWhitelist.join('|') +      // scheme:
            '):' +
            '|' +
            'www\\d{0,3}[.]' +                    // www.
            '|' +
            '[a-z0-9.\\-]+[.][a-z]{2,4}/' +       // foo.xx/
        ')' +
        '(?:' +                                   // one or more:
            '[^\\s()<>]+' +                       // run of non-space non-()
            '|' +                                 // or
            _balancedParens +                     // balanced parens
        ')+' +
        '(?:' +                                   // end with:
            _balancedParens +                     // balanced parens
            '|' +                                 // or
            _notTrailingJunk +                    // last non-junk char
        ')' +
    ')', 'gi');

const _channelRegexp = new RegExp('(^| )#([\\w\\+\\.-]+)','g');

let _gpasteExpire = undefined;

let _inFlatpakSandbox = undefined;

function isFlatpakSandbox() {
    if (_inFlatpakSandbox === undefined)
        _inFlatpakSandbox = GLib.file_test('/.flatpak-info', GLib.FileTest.EXISTS);
    return _inFlatpakSandbox;
}

function getTpEventTime() {
    let time = Gtk.get_current_event_time ();
    if (time == 0)
      return GLib.MAXUINT32;
    return Tp.user_action_time_from_x11 (time);
}

function storeAccountPassword(account, password, callback) {
    let label = _("Polari server password for %s").format(account.display_name);
    _storePassword(SECRET_SCHEMA_ACCOUNT, label, account, password, callback);
}

function storeIdentifyPassword(account, password, callback) {
    let label = _("Polari NickServ password for %s").format(account.display_name);
    _storePassword(SECRET_SCHEMA_IDENTIFY, label, account, password, callback);
}

function _storePassword(schema, label, account, password, callback) {
    let attr = { 'account-id': account.get_path_suffix() };
    let coll = Secret.COLLECTION_DEFAULT;
    Secret.password_store(schema, attr, coll, label, password, null, (o, res) => {
        try {
            let success = Secret.password_store_finish(res);
            callback(success);
        } catch(e) {
            log('Failed to store password for account "%s": %s'.format(
                account.display_name, e.message));
            callback(false);
        }
    });
}

function lookupAccountPassword(account, callback) {
    _lookupPassword(SECRET_SCHEMA_ACCOUNT, account, callback);
}

function lookupIdentifyPassword(account, callback) {
    _lookupPassword(SECRET_SCHEMA_IDENTIFY, account, callback);
}

function _lookupPassword(schema, account, callback) {
    let attr = { 'account-id': account.get_path_suffix() };
    Secret.password_lookup(schema, attr, null, (o, res) => {
        try {
            let password = Secret.password_lookup_finish(res);
            callback(password);
        } catch(e) {
            log('Failed to lookup password for account "%s": %s'.format(
                account.display_name, e.message));
            callback(null);
        }
    });
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
    while ((match = _urlRegexp.exec(str)))
        res.push({ url: match[2], pos: match.index + match[1].length });
    return res;
}

function findChannels(str, server) {
    let res = [], match;
    while ((match = _channelRegexp.exec(str)))
        res.push({ url: 'irc://%s/%s'.format(server, match[2]),
                   name: '#' + match[2],
                   pos: match.index + match[1].length });
    return res;
}

function openURL(url, timestamp) {
    let app = Gio.Application.get_default();
    try {
        if (app.active_window)
            Gtk.show_uri_on_window (app.active_window, url, timestamp)
        else
            Gtk.show_uri (Gdk.Screen.get_default(), url, timestamp);
    } catch(e) {
        let n = new AppNotifications.SimpleOutput(_("Failed to open link"));
        app.notificationQueue.addNotification(n);
        debug("failed to open %s: %s".format(url, e.message));
    }
}

function updateTerms(terms, str) {
    let normalized = str.trim().toLowerCase().replace(/\s+/g, ' ');
    let newTerms = normalized ? normalized.split(' ') : [];

    let changed = newTerms.length != terms.length;
    for (let i = 0; i < terms.length && !changed; i++)
        changed = terms[i] != newTerms[i];

    if (changed)
        terms.splice.apply(terms, [0, terms.length, ...newTerms]);

    return changed;
}

function _getGpasteExpire(callback) {
    let session = new Soup.Session();
    let paramUrl = GPASTE_BASEURL + 'api/json/parameter/expire';
    let message = Soup.form_request_new_from_hash('GET', paramUrl, {});
    session.queue_message(message, (s, message) => {
        if (message.status_code != Soup.KnownStatusCode.OK) {
            callback(false);
            return;
        }

        let info = {};
        try {
            info = JSON.parse(message.response_body.data);
        } catch(e) {
            log(e.message);
        }

        let values = info.result ? info.result.values : undefined;
        if (!values)
            callback(false);

        let day = 24 * 60 * 60;
        _gpasteExpire = values.reduce((acc, val) => {
            return Math.abs(day - acc) < Math.abs(day - val) ? acc : val;
        }, 0).toString();
        callback(true);
    });
}

function gpaste(text, title, callback) {
    if (_gpasteExpire == undefined) {
        _getGpasteExpire(success => {
            if (success)
                gpaste(text, title, callback);
            else
                callback(null);
        });
        return;
    }

    if (title.length > MAX_PASTE_TITLE_LENGTH)
        title = title.substr(0, MAX_PASTE_TITLE_LENGTH - 1) + '…';

    let params = {
        title: title,
        data: text,
        expire: _gpasteExpire,
        language: 'text'
    };

    let session = new Soup.Session();
    let createUrl = GPASTE_BASEURL + 'api/json/create';
    let message = Soup.form_request_new_from_hash('POST', createUrl, params);
    session.queue_message(message, (s, message) => {
        if (message.status_code != Soup.KnownStatusCode.OK) {
            callback(null);
            return;
        }

        let info = {};
        try {
            info = JSON.parse(message.response_body.data);
        } catch(e) {
            log(e.message);
        }
        if (info.result && info.result.id)
            callback(GPASTE_BASEURL + info.result.id);
        else
            callback(null);
    });
}

function imgurPaste(pixbuf, title, callback) {
    let [success, buffer] = pixbuf.save_to_bufferv('png', [], []);
    if (!success) {
        callback(null);
        return;
    }

    let params = {
        title: title,
        image: GLib.base64_encode(buffer)
    };

    let session = new Soup.Session();
    let createUrl = 'https://api.imgur.com/3/image';
    let message = Soup.form_request_new_from_hash('POST', createUrl, params);

    let requestHeaders = message.request_headers;
    requestHeaders.append('Authorization', 'Client-ID ' + IMGUR_CLIENT_ID);
    session.queue_message(message, (s, message) => {
        if (message.status_code != Soup.KnownStatusCode.OK) {
            callback(null);
            return;
        }

        let info = {};
        try {
            info = JSON.parse(message.response_body.data);
        } catch(e) {
            log(e.message);
        }
        if (info.success)
            callback(info.data.link);
        else
            callback(null);
    });
}
