AC_INIT([polari],[3.19.90],[https://bugzilla.gnome.org/enter_bug.cgi?product=polari],[polari])
AX_IS_RELEASE([git-directory])

AC_SUBST([APP_ID],[org.gnome.Polari])

AC_CONFIG_MACRO_DIR([m4])
AC_CONFIG_AUX_DIR([build-aux])

AM_INIT_AUTOMAKE([1.11 check-news dist-xz no-dist-gzip tar-ustar foreign subdir-objects])

AM_SILENT_RULES([yes])
AM_MAINTAINER_MODE([enable])

GETTEXT_PACKAGE=AC_PACKAGE_NAME
AC_SUBST(GETTEXT_PACKAGE)
IT_PROG_INTLTOOL([0.50.0])

GOBJECT_INTROSPECTION_REQUIRE([0.9.6])

AX_CHECK_ENABLE_DEBUG([yes])
AC_USE_SYSTEM_EXTENSIONS
AX_COMPILER_FLAGS()

AC_PROG_CC

# Initialize libtool
AM_PROG_AR
LT_PREREQ([2.2])
LT_INIT([disable-static])

GLIB_GSETTINGS

PKG_CHECK_MODULES(POLARI,
                  gio-2.0 >= 2.43.4
                  gobject-introspection-1.0
                  gtk+-3.0 >= 3.15.6
                  telepathy-glib);

AC_CHECK_FUNCS([strcasestr])

AC_PATH_PROG([GJS_CONSOLE],[gjs-console],[no])

if test "$GJS_CONSOLE" = "no"; then
  AC_MSG_ERROR([gjs is required to build Polari])
fi

AC_PROG_LN_S

GLIB_COMPILE_RESOURCES=`$PKG_CONFIG --variable=glib_compile_resources gio-2.0`
AC_SUBST(GLIB_COMPILE_RESOURCES)

AC_PATH_PROG(DESKTOP_FILE_VALIDATE, desktop-file-validate)

AX_REQUIRE_DEFINED([APPSTREAM_XML])
APPSTREAM_XML

AC_CONFIG_FILES([
  Makefile
  data/Makefile
  data/appdata/Makefile
  data/icons/Makefile
  po/Makefile.in
  src/Makefile
  xdg-app/Makefile
])

AC_OUTPUT
