project('polari', 'c',
  version: '42.1',
  meson_version: '>= 0.59.0',
  license: 'GPL2+'
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
appstream_util = find_program('appstream-util', required: false)
check_version = find_program('meson/check-version.py')

gio = dependency('gio-2.0', version: '>= 2.43.4')
telepathy_glib = dependency('telepathy-glib')
girepository = dependency('gobject-introspection-1.0')
gjs = dependency('gjs-1.0', version: '>= 1.69.2')

conf = configuration_data()

conf.set_quoted('PKGLIBDIR', pkglibdir)

cc = meson.get_compiler('c')
conf.set('HAVE_STRCASESTR', cc.has_function('strcasestr'))
conf.set('SNAPSHOT', get_option('snapshot'))

config_h = declare_dependency(
  sources: configure_file(
    configuration: conf,
    output: 'config.h'
  ),
  include_directories: include_directories('.')
)

gnome.post_install(
  glib_compile_schemas: true,
  gtk_update_icon_cache: true,
  update_desktop_database: true
)

subdir('src')
subdir('data')
subdir('po')
subdir('help')

meson.add_dist_script(check_version, meson.project_version(), 'NEWS')

if (appstream_util.found())
  meson.add_dist_script(check_version,
    meson.project_version(),
    '--type', 'metainfo',
    'data/appdata/org.gnome.Polari.appdata.xml.in')
endif

summary('prefix', get_option('prefix'))
summary('bindir', get_option('bindir'))
summary('libdir', get_option('libdir'))
summary('datadir', get_option('datadir'))

summary('buildtype', get_option('buildtype'), section: 'Build Configuration')
summary('snapshot', get_option('snapshot'), section: 'Build Configuration')
summary('debug', get_option('debug'), section: 'Build Configuration')
