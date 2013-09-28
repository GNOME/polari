EXTRA_DIST =
CLEANFILES =
INTROSPECTION_GIRS =

girdir = $(pkgdatadir)/gir-1.0
typelibdir = $(pkglibdir)/girepository-1.0

include $(INTROSPECTION_MAKEFILE)
include Makefile-lib.am

gir_DATA = $(INTROSPECTION_GIRS)
typelib_DATA = $(gir_DATA:.gir=.typelib)

CLEANFILES += $(gir_DATA) $(typelib_DATA)

do_subst = sed -e 's|@localedir[@]|$(localedir)|g' \
               -e 's|@pkgdatadir[@]|$(pkgdatadir)|g' \
               -e 's|@pkglibdir[@]|$(pkglibdir)|g' \
               -e 's|@GJS_CONSOLE[@]|$(GJS_CONSOLE)|g' \
               -e 's|@PACKAGE_VERSION[@]|$(PACKAGE_VERSION)|g' \
               $(NULL)

bin_SCRIPTS = polari

polari: polari.in
	$(AM_V_GEN) $(do_subst) $< > $@

jsdir = $(pkgdatadir)/js/
dist_js_DATA = \
	accountsMonitor.js \
	application.js \
	appNotifications.js \
	chatroomManager.js \
	chatView.js \
	connections.js \
	ircParser.js \
	joinDialog.js \
	main.js \
	mainWindow.js \
	messageDialog.js \
	notify.js \
	pasteManager.js \
	roomList.js \
	tabCompletion.js \
	userList.js \
	utils.js \
	$(NULL)

config.js: config.js.in Makefile
	$(AM_V_GEN) $(do_subst) $< > $@

nodist_js_DATA = \
	config.js \
	$(NULL)

EXTRA_DIST += \
	config.js.in \
	polari.in \
	$(NULL)

CLEANFILES += \
	config.js \
	polari \
	$(NULL)
