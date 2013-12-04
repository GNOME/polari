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
  TpAccount *account;
  TpChannel *channel;

  GIcon *icon;
  char  *channel_name;
  char  *display_name;
  char  *topic;

  char *self_nick;

  TpHandleType type;

  guint self_contact_notify_id;
  guint group_contacts_changed_id;

  TpProxySignalConnection *properties_changed_id;
};

enum
{
  PROP_0,

  PROP_ID,
  PROP_ICON,
  PROP_ACCOUNT,
  PROP_TYPE,
  PROP_CHANNEL_NAME,
  PROP_CHANNEL,
  PROP_DISPLAY_NAME,
  PROP_TOPIC,

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

  MEMBERS_CHANGED,

  LAST_SIGNAL
};

static guint signals[LAST_SIGNAL];

static GRegex *color_code_regex = NULL;

G_DEFINE_TYPE_WITH_PRIVATE (PolariRoom, polari_room, G_TYPE_OBJECT)

#define tp_properties_changed_cb \
        tp_cli_dbus_properties_signal_callback_properties_changed
#define tp_properties_get_all_cb \
        tp_cli_dbus_properties_callback_for_get_all

static char *
polari_create_room_id (TpAccount    *account,
                       const char   *name,
                       TpHandleType  type)
{
  return g_strdup_printf ("%s/%d/%s",
                          tp_proxy_get_object_path (TP_PROXY (account)),
                          type, name);
}

/**
 * polari_room_id_from_channel:
 * @channel: a TpChannel
 *
 * Returns: (transfer full): a room ID corresponding to @channel
 */
char *
polari_create_room_id_from_channel (TpChannel *channel)
{
  TpAccount *account;
  TpHandleType type;
  const char *name;

  g_return_val_if_fail (TP_IS_CHANNEL (channel), NULL);

  account = tp_connection_get_account (tp_channel_get_connection (channel));
  name = tp_channel_get_identifier (channel);
  tp_channel_get_handle (channel, &type);
  return polari_create_room_id (account, name, type);
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
  result = strstr(text, priv->self_nick) != NULL;
  g_free (text);

  return result;
}

void
polari_room_set_topic (PolariRoom *room,
                       const char *topic)
{
  g_return_if_fail (POLARI_IS_ROOM (room));

  tp_cli_channel_interface_subject_call_set_subject (room->priv->channel, -1,
      topic, NULL, NULL, NULL, NULL);

}

void
polari_room_add_member (PolariRoom *room,
                        TpContact  *member)
{
  TpChannel *channel;

  g_return_if_fail (POLARI_IS_ROOM (room));

  channel = room->priv->channel;

  if (!tp_proxy_has_interface_by_id (TP_PROXY (channel),
                                     TP_IFACE_QUARK_CHANNEL_INTERFACE_GROUP))
    return;

  {
    TpHandle handle = tp_contact_get_handle (member);
    GArray handles = { (char *)&handle, 1 };

    tp_cli_channel_interface_group_call_add_members (channel,
                                   -1, &handles, NULL, NULL, NULL, NULL, NULL);
  }
}

void
polari_room_remove_member (PolariRoom *room,
                           TpContact  *member)
{
  TpChannel *channel;

  g_return_if_fail (POLARI_IS_ROOM (room));

  channel = room->priv->channel;

  if (!tp_proxy_has_interface_by_id (TP_PROXY (channel),
                                     TP_IFACE_QUARK_CHANNEL_INTERFACE_GROUP))
    return;

  {
    TpHandle handle = tp_contact_get_handle (member);
    GArray handles = { (char *)&handle, 1 };

    tp_cli_channel_interface_group_call_remove_members (channel,
                                   -1, &handles, NULL, NULL, NULL, NULL, NULL);
  }
}

int
polari_room_compare (PolariRoom *room,
                     PolariRoom *other)
{
  TpAccount *account1, *account2;

  g_return_val_if_fail (POLARI_IS_ROOM (room) && POLARI_IS_ROOM (other), 0);
  g_return_val_if_fail (room->priv->account && other->priv->account, 0);

  account1 = room->priv->account;
  account2 = other->priv->account;

  if (account1 != account2)
    return strcmp (tp_account_get_display_name (account1),
                   tp_account_get_display_name (account2));

  if (room->priv->type != other->priv->type)
    return room->priv->type == TP_HANDLE_TYPE_ROOM ? -1 : 1;

  return strcmp (room->priv->display_name, other->priv->display_name);
}

static char *
strip_color_codes (const char *string) {
  if (G_UNLIKELY (color_code_regex == NULL))
    color_code_regex = g_regex_new ("\x03(?:[0-9]{1,2}(?:,[0-9]{1,2})?)?",
                                    G_REGEX_OPTIMIZE, 0, NULL);
  return g_regex_replace_literal (color_code_regex, string, -1, 0, "", 0, NULL);
}

