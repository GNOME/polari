AC_INIT([polari],[0.0.1],[],[polari])

AC_CONFIG_MACRO_DIR([m4])
AC_CONFIG_AUX_DIR([build-aux])

m4_ifdef([AM_SILENT_RULES],[AM_SILENT_RULES([yes])])

AM_INIT_AUTOMAKE([1.11 dist-xz no-dist-gzip tar-ustar foreign])
AM_MAINTAINER_MODE([enable])

GETTEXT_PACKAGE=AC_PACKAGE_NAME
AC_SUBST(GETTEXT_PACKAGE)
IT_PROG_INTLTOOL([0.50.0])

GOBJECT_INTROSPECTION_REQUIRE([0.9.6])

# Initialize libtool
LT_PREREQ([2.2])
LT_INIT([disable-static])

GLIB_GSETTINGS

PKG_CHECK_MODULES(POLARI,
                  gio-2.0
                  gobject-introspection-1.0
                  gtk+-3.0 >= 3.9.12
                  telepathy-glib);

AC_PATH_PROG([GJS_CONSOLE],[gjs-console],[no])

if test "$GJS_CONSOLE" = "no"; then
  AC_MSG_ERROR([gjs is required to build Polari])
fi

GLIB_COMPILE_RESOURCES=`$PKG_CONFIG --variable=glib_compile_resources gio-2.0`
AC_SUBST(GLIB_COMPILE_RESOURCES)

AC_PATH_PROG(DESKTOP_FILE_VALIDATE, desktop-file-validate)

AC_CONFIG_FILES([
Makefile
data/Makefile
data/appdata/Makefile
data/icons/Makefile
po/Makefile.in
src/Makefile
])

AC_OUTPUT
