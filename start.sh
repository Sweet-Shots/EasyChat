#!/usr/bin/env bash
# EasyChat on macOS or Linux. Needs python3, which both already have.
cd "$(dirname "$0")" || exit 1

for candidate in python3 python; do
  if command -v "$candidate" >/dev/null 2>&1 && "$candidate" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)'; then
    exec "$candidate" server.py
  fi
done

echo "No Python 3 found. Install it from https://www.python.org/downloads/ and run this again."
exit 1
