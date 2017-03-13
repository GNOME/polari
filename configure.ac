AC_INIT([polari],[3.23.92],[https://bugzilla.gnome.org/enter_bug.cgi?product=polari],[polari])
AX_IS_RELEASE([git-directory])

AC_SUBST([APP_ID],[org.gnome.Polari])

AC_CONFIG_MACRO_DIR([m4])
AC_CONFIG_AUX_DIR([build-aux])

AM_INIT_AUTOMAKE([1.11 check-news dist-xz no-dist-gzip tar-ustar foreign subdir-objects])

AM_SILENT_RULES([yes])
AM_MAINTAINER_MODE([enable])

GOBJECT_INTROSPECTION_REQUIRE([0.9.6])

AX_CHECK_ENABLE_DEBUG([yes])
AC_USE_SYSTEM_EXTENSIONS
AX_COMPILER_FLAGS()

AC_PROG_CC

GETTEXT_PACKAGE=AC_PACKAGE_NAME
AC_SUBST(GETTEXT_PACKAGE)

AM_GNU_GETTEXT_VERSION([0.19.6])
AM_GNU_GETTEXT([external])

# Initialize libtool
AM_PROG_AR
LT_PREREQ([2.2])
LT_INIT([disable-static])

GLIB_GSETTINGS

PKG_CHECK_MODULES(LIBPOLARI,
                  gtk+-3.0 >= 3.21.6
                  telepathy-glib);
PKG_CHECK_MODULES(POLARI,
                  gio-2.0
                  gobject-introspection-1.0
                  gjs-1.0)

AC_CHECK_FUNCS([strcasestr])

AX_PROG_GJS
AX_CHECK_GIRS_GJS([Gdk], [3.0])
AX_CHECK_GIRS_GJS([GdkPixbuf], [2.0])
AX_CHECK_GIR_SYMBOLS_GJS([Gio], [2.0], [Application.send_notification])
AX_CHECK_GIR_SYMBOLS_GJS([GLib], [2.0], [log_variant])
AX_CHECK_GIRS_GJS([GObject], [2.0])
AX_CHECK_GIR_SYMBOLS_GJS([Gspell], [1], [Entry])
AX_CHECK_GIR_SYMBOLS_GJS([Gtk], [3.0], [ScrolledWindow.set_propagate_natural_width])
AX_CHECK_GIRS_GJS([Pango], [1.0])
AX_CHECK_GIRS_GJS([PangoCairo], [1.0])
AX_CHECK_GIRS_GJS([Secret], [1])
AX_CHECK_GIRS_GJS([Soup], [2.4])
AX_CHECK_GIRS_GJS([TelepathyGLib], [0.12])
AX_CHECK_GIRS_GJS([TelepathyLogger], [0.2])

AC_PROG_LN_S

GLIB_COMPILE_RESOURCES=`$PKG_CONFIG --variable=glib_compile_resources gio-2.0`
AC_SUBST(GLIB_COMPILE_RESOURCES)

YELP_HELP_INIT

AC_PATH_PROG(DESKTOP_FILE_VALIDATE, desktop-file-validate)

AX_REQUIRE_DEFINED([APPSTREAM_XML])
APPSTREAM_XML

AC_CONFIG_FILES([
  Makefile
  data/Makefile
  data/appdata/Makefile
  data/icons/Makefile
  help/Makefile
  po/Makefile.in
  src/Makefile
])

AC_OUTPUT
