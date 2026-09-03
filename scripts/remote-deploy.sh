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
# on a bad build would still look successful. Ask the service itself.
for _ in $(seq 20); do
  if curl -fsS --max-time 2 "localhost:${HTTP_PORT:-3010}/v1/status" >/dev/null; then
    echo "Deployed $(git rev-parse --short HEAD)"
    exit 0
  fi

  sleep 1
done

echo "Service did not answer /v1/status after restart" >&2
systemctl --no-pager --lines=30 status freemap-osm-api >&2 || true
exit 1
