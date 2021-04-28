appdata_name = app_id + '.appdata.xml'
appdata = i18n.merge_file(appdata_name,
  input: appdata_name + '.in',
  output: appdata_name,
  po_dir: '../../po',
  install: true,
  install_dir: metainfodir
)

if (appstream_util.found())
  test('Validating ' + appdata_name,
    appstream_util,
    args: ['validate', '--nonet', appdata.full_path()],
    workdir: meson.current_build_dir(),
    depends: [appdata]
  )

  r = run_command(appstream_util, '--help')
  if (r.stdout().contains('validate-version'))
    test('Checking release entry for @0@'.format(meson.project_version()),
      appstream_util,
      args: ['validate-version', appdata.full_path(), meson.project_version()],
      workdir: meson.current_build_dir(),
      depends: [appdata]
    )
  endif
endif
