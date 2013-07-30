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

#include "polari-drag-helper.h"

void
polari_drag_dest_request_data (GtkWidget      *widget,
                               GdkDragContext *context,
                               guint32         time_)
{
  GdkAtom target;

  target = gtk_drag_dest_find_target (widget, context, NULL);
  if (target == GDK_NONE)
    return;

  gtk_drag_get_data (widget, context, target, time_);
}

gboolean
polari_drag_dest_supports_target (GtkWidget      *widget,
                                  GdkDragContext *context)
{
  return gtk_drag_dest_find_target (widget, context, NULL) != GDK_NONE;
}

guint
polari_drag_dest_find_target (GtkWidget      *widget,
                              GdkDragContext *context)
{
  GdkAtom target;
  guint info;

  target = gtk_drag_dest_find_target (widget, context, NULL);
  gtk_target_list_find (gtk_drag_dest_get_target_list (widget), target, &info);

  return info;
}
