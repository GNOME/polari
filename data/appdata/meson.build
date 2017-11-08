appdata = app_id + '.appdata.xml'
i18n.merge_file(appdata,
  input: appdata + '.in',
  output: appdata,
  po_dir: '../../po',
  install: true,
  install_dir: metainfodir
)

if (appstream_util.found())
  test('Validating ' + appdata,
    appstream_util,
    args: ['validate', '--nonet', appdata],
    workdir: meson.current_build_dir()
  )
endif
