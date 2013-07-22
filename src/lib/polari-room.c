/* -*- Mode: C; tab-width: 8; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/*
 * Copyright (C) 2013 Red Hat, Inc.
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU Lesser General Public License as published
 * by the Free Software Foundation, either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful, but
 * WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
 * See the GNU Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.";
 */

#include <string.h>

#include "polari-room.h"

struct _PolariRoomPrivate {
  TpChannel *channel;

  GIcon *icon;
  char  *id;
  char  *display_name;

  guint identifier_notify_id;
  guint group_contacts_changed_id;
};

enum
{
  PROP_0,

  PROP_ID,
  PROP_ICON,
  PROP_CHANNEL,
  PROP_DISPLAY_NAME,

  LAST_PROP
};

static GParamSpec *props[LAST_PROP];

enum
{
  MEMBER_JOINED,
  MEMBER_LEFT,
  MEMBER_DISCONNECTED,
  MEMBER_RENAMED,
  MEMBER_KICKED,
  MEMBER_BANNED,

  LAST_SIGNAL
};

static guint signals[LAST_SIGNAL];

G_DEFINE_TYPE_WITH_PRIVATE (PolariRoom, polari_room, G_TYPE_OBJECT)

void
polari_room_send (PolariRoom *room,
                  const char *message)
{
  TpMessage *tp_message;
  TpChannelTextMessageType type;

  g_return_if_fail (POLARI_IS_ROOM (room));

  type = TP_CHANNEL_TEXT_MESSAGE_TYPE_NORMAL;

  if (g_str_has_prefix (message, "/me "))
    {
      message += strlen ("/me ");
      type = TP_CHANNEL_TEXT_MESSAGE_TYPE_ACTION;
    }
  tp_message = tp_client_message_new_text (type, message);

  tp_text_channel_send_message_async (TP_TEXT_CHANNEL (room->priv->channel),
                                      tp_message, 0, NULL, NULL);
}

void
polari_room_leave (PolariRoom *room)
{
  g_return_if_fail (POLARI_IS_ROOM (room));

  tp_channel_leave_async (room->priv->channel,
                          TP_CHANNEL_GROUP_CHANGE_REASON_NONE, "Good bye!",
                          NULL, NULL);
}

gboolean
polari_room_should_highlight_message (PolariRoom *room,
                                      TpMessage *message)
{
  PolariRoomPrivate *priv;
  TpConnection *conn;
  TpContact *sender, *self;
  char *text;
  gboolean result;

  g_return_val_if_fail (POLARI_IS_ROOM (room), FALSE);

  priv = room->priv;

  if (!priv->channel)
    return FALSE;

  conn = tp_channel_get_connection (room->priv->channel);
  self = tp_connection_get_self_contact (conn);

  if (tp_signalled_message_get_sender (message) == self)
    return FALSE;

  text = tp_message_to_text (message, NULL);
  result = strstr(text, tp_contact_get_alias (self)) != NULL;
  g_free (text);

  return result;
}

int
polari_room_compare (PolariRoom *room,
                     PolariRoom *other)
{
  TpAccount *account1, *account2;
  TpHandleType type1, type2;
  TpConnection *conn;

  g_return_val_if_fail (POLARI_IS_ROOM (room) && POLARI_IS_ROOM (other), 0);
  g_return_val_if_fail (room->priv->channel && other->priv->channel, 0);

  conn = tp_channel_get_connection (room->priv->channel);
  account1 = tp_connection_get_account (conn);

  conn = tp_channel_get_connection (other->priv->channel);
  account2 = tp_connection_get_account (conn);

  if (account1 != account2)
    return strcmp (tp_account_get_display_name (account1),
                   tp_account_get_display_name (account2));

  tp_channel_get_handle (room->priv->channel, &type1);
  tp_channel_get_handle (other->priv->channel, &type2);

  if (type1 != type2)
    return type1 == TP_HANDLE_TYPE_ROOM ? -1 : 1;

  return strcmp (room->priv->display_name, other->priv->display_name);
}

static void
update_identifier (PolariRoom *room)
{
  PolariRoomPrivate *priv = room->priv;
  const char *id = NULL;

  if (priv->channel)
    id = tp_channel_get_identifier (priv->channel);

  g_clear_pointer (&priv->display_name, g_free);
  if (id)
    priv->display_name = g_strdup (id + (id[0] == '#' ? 1 : 0));

  g_object_notify_by_pspec (G_OBJECT (room), props[PROP_DISPLAY_NAME]);
}

