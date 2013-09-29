appdatadir = $(datadir)/appdata
appdata_DATA = $(appdata_in_files:.xml.in=.xml)
appdata_in_files = org.gnome.Polari.appdata.xml.in

@INTLTOOL_XML_RULE@

EXTRA_DIST = $(appdata_in_files)
CLEANFILES = $(appdata_DATA)
