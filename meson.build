# SPDX-FileCopyrightText: 2016 Florian Müllner <fmuellner@gnome.org>
#
# SPDX-License-Identifier: GPL-2.0-or-later

project(
  'polari',
  'c',
  version: '46.0',
  meson_version: '>= 1.1.0',
  license: 'GPL-2.0-or-later',
)

app_id = 'org.gnome.Polari'

gnome = import('gnome')
i18n = import('i18n')

prefix = get_option('prefix')

bindir = join_paths(prefix, get_option('bindir'))
libdir = join_paths(prefix, get_option('libdir'))
datadir = join_paths(prefix, get_option('datadir'))

pkglibdir = join_paths(libdir, meson.project_name())
pkgdatadir = join_paths(datadir, meson.project_name())

desktopdir = join_paths(datadir, 'applications')
icondir = join_paths(datadir, 'icons')
metainfodir = join_paths(datadir, 'metainfo')
schemadir = join_paths(datadir, 'glib-2.0', 'schemas')
servicedir = join_paths(datadir, 'dbus-1', 'services')
tpclientdir = join_paths(datadir, 'telepathy', 'clients')
girdir = join_paths(pkgdatadir, 'gir-1.0')
typelibdir = join_paths(pkglibdir, 'girepository-1.0')

desktop_file_validate = find_program('desktop-file-validate', required: false)
json_glib_validate = find_program('json-glib-validate', required: false)
appstreamcli = find_program('appstreamcli', required: false)
check_version = find_program('build-aux/meson/check-version.py')

gio_req = '>= 2.85.1'
gjs_req = '>= 1.85.1'

gio = dependency('gio-2.0', version: gio_req)
telepathy_glib = dependency('telepathy-glib')
tracker = dependency('tracker-sparql-3.0')
girepository = dependency('girepository-2.0', version: gio_req)
gjs = dependency('gjs-1.0', version: gjs_req)

conf = configuration_data()

conf.set_quoted('PKGLIBDIR', pkglibdir)

cc = meson.get_compiler('c')
gjs_has_autocleanup = cc.compiles(
  '''
  #include <gjs/gjs.h>
  void main(void) { g_autoptr(GjsContext) context = NULL; }
  ''',
  dependencies: [gjs],
)

conf.set('HAVE_STRCASESTR', cc.has_function('strcasestr'))
conf.set('SNAPSHOT', get_option('snapshot'))
conf.set('GJS_HAS_AUTOCLEANUP', gjs_has_autocleanup)

config_h = declare_dependency(
  sources: configure_file(configuration: conf, output: 'config.h'),
  include_directories: include_directories('.'),
)

gnome.post_install(
  glib_compile_schemas: true,
  gtk_update_icon_cache: true,
  update_desktop_database: true,
)

subdir('data')
subdir('src')
subdir('po')
subdir('help')

meson.add_dist_script(check_version, meson.project_version(), 'NEWS')
meson.add_dist_script(
  check_version,
  meson.project_version(),
  '--type', 'metainfo',
  'data/metainfo/org.gnome.Polari.metainfo.xml.in',
)

summary('prefix', get_option('prefix'))
summary('bindir', get_option('bindir'))
summary('libdir', get_option('libdir'))
summary('datadir', get_option('datadir'))

summary('buildtype', get_option('buildtype'), section: 'Build Configuration')
summary('snapshot', get_option('snapshot'), section: 'Build Configuration')
summary('debug', get_option('debug'), section: 'Build Configuration')
