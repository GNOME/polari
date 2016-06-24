SUBDIRS = appdata icons

desktopdir = $(datadir)/applications
desktop_DATA = $(desktop_in_files:.desktop.in=.desktop)
desktop_in_files = $(APP_ID).desktop.in

autostartdir = $(pkgdatadir)
autostart_DATA = $(APP_ID).Autostart.desktop

%.desktop: %.desktop.in Makefile
	$(AM_V_GEN) $(MSGFMT) --desktop --template $< -d $(top_srcdir)/po -o $@

servicedir = $(datadir)/dbus-1/services
service_DATA = $(service_in_files:.service.in=.service)
service_in_files = $(APP_ID).service.in \
	org.freedesktop.Telepathy.Client.Polari.service.in

%.service: %.service.in Makefile
	$(AM_V_GEN) sed -e "s|\@bindir\@|$(bindir)|" $< > $@

check-local:
	$(DESKTOP_FILE_VALIDATE) $(desktop_DATA)

gsettings_SCHEMAS = $(APP_ID).gschema.xml
@GSETTINGS_RULES@

clientdir=$(datadir)/telepathy/clients
dist_client_DATA = Polari.client

EXTRA_DIST = \
	$(autostart_DATA) \
	$(desktop_in_files) \
	$(service_in_files) \
	$(APP_ID).data.gresource.xml \
	$(gsettings_SCHEMAS) \
	$(NULL)

CLEANFILES = \
	$(desktop_DATA) \
	$(service_DATA) \
	$(NULL)
