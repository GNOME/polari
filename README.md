# ![polari-logo] Polari

Polari is a simple Internet Relay Chat (IRC) client that is designed to
integrate seamlessly with the GNOME desktop. You can find additional
information on its [GNOME project page][project-page].

## Hacking

The easiest way to build the latest development version of Polari and
start hacking on the code is to follow the recommended [GNOME guide]
[build-instructions].

## Getting in Touch

Surprise, there is an IRC channel! If you have any questions regarding the
use or development of Polari, want to discuss design or simply hang out
with nice folks, please join us in [#polari on irc.gnome.org][irc-channel].

## How to report bugs

If you found a problem or have a feature suggestion, please report the
issue to the GNOME [bug tracking system][bug-tracker].


## Default branch

The default development branch is `main`. If you still have a local
checkout with the old name, use:
```sh
git checkout master
git branch -m master main
git fetch
git branch --unset-upstream
git branch -u origin/main
git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main
```

[project-page]: https://wiki.gnome.org/Apps/Polari
[build-instructions]: https://wiki.gnome.org/Newcomers/BuildProject
[irc-channel]: irc://irc.gnome.org/%23polari
[bug-tracker]: https://gitlab.gnome.org/GNOME/polari/issues
[polari-logo]: logo.png
