subdir('appdata')
subdir('icons')

desktop_filename = app_id + '.desktop'
desktop_file = i18n.merge_file(desktop_filename,
  input: desktop_filename + '.in',
  output: desktop_filename,
  po_dir: '../po',
  install: true,
  install_dir: desktopdir,
  type: 'desktop'
)

if (desktop_file_validate.found())
  test('Validating ' + desktop_filename,
    desktop_file_validate,
    args: [desktop_file.full_path()],
    workdir: meson.current_build_dir(),
    depends: [desktop_file]
  )
endif

service_conf = configuration_data()
service_conf.set('bindir', bindir)

services = [
  'org.freedesktop.Telepathy.Client.Polari.service',
  app_id + '.service'
]

foreach s : services
  configure_file(
    input: s + '.in',
    output: s,
    configuration: service_conf,
    install_dir: servicedir
  )
endforeach

install_data(app_id + '.gschema.xml', install_dir: schemadir)
install_data('Polari.client', install_dir: tpclientdir)
