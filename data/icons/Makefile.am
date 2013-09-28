public_icons_themes = \
	hicolor \
	$(NULL)

icondir = $(datadir)/icons/

nobase_dist_icon_DATA = \
	hicolor/16x16/apps/polari.png \
	hicolor/22x22/apps/polari.png \
	hicolor/24x24/apps/polari.png \
	hicolor/32x32/apps/polari.png \
	hicolor/48x48/apps/polari.png \
	hicolor/512x512/apps/polari.png \
	hicolor/scalable/apps/polari.svg \
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