static void
update_icon (PolariRoom *room)
{
  PolariRoomPrivate *priv = room->priv;

  g_clear_object (&priv->icon);

  if (priv->channel)
    {
      const char *icon_name;
      gboolean is_private;

      is_private = !tp_proxy_has_interface_by_id (TP_PROXY (priv->channel),
                                                  TP_IFACE_QUARK_CHANNEL_INTERFACE_GROUP);
      icon_name = is_private ? "avatar-default-symbolic"
                             : "user-available-symbolic";
      priv->icon = g_themed_icon_new (icon_name);
    }

  g_object_notify_by_pspec (G_OBJECT (room), props[PROP_ICON]);
}

static void
on_identifier_notify (GObject    *object,
                      GParamSpec *pspec,
                      gpointer    user_data)
{
  update_identifier (POLARI_ROOM (user_data));
}

static void
on_group_contacts_changed (TpChannel  *channel,
                           GPtrArray  *added,
                           GPtrArray  *removed,
                           GPtrArray  *local_pending,
                           GPtrArray  *remote_pending,
                           TpContact  *actor,
                           GHashTable *details,
                           gpointer    user_data)
{
  TpChannelGroupChangeReason reason;
  const char *message;
  int i;

  reason = tp_asv_get_uint32 (details, "change-reason", NULL);
  message = tp_asv_get_string (details, "message");

  switch (reason)
    {
    case TP_CHANNEL_GROUP_CHANGE_REASON_RENAMED:
      g_signal_emit (user_data, signals[MEMBER_RENAMED], 0,
                     g_ptr_array_index (removed, 0),
                     g_ptr_array_index (added, 0));
      break;
    case TP_CHANNEL_GROUP_CHANGE_REASON_OFFLINE:
      for (i = 0; i < removed->len; i++)
        g_signal_emit (user_data, signals[MEMBER_DISCONNECTED], 0,
                       g_ptr_array_index (removed, i), message);
      break;
    case TP_CHANNEL_GROUP_CHANGE_REASON_KICKED:
      for (i = 0; i < removed->len; i++)
        g_signal_emit (user_data, signals[MEMBER_KICKED], 0,
                       g_ptr_array_index (removed, i), actor);
      break;
    case TP_CHANNEL_GROUP_CHANGE_REASON_BANNED:
      for (i = 0; i < removed->len; i++)
        g_signal_emit (user_data, signals[MEMBER_BANNED], 0,
                       g_ptr_array_index (removed, i), actor);
      break;
    case TP_CHANNEL_GROUP_CHANGE_REASON_NONE:
      for (i = 0; i < removed->len; i++)
        g_signal_emit (user_data, signals[MEMBER_LEFT], 0,
                       g_ptr_array_index (removed, i), message);
      for (i = 0; i < added->len; i++)
        g_signal_emit (user_data, signals[MEMBER_JOINED], 0,
                       g_ptr_array_index (added, i));
      break;
    }
}

static void
polari_room_set_channel (PolariRoom *room,
                         TpChannel  *channel)
{
  PolariRoomPrivate *priv;

  g_return_if_fail (POLARI_IS_ROOM (room));
  g_return_if_fail (channel == NULL || TP_IS_TEXT_CHANNEL (channel));

  priv = room->priv;

  if (priv->channel == channel)
    return;

  if (priv->channel)
    {
      g_signal_handler_disconnect (priv->channel, priv->identifier_notify_id);
      g_signal_handler_disconnect (priv->channel, priv->group_contacts_changed_id);
      g_clear_object (&priv->channel);
    }

  if (channel)
    {
      priv->channel = g_object_ref (channel);

      if (priv->id == NULL)
        priv->id = g_strdup (tp_proxy_get_object_path (TP_PROXY (channel)));

      priv->identifier_notify_id =
        g_signal_connect (channel, "notify::identifier",
                          G_CALLBACK (on_identifier_notify), room);
      priv->group_contacts_changed_id =
        g_signal_connect (channel, "group-contacts-changed",
                          G_CALLBACK (on_group_contacts_changed), room);
    }

    g_object_freeze_notify (G_OBJECT (room));

    update_identifier (room);
    update_icon (room);

    g_object_notify_by_pspec (G_OBJECT (room), props[PROP_CHANNEL]);

    g_object_thaw_notify (G_OBJECT (room));
}

static void
polari_room_get_property (GObject    *object,
                          guint       prop_id,
                          GValue     *value,
                          GParamSpec *pspec)
{
  PolariRoomPrivate *priv = POLARI_ROOM(object)->priv;

  switch (prop_id)
    {
    case PROP_ID:
      g_value_set_string (value, priv->id);
      break;
    case PROP_ICON:
      g_value_set_object (value, priv->icon);
      break;
    case PROP_CHANNEL:
      g_value_set_object (value, priv->channel);
      break;
    case PROP_DISPLAY_NAME:
      g_value_set_string (value, priv->display_name);
      break;
    default:
      G_OBJECT_WARN_INVALID_PROPERTY_ID (object, prop_id, pspec);
    }
}

