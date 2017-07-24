/* polari-message.h
 *
 * Copyright (C) 2017 Florian Müllner <fmuellner@gnome.org>
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

#ifndef POLARI_MESSAGE_H
#define POLARI_MESSAGE_H

#include <telepathy-glib/telepathy-glib.h>
#include <telepathy-logger/telepathy-logger.h>

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
PolariMessage   *polari_message_new_from_tpl_event  (TplEvent  *tpl_event);

PolariMessage   *polari_message_copy  (PolariMessage *self);
void             polari_message_free  (PolariMessage *self);

const char        *polari_message_get_text   (PolariMessage *message);
const char        *polari_message_get_sender (PolariMessage *message);
GDateTime         *polari_message_get_time   (PolariMessage *message);
gboolean           polari_message_is_action  (PolariMessage *message);
gboolean           polari_message_is_self    (PolariMessage *message);

G_DEFINE_AUTOPTR_CLEANUP_FUNC (PolariMessage, polari_message_free)

G_END_DECLS

#endif /* POLARI_MESSAGE_H */

