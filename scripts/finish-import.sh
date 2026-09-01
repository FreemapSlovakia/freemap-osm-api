#!/bin/bash
# Waits for a running import, then does everything that follows it: the derived
# column and indexes, replication against the planet's minutely service, and
# both units. Written for the first bring-up, where the steps are hours apart
# and there is nothing to decide between them.
#
#   sudo systemd-run --unit=osm-finish --collect \
#     /opt/freemap-osm-api/scripts/finish-import.sh
#
# Safe to run again: post-import.sql is idempotent, and replication init only
# rewrites the stored sequence.

set -euo pipefail

DB=${PGDATABASE:-osm}
REPO=/opt/freemap-osm-api
MINUTELY=https://planet.openstreetmap.org/replication/minute

echo "waiting for osm-import to finish"
while systemctl is-active --quiet osm-import; do
  sleep 60
done

# The unit is transient and collected, so its exit status is gone by now; this
# line is what osm2pgsql prints only on a run that completed.
if ! journalctl -u osm-import --no-pager | grep -q 'osm2pgsql took'; then
  echo "import did not complete — leaving the database alone" >&2
  exit 1
fi

rows=$(runuser -u osm -- psql -d "$DB" -tAc 'SELECT count(*) FROM osm_object')
echo "imported $rows rows"

# Europe is hundreds of millions; anything less means the region matched almost
# nothing and the rest of this would only build indexes over an empty table.
if [ "$rows" -lt 50000000 ]; then
  echo "only $rows rows — check FM_REGION_QUERY before going on" >&2
  exit 1
fi

echo "post-import.sql (rewrites the table for kv, then builds the indexes)"
time runuser -u osm -- psql -d "$DB" -v ON_ERROR_STOP=1 -f "$REPO/sql/post-import.sql"

# Explicitly the planet's minutely service: left alone, init would take the
# daily Geofabrik URL out of the extract's header. --start-at in minutes makes
# it use the database's own timestamp, rolled back that far.
echo "replication init"
runuser -u osm -- osm2pgsql-replication init -d "$DB" \
  --server "$MINUTELY" --start-at 180

systemctl start freemap-osm-api
systemctl enable --now freemap-osm-update.timer

sleep 5
curl -fsS localhost:3010/v1/status && echo
echo "done"
