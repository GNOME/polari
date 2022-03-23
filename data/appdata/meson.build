# SPDX-FileCopyrightText: 2016 Florian Müllner <fmuellner@gnome.org>
#
# SPDX-License-Identifier: GPL-2.0-or-later

appdata_name = app_id + '.appdata.xml'
appdata = i18n.merge_file(
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
endif
