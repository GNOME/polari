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

#include "lib/polari-tpl-importer.h"
#include "lib/polari-message.h"
#include "lib/polari-util.h"

static GMainLoop *loop;
static guint status = 0;

static gboolean process_next (PolariTplImporter *importer,
                              GList             *files);

static void
import_ready (GObject      *source,
               GAsyncResult *result,
               gpointer      user_data)
{
  PolariTplImporter *importer = POLARI_TPL_IMPORTER (source);
  GList *messages, *l;
  GError *error = NULL;
  GList *files = user_data;
  TrackerSparqlConnection *connection;
  TrackerNamespaceManager *ns_manager;
  GString *sparql = g_string_new (NULL);
  char *account_id = NULL, *channel_name = NULL;
  gboolean is_room;

  messages = polari_tpl_importer_import_finish (importer,
                                                result,
                                                &account_id,
                                                &channel_name,
                                                &is_room,
                                                &error);

  if (error)
    {
      g_printerr ("Failed to import file: %s\n", error->message);
      g_error_free (error);
      status = 1;
      goto out;
    }

  connection = polari_util_get_tracker_connection (&error);
  ns_manager = tracker_sparql_connection_get_namespace_manager (connection);

  if (error)
    {
      g_printerr ("Failed to import file: %s\n", error->message);
      g_error_free (error);
      status = 1;
      goto out;
    }

  for (l = messages; l; l = l->next)
    {
      PolariMessage *message = l->data;
#if 1
      TrackerResource *res;
      char *tmp;

      res = polari_message_to_tracker_resource (message,
                                                account_id,
                                                channel_name,
                                                is_room);

      tmp = tracker_resource_print_sparql_update (res, ns_manager, NULL);
      g_string_append (sparql, tmp);
      g_object_unref (res);
      g_free (tmp);
#else
      g_print ("<%s> %s\n",
              polari_message_get_sender (tpl_message),
              polari_message_get_text (tpl_message));
#endif
    }
  g_list_free_full (messages, (GDestroyNotify)polari_message_free);

  if (sparql->len > 0)
    tracker_sparql_connection_update (connection, sparql->str,
                                      G_PRIORITY_DEFAULT, NULL, &error);

  if (error)
    {
      g_printerr ("Failed to import file: %s\n", error->message);
      g_error_free (error);
      status = 1;
    }

out:
  g_string_free (sparql, TRUE);

  g_free (account_id);
  g_free (channel_name);

  if (!process_next (importer, files))
    g_main_loop_quit (loop);
}

static gboolean
process_next (PolariTplImporter *importer,
              GList             *files)
{
  GFile *file;

  if (files == NULL)
    return FALSE;

  file = files->data;
  files = g_list_delete_link (files, files);

  polari_tpl_importer_import_async (importer, file, NULL, import_ready, files);
  g_object_unref (file);

  return TRUE;
}

static void
files_ready (GObject      *source,
             GAsyncResult *result,
             gpointer      user_data)
{
  PolariTplImporter *importer = POLARI_TPL_IMPORTER (source);
  GList *files;
  GError *error = NULL;

  files = polari_tpl_importer_collect_files_finish (importer, result, &error);

  if (error)
    {
      g_printerr ("Failed to collect log files: %s", error->message);
      g_error_free (error);
      status = 1;
    }

  if (!process_next (importer, files))
    g_main_loop_quit (loop);
}

static int
handle_import (int   argc,
               char *argv[])
{
  PolariTplImporter *importer;
  loop = g_main_loop_new (NULL, FALSE);
  importer = polari_tpl_importer_new ();

  polari_tpl_importer_collect_files_async (importer, NULL, files_ready, NULL);

  g_main_loop_run (loop);

  g_object_unref (importer);
  g_main_loop_unref (loop);

  return status;
}

static int
handle_query (int argc,
              char *argv[])
{
  TrackerSparqlConnection *connection;
  TrackerSparqlCursor *cursor;
  GError *error = NULL;
  char *sparql;

  connection = polari_util_get_tracker_connection (NULL);

  sparql = argv[1];

  cursor = tracker_sparql_connection_query (connection, sparql, NULL, &error);

  if (error)
    {
      g_printerr ("%s", error->message);
      g_error_free (error);
      return 1;
    }

  while (tracker_sparql_cursor_next (cursor, NULL, NULL))
    {
      int i;

      for (i = 0; i < tracker_sparql_cursor_get_n_columns (cursor); i++)
        {
          switch (tracker_sparql_cursor_get_value_type (cursor, i))
            {
            case TRACKER_SPARQL_VALUE_TYPE_STRING:
            case TRACKER_SPARQL_VALUE_TYPE_DATETIME:
            case TRACKER_SPARQL_VALUE_TYPE_URI:
              g_print ("%s\t", tracker_sparql_cursor_get_string (cursor, i, NULL));
              break;
            case TRACKER_SPARQL_VALUE_TYPE_INTEGER:
              g_print ("%ld\t", tracker_sparql_cursor_get_integer (cursor, i));
              break;
            case TRACKER_SPARQL_VALUE_TYPE_DOUBLE:
              g_print ("%.3f\t", tracker_sparql_cursor_get_double (cursor, i));
              break;
            case TRACKER_SPARQL_VALUE_TYPE_BOOLEAN:
              g_print ("%s\t", tracker_sparql_cursor_get_boolean (cursor, i) ? "true" : "false");
            case TRACKER_SPARQL_VALUE_TYPE_BLANK_NODE:
            case TRACKER_SPARQL_VALUE_TYPE_UNBOUND:
              g_print ("\t");
              break;
            }
          g_print ("\n");
        }
    }

  return status;
}

static void
usage ()
{
  g_printerr ("Usage:\n");
  g_printerr ("  polari-log-tool COMMAND ARGS\n");
  g_printerr ("\n");
  g_printerr ("Commands:\n");
  g_printerr ("  import         Import logs from telepathy-logger\n");
  g_printerr ("  query          Run a sparql query\n");
}

int
main (int   argc,
      char *argv[])
{
  const char *command;

  g_set_prgname ("polari-log-tool");
  g_set_application_name ("Polari Log Tool");

  if (argc < 2)
    {
      usage ();
      return 1;
    }

  command = argv[1];
  argc -= 1;
  argv += 1;

  if (g_str_equal (command, "import"))
    return handle_import (argc, argv);
  else if (g_str_equal (command, "query"))
    return handle_query (argc, argv);
}
