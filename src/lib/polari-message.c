/* polari-message.c
 *
 * Copyright (C) 2017 Florian Müllner <fmuellner@gnome.org>
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

#include "polari-message-private.h"

G_DEFINE_BOXED_TYPE (PolariMessage, polari_message, polari_message_copy, polari_message_free)

PolariMessage *
polari_message_new_empty ()
{
  return g_slice_new0 (PolariMessage);
}

PolariMessage *
polari_message_new (const char *text,
                    const char *sender,
                    GDateTime  *time,
                    gboolean    is_action,
                    gboolean    is_self)
{
  PolariMessage *self;

  self = polari_message_new_empty ();

  self->text = g_strdup (text);
  self->sender = g_strdup (sender);
  self->time = g_date_time_ref (time);
  self->is_action = is_action;
  self->is_self = is_self;

  return self;
}

PolariMessage *
polari_message_new_from_tp_message (TpMessage *tp_message)
{
  PolariMessage *self;
  char *text = tp_message_to_text (tp_message, NULL);
  TpContact *sender = tp_signalled_message_get_sender (tp_message);
  TpChannelTextMessageType type = tp_message_get_message_type (tp_message);
  gint64 timestamp;
  gboolean incoming;

  timestamp = tp_message_get_sent_timestamp (tp_message);
  if (timestamp == 0)
    timestamp = tp_message_get_received_timestamp (tp_message);

  tp_message_get_pending_message_id (tp_message, &incoming);

  self = polari_message_new (text,
                             tp_contact_get_alias (sender),
                             g_date_time_new_from_unix_utc (timestamp),
                             type == TP_CHANNEL_TEXT_MESSAGE_TYPE_ACTION,
                             !incoming);
  g_free (text);

  return self;
}

PolariMessage *
polari_message_new_from_tpl_event (TplEvent *event)
{
  TplTextEvent *text_event = TPL_TEXT_EVENT (event);
  const char *text = tpl_text_event_get_message (text_event);
  TplEntity *sender = tpl_event_get_sender (event);
  gint64 timestamp = tpl_event_get_timestamp (event);
  TpChannelTextMessageType type = tpl_text_event_get_message_type (text_event);
  gboolean is_self = tpl_entity_get_entity_type (sender) == TPL_ENTITY_SELF;

  return polari_message_new (text,
                             tpl_entity_get_alias (sender),
                             g_date_time_new_from_unix_utc (timestamp),
                             type == TP_CHANNEL_TEXT_MESSAGE_TYPE_ACTION,
                             is_self);
}

PolariMessage *
polari_message_copy (PolariMessage *self)
{
  g_return_val_if_fail (self, NULL);

  return polari_message_new (self->text,
                             self->sender,
                             self->time,
                             self->is_action,
                             self->is_self);
}

void
polari_message_free (PolariMessage *self)
{
  g_return_if_fail (self);

  g_free (self->text);
  g_free (self->sender);
  g_date_time_unref (self->time);

  g_slice_free (PolariMessage, self);
}

const char *
polari_message_get_text (PolariMessage *message)
{
  return message->text;
}

const char *
polari_message_get_sender (PolariMessage *message)
{
  return message->sender;
}

GDateTime *
polari_message_get_time (PolariMessage *message)
{
  return g_date_time_ref (message->time);
}

gboolean
polari_message_is_action (PolariMessage *message)
{
  return message->is_action;
}

gboolean
polari_message_is_self (PolariMessage *message)
{
  return message->is_self;
}

static TrackerResource *
create_account_resource (const char *id)
{
  TrackerResource *res;
  char *uri;

  uri = tracker_sparql_escape_uri_printf ("urn:account:%s", id);

  res = tracker_resource_new (uri);

  tracker_resource_set_uri (res, "rdf:type", "polari:Account");
  tracker_resource_set_string (res, "polari:id", id);

  g_free (uri);

  return res;
}

static TrackerResource *
create_channel_resource (const char *name,
                         const char *account_id,
                         gboolean    is_room)
{
  TrackerResource *res;
  char *uri;

  uri = tracker_sparql_escape_uri_printf ("urn:channel:%s:%s", account_id, name);

  res = tracker_resource_new (uri);

  tracker_resource_set_uri (res, "rdf:type", is_room ? "polari:Room"
                                                     : "polari:Conversation");
  tracker_resource_set_string (res, "polari:name", name);
  tracker_resource_set_take_relation (res, "polari:account",
                                      create_account_resource (account_id));

  g_free (uri);

  return res;
}

static TrackerResource *
create_sender_resource (const char *nick,
                        const char *account_id,
                        gboolean    is_self)
{
  TrackerResource *res;
  char *uri, *id;

  id = g_ascii_strdown (nick, -1);
  uri = tracker_sparql_escape_uri_printf ("urn:contact:%s:%s", account_id, id);

  res = tracker_resource_new (uri);

  tracker_resource_set_uri (res, "rdf:type", is_self ? "polari:SelfContact"
                                                     : "polari:Contact");
  tracker_resource_set_string (res, "polari:nick", nick);

  g_free (id);
  g_free (uri);

  return res;
}

/**
 * polari_message_to_tracker_resource:
 *
 * Returns: (transfer full):
 */
TrackerResource *
polari_message_to_tracker_resource (PolariMessage *message,
                                    const char    *account_id,
                                    const char    *channel_name,
                                    gboolean       is_room)
{
  TrackerResource *res, *rel;
  char *uri, *time;

  uri = tracker_sparql_get_uuid_urn ();

  res = tracker_resource_new (uri);

  if (polari_message_is_action (message))
    tracker_resource_set_uri (res, "rdf:type", "polari:ActionMessage");
  else
    tracker_resource_set_uri (res, "rdf:type", "polari:Message");

  time = g_date_time_format (polari_message_get_time (message), "%FT%H:%M:%S");
  tracker_resource_set_string (res, "polari:time", time);

  tracker_resource_set_string (res, "polari:text", polari_message_get_text (message));

  rel = create_sender_resource (polari_message_get_sender (message),
                                account_id,
                                polari_message_is_self (message));
  tracker_resource_set_take_relation (res, "polari:sender", rel);

  rel = create_channel_resource (channel_name, account_id, is_room);
  tracker_resource_set_take_relation (res, "polari:channel", rel);

  g_free (uri);
  g_free (time);

  return res;
}
