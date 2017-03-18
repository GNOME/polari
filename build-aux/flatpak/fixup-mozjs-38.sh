#!/usr/bin/bash

# mozjs-38.pc includes an '-include' flat that points to a header
# ninja considers "dirty"; just kill it off.
mozjs=/usr/lib/pkgconfig/mozjs-38.pc
sed -e 's@-include [^ ]\+@@' $mozjs > /app${mozjs##/usr}
