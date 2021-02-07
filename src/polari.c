#include <girepository.h>
#include <gjs/gjs.h>

#include "config.h"

G_DEFINE_AUTOPTR_CLEANUP_FUNC (GjsContext, g_object_unref)

const char *src =
  "imports.package.start({ name: '" PACKAGE_NAME "',"
  "                        version: '" PACKAGE_VERSION "',"
  "                        prefix: '" PREFIX "',"
  "                        libdir: '" LIBDIR "' });";

static char **
get_js_argv (int argc, const char * const *argv)
{
  char * injected_args[] = {
#ifdef SNAPSHOT
    "--test-instance",
#endif
    NULL
  };
  char **strv;
  guint js_argc = argc - 1; // gjs doesn't do argv[0]
  guint i;

  strv = g_new0 (char *, js_argc + G_N_ELEMENTS (injected_args) + 1);
  for (i = 0; i < js_argc; i++)
    strv[i] = g_strdup (argv[i + 1]);
  for (i = 0; i < G_N_ELEMENTS (injected_args); i++)
    strv[js_argc + i] = g_strdup (injected_args[i]);
  return strv;
}

static gboolean
get_profiler_fd (int *fd_p)
{
  const char *enabled;
  const char *fd_str;
  int fd;

  /* Sysprof uses the "GJS_TRACE_FD=N" environment variable to connect GJS
   * profiler data to the combined Sysprof capture. Since we are in control of
   * the GjsContext, we need to proxy this FD across to the GJS profiler.
   */

  fd_str = g_getenv ("GJS_TRACE_FD");
  enabled = g_getenv ("GJS_ENABLE_PROFILER");
  if (fd_str == NULL || enabled == NULL)
    return FALSE;

  fd = atoi (fd_str);

  if (fd <= 2)
    return FALSE;

  *fd_p = fd;
  return TRUE;
}

int
main (int argc, char *argv[])
{
  const char *search_path[] = { "resource:///org/gnome/Polari/js", NULL };
  g_autoptr (GOptionContext) option_context = NULL;
  g_autoptr (GError) error = NULL;
  g_autoptr (GjsContext) context = NULL;
  g_auto (GStrv) js_argv = NULL;
  GjsProfiler *profiler = NULL;
  gboolean debugger = FALSE;
  int status, profiler_fd;

  GOptionEntry entries[] =
    {
      { "debugger", 'd', 0, G_OPTION_ARG_NONE, &debugger, NULL, NULL },
      { NULL }
    };

#ifdef SNAPSHOT
  g_set_application_name ("Polari Development Snapshot");
#else
  g_set_application_name ("Polari");
#endif

  g_irepository_prepend_search_path (PKGLIBDIR "/girepository-1.0");
  g_irepository_prepend_library_path (PKGLIBDIR);

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

  js_argv = get_js_argv (argc, (const char * const *)argv);

  if (!gjs_context_define_string_array (context, "ARGV",
                                        -1, (const char **)js_argv,
                                        &error))
    {
      g_message ("Failed to define ARGV: %s", error->message);

      return 1;
    }

  if (get_profiler_fd (&profiler_fd))
    {
      profiler = gjs_context_get_profiler (context);

      gjs_profiler_set_fd (profiler, profiler_fd);
      gjs_profiler_start (profiler);
    }

  if (!gjs_context_eval (context, src, -1, "<main>", &status, &error))
    g_message ("Execution of start() threw exception: %s", error->message);

  if (profiler)
    gjs_profiler_stop (profiler);

  return status;
}
