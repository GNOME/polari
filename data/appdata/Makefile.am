appdatadir = $(datadir)/appdata
appdata_DATA = $(appdata_in_files:.xml.in=.xml)
appdata_in_files = org.gnome.Polari.appdata.xml.in

@INTLTOOL_XML_RULE@

check-local:
	if test x$(APPDATA_VALIDATE) != x; then \
		$(APPDATA_VALIDATE) $(appdata_DATA); \
	fi

EXTRA_DIST = $(appdata_in_files)
CLEANFILES = $(appdata_DATA)
