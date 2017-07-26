/*
 * SPDX-FileCopyrightText: 2017 Florian Müllner <fmuellner@gnome.org>
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

#pragma once

#include <gio/gio.h>

#include <libtracker-sparql/tracker-sparql.h>

G_BEGIN_DECLS

#define POLARI_TYPE_TPL_IMPORTER (polari_tpl_importer_get_type())

G_DECLARE_FINAL_TYPE (PolariTplImporter, polari_tpl_importer, POLARI, TPL_IMPORTER, GObject)

PolariTplImporter *polari_tpl_importer_new (void);

void   polari_tpl_importer_import_async  (PolariTplImporter   *self,
                                          GFile               *file,
                                          GCancellable        *cancellable,
                                          GAsyncReadyCallback  callback,
                                          gpointer             user_data);

TrackerBatch *polari_tpl_importer_import_finish (PolariTplImporter  *self,
                                                 GAsyncResult       *result,
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
