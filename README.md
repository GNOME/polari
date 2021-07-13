# This branch is deprecated

All development happens on the main branch. To update your local
checkout, use the following:

```sh
git checkout master
git branch -m master main
git fetch
git branch --unset-upstream
git branch -u origin/main
git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main
```

This branch is kept around to avoid breaking build tooling that requires a
pinned commit hash to be on the master branch unless otherwise specified.
See https://gitlab.gnome.org/GNOME/glib/-/issues/2348 for details.
