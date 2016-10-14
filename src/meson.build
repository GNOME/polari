script_conf = configuration_data()
script_conf.set('GJS', gjs_console.path())

script = 'polari-accounts'
configure_file(input: script + '.in',
               output: script,
               configuration: script_conf)

resource_name = app_id + '.data.gresource.xml'
data_resources = gnome.compile_resources('data-resources',
                                         join_paths(src_datadir, resource_name),
                                         source_dir: src_datadir,
                                         c_name: 'data_resources')

resource_name = app_id + '.src.gresource.xml'
src_resources = gnome.compile_resources('src-resources',
                                        resource_name,
                                        c_name: 'src_resources')

exeargs = ['-DPACKAGE_NAME="polari"',
           '-DPACKAGE_VERSION="@0@"'.format(meson.project_version()),
           '-DPREFIX="@0@"'.format(prefix),
           '-DLIBDIR="@0@"'.format(join_paths(prefix, libdir)),
           '-DPKGLIBDIR="@0@"'.format(join_paths(prefix, pkglibdir))]
polari = executable('polari',
                    ['polari.c', src_resources, data_resources],
                    dependencies: [gio, girepository, gjs],
                    c_args: exeargs,
                    install: true)

libsources = [join_paths('lib', 'polari-drag-helper.c'),
              join_paths('lib', 'polari-drag-helper.h'),
              join_paths('lib', 'polari-room.c'),
              join_paths('lib', 'polari-room.h'),
              join_paths('lib', 'polari-util.c'),
              join_paths('lib', 'polari-util.h')]

libargs = ['-DG_LOG_USE_STRUCTURED',
           '-DG_LOG_DOMAIN="Polari"']
libpolari = shared_library('polari-1.0', libsources,
                           dependencies: [gio, gtk3, telepathy_glib],
                           c_args: libargs,
                           install: true,
                           install_dir: pkglibdir)

gnome.generate_gir(libpolari,
                   sources: libsources,
                   nsversion: '1.0',
                   namespace: 'Polari',
                   symbol_prefix: 'polari',
                   identifier_prefix: 'Polari',
                   includes: ['Gio-2.0', 'Gtk-3.0', 'TelepathyGLib-0.12'],
                   install_dir_gir: girdir,
                   install_dir_typelib: typelibdir,
                   install: true)