static void
polari_room_set_property (GObject      *object,
                          guint         prop_id,
                          const GValue *value,
                          GParamSpec   *pspec)
{
  g_return_if_fail (POLARI_IS_ROOM (object));
  g_return_if_fail (G_IS_OBJECT (object));
  PolariRoom *room = POLARI_ROOM(object);

  switch (prop_id)
    {
    case PROP_CHANNEL:
      polari_room_set_channel (room, g_value_get_object (value));
      break;
    default:
      G_OBJECT_WARN_INVALID_PROPERTY_ID (object, prop_id, pspec);
    }
}

static void
polari_room_dispose (GObject *object)
{
  polari_room_set_channel (POLARI_ROOM (object), NULL);
  G_OBJECT_CLASS (polari_room_parent_class)->dispose (object);
}

static void
polari_room_finalize (GObject *object)
{
  PolariRoomPrivate *priv = POLARI_ROOM (object)->priv;

  g_clear_pointer (&priv->id, g_free);
  g_clear_pointer (&priv->display_name, g_free);

  G_OBJECT_CLASS (polari_room_parent_class)->finalize (object);
}

static void
polari_room_class_init (PolariRoomClass *klass)
{
  GObjectClass *object_class = G_OBJECT_CLASS (klass);

  object_class->get_property = polari_room_get_property;
  object_class->set_property = polari_room_set_property;
  object_class->dispose = polari_room_dispose;
  object_class->finalize = polari_room_finalize;

  props[PROP_ID] =
    g_param_spec_string ("id",
                         "Id",
                         "Room identifier",
                         NULL,
                         G_PARAM_READABLE);

  props[PROP_DISPLAY_NAME] =
    g_param_spec_string ("display-name",
                         "Display name",
                         "Display name",
                         NULL,
                         G_PARAM_READABLE);

  props[PROP_ICON] =
    g_param_spec_object ("icon",
                         "Icon",
                         "Icon",
                         G_TYPE_ICON,
                         G_PARAM_READABLE);

  props[PROP_CHANNEL] =
    g_param_spec_object ("channel",
                         "Channel",
                         "Channel",
                         TP_TYPE_CHANNEL,
                         G_PARAM_READWRITE);

  g_object_class_install_properties (object_class, LAST_PROP, props);

  signals[MEMBER_JOINED] =
    g_signal_new ("member-joined",
                  G_TYPE_FROM_CLASS (klass),
                  G_SIGNAL_RUN_LAST,
                  0,
                  NULL, NULL, NULL,
                  G_TYPE_NONE, 1, TP_TYPE_CONTACT);

  signals[MEMBER_LEFT] =
    g_signal_new ("member-left",
                  G_TYPE_FROM_CLASS (klass),
                  G_SIGNAL_RUN_LAST,
                  0,
                  NULL, NULL, NULL,
                  G_TYPE_NONE, 2, TP_TYPE_CONTACT, G_TYPE_STRING);

  signals[MEMBER_DISCONNECTED] =
    g_signal_new ("member-disconnected",
                  G_TYPE_FROM_CLASS (klass),
                  G_SIGNAL_RUN_LAST,
                  0,
                  NULL, NULL, NULL,
                  G_TYPE_NONE, 2, TP_TYPE_CONTACT, G_TYPE_STRING);

  signals[MEMBER_RENAMED] =
    g_signal_new ("member-renamed",
                  G_TYPE_FROM_CLASS (klass),
                  G_SIGNAL_RUN_LAST,
                  0,
                  NULL, NULL, NULL,
                  G_TYPE_NONE, 2, TP_TYPE_CONTACT, TP_TYPE_CONTACT);

  signals[MEMBER_KICKED] =
    g_signal_new ("member-kicked",
                  G_TYPE_FROM_CLASS (klass),
                  G_SIGNAL_RUN_LAST,
                  0,
                  NULL, NULL, NULL,
                  G_TYPE_NONE, 2, TP_TYPE_CONTACT, TP_TYPE_CONTACT);

  signals[MEMBER_BANNED] =
    g_signal_new ("member-banned",
                  G_TYPE_FROM_CLASS (klass),
                  G_SIGNAL_RUN_LAST,
                  0,
                  NULL, NULL, NULL,
                  G_TYPE_NONE, 2, TP_TYPE_CONTACT, TP_TYPE_CONTACT);
}

static void
polari_room_init (PolariRoom *room)
{
  room->priv = polari_room_get_instance_private (room);
}
