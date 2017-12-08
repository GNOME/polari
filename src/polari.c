#include <girepository.h>
#include <gjs/gjs.h>

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
  g_autoptr (GError) error = NULL;
  g_autoptr (GjsContext) context = NULL;
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

      return 1;
    }

  if (!gjs_context_eval (context, src, -1, "<main>", &status, &error))
    {
      g_message ("Execution of start() threw exception: %s", error->message);

      return status;
    }

  return 0;
}
