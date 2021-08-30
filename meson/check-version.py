#!/usr/bin/env python3

import os, sys
from pathlib import Path
import argparse, subprocess

def check_version(version, file):
    subprocess.run(['appstream-util', 'validate-version', file, version],
                   check=True)

parser = argparse.ArgumentParser(description='Check release version information.')
parser.add_argument('version', help='the version to check for')
parser.add_argument('files', nargs='+', help='files to check')
args = parser.parse_args()

distroot = os.environ.get('MESON_DIST_ROOT', './')

try:
    for file in args.files:
        check_version(args.version, Path(distroot, file))
except:
    sys.exit(1)
