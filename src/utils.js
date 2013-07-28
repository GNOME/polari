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

const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const Soup = imports.gi.Soup;

const Signals = imports.signals;

const FPASTE_BASEURL = 'http://paste.fedoraproject.org/'

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

function addJSSignalMethods(proto) {
    proto.connectJS = Signals._connect;
    proto.disconnectJS = Signals._disconnect;
    proto.emitJS = Signals._emit;
    proto.disconnectAllJS = Signals._disconnectAll;
}

function fpaste(text, user, callback) {
    let getUrl = function(session, id) {
        let longUrl = FPASTE_BASEURL + id;
        session.queue_message(Soup.Message.new('POST', longUrl + '/json'),
            function(session, message) {
                if (message.status_code != Soup.KnownStatusCode.OK) {
                    callback(null);
                    return;
                }

                // workaround: the response contains the pasted data
                // unescaped (e.g. newlines), which is not legal json;
                // just grab the property we're interested in
                let lines = message.response_body.data.split('\n');
                let shortUrl = null;
                for (let i = 0; i < lines.length; i++) {
                    if (lines[i].indexOf('short_url') > -1) {
                        shortUrl = lines[i];
                        break;
                    }
                }

                let info = {};
                try {
                    if (shortUrl)
                        info = JSON.parse('{ %s }'.format(shortUrl));
                } catch(e) {
                    log(e.message);
                }
                if (info.short_url)
                    callback(info.short_url);
                else
                    callback(longUrl);
            });
    };
    let params = {
        paste_data: text,
        paste_lang: 'text',
        paste_user: user,
        api_submit: '1',
        mode: 'json'
    };

    let session = new Soup.Session();
    let message = Soup.form_request_new_from_hash('POST', FPASTE_BASEURL, params);
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
                getUrl(session, info.result.id);
            else
                callback(null);
        });
}
