project('polari', 'c',
  version: '3.38.0',
  meson_version: '>= 0.51.0',
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

js_shell = find_program('js78', required: false)

desktop_file_validate = find_program('desktop-file-validate', required: false)
appstream_util = find_program('appstream-util', required: false)

gio = dependency('gio-2.0', version: '>= 2.43.4')
gtk3 = dependency('gtk+-3.0', version: '>= 3.21.6')
telepathy_glib = dependency('telepathy-glib')
girepository = dependency('gobject-introspection-1.0')
gjs = dependency('gjs-1.0', version: '>= 1.57.3')

conf = configuration_data()

conf.set_quoted('PACKAGE_NAME', meson.project_name())
conf.set_quoted('PACKAGE_VERSION', '@VCS_TAG@')
conf.set_quoted('PREFIX', prefix)
conf.set_quoted('LIBDIR', libdir)
conf.set_quoted('PKGLIBDIR', pkglibdir)

cc = meson.get_compiler('c')
conf.set('HAVE_STRCASESTR', cc.has_function('strcasestr'))
conf.set('SNAPSHOT', get_option('snapshot'))

config_h = declare_dependency(
  sources: vcs_tag(
    command: ['git', 'describe'],
    input: configure_file(
      configuration: conf,
      output: 'config.h.in'
    ),
    output: 'config.h'
  ),
  include_directories: include_directories('.')
)

subdir('src')
subdir('data')
subdir('po')
subdir('help')

meson.add_install_script('meson/meson-postinstall.sh')

summary_dirs = {
  'prefix': get_option('prefix'),
  'bindir': get_option('bindir'),
  'libdir': get_option('libdir'),
  'datadir': get_option('datadir'),
}

summary_build = {
  'buildtype': get_option('buildtype'),
  'snapshot': get_option('snapshot'),
  'debug': get_option('debug'),
}

if meson.version().version_compare('>= 0.53.0')
  summary(summary_dirs, section: 'Directories')
  summary(summary_build, section: 'Build Configuration')
endif
