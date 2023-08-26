/*
 * SPDX-FileCopyrightText: 2017 Florian Müllner <fmuellner@gnome.org>
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

#include "polari-tpl-importer.h"
#include "polari-message-private.h"
#include "polari-util.h"

#include <string.h>
#include <stdio.h>

#define DEFAULT_GRAPH "polari:irc"

struct _PolariTplImporter
{
  GObject parent_instance;
};

G_DEFINE_TYPE (PolariTplImporter, polari_tpl_importer, G_TYPE_OBJECT)

static void stream_read_content (GInputStream *stream,
                                 GTask        *task);

PolariTplImporter *
polari_tpl_importer_new (void)
{
  return g_object_new (POLARI_TYPE_TPL_IMPORTER, NULL);
}

typedef struct {
  GMarkupParseContext *context;
  char *content;

  char *account_id;
  char *channel_name;

  PolariMessage *message;
  TrackerBatch *batch;
  GString *message_text;

  gboolean is_room;
} ImportData;

static void
import_data_free (ImportData *data)
{
  g_free (data->content);
  g_free (data->account_id);
  g_free (data->channel_name);
  g_markup_parse_context_free (data->context);

  g_clear_object (&data->batch);
  g_clear_pointer (&data->message, polari_message_free);

  if (data->message_text)
    g_string_free (data->message_text, TRUE);
  g_free (data);
}

static GDateTime *
parse_time_string (const char *str)
{
  int year, month, day, hour, min, sec, n_parsed;

  if (str == NULL)
    return NULL;

  year = month = day = hour = min = sec = 0;
  n_parsed = sscanf (str, "%4d%2d%2dT%2d:%2d:%2d",
                     &year, &month, &day,
                     &hour, &min, &sec);

  if (n_parsed != 3 && n_parsed != 6)
    return NULL;

  return g_date_time_new_utc (year, month, day, hour, min, sec);
}

static void
tpl_log_start_element_handler (GMarkupParseContext  *context G_GNUC_UNUSED,
                               const char           *element_name,
                               const char          **attribute_names,
                               const char          **attribute_values,
                               gpointer              user_data,
                               GError              **error)
{
  if (strcmp (element_name, "message") == 0)
    {
      GTask *task = user_data;
      ImportData *data = g_task_get_task_data (task);
      PolariMessage *message = polari_message_new_empty ();
      const char *time_str, *type_str;

      data->message = message;
      data->message_text = g_string_new (NULL);

      g_markup_collect_attributes (element_name,
                                   attribute_names,
                                   attribute_values,
                                   error,
                                   G_MARKUP_COLLECT_STRING,
                                   "id",
                                   NULL,
                                   G_MARKUP_COLLECT_STRING,
                                   "token",
                                   NULL,
                                   G_MARKUP_COLLECT_STRDUP,
                                   "name",
                                   &message->sender,
                                   G_MARKUP_COLLECT_STRING,
                                   "type",
                                   &type_str,
                                   G_MARKUP_COLLECT_STRING,
                                   "time",
                                   &time_str,
                                   G_MARKUP_COLLECT_BOOLEAN,
                                   "isuser",
                                   &message->is_self,
                                   G_MARKUP_COLLECT_INVALID);

      message->time = parse_time_string (time_str);
      message->is_action = strcmp (type_str, "action") == 0;
    }
}

static void
tpl_log_end_element_handler (GMarkupParseContext  *context G_GNUC_UNUSED,
                             const char           *element_name,
                             gpointer              user_data,
                             GError              **error G_GNUC_UNUSED)
{
  TrackerResource *resource;

  if (strcmp (element_name, "message") == 0)
    {
      GTask *task = user_data;
      ImportData *data = g_task_get_task_data (task);
      PolariMessage *message = data->message;

      g_string_append_c (data->message_text, '\0');
      message->text = g_string_free (data->message_text, FALSE);
      data->message_text = NULL;

      resource = polari_message_to_tracker_resource (message,
                                                     data->account_id,
                                                     data->channel_name,
                                                     data->is_room);
      tracker_batch_add_resource (data->batch,
                                  DEFAULT_GRAPH,
                                  resource);
      g_object_unref (resource);

      g_clear_pointer (&data->message, polari_message_free);
    }
}

static void
tpl_log_text_handler (GMarkupParseContext  *context G_GNUC_UNUSED,
                      const char           *text,
                      gsize                 length,
                      gpointer              user_data,
                      GError              **error G_GNUC_UNUSED)
{
  GTask *task = user_data;
  ImportData *data = g_task_get_task_data (task);

  if (data->message_text)
    g_string_append_len (data->message_text, text, length);
}

static GMarkupParser tpl_log_parser = {
  tpl_log_start_element_handler,
  tpl_log_end_element_handler,
  tpl_log_text_handler,
  NULL,
  NULL
};

static void
content_ready (GObject      *source,
               GAsyncResult *result,
               gpointer      user_data)
{
  GInputStream *stream = G_INPUT_STREAM (source);
  GTask *task = user_data;
  ImportData *data = g_task_get_task_data (task);
  GError *error = NULL;
  gssize count;

  count = g_input_stream_read_finish (stream, result, &error);

  if (count > 0)
    {
      if (!g_markup_parse_context_parse (data->context, data->content, count, &error))
        count = -1;
    }

  if (count <= 0)
    {
      if (count < 0)
        g_task_return_error (task, error);
      else
        g_task_return_pointer (task, g_object_ref (data->batch), g_object_unref);

      g_object_unref (task);

      g_input_stream_close_async (stream, G_PRIORITY_DEFAULT, NULL, NULL, NULL);
      g_object_unref (stream);
    }
  else
    {
      stream_read_content (stream, task);
    }
}

#define CONTENT_BLOCK_SIZE 8192

static void
stream_read_content (GInputStream *stream,
                     GTask        *task)
{
  ImportData *data = g_task_get_task_data (task);

  g_input_stream_read_async (stream,
                             data->content,
                             CONTENT_BLOCK_SIZE,
                             G_PRIORITY_DEFAULT,
                             g_task_get_cancellable (task),
                             content_ready,
                             task);
}

static void
get_channel_and_account_info (GFile     *file,
                              char     **account_id,
                              char     **channel_name,
                              gboolean  *is_room)
{
  GFile *parent;
  char *path, *dirname;

  parent = g_file_get_parent (file);

  path = g_file_get_path (parent);
  dirname = g_path_get_dirname (path);
  g_free (path);

  *channel_name = g_file_get_basename (parent);
  *account_id = g_path_get_basename (dirname);

  if (strcmp (*account_id, "chatrooms") == 0)
    {
      char *tmp = g_path_get_dirname (dirname);
      g_free (*account_id);

      *account_id = g_path_get_basename (tmp);
      g_free (tmp);

      *is_room = TRUE;
    }
  else
    {
      *is_room = FALSE;
    }

  g_strdelimit (*account_id, "_", '/');

  g_object_unref (parent);
  g_free (dirname);
}

static void
file_read_ready (GObject      *source,
                 GAsyncResult *result,
                 gpointer      user_data)
{
  TrackerSparqlConnection *connection;
  GTask *task = user_data;
  GFileInputStream *input;
  GError *error = NULL;
  ImportData *data;

  input = g_file_read_finish (G_FILE (source), result, &error);
  g_object_unref (source);

  if (error)
    {
      g_task_return_error (task, error);
      g_object_unref (task);
      return;
    }

  connection = polari_util_get_tracker_connection (&error);

  if (error)
    {
      g_task_return_error (task, error);
      g_object_unref (task);
      return;
    }

  data = g_new0 (ImportData, 1);
  data->context = g_markup_parse_context_new (&tpl_log_parser, 0, task, NULL);
  data->content = g_malloc0 (CONTENT_BLOCK_SIZE);
  data->batch = tracker_sparql_connection_create_batch (connection);

  get_channel_and_account_info (G_FILE (source),
                                &data->account_id, &data->channel_name, &data->is_room);

  g_task_set_task_data (task, data, (GDestroyNotify)import_data_free);
  stream_read_content (G_INPUT_STREAM (input), task);
}

void
polari_tpl_importer_import_async (PolariTplImporter   *self,
                                  GFile               *file,
                                  GCancellable        *cancellable,
                                  GAsyncReadyCallback  callback,
                                  gpointer             user_data)
{
  GTask *task;

  g_return_if_fail (POLARI_IS_TPL_IMPORTER (self));

  task = g_task_new (self, cancellable, callback, user_data);
  g_task_set_source_tag (task, polari_tpl_importer_import_async);

  g_file_read_async (g_object_ref (file),
                     G_PRIORITY_DEFAULT,
                     cancellable,
                     file_read_ready,
                     task);
}

/**
 * polari_tpl_importer_import_finish:
 * @self:
 * @result:
 * @error:
 *
 * Returns: (transfer full):
 **/
