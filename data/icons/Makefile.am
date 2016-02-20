public_icons_themes = \
	hicolor \
	$(NULL)

icondir = $(datadir)/icons/

nobase_dist_icon_DATA = \
	hicolor/16x16/apps/org.gnome.Polari.png \
	hicolor/22x22/apps/org.gnome.Polari.png \
	hicolor/24x24/apps/org.gnome.Polari.png \
	hicolor/32x32/apps/org.gnome.Polari.png \
	hicolor/48x48/apps/org.gnome.Polari.png \
	hicolor/256x256/apps/org.gnome.Polari.png \
	hicolor/512x512/apps/org.gnome.Polari.png \
	hicolor/scalable/apps/org.gnome.Polari-symbolic.svg \
	$(NULL)

noinst_DATA = \
	polari.svg \
	$(NULL)

EXTRA_DIST = \
	polari.svg \
	$(NULL)

gtk_update_icon_cache = gtk-update-icon-cache -f -t

install-data-hook: update-icon-cache
uninstall-hook: update-icon-cache
update-icon-cache:
	@-if test -z "$(DESTDIR)"; then \
		echo "Updating Gtk icon cache."; \
		for theme in $(public_icons_themes); do \
			$(gtk_update_icon_cache) $(datadir)/icons/$$theme; \
		done; \
	else \
		echo "*** Icon cache not updated.  After (un)install, run this:"; \
		for theme in $(public_icons_themes); do \
			echo "***   $(gtk_update_icon_cache) $(datadir)/icons/$$theme"; \
		done; \
	fi
