desktopdir = $(datadir)/applications
desktop_DATA = $(desktop_in_files:.desktop.in=.desktop)
desktop_in_files = polari.desktop.in

@INTLTOOL_DESKTOP_RULE@

check-local:
	$(DESKTOP_FILE_VALIDATE) $(desktop_DATA)

resource_files=$(shell $(GLIB_COMPILE_RESOURCES) --sourcedir=$(srcdir) --generate-dependencies $(srcdir)/polari.gresource.xml)
polari.gresource: polari.gresource.xml $(resource_files)
	$(AM_V_GEN) $(GLIB_COMPILE_RESOURCES) --target=$@ --sourcedir=$(srcdir) $<

resourcedir=$(pkgdatadir)
resource_DATA=polari.gresource

gsettings_in_files = org.gnome.polari.gschema.xml.in
gsettings_SCHEMAS = $(gsettings_in_files:.xml.in=.xml)

@INTLTOOL_XML_NOMERGE_RULE@
@GSETTINGS_RULES@

EXTRA_DIST = \
	$(desktop_in_files) \
	polari.gresource.xml \
	$(resource_files) \
	$(gsettings_in_files) \
	$(NULL)

CLEANFILES = \
	$(desktop_DATA) \
	$(resource_DATA) \
k$(gsettings_SCHEMAS) \
	$(NULL)
