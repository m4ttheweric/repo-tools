#!/bin/bash
# Mimics `sdm login`: print the auth URL, then block until a sentinel file
# exists (standing in for the browser completing the SAML flow), then succeed.
if [ "$1" = "login" ]; then
  echo "Please complete logging in at: https://app.strongdm.com/auth-confirm-native/fixture123"
  # Prove `open` is a no-op shim on PATH: calling it must not error or launch anything.
  open "https://example.test/should-be-swallowed" || true
  for _ in $(seq 1 100); do
    [ -f "$SDM_LOGIN_SENTINEL" ] && { echo "authentication successful"; exit 0; }
    sleep 0.1
  done
  echo "timed out waiting for sentinel" >&2
  exit 1
fi
exit 64
