SUBDIRS = appdata icons

desktopdir = $(datadir)/applications
desktop_DATA = $(desktop_in_files:.desktop.in=.desktop)
desktop_in_files = $(APP_ID).desktop.in

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

resource_files=$(shell $(GLIB_COMPILE_RESOURCES) --sourcedir=$(srcdir) --generate-dependencies $(srcdir)/$(APP_ID).data.gresource.xml)
$(APP_ID).data.gresource: $(APP_ID).data.gresource.xml $(resource_files)
	$(AM_V_GEN) $(GLIB_COMPILE_RESOURCES) --target=$@ --sourcedir=$(srcdir) $<

resourcedir=$(pkgdatadir)
resource_DATA=$(APP_ID).data.gresource

gsettings_SCHEMAS = $(APP_ID).gschema.xml
@GSETTINGS_RULES@

clientdir=$(datadir)/telepathy/clients
dist_client_DATA = Polari.client

EXTRA_DIST = \
	$(desktop_in_files) \
	$(service_in_files) \
	$(APP_ID).data.gresource.xml \
	$(resource_files) \
	$(gsettings_SCHEMAS) \
	$(NULL)

CLEANFILES = \
	$(desktop_DATA) \
	$(service_DATA) \
	$(resource_DATA) \
	$(NULL)
