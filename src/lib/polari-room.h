/* -*- Mode: C; tab-width: 8; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/*
 * SPDX-FileCopyrightText: 2013 Red Hat, Inc.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

#pragma once

#include <glib-object.h>

G_GNUC_BEGIN_IGNORE_DEPRECATIONS
#include <telepathy-glib/telepathy-glib.h>
G_GNUC_END_IGNORE_DEPRECATIONS

G_BEGIN_DECLS

#define POLARI_TYPE_ROOM            (polari_room_get_type())
G_DECLARE_FINAL_TYPE (PolariRoom, polari_room, POLARI, ROOM, GObject)

const char *polari_room_get_channel_error (PolariRoom *room);
void        polari_room_set_channel_error (PolariRoom *room,
                                           const char *channel_error);

gboolean polari_room_should_highlight_message (PolariRoom *room,
                                               const char *sender,
                                               const char *message);

void  polari_room_set_topic (PolariRoom *room, const char *topic);

void  polari_room_add_member    (PolariRoom *room, TpContact *member);
void  polari_room_remove_member (PolariRoom *room, TpContact *member);

void polari_room_send_identify_message_async (PolariRoom          *room,
                                              const char          *command,
                                              const char          *username,
                                              const char          *password,
                                              GAsyncReadyCallback  callback,
                                              gpointer             user_data);
gboolean polari_room_send_identify_message_finish (PolariRoom    *room,
                                                   GAsyncResult  *res,
                                                   GError       **error);

char *polari_create_room_id (TpAccount    *account,
                             const char   *name,
                             TpHandleType  type);

G_END_DECLS
