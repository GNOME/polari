@APPSTREAM_XML_RULES@

appstream_in_files = $(APP_ID).appdata.xml.in
appstream_XML = $(appstream_in_files:.xml.in=.xml)

%.xml: %.xml.in Makefile
	$(AM_V_GEN) $(MSGFMT) --xml --template $< -d $(top_srcdir)/po -o $@

EXTRA_DIST = $(appstream_in_files)
CLEANFILES = $(appstream_XML)
