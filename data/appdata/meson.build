appdata = app_id + '.appdata.xml'
i18n.merge_file('appdata',
                input: appdata + '.in',
                output: appdata,
                po_dir: src_podir,
                install: true,
                install_dir: appdatadir)

if (appstream_util.found())
  test('Validating ' + appdata,
       appstream_util,
       args: ['validate', '--nonet', appdata],
       workdir: meson.current_build_dir())
endif
