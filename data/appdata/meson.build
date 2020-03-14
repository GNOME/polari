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

  r = run_command(appstream_util, '--help')
  if (r.stdout().contains('validate-version'))
    test('Checking release entry for @0@'.format(meson.project_version()),
      appstream_util,
      args: ['validate-version', appdata, meson.project_version()],
      workdir: meson.current_build_dir()
    )
  endif
endif
