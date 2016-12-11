#include <girepository.h>
#include <gjs/gjs.h>

const char *src =
  "imports.package.start({ name: '" PACKAGE_NAME "',"
  "                        version: '" PACKAGE_VERSION "',"
  "                        prefix: '" PREFIX "',"
  "                        libdir: '" LIBDIR "' });";

int
main (int argc, char *argv[])
{
  const char *search_path[] = { "resource:///org/gnome/Polari/js", NULL };
  GError *error = NULL;
  GjsContext *context;
  int status;

  g_irepository_prepend_search_path (PKGLIBDIR);

  context = g_object_new (GJS_TYPE_CONTEXT,
                          "search-path", search_path,
                          NULL);

  if (!gjs_context_define_string_array (context, "ARGV",
                                        argc - 1, (const char **)argv + 1,
                                        &error))
    {
      g_message ("Failed to define ARGV: %s", error->message);
      g_error_free (error);

      g_object_unref (context);

      return 1;
    }

  if (!gjs_context_eval (context, src, -1, "<main>", &status, &error))
    {
      g_message ("Execution of start() threw exception: %s", error->message);
      g_error_free (error);

      g_object_unref (context);

      return status;
    }

  g_object_unref (context);

  return 0;
}
