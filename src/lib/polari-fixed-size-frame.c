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

#include "polari-fixed-size-frame.h"

struct _PolariFixedSizeFramePrivate {
  int width;
  int height;
};

enum
{
  PROP_0,

  PROP_WIDTH,
  PROP_HEIGHT,

  LAST_PROP
};

static GParamSpec *props[LAST_PROP];

static void
polari_fixed_size_frame_buildable_init (GtkBuildableIface *iface);

G_DEFINE_TYPE_WITH_CODE (PolariFixedSizeFrame, polari_fixed_size_frame,
                         GTK_TYPE_FRAME,
                         G_ADD_PRIVATE (PolariFixedSizeFrame)
                         G_IMPLEMENT_INTERFACE (GTK_TYPE_BUILDABLE,
                                                polari_fixed_size_frame_buildable_init))

static void
polari_fixed_size_frame_buildable_init (GtkBuildableIface *iface)
{
}

static void
queue_redraw (PolariFixedSizeFrame *self)
{
  GtkWidget *child = gtk_bin_get_child (GTK_BIN (self));

  if (child)
    gtk_widget_queue_resize (child);

  gtk_widget_queue_draw (GTK_WIDGET (self));
}

static void
polari_fixed_size_frame_set_width (PolariFixedSizeFrame *self,
                                       int                       width)
{
  if (self->priv->width != width)
    {
      self->priv->width = width;
      g_object_notify_by_pspec (G_OBJECT (self), props[PROP_WIDTH]);

      queue_redraw (self);
    }
}

static void
polari_fixed_size_frame_set_height (PolariFixedSizeFrame *self,
                                        int                       height)
{
  if (self->priv->height != height)
    {
      self->priv->height = height;
      g_object_notify_by_pspec (G_OBJECT (self), props[PROP_HEIGHT]);

      queue_redraw (self);
    }
}

static void
polari_fixed_size_frame_set_property (GObject      *object,
                                          guint         prop_id,
                                          const GValue *value,
                                          GParamSpec   *pspec)
{
  PolariFixedSizeFrame *self = POLARI_FIXED_SIZE_FRAME (object);

  switch (prop_id)
    {
    case PROP_WIDTH:
      polari_fixed_size_frame_set_width(self, g_value_get_int (value));
      break;
    case PROP_HEIGHT:
      polari_fixed_size_frame_set_height(self, g_value_get_int (value));
      break;
    default:
      G_OBJECT_WARN_INVALID_PROPERTY_ID (object, prop_id, pspec);
    }
}

static void
polari_fixed_size_frame_get_property (GObject    *object,
                                          guint       prop_id,
                                          GValue     *value,
                                          GParamSpec *pspec)
{
  PolariFixedSizeFrame *self = POLARI_FIXED_SIZE_FRAME (object);

  switch (prop_id)
    {
    case PROP_WIDTH:
        g_value_set_int (value, self->priv->width);
      break;
    case PROP_HEIGHT:
        g_value_set_int (value, self->priv->height);
      break;
    default:
      G_OBJECT_WARN_INVALID_PROPERTY_ID (object, prop_id, pspec);
    }
}

static void
polari_fixed_size_frame_get_preferred_width (GtkWidget *widget,
                                                 int       *minimum_size,
                                                 int       *natural_size)
{
  PolariFixedSizeFrame *self = POLARI_FIXED_SIZE_FRAME (widget);

  if (self->priv->width == -1)
    {
      GTK_WIDGET_CLASS (polari_fixed_size_frame_parent_class)->get_preferred_width (widget, minimum_size, natural_size);
    }
  else
    {
      *minimum_size = *natural_size = self->priv->width;
    }
}

static void
polari_fixed_size_frame_get_preferred_height (GtkWidget *widget,
                                                  int       *minimum_size,
                                                  int       *natural_size)
{
  PolariFixedSizeFrame *self = POLARI_FIXED_SIZE_FRAME (widget);

  if (self->priv->height == -1)
    {
      GTK_WIDGET_CLASS (polari_fixed_size_frame_parent_class)->get_preferred_height (widget, minimum_size, natural_size);
    }
  else
    {
      *minimum_size = *natural_size = self->priv->height;
    }
}

static void
polari_fixed_size_frame_class_init (PolariFixedSizeFrameClass *klass)
{
  GObjectClass *object_class = G_OBJECT_CLASS (klass);
  GtkWidgetClass *widget_class = GTK_WIDGET_CLASS (klass);
  GtkContainerClass *container_class = GTK_CONTAINER_CLASS (klass);

  object_class->get_property = polari_fixed_size_frame_get_property;
  object_class->set_property = polari_fixed_size_frame_set_property;
  widget_class->get_preferred_width =
    polari_fixed_size_frame_get_preferred_width;
  widget_class->get_preferred_height =
    polari_fixed_size_frame_get_preferred_height;
  gtk_container_class_handle_border_width (container_class);

  props[PROP_WIDTH] =
    g_param_spec_int ("width",
                      "Width",
                      "Fixed width of the widget, or -1 to use the child's "
                      "width",
                      -1,
                      G_MAXINT,
                      -1,
                      G_PARAM_READWRITE);

  props[PROP_HEIGHT] =
    g_param_spec_int ("height",
                      "Height",
                      "Fixed height of the widget, or -1 to use the child's "
                      "height",
                      -1,
                      G_MAXINT,
                      -1,
                      G_PARAM_READWRITE);

  g_object_class_install_properties (object_class, LAST_PROP, props);
}

static void
polari_fixed_size_frame_init (PolariFixedSizeFrame *self)
{
  self->priv = polari_fixed_size_frame_get_instance_private (self),
  self->priv->width = -1;
  self->priv->height = -1;
}