TrackerBatch *
polari_tpl_importer_import_finish (PolariTplImporter  *self,
                                   GAsyncResult       *result,
                                   GError            **error)
{
  g_return_val_if_fail (g_task_is_valid (result, self), NULL);

  return g_task_propagate_pointer (G_TASK (result), error);
}

static void
free_file_list (GList *files)
{
  g_list_free_full (files, g_object_unref);
}

static GList *
collect_files_recursively (GFile         *dir,
                           GCancellable  *cancellable,
                           GError       **error)
{
  GFileEnumerator *direnum;
  GFileInfo *info;
  GFile *child;
  GList *files = NULL;

  direnum = g_file_enumerate_children (dir,
                                       G_FILE_ATTRIBUTE_STANDARD_TYPE,
                                       G_FILE_QUERY_INFO_NONE,
                                       cancellable,
                                       error);

  if (error && *error)
    return NULL;

  while (g_file_enumerator_iterate (direnum, &info, &child, cancellable, error))
    {
      if (!info)
        break;

      if (g_file_info_get_file_type (info) == G_FILE_TYPE_DIRECTORY)
        files = g_list_concat (files, collect_files_recursively (child, cancellable, error));
      else
        files = g_list_prepend (files, g_object_ref (child));

      if (error && *error)
        break;
    }
  g_object_unref (direnum);

  if (error && *error)
    {
      free_file_list (files);
      return NULL;
    }

  return files;
}

