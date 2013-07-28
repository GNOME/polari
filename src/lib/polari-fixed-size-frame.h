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

#ifndef __POLARI_FIXED_SIZE_FRAME_H__
#define __POLARI_FIXED_SIZE_FRAME_H__

#include <gtk/gtk.h>

G_BEGIN_DECLS

typedef struct _PolariFixedSizeFrame        PolariFixedSizeFrame;
typedef struct _PolariFixedSizeFrameClass   PolariFixedSizeFrameClass;
typedef struct _PolariFixedSizeFramePrivate PolariFixedSizeFramePrivate;

#define POLARI_TYPE_FIXED_SIZE_FRAME            (polari_fixed_size_frame_get_type())
#define POLARI_FIXED_SIZE_FRAME(o)              (G_TYPE_CHECK_INSTANCE_CAST ((o), POLARI_TYPE_FIXED_SIZE_FRAME, PolariFixedSizeFrame))
#define POLARI_IS_FIXED_SIZE_FRAME(o)           (G_TYPE_CHECK_INSTANCE_TYPE ((o), POLARI_TYPE_FIXED_SIZE_FRAME))
#define POLARI_FIXED_SIZE_FRAME_CLASS(klass)    (G_TYPE_CHECK_CLASS_CAST ((klass), POLARI_TYPE_FIXED_SIZE_FRAME, PolariFixedSizeFrameClass))
#define POLARI_IS_FIXED_SIZE_FRAME_CLASS(klass) (G_TYPE_CHECK_CLASS_TYPE ((klass), POLARI_TYPE_FIXED_SIZE_FRAME))
#define POLARI_FIXED_SIZE_FRAME_GET_CLASS(o)    (G_TYPE_INSTANCE_GET_CLASS ((o), POLARI_TYPE_FIXED_SIZE_FRAME, PolariFixedSizeFrameClass))

struct _PolariFixedSizeFrame {
  GtkFrame parent_instance;

  PolariFixedSizeFramePrivate *priv;
};

struct _PolariFixedSizeFrameClass {
  GtkFrameClass parent_class;
};

GType polari_fixed_size_frame_get_type (void) G_GNUC_CONST;

G_END_DECLS

#endif
