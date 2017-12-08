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

#pragma once

#include <glib-object.h>

#include <telepathy-glib/telepathy-glib.h>

G_BEGIN_DECLS

#define POLARI_TYPE_ROOM            (polari_room_get_type())
G_DECLARE_FINAL_TYPE (PolariRoom, polari_room, POLARI, ROOM, GObject)

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
