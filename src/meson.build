data_resources = gnome.compile_resources(
  'data-resources',
  '../data/@0@.data.gresource.xml'.format(app_id),
  source_dir: '../data',
  c_name: 'data_resources'
)

config_js = vcs_tag(
  command: ['git', 'describe'],
  input: configure_file(
    configuration: {
      'PACKAGE_NAME': meson.project_name(),
      'PACKAGE_VERSION': '@VCS_TAG@',
      'PREFIX': prefix,
      'LIBDIR': libdir,
    },
    input: 'config.js.in',
    output: 'config.js.in'
  ),
  output: 'config.js'
)

src_resources = gnome.compile_resources(
  'src-resources',
  '@0@.src.gresource.xml'.format(app_id),
  dependencies: config_js,
  c_name: 'src_resources'
)

polari = executable('polari', ['polari.c', src_resources, data_resources],
  dependencies: [config_h, gio, girepository, gjs],
  install: true
)

libsources = [
  'lib/polari-client-factory.c',
  'lib/polari-client-factory.h',
  'lib/polari-room.c',
  'lib/polari-room.h',
  'lib/polari-util.c',
  'lib/polari-util.h'
]

lib_nongir_sources = [
  'lib/polari-tp-autocleanup.h',
]

libargs = [
  '-DG_LOG_USE_STRUCTURED',
  '-DG_LOG_DOMAIN="Polari"'
]
libpolari = shared_library('polari-1.0', libsources + lib_nongir_sources,
  dependencies: [gio, telepathy_glib],
  c_args: libargs,
  install: true,
  install_dir: pkglibdir
)

libpolari_dep = declare_dependency(
  include_directories: include_directories('lib'),
  dependencies: [gio, telepathy_glib],
  link_with: libpolari
)

gnome.generate_gir(libpolari,
  sources: libsources,
  nsversion: '1.0',
  namespace: 'Polari',
  symbol_prefix: 'polari',
  identifier_prefix: 'Polari',
  includes: ['Gio-2.0', 'TelepathyGLib-0.12'],
  extra_args: '--quiet',
  install_dir_gir: girdir,
  install_dir_typelib: typelibdir,
  install: true
)

subdir('tests')

install_data('thumbnailer.js', install_dir: pkgdatadir)
