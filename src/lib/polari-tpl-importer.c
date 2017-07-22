/* polari-tpl-importer.c
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

#include "polari-tpl-importer.h"
#include "polari-message-private.h"

#include <string.h>
#include <stdio.h>

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

  GList *messages;
  GString *message_text;

  gboolean is_room;
} ImportData;

static void
message_list_free (GList *list)
{
  g_list_free_full (list, (GDestroyNotify)polari_message_free);
}

static void
import_data_free (ImportData *data)
{
  g_free (data->content);
  g_free (data->account_id);
  g_free (data->channel_name);
  g_markup_parse_context_free (data->context);

  message_list_free (data->messages);
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
tpl_log_start_element_handler (GMarkupParseContext  *context,
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

      data->messages = g_list_prepend (data->messages, message);
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
tpl_log_end_element_handler (GMarkupParseContext  *context,
                             const char           *element_name,
                             gpointer              user_data,
                             GError              **error)
{
  if (strcmp (element_name, "message") == 0)
    {
      GTask *task = user_data;
      ImportData *data = g_task_get_task_data (task);
      PolariMessage *message = data->messages->data;

      g_string_append_c (data->message_text, '\0');
      message->text = g_string_free (data->message_text, FALSE);
      data->message_text = NULL;
    }
}

static void
tpl_log_text_handler (GMarkupParseContext  *context,
                      const char           *text,
                      gsize                 length,
                      gpointer              user_data,
                      GError              **error)
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
        g_task_return_pointer (task,
                               g_list_reverse (g_steal_pointer (&data->messages)),
                               (GDestroyNotify)message_list_free);
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

  data = g_new0 (ImportData, 1);
  data->context = g_markup_parse_context_new (&tpl_log_parser, 0, task, NULL);
  data->content = g_malloc0 (CONTENT_BLOCK_SIZE);

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
 *
 * Returns: (transfer full) (element-type PolariMessage):
 */
GList *
polari_tpl_importer_import_finish (PolariTplImporter  *self,
                                   GAsyncResult       *result,
                                   char              **account_id,
                                   char              **channel_name,
                                   gboolean           *is_room,
                                   GError            **error)
{
  ImportData *data;

  g_return_val_if_fail (g_task_is_valid (result, self), NULL);

  data = g_task_get_task_data (G_TASK (result));
  if (account_id)
    *account_id = g_strdup (data->account_id);
  if (channel_name)
    *channel_name = g_strdup (data->channel_name);
  if (is_room)
    *is_room = data->is_room;

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
polari_tpl_importer_init (PolariTplImporter *self)
{
}
