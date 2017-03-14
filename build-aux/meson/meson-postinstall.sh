#!/bin/sh

# Package managers set this so we don't need to run
if [ -z "$DESTDIR" ]; then
  glib-compile-schemas ${MESON_INSTALL_PREFIX}/share/glib-2.0/schemas
  update-desktop-database -q ${MESON_INSTALL_PREFIX}/share/applications
  gtk-update-icon-cache -q -t -f ${MESON_INSTALL_PREFIX}/share/icons/hicolor
fi