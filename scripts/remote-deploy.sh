#!/usr/bin/env bash
#
# Runs ON fm5 as the `freemap` user: installs deps, rebuilds, restarts the
# service. See README "Deployment (fm5)" and .github/workflows/deploy.yml.
#
# The caller does the `git` update BEFORE invoking this, so the script is never
# rewritten by git mid-run — which would shift the file under bash and corrupt
# execution.
#
# The restart needs this sudoers rule (as root, in /etc/sudoers.d/freemap-osm-api):
#   freemap ALL=(root) NOPASSWD: /usr/bin/systemctl restart freemap-osm-api
set -euo pipefail

# Load fnm (provides node/pnpm). Non-interactive SSH and CI shells don't source
# ~/.bashrc where fnm is normally set up, so do it explicitly here.
export PATH="$HOME/.local/share/fnm:$PATH"
eval "$(fnm env --shell bash)"
fnm use default

cd "${DEPLOY_DIR:-/opt/freemap-osm-api}"

pnpm install --frozen-lockfile
pnpm build

sudo systemctl restart freemap-osm-api

# The unit returns before the port is up, so a deploy that starts and then dies
# on a bad build would still look successful. Ask the service itself, on the
# port the unit is actually configured with — systemd reads that file, this
# shell doesn't.
#
# Sourced rather than grepped, and never allowed to fail the script. `set -e`
# takes a failing command substitution as a reason to abort, so reading this
# with `sed` would abandon the deploy right here — after the restart, before
# the check that the restart worked — if the file were missing. And the value
# may be quoted, which is valid in an EnvironmentFile and which a `sed` would
# leave in the URL, failing every probe against a service that is in fact up.
HTTP_PORT=''
# shellcheck disable=SC1091
. /etc/freemap-osm-api.conf 2>/dev/null || true

port=${HTTP_PORT:-3010}

# Anything the URL cannot carry (stray quoting, CRLF) would fail every probe
# and report a healthy deploy as a failure, so fall back to the default port
# rather than to a value that cannot work.
[[ $port =~ ^[0-9]+$ ]] || port=3010

for _ in $(seq 20); do
  if curl -fsS --max-time 2 "localhost:${port}/v1/status" >/dev/null 2>&1; then
    echo "Deployed $(git rev-parse --short HEAD)"
    exit 0
  fi

  sleep 1
done

echo "Service did not answer /v1/status after restart" >&2
systemctl --no-pager --lines=30 status freemap-osm-api >&2 || true
exit 1
