subdir('appdata')
subdir('icons')

desktop_file = app_id + '.desktop'
i18n.merge_file(desktop_file,
  input: desktop_file + '.in',
  output: desktop_file,
  po_dir: '../po',
  install: true,
  install_dir: desktopdir,
  type: 'desktop'
)

if (desktop_file_validate.found())
  test('Validating ' + desktop_file,
    desktop_file_validate,
    args: [desktop_file],
    workdir: meson.current_build_dir()
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
install_data(app_id + '.Autostart.desktop', install_dir: pkgdatadir)
install_data('Polari.client', install_dir: tpclientdir)
