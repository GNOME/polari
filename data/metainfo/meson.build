# SPDX-FileCopyrightText: 2016 Florian Müllner <fmuellner@gnome.org>
#
# SPDX-License-Identifier: GPL-2.0-or-later

metainfo = i18n.merge_file(
  input: app_id + '.metainfo.xml.in',
  output: '@BASENAME@',
  po_dir: '../../po',
  install: true,
  install_dir: metainfodir,
)

if (appstreamcli.found())
  test(
    'Validating metainfo',
    appstreamcli,
    args: ['validate', '--no-net', '--explain', metainfo.full_path()],
    workdir: meson.current_build_dir(),
    depends: [metainfo],
  )
endif
