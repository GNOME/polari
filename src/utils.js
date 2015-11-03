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
const Tp = imports.gi.TelepathyGLib;

const AppNotifications = imports.appNotifications;
const Signals = imports.signals;

const GPASTE_BASEURL = 'https://paste.gnome.org/'

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

function addJSSignalMethods(proto) {
    proto.connectJS = Signals._connect;
    proto.disconnectJS = Signals._disconnect;
    proto.emitJS = Signals._emit;
    proto.disconnectAllJS = Signals._disconnectAll;
}

function getTpEventTime() {
    let time = Gtk.get_current_event_time ();
    if (time == 0)
      return GLib.MAXUINT32;
    return Tp.user_action_time_from_x11 (time);
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
