test_env = [
  'G_TEST_SRCDIR=@0@'.format(meson.current_source_dir()),
  'G_TEST_BUILDDIR=@0@'.format(meson.current_build_dir())
]

test_util = executable('test-util',
  'test-util.c',
  dependencies: libpolari_dep
)
test('Testing utility functions', test_util, env: test_env)