static GList *
collect_log_files (GFile         *dir,
                   GCancellable  *cancellable,
                   GError       **error)
{
  GFileEnumerator *direnum;
  GFileInfo *info;
  GFile *child;
  GList *files = NULL;

  direnum = g_file_enumerate_children (dir,
                                       G_FILE_ATTRIBUTE_STANDARD_NAME,
                                       G_FILE_QUERY_INFO_NONE,
                                       cancellable,
                                       error);

  if (error && *error)
    return NULL;

  while (g_file_enumerator_iterate (direnum, &info, &child, cancellable, error))
    {
      if (!info)
        break;

      if (!g_str_has_prefix (g_file_info_get_name (info), "idle_irc_"))
        continue;

      files = g_list_concat (files, collect_files_recursively (child, cancellable, error));

      if (error && *error)
        break;
    }
  g_object_unref (direnum);

  if (error && *error)
    {
      free_file_list (files);
      return NULL;
    }

  return files;
}

static void
collect_files_thread_func (GTask        *task,
                           gpointer      source_object G_GNUC_UNUSED,
                           gpointer      task_data G_GNUC_UNUSED,
                           GCancellable *cancellable)
{
  g_autoptr(GFile) log_root = NULL;
  const char *user_data_dir;
  g_autofree char *path = NULL;
  GList *files;
  GError *error = NULL;

  user_data_dir = g_getenv ("TPL_LOG_DIR");
  if (user_data_dir)
    {
      g_autofree char *try_dir = NULL;

      try_dir = g_build_path (G_DIR_SEPARATOR_S,
                              user_data_dir, "TpLogger", "logs",
                              NULL);
      if (!g_file_test (try_dir, G_FILE_TEST_EXISTS))
        user_data_dir = NULL;
    }

  if (!user_data_dir)
    user_data_dir = g_get_user_data_dir ();

  path = g_build_filename (user_data_dir, "TpLogger", "logs", NULL);
  log_root = g_file_new_for_path (path);

  files = collect_log_files (log_root, cancellable, &error);

  if (error)
    g_task_return_error (task, error);
  else
    g_task_return_pointer (task, files, (GDestroyNotify)free_file_list);

  g_object_unref (task);
}

void
polari_tpl_importer_collect_files_async  (PolariTplImporter   *self,
                                          GCancellable        *cancellable,
                                          GAsyncReadyCallback  callback,
                                          gpointer             user_data)
{
  GTask *task;

  g_return_if_fail (POLARI_IS_TPL_IMPORTER (self));

  task = g_task_new (self, cancellable, callback, user_data);
  g_task_set_source_tag (task, polari_tpl_importer_collect_files_async);

  g_task_run_in_thread (task, collect_files_thread_func);
}

/**
 * polari_tpl_importer_collect_files_finish:
 *
 * Returns: (transfer full) (element-type GFile):
 */
GList *
polari_tpl_importer_collect_files_finish (PolariTplImporter  *self,
                                          GAsyncResult       *result,
                                          GError            **error)
{
  g_return_val_if_fail (g_task_is_valid (result, self), NULL);
  return g_task_propagate_pointer (G_TASK (result), error);
}

static void
polari_tpl_importer_finalize (GObject *object)
{
  //PolariTplImporter *self = (PolariTplImporter *)object;

  G_OBJECT_CLASS (polari_tpl_importer_parent_class)->finalize (object);
}

static void
polari_tpl_importer_class_init (PolariTplImporterClass *klass)
{
  GObjectClass *object_class = G_OBJECT_CLASS (klass);

  object_class->finalize = polari_tpl_importer_finalize;
}

static void
polari_tpl_importer_init (PolariTplImporter *self G_GNUC_UNUSED)
{
}
