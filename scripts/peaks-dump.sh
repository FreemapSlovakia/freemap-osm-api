#!/bin/bash
# Writes every peak and volcano node to stdout as a GeoPackage, for
# dem-pyramid's peaks-osm.gpkg. Run as `osm`, whose peer role reads the
# database:
#
#   sudo -u osm /opt/freemap-osm-api/scripts/peaks-dump.sh > peaks-osm.gpkg
#
# On fm5 it is the one thing the `peaks-dump` user's key can run; see README
# "Peaks dump for dem-pyramid".

set -euo pipefail

# The database the replication unit writes, by the same settings. Only the
# libpq lines: it is a systemd EnvironmentFile, not shell, and other values
# hold unquoted spaces.
while IFS='=' read -r key value; do
	export "$key=$value"
done < <(grep -E '^PG[A-Z_]*=' /etc/freemap-osm-api.conf)

# A GeoPackage is written by seeking, so it cannot go to stdout directly.
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
# A dropped ssh session hangs the script up. ogr2ogr runs in the background
# below because bash defers a trap until its foreground child exits, and the
# export would otherwise run to the end for nobody.
trap 'kill "${pid:-}" 2>/dev/null; exit 1' HUP INT TERM PIPE

# `kv` holds values lowercased and semicolon lists split, so this keeps
# `natural=Peak` and `natural=peak;saddle` as the index finds them; `type`
# says which of the two it was, the same way.
ogr2ogr -f GPKG "$tmp/peaks.gpkg" PG: \
	-nln peaks -nlt POINT -a_srs EPSG:4326 \
	-sql "SELECT osm_id,
	             tags->>'name' AS name,
	             CASE WHEN kv @> ARRAY['natural=volcano'] THEN 'volcano'
	                  ELSE 'peak' END AS type,
	             tags->>'ele' AS ele_osm,
	             ST_Transform(geom, 4326) AS geom
	        FROM osm_object
	       WHERE kv && ARRAY['natural=peak', 'natural=volcano']
	         AND osm_type = 'N'" &
pid=$!
wait "$pid"

cat "$tmp/peaks.gpkg"
