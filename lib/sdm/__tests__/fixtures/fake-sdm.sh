#!/bin/bash
# Fake sdm CLI for runner tests. Behavior keyed on first arg:
#   ok      -> prints two lines, exit 0
#   fail    -> prints error text to stderr, exit 1
#   sleep   -> sleeps 5s (for timeout tests)
#   status  -> prints a healthy status table, exit 0
case "$1" in
  ok) echo "line one"; echo "line two"; exit 0 ;;
  fail) echo "boom: access denied to resource" >&2; exit 1 ;;
  sleep) sleep 5; exit 0 ;;
  status) printf "DATASOURCE  STATUS  ADDRESS\nexample-shared-dev  connected  127.0.0.1:15432\n"; exit 0 ;;
  *) exit 64 ;;
esac
