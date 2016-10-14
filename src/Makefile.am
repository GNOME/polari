EXTRA_SCRIPTS =
EXTRA_DIST =
CLEANFILES =
INTROSPECTION_GIRS =
BUILT_SOURCES =

girdir = $(pkgdatadir)/gir-1.0
typelibdir = $(pkglibdir)/girepository-1.0

include $(INTROSPECTION_MAKEFILE)
include Makefile-lib.am

gir_DATA = $(INTROSPECTION_GIRS)
typelib_DATA = $(gir_DATA:.gir=.typelib)

CLEANFILES += $(gir_DATA) $(typelib_DATA)

do_subst = sed -e 's|@prefix[@]|$(prefix)|g' \
               -e 's|@libdir[@]|$(libdir)|g' \
               -e 's|@GJS[@]|$(GJS)|g' \
               -e 's|@PACKAGE_NAME[@]|$(PACKAGE_NAME)|g' \
               -e 's|@PACKAGE_VERSION[@]|$(PACKAGE_VERSION)|g' \
               $(NULL)

bin_PROGRAMS = polari
polari_SOURCES = \
	polari.c \
	$(src_resources) \
	$(data_resources) \
	$(NULL)
polari_CFLAGS = \
	$(POLARI_CFLAGS) \
	-DPREFIX=\"$(prefix)\" \
	-DLIBDIR=\"$(libdir)\" \
	-DPKGLIBDIR=\"$(pkglibdir)\" \
	$(NULL)
polari_LDADD = $(POLARI_LIBS)

nodist_noinst_SCRIPTS = polari-accounts

polari-accounts: polari-accounts.in
	$(AM_V_GEN) $(do_subst) $< > $@ && chmod +x $@

src_resource_files = $(shell $(GLIB_COMPILE_RESOURCES) --sourcedir=$(srcdir) --generate-dependencies $(srcdir)/$(APP_ID).src.gresource.xml)
src-resources.h: $(APP_ID).src.gresource.xml $(src_resource_files)
	$(AM_V_GEN) $(GLIB_COMPILE_RESOURCES) --target=$@ --sourcedir=$(srcdir) --generate --c-name src_resources $<
src-resources.c: $(APP_ID).src.gresource.xml $(src_resource_files)
	$(AM_V_GEN) $(GLIB_COMPILE_RESOURCES) --target=$@ --sourcedir=$(srcdir) --generate --c-name src_resources $<
src_resources = src-resources.c src-resources.h

BUILT_SOURCES += $(src_resources)

data_resource_files=$(shell $(GLIB_COMPILE_RESOURCES) --sourcedir=$(top_srcdir)/data --generate-dependencies $(top_srcdir)/data/$(APP_ID).data.gresource.xml)
data-resources.h: $(top_srcdir)/data/$(APP_ID).data.gresource.xml $(data_resource_files)
	$(AM_V_GEN) $(GLIB_COMPILE_RESOURCES) --target=$@ --sourcedir=$(top_srcdir)/data --generate --c-name data_resources $<
data-resources.c: $(top_srcdir)/data/$(APP_ID).data.gresource.xml $(data_resource_files)
	$(AM_V_GEN) $(GLIB_COMPILE_RESOURCES) --target=$@ --sourcedir=$(top_srcdir)/data --generate --c-name data_resources $<
data_resources = data-resources.h data-resources.c

BUILT_SOURCES += $(data_resources)

EXTRA_DIST += \
	$(APP_ID).src.gresource.xml \
	polari-accounts.in \
	$(data_resource_files) \
	$(src_resource_files) \
	$(NULL)

CLEANFILES += \
	$(data_resources) \
	$(src_resources) \
        polari-accounts \
	$(NULL)
