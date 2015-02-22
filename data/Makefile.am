SUBDIRS = appdata icons

desktopdir = $(datadir)/applications
desktop_DATA = $(desktop_in_files:.desktop.in=.desktop)
desktop_in_files = $(APP_ID).desktop.in

@INTLTOOL_DESKTOP_RULE@

servicedir = $(datadir)/dbus-1/services
service_DATA = $(service_in_files:.service.in=.service)
service_in_files = $(APP_ID).service.in

$(APP_ID).service: $(APP_ID).service.in Makefile
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
