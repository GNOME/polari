/*
 * SPDX-FileCopyrightText: 2017 Florian Müllner <fmuellner@gnome.org>
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

#include "polari-message-private.h"

G_DEFINE_BOXED_TYPE (PolariMessage, polari_message, polari_message_copy, polari_message_free)

PolariMessage *
polari_message_new_empty ()
{
  return g_new0 (PolariMessage, 1);
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

  g_free (self);
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

/**
 * polari_message_get_time:
 *
 * Returns: (transfer none):
 **/
GDateTime *
polari_message_get_time (PolariMessage *message)
{
  return message->time;
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
  g_autofree char *uri = NULL;

  uri = g_strconcat ("urn:account:", id, NULL);

  res = tracker_resource_new (uri);

  tracker_resource_set_uri (res, "rdf:type", "polari:Account");
  tracker_resource_set_string (res, "polari:id", id);

  return res;
}

static TrackerResource *
create_channel_resource (const char *name,
                         const char *account_id,
                         gboolean    is_room)
{
  TrackerResource *res;
  g_autofree char *uri = NULL;

  uri = g_strdup_printf ("urn:channel:%s:%s", account_id, name);

  res = tracker_resource_new (uri);

  tracker_resource_set_uri (res, "rdf:type", is_room ? "polari:Room"
                                                     : "polari:Conversation");
  tracker_resource_set_string (res, "polari:name", name);
  tracker_resource_set_take_relation (res, "polari:account",
                                      create_account_resource (account_id));

  return res;
}

static TrackerResource *
create_sender_resource (const char *nick,
                        const char *account_id,
                        gboolean    is_self)
{
  TrackerResource *res;
  g_autofree char *uri = NULL, *id = NULL;

  id = g_ascii_strdown (nick, -1);
  uri = g_strdup_printf ("urn:contact:%s:%s", account_id, id);

  res = tracker_resource_new (uri);

  tracker_resource_set_uri (res, "rdf:type", is_self ? "polari:SelfContact"
                                                     : "polari:Contact");
  tracker_resource_set_string (res, "polari:nick", nick);

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
  GDateTime *time;

  res = tracker_resource_new (NULL);

  tracker_resource_set_uri (res, "rdf:type", "polari:Message");

  if (polari_message_is_action (message))
    tracker_resource_set_boolean (res, "polari:isAction", TRUE);

  time = polari_message_get_time (message);
  tracker_resource_set_datetime (res, "polari:time", time);

  tracker_resource_set_string (res, "polari:text", polari_message_get_text (message));

  rel = create_sender_resource (polari_message_get_sender (message),
                                account_id,
                                polari_message_is_self (message));
  tracker_resource_set_take_relation (res, "polari:sender", rel);

  rel = create_channel_resource (channel_name, account_id, is_room);
  tracker_resource_set_take_relation (res, "polari:channel", rel);

  return res;
}