static void
update_self_nick (PolariRoom *room)
{
  TpConnection *conn;
  TpContact *self;
  const char *nick;
  int len;

  PolariRoomPrivate *priv = room->priv;

  g_clear_pointer (&priv->self_nick, g_free);

  conn = tp_channel_get_connection (room->priv->channel);
  self = tp_connection_get_self_contact (conn);

  nick = tp_contact_get_alias (self);
  len = strlen (nick);
  do
    if (g_ascii_isalnum (nick[len - 1]))
        break;
  while (--len > 0);

  priv->self_nick = g_strndup (nick, len);
}

static void
update_identifier (PolariRoom *room)
{
  PolariRoomPrivate *priv = room->priv;

  g_clear_pointer (&priv->display_name, g_free);
  if (priv->channel_name)
    priv->display_name = g_strdup (priv->channel_name +
                                   (priv->channel_name[0] == '#' ? 1 : 0));

  g_object_notify_by_pspec (G_OBJECT (room), props[PROP_DISPLAY_NAME]);
}

static void
update_icon (PolariRoom *room)
{
  PolariRoomPrivate *priv = room->priv;

  g_clear_object (&priv->icon);

  if (priv->channel &&
      !tp_proxy_has_interface_by_id (TP_PROXY (priv->channel),
                                     TP_IFACE_QUARK_CHANNEL_INTERFACE_GROUP))
    priv->icon = g_themed_icon_new ("avatar-default-symbolic");

  g_object_notify_by_pspec (G_OBJECT (room), props[PROP_ICON]);
}

static void
on_self_contact_notify (GObject    *object,
                        GParamSpec *pspec,
                        gpointer    user_data)
{
  update_self_nick (POLARI_ROOM (user_data));
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
  const char *raw_message;
  char *message = NULL;
  int i;

  reason = tp_asv_get_uint32 (details, "change-reason", NULL);
  raw_message = tp_asv_get_string (details, "message");

  if (raw_message)
    message = strip_color_codes (raw_message);

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

  g_signal_emit (user_data, signals[MEMBERS_CHANGED], 0);
  g_free (message);
}

static void
update_subject (PolariRoom *room,
                GHashTable *properties)
{
  PolariRoomPrivate *priv = room->priv;
  const char *subject;

  subject = tp_asv_get_string (properties, "Subject");
  if (subject == NULL || g_strcmp0 (priv->topic, subject) == 0)
    return;

  g_free (priv->topic);
  priv->topic = *subject ? g_strdup (subject) : NULL;

  g_object_notify_by_pspec (G_OBJECT (room), props[PROP_TOPIC]);
}

static void
subject_get_all (TpProxy *proxy,
                 GHashTable *properties,
                 GError     *error,
                 gpointer    user_data,
                 GObject    *object)
{
  if (error)
    return;

  update_subject (POLARI_ROOM (user_data), properties);
}

static void
properties_changed (TpProxy *proxy,
                    const char *iface_name,
                    GHashTable *changed,
                    const char *invalidated,
                    gpointer    data,
                    GObject    *weak_ref)
{
  if (strcmp (iface_name, TP_IFACE_CHANNEL_INTERFACE_SUBJECT) != 0)
    return;

  update_subject (POLARI_ROOM (data), changed);
}

static void
polari_room_set_account (PolariRoom *room,
                         TpAccount  *account)
{
  PolariRoomPrivate *priv;

  g_return_if_fail (POLARI_IS_ROOM (room));
  g_return_if_fail (account == NULL || TP_IS_ACCOUNT (account));

  priv = room->priv;

  if (priv->account == account)
    return;

  if (priv->account)
    g_object_unref (priv->account);
  priv->account = g_object_ref (account);

  g_object_notify_by_pspec (G_OBJECT (room), props[PROP_ACCOUNT]);
}

static void
polari_room_set_type (PolariRoom *room,
                      int         type)
{
  PolariRoomPrivate *priv;

  g_return_if_fail (POLARI_IS_ROOM (room));

  priv = room->priv;

  if (priv->type == type)
    return;

  priv->type = type;

  g_object_notify_by_pspec (G_OBJECT (room), props[PROP_TYPE]);
}

