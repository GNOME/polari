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

#ifndef __POLARI_ROOM_H__
#define __POLARI_ROOM_H__

#include <glib-object.h>

#include <telepathy-glib/telepathy-glib.h>

G_BEGIN_DECLS

typedef struct _PolariRoom        PolariRoom;
typedef struct _PolariRoomClass   PolariRoomClass;
typedef struct _PolariRoomPrivate PolariRoomPrivate;

#define POLARI_TYPE_ROOM            (polari_room_get_type())
#define POLARI_ROOM(obj)            (G_TYPE_CHECK_INSTANCE_CAST ((obj), POLARI_TYPE_ROOM, PolariRoom))
#define POLARI_ROOM_CLASS(klass)    (G_TYPE_CHECK_CLASS_CAST ((klass), POLARI_TYPE_ROOM, PolariRoomClass))
#define POLARI_IS_ROOM(obj)         (G_TYPE_CHECK_INSTANCE_TYPE ((obj), POLARI_TYPE_ROOM))
#define POLARI_IS_ROOM_CLASS(klass) (G_TYPE_CHECK_CLASS_TYPE ((klass), POLARI_TYPE_ROOM))
#define POLARI_ROOM_GET_CLASS(obj)  (G_TYPE_INSTANCE_GET_CLASS ((obj), POLARI_TYPE_ROOM, PolariRoomClass))

struct _PolariRoom {
    GObject parent_instance;

    PolariRoomPrivate *priv;
};

struct _PolariRoomClass {
    GObjectClass parent_class;
};

GType polari_room_get_type (void) G_GNUC_CONST;

void  polari_room_send    (PolariRoom *room, const char *message);
void  polari_room_leave   (PolariRoom *room);

gboolean polari_room_should_highlight_message (PolariRoom *room,
                                               TpMessage *message);

int   polari_room_compare (PolariRoom *room, PolariRoom *other);

G_END_DECLS

#endif /* __POLARI_ROOM_H__ */
