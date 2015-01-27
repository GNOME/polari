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

#define POLARI_TYPE_FIXED_SIZE_FRAME            (polari_fixed_size_frame_get_type())
G_DECLARE_FINAL_TYPE(PolariFixedSizeFrame, polari_fixed_size_frame, POLARI, FIXED_SIZE_FRAME, GtkFrame)

G_END_DECLS

#endif
