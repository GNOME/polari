AC_INIT([polari],[0.0.1],[],[polari])

m4_ifdef([AM_SILENT_RULES],[AM_SILENT_RULES([yes])])

AM_INIT_AUTOMAKE([1.11 dist-xz no-dist-gzip tar-ustar foreign])
AM_MAINTAINER_MODE([enable])

GETTEXT_PACKAGE=AC_PACKAGE_NAME
AC_SUBST(GETTEXT_PACKAGE)
IT_PROG_INTLTOOL(0.40.0)

AM_GNU_GETTEXT([external])
AM_GNU_GETTEXT_VERSION([0.17])

GOBJECT_INTROSPECTION_REQUIRE([0.9.6])

AM_DISABLE_STATIC
AC_PROG_LIBTOOL

GLIB_GSETTINGS

PKG_CHECK_MODULES(POLARI,
                  gio-2.0
                  gobject-introspection-1.0
                  gtk+-3.0
                  telepathy-glib);

GJS_CONSOLE=`$PKG_CONFIG --variable=gjs_console gjs-1.0`
AC_SUBST(GJS_CONSOLE)

GLIB_COMPILE_RESOURCES=`$PKG_CONFIG --variable=glib_compile_resources gio-2.0`
AC_SUBST(GLIB_COMPILE_RESOURCES)

AC_PATH_PROG(DESKTOP_FILE_VALIDATE, desktop-file-validate)

AC_CONFIG_FILES([
Makefile
data/Makefile
po/Makefile.in
src/Makefile
])

AC_OUTPUT
