/*
 * SPDX-FileCopyrightText: 2017 Florian Müllner <fmuellner@gnome.org>
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

#pragma once

#include <libtracker-sparql/tracker-sparql.h>
G_GNUC_BEGIN_IGNORE_DEPRECATIONS
#include <telepathy-glib/telepathy-glib.h>
G_GNUC_END_IGNORE_DEPRECATIONS

G_BEGIN_DECLS

GType polari_message_get_type (void) G_GNUC_CONST;
#define POLARI_TYPE_MESSAGE (polari_message_get_type())

typedef struct _PolariMessage PolariMessage;

PolariMessage   *polari_message_new                 (const char *text,
                                                     const char *sender,
                                                     GDateTime  *time,
                                                     gboolean    is_action,
                                                     gboolean    is_self);
PolariMessage   *polari_message_new_from_tp_message (TpMessage *tp_message);

PolariMessage   *polari_message_copy  (PolariMessage *self);
void             polari_message_free  (PolariMessage *self);

const char        *polari_message_get_text   (PolariMessage *message);
const char        *polari_message_get_sender (PolariMessage *message);
GDateTime         *polari_message_get_time   (PolariMessage *message);
gboolean           polari_message_is_action  (PolariMessage *message);
gboolean           polari_message_is_self    (PolariMessage *message);

TrackerResource *polari_message_to_tracker_resource (PolariMessage *message,
                                                     const char    *account_id,
                                                     const char    *channel_name,
                                                     gboolean       is_room);

G_DEFINE_AUTOPTR_CLEANUP_FUNC (PolariMessage, polari_message_free)

G_END_DECLS

