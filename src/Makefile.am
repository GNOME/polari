EXTRA_SCRIPTS =
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

do_subst = sed -e 's|@prefix[@]|$(prefix)|g' \
               -e 's|@libdir[@]|$(libdir)|g' \
               -e 's|@GJS_CONSOLE[@]|$(GJS_CONSOLE)|g' \
               -e 's|@PACKAGE_NAME[@]|$(PACKAGE_NAME)|g' \
               -e 's|@PACKAGE_VERSION[@]|$(PACKAGE_VERSION)|g' \
               $(NULL)

appdir = $(pkgdatadir)
nodist_app_SCRIPTS = $(APP_ID)

$(APP_ID): $(APP_ID).in
	$(AM_V_GEN) $(do_subst) $< > $@

jsdir = $(pkgdatadir)/
dist_js_DATA = \
	accountsMonitor.js \
	application.js \
	appNotifications.js \
	chatroomManager.js \
	chatView.js \
	connections.js \
	entryArea.js \
	ircParser.js \
	joinDialog.js \
	main.js \
	mainWindow.js \
	messageDialog.js \
	pasteManager.js \
	roomList.js \
	roomStack.js \
	tabCompletion.js \
	userList.js \
	utils.js \
	$(NULL)

EXTRA_DIST += \
	$(APP_ID).in \
	$(NULL)

CLEANFILES += \
	$(APP_ID) \
	$(NULL)

install-exec-hook:
	$(MKDIR_P) $(DESTDIR)$(bindir)
	-rm -f $(DESTDIR)$(bindir)/$(PACKAGE_NAME)
	$(LN_S) $(appdir)/$(APP_ID) $(DESTDIR)$(bindir)/$(PACKAGE_NAME)
uninstall-hook:
	-rm -f $(DESTDIR)$(bindir)/$(PACKAGE_NAME)
