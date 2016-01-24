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

$(APP_ID): $(APP_ID).in $(top_srcdir)/configure.ac
	$(AM_V_GEN) $(do_subst) $< > $@

nodist_noinst_SCRIPTS = polari-accounts

polari-accounts: polari-accounts.in
	$(AM_V_GEN) $(do_subst) $< > $@ && chmod +x $@

resource_files = $(shell $(GLIB_COMPILE_RESOURCES) --sourcedir=$(srcdir) --generate-dependencies $(srcdir)/$(APP_ID).src.gresource.xml)
$(APP_ID).src.gresource: $(APP_ID).src.gresource.xml $(resource_files)
	$(AM_V_GEN) $(GLIB_COMPILE_RESOURCES) --target=$@ --sourcedir=$(srcdir) $<

resourcedir = $(pkgdatadir)
resource_DATA = $(APP_ID).src.gresource

EXTRA_DIST += \
	$(APP_ID).in \
	$(APP_ID).src.gresource.xml \
	polari-accounts.in \
	$(resource_files) \
	$(NULL)

CLEANFILES += \
	$(APP_ID) \
	$(APP_ID).src.gresource \
        polari-accounts \
	$(NULL)

install-exec-hook:
	$(MKDIR_P) $(DESTDIR)$(bindir)
	-rm -f $(DESTDIR)$(bindir)/$(PACKAGE_NAME)
	$(LN_S) $(appdir)/$(APP_ID) $(DESTDIR)$(bindir)/$(PACKAGE_NAME)
uninstall-hook:
	-rm -f $(DESTDIR)$(bindir)/$(PACKAGE_NAME)
