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
const Soup = imports.gi.Soup;
const Secret = imports.gi.Secret;
const Tp = imports.gi.TelepathyGLib;

const AppNotifications = imports.appNotifications;
const Signals = imports.signals;

const SECRET_SCHEMA = new Secret.Schema(
    'org.gnome.Polari.Account', Secret.SchemaFlags.NONE,
    { 'account-id': Secret.SchemaAttributeType.STRING }
);

const GPASTE_BASEURL = 'https://paste.gnome.org/';

// Silly paste.gnome.org limitation:
// http://sayakb.github.io/sticky-notes/pages/api/#create-return-values-on-error
// The visible title is even more limited than the 30-character hard limit ...
const MAX_PASTE_TITLE_LENGTH = 25;

const IMGUR_CLIENT_ID = '4109e59177ec95e';

// http://daringfireball.net/2010/07/improved_regex_for_matching_urls
const _balancedParens = '\\((?:[^\\s()<>]+|(?:\\(?:[^\\s()<>]+\\)))*\\)';
const _leadingJunk = '[\\s`(\\[{\'\\"<\u00AB\u201C\u2018]';
const _notTrailingJunk = '[^\\s`!()\\[\\]{};:\'\\".,<>?\u00AB\u00BB\u201C\u201D\u2018\u2019]';
const _uriList = getURISchemes();

const _urlRegexp = new RegExp(
    '(^|' + _leadingJunk + ')' +
    '(' +
        '(?:' +
            '(?:' + _uriList.join('|') + '):' +   // scheme:
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

let debugInit = false;
let debugEnabled = false;

function debug(str) {
    if (!debugInit) {
        let env = GLib.getenv('POLARI_DEBUG');
        if (env)
            debugEnabled = true;

        debugInit = true;
    }

    if (debugEnabled)
        log('DEBUG: ' + str);
}

function getURISchemes() {
    let apps = Gio.AppInfo.get_all();
    let prefix = 'x-scheme-handler/';
    let schemes = [];

    apps.forEach(function(app) {
        let types = app.get_supported_types();
        if (!types)
            return;

        types.forEach(function(type) {
            if (type.startsWith(prefix))
                schemes.push(type.replace(prefix, ''));
        });
    });
    return schemes;
}

function initActions(actionMap, simpleActionEntries, context) {
    simpleActionEntries.forEach(function(actionEntry) {
        let props = {};
                ['name', 'state', 'parameter_type'].forEach(
                    function(prop) {
                        if (actionEntry[prop])
                            props[prop] = actionEntry[prop];
                    });
                let action = new Gio.SimpleAction(props);
                if (actionEntry.create_hook)
                    actionEntry.create_hook(action);
                if (actionEntry.activate)
                    action.connect('activate', actionEntry.activate);
    });
}


function getTpEventTime() {
    let time = Gtk.get_current_event_time ();
    if (time == 0)
      return GLib.MAXUINT32;
    return Tp.user_action_time_from_x11 (time);
}

function storeAccountPassword(account, password, callback) {
    let attr = { 'account-id': account.get_path_suffix() };
    let label = _("Polari server password for %s").format(account.display_name);
    Secret.password_store(SECRET_SCHEMA, attr, Secret.COLLECTION_DEFAULT,
                          label, password, null,
        function(o, res) {
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
    let attr = { 'account-id': account.get_path_suffix() };
    Secret.password_lookup(SECRET_SCHEMA, attr, null,
        function(o, res) {
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
    let ctx = Gdk.Display.get_default().get_app_launch_context();
    ctx.set_timestamp(timestamp);
    try {
        Gio.AppInfo.launch_default_for_uri(url, ctx);
    } catch(e) {
        let n = new AppNotifications.SimpleOutput(_("Failed to open link"));
        let app = Gio.Application.get_default();
        app.notificationQueue.addNotification(n);
        debug("failed to open %s: %s".format(url, e.message));
    }
}

function gpaste(text, title, callback) {
    if (title.length > MAX_PASTE_TITLE_LENGTH)
        title = title.substr(0, MAX_PASTE_TITLE_LENGTH - 1) + '…';

    let params = {
        title: title,
        data: text,
        language: 'text'
    };

    let session = new Soup.Session();
    let createUrl = GPASTE_BASEURL + 'api/json/create';
    let message = Soup.form_request_new_from_hash('POST', createUrl, params);
    session.queue_message(message,
        function(session, message) {
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
    session.queue_message(message,
        function(session, message) {
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

function formatTimestamp(timestamp) {
    let date = GLib.DateTime.new_from_unix_local(timestamp);
    let now = GLib.DateTime.new_now_local();

    // 00:01 actually, just to be safe
    let todayMidnight = GLib.DateTime.new_local(now.get_year(),
                                                now.get_month(),
                                                now.get_day_of_month(),
                                                0, 1, 0);
    let dateMidnight = GLib.DateTime.new_local(date.get_year(),
                                               date.get_month(),
                                               date.get_day_of_month(),
                                               0, 1, 0);
    let daysAgo = todayMidnight.difference(dateMidnight) / GLib.TIME_SPAN_DAY;

    let format;
    let desktopSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });
    let clockFormat = desktopSettings.get_string('clock-format');
    let hasAmPm = date.format('%p') != '';

    if (clockFormat == '24h' || !hasAmPm) {
        if(daysAgo < 1) { // today
            /* Translators: Time in 24h format */
            format = _("%H\u2236%M");
        } else if(daysAgo <2) { // yesterday
            /* Translators: this is the word "Yesterday" followed by a
             time string in 24h format. i.e. "Yesterday, 14:30" */
            // xgettext:no-c-format
            format = _("Yesterday, %H\u2236%M");
        } else if (daysAgo < 7) { // this week
            /* Translators: this is the week day name followed by a time
             string in 24h format. i.e. "Monday, 14:30" */
            // xgettext:no-c-format
            format = _("%A, %H\u2236%M");
        } else if (date.get_year() == now.get_year()) { // this year
            /* Translators: this is the month name and day number
             followed by a time string in 24h format.
             i.e. "May 25, 14:30" */
            // xgettext:no-c-format
            format = _("%B %d, %H\u2236%M");
        } else { // before this year
            /* Translators: this is the month name, day number, year
             number followed by a time string in 24h format.
             i.e. "May 25 2012, 14:30" */
            // xgettext:no-c-format
            format = _("%B %d %Y, %H\u2236%M");
        }
    } else {
        if(daysAgo < 1) { // today
            /* Translators: Time in 12h format */
            format = _("%l\u2236%M %p");
        } else if(daysAgo <2) { // yesterday
            /* Translators: this is the word "Yesterday" followed by a
             time string in 12h format. i.e. "Yesterday, 2:30 pm" */
            // xgettext:no-c-format
            format = _("Yesterday, %l\u2236%M %p");
        } else if (daysAgo < 7) { // this week
            /* Translators: this is the week day name followed by a time
             string in 12h format. i.e. "Monday, 2:30 pm" */
            // xgettext:no-c-format
            format = _("%A, %l\u2236%M %p");
        } else if (date.get_year() == now.get_year()) { // this year
            /* Translators: this is the month name and day number
             followed by a time string in 12h format.
             i.e. "May 25, 2:30 pm" */
            // xgettext:no-c-format
            format = _("%B %d, %l\u2236%M %p");
        } else { // before this year
            /* Translators: this is the month name, day number, year
             number followed by a time string in 12h format.
             i.e. "May 25 2012, 2:30 pm"*/
            // xgettext:no-c-format
            format = _("%B %d %Y, %l\u2236%M %p");
        }
    }

    return date.format(format);
}