static void
polari_room_set_channel_name (PolariRoom *room,
                              const char *channel_name)
{
  PolariRoomPrivate *priv;

  g_return_if_fail (POLARI_IS_ROOM (room));

  priv = room->priv;

  if (priv->channel_name)
    g_free (priv->channel_name);
  priv->channel_name = g_strdup (channel_name);

  update_identifier (room);

  g_object_notify_by_pspec (G_OBJECT (room), props[PROP_CHANNEL_NAME]);
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
      g_signal_handler_disconnect (priv->channel, priv->group_contacts_changed_id);
      g_signal_handler_disconnect (tp_channel_get_connection (priv->channel),
                                   priv->self_contact_notify_id);

      tp_proxy_signal_connection_disconnect (priv->properties_changed_id);

      g_clear_object (&priv->channel);
    }

  if (channel)
    {
      TpConnection *connection = tp_channel_get_connection (channel);
      TpHandleType type;

      priv->channel = g_object_ref (channel);

      tp_channel_get_handle (channel, &type);
      polari_room_set_type (room, type);
      polari_room_set_channel_name (room, tp_channel_get_identifier (channel));
      polari_room_set_account (room, tp_connection_get_account (connection));

      tp_cli_dbus_properties_call_get_all (channel, -1,
                                     TP_IFACE_CHANNEL_INTERFACE_SUBJECT,
                                     (tp_properties_get_all_cb)subject_get_all,
                                     room, NULL, NULL);


      priv->self_contact_notify_id =
        g_signal_connect (tp_channel_get_connection (channel),
                          "notify::self-contact",
                          G_CALLBACK (on_self_contact_notify), room);
      priv->group_contacts_changed_id =
        g_signal_connect (channel, "group-contacts-changed",
                          G_CALLBACK (on_group_contacts_changed), room);
      priv->properties_changed_id =
        tp_cli_dbus_properties_connect_to_properties_changed (
                                 channel,
                                 (tp_properties_changed_cb) properties_changed,
                                 room, NULL, NULL, NULL);
    }
  else
    {
      polari_room_set_type (room, TP_HANDLE_TYPE_NONE);
      polari_room_set_channel_name (room, NULL);
      polari_room_set_account (room, NULL);
    }

  g_object_freeze_notify (G_OBJECT (room));

  update_self_nick (room);
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
      g_value_take_string (value,
                           polari_create_room_id (priv->account,
                                                  priv->channel_name,
                                                  priv->type));
      break;
    case PROP_ICON:
      g_value_set_object (value, priv->icon);
      break;
    case PROP_ACCOUNT:
      g_value_set_object (value, priv->account);
      break;
    case PROP_TYPE:
      g_value_set_int (value, priv->type);
      break;
    case PROP_CHANNEL_NAME:
      g_value_set_string (value, priv->channel_name);
      break;
    case PROP_CHANNEL:
      g_value_set_object (value, priv->channel);
      break;
    case PROP_DISPLAY_NAME:
      g_value_set_string (value, priv->display_name);
      break;
    case PROP_TOPIC:
      g_value_set_string (value, priv->topic);
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
  PolariRoomPrivate *priv = POLARI_ROOM (object)->priv;

  polari_room_set_channel (POLARI_ROOM (object), NULL);
  g_clear_object (&priv->account);
  G_OBJECT_CLASS (polari_room_parent_class)->dispose (object);
}

static void
polari_room_finalize (GObject *object)
{
  PolariRoomPrivate *priv = POLARI_ROOM (object)->priv;

  g_clear_pointer (&priv->channel_name, g_free);
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

  props[PROP_TOPIC] =
    g_param_spec_string ("topic",
                         "Topic",
                         "Topic",
                         NULL,
                         G_PARAM_READABLE);

  props[PROP_ICON] =
    g_param_spec_object ("icon",
                         "Icon",
                         "Icon",
                         G_TYPE_ICON,
                         G_PARAM_READABLE);

  props[PROP_ACCOUNT] =
    g_param_spec_object ("account",
                         "Account",
                         "Account",
                         TP_TYPE_ACCOUNT,
                         G_PARAM_READABLE);

  props[PROP_TYPE] =
    g_param_spec_int ("type",
                       "Type",
                       "Type",
                       TP_HANDLE_TYPE_NONE,
                       TP_HANDLE_TYPE_GROUP,
                       TP_HANDLE_TYPE_ROOM,
                       G_PARAM_READABLE);

  props[PROP_CHANNEL_NAME] =
    g_param_spec_string ("channel-name",
                         "Channel name",
                         "Channel name",
                         NULL,
                         G_PARAM_READABLE);

  props[PROP_CHANNEL] =
    g_param_spec_object ("channel",
                         "Channel",
                         "Channel",
                         TP_TYPE_CHANNEL,
                         G_PARAM_READWRITE | G_PARAM_CONSTRUCT_ONLY);

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

  signals[MEMBERS_CHANGED] =
    g_signal_new ("members-changed",
                  G_TYPE_FROM_CLASS (klass),
                  G_SIGNAL_RUN_LAST,
                  0,
                  NULL, NULL, NULL,
                  G_TYPE_NONE, 0);
}

static void
polari_room_init (PolariRoom *room)
{
  room->priv = polari_room_get_instance_private (room);
}
