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

#include "lib/polari-util.h"

static guint status = 0;

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

  if (g_str_equal (command, "query"))
    return handle_query (argc, argv);
}
