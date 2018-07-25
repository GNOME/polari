#include <girepository.h>
#include <gjs/gjs.h>

#include "config.h"

G_DEFINE_AUTOPTR_CLEANUP_FUNC (GjsContext, g_object_unref)

const char *src =
  "imports.package.start({ name: '" PACKAGE_NAME "',"
  "                        version: '" PACKAGE_VERSION "',"
  "                        prefix: '" PREFIX "',"
  "                        libdir: '" LIBDIR "' });";

int
main (int argc, char *argv[])
{
  const char *search_path[] = { "resource:///org/gnome/Polari/js", NULL };
  g_autoptr (GOptionContext) option_context = NULL;
  g_autoptr (GError) error = NULL;
  g_autoptr (GjsContext) context = NULL;
  gboolean debugger = FALSE;
  int status;

  GOptionEntry entries[] =
    {
      { "debugger", 'd', 0, G_OPTION_ARG_NONE, &debugger, NULL, NULL }
    };

  g_irepository_prepend_search_path (PKGLIBDIR);

  context = g_object_new (GJS_TYPE_CONTEXT,
                          "search-path", search_path,
                          NULL);

  option_context = g_option_context_new ("");
  g_option_context_set_help_enabled (option_context, FALSE);
  g_option_context_set_ignore_unknown_options (option_context, TRUE);
  g_option_context_add_main_entries (option_context, entries, NULL);

  g_option_context_parse (option_context, &argc, &argv, NULL);

  if (debugger)
    gjs_context_setup_debugger_console (context);

  if (!gjs_context_define_string_array (context, "ARGV",
                                        argc - 1, (const char **)argv + 1,
                                        &error))
    {
      g_message ("Failed to define ARGV: %s", error->message);

      return 1;
    }

  if (!gjs_context_eval (context, src, -1, "<main>", &status, &error))
    {
      g_message ("Execution of start() threw exception: %s", error->message);

      return status;
    }

  return 0;
}
