/* polari-tpl-importer.h
 *
 * Copyright (C) 2017 Florian Müllner <fmuellner@gnome.org>
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
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

#ifndef POLARI_TPL_IMPORTER_H
#define POLARI_TPL_IMPORTER_H

#include <gio/gio.h>

G_BEGIN_DECLS

#define POLARI_TYPE_TPL_IMPORTER (polari_tpl_importer_get_type())

G_DECLARE_FINAL_TYPE (PolariTplImporter, polari_tpl_importer, POLARI, TPL_IMPORTER, GObject)

PolariTplImporter *polari_tpl_importer_new (void);

void   polari_tpl_importer_import_async  (PolariTplImporter   *self,
                                          GFile               *file,
                                          GCancellable        *cancellable,
                                          GAsyncReadyCallback  callback,
                                          gpointer             user_data);

GList *polari_tpl_importer_import_finish (PolariTplImporter  *self,
                                          GAsyncResult       *result,
                                          char              **account_id,
                                          char              **channel_name,
                                          gboolean           *is_room,
                                          GError            **error);

void   polari_tpl_importer_collect_files_async  (PolariTplImporter   *self,
                                                 GCancellable        *cancellable,
                                                 GAsyncReadyCallback  callback,
                                                 gpointer             user_data);

GList *polari_tpl_importer_collect_files_finish (PolariTplImporter  *self,
                                                 GAsyncResult       *result,
                                                 GError            **error);

#define POLARI_TYPE_TPL_MESSAGE (polari_tpl_message_get_type())

G_END_DECLS

#endif /* POLARI_TPL_IMPORTER_H */

