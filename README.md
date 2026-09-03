# Freemap OSM API

A small read-only HTTP API over an osm2pgsql database, replacing the Overpass
instance the Freemap app used for its objects (POI) layer and for map details.
It is closed-form on purpose: no Overpass QL, only the queries the app actually
makes.

## Endpoints

| Endpoint | Replaces |
| --- | --- |
| `GET /v1/features` | the objects layer's `nwr[…](bbox); out center` query |
| `GET /v1/features/at` | map details' `around:` + `is_in`/`pivot` pair, in one round trip |
| `GET /v1/features/by-id` | `(id:…); (._;>;); out` for the elements a link or a map's pins name |
| `GET /v1/status` | — |

### `GET /v1/features`

```
/v1/features?bbox=19.0,48.6,19.3,48.8&f=amenity=restaurant&f=natural=peak
            &f=amenity=shelter,shelter_type=picnic_shelter&limit=500
```

`f` is repeatable and the clauses are **OR**ed; the comma-separated predicates
inside one `f` are **AND**ed. A predicate is `k=v` (value match), `k` (key
present) or `!k` (key absent). Values are matched case-insensitively and
semicolon lists are exploded at import, so `cuisine=pizza` finds
`cuisine=Pizza;Kebab`.

Answers a GeoJSON `FeatureCollection` whose features carry `id` (`way/123`),
`properties` (all tags), a point `geometry` (`ST_PointOnSurface`, so it is
inside the polygon — better than Overpass's bbox center) and the full
geometry's `bbox`. `truncated: true` says the limit was hit, so the client no
longer has to infer that from the result count.

### `GET /v1/features/at`

```
/v1/features/at?lon=19.1&lat=48.7&radius=33&limit=100&keys=amenity,natural,…
```

```json
{ "nearby":     { "type": "FeatureCollection", "features": [ … "distance": 12.4 ] },
  "containing": { "type": "FeatureCollection", "features": [ … "area": 91234.5 ] } }
```

`nearby` is ordered by distance in meters, `containing` (areas the point falls
in) by area in square meters, ascending — both computed in the database, so the
client sorts nothing.

### `GET /v1/features/by-id`

```
/v1/features/by-id?ids=node/240109189,way/27865468,relation/14296
```

Up to 300 ids, in the `node/123` form the other routes emit, comma-separated
and repeatable. Unlike them it answers with each object's **own** geometry
rather than a label point, since the caller draws the thing.

The cap is what an HTTP/1.1 request line holds, not what the query costs: `/`
and `,` percent-encode to three bytes each and node ids now run to eleven
digits, so one id is 21 bytes of query string and nginx's default 8 kB buffer
is reached around 380 — measured, 380 answers and 400 does not. Past that the
request fails at nginx as a 414 the API never sees, so nothing it returns could
explain it. HTTP/2 compresses headers and escapes the limit, which is why a
browser gets further than curl does; the cap is set for the client that
doesn't.

An id the database does not hold is simply absent — the import keeps only
tagged objects, and only within its region — so a caller must key the answer by
`id` rather than by position.

Whole geometry has no natural size bound, so a response stops after 300 000
vertices and says `truncated: true`; the first feature is always whole, so a
single large relation still answers. One country boundary is ~45 000 vertices
and near a megabyte.

Absence therefore has two causes, and `truncated` is what tells them apart. The
answer is ordered by `(osm_type, osm_id)` ascending and truncation drops the
tail of that order, so nodes always survive — a whole request of them costs 300
vertices — then relations, and ways are what a truncated response loses.

### `GET /v1/status`

`dataTimestamp` (last change applied), `importTimestamp` and a rough `coverage`
bbox. Every response also carries `X-Data-Timestamp`.

With `DOCS=true` the Scalar reference is at `/docs/` and the OpenAPI document
at `/docs/openapi.json`.

## Data model

One table, written by `osm2pgsql/freemap-osm.lua`:

```
osm_object(osm_type "char", osm_id bigint, tags jsonb, geom geometry(…,3857),
           area real, kv text[] GENERATED)
```

Every tagged object is stored with all of its tags — the Lua does no filtering.
The generated `kv` column is what makes them searchable: a bare `key` element
per key, plus a `key=value` element per value (lowercased, semicolon lists
exploded). One GIN index over `kv` answers every predicate the API supports as
an array-containment test — no regex, no `LIKE`, no jsonb path scan.

**Every key is searchable and no list has to be kept.** What
`fm_value_deny_patterns()` and `fm_max_value_length()` in
[`sql/post-import.sql`](sql/post-import.sql) exclude is *value* indexing for
keys whose values are free text or near-unique (`name*`, `addr:*`, `ref*`,
`website`, dates, …) and values over 40 characters.
A predicate on one of those is not refused: the key still anchors the lookup on
the index and `fm_tag_matches()` rechecks the value on the rows that come back.

That anchor is only as selective as the key is rare, and the denied keys are the
common ones. Measured on Slovakia, `f=addr:housenumber=12` over a city viewport
reads all 1.6 M `addr:housenumber` postings (135 ms of 292 ms), and `f=name=…`
drops the geometry index for a 457 k-row heap scan — 104 ms for a city bbox,
around a second for the whole country, and the cost follows the key's *global*
frequency, not the viewport, so Europe multiplies it. Pair such a predicate with
a selective one (`f=amenity=restaurant,name=…`) and it is cheap again.

Measured on the Slovakia extract, the `kv` index is 22 MB with a hand-kept key
allowlist, **66 MB with these rules**, and 333 MB with every value indexed —
the last mostly `ref:minvskaddress`, 1.5 M distinct terms nobody searches for.
Against a table that is ~330 GB for Europe, the middle option costs nothing
worth the maintenance of the first.

After changing the rules:

```sql
ALTER TABLE osm_object ALTER COLUMN kv SET EXPRESSION AS (fm_kv(tags));
REINDEX INDEX CONCURRENTLY osm_object_kv_idx;
```

```sh
sudo systemctl restart freemap-osm-api
```

That rewrites the table but needs no re-import, because `tags` already holds
everything. The restart is not optional: the API reads the rules once, at
startup, so a process that outlives a *newly denied* key keeps asking the index
for `key=value` entries the rebuild removed — and answers an empty
`FeatureCollection` with no error.

### Known differences from Overpass

- Relations are stored as multipolygons (`type=multipolygon`/`boundary`) or
  multilinestrings (everything else). A relation whose members carry no line
  geometry gets no row.
- `area` and `distance` are computed in Web Mercator and scaled by cos(lat).
  Exact enough at a click radius; only ever compared between candidates at one
  point.

## Local setup

```sh
createdb -T template0 fmosm
psql -d fmosm -c 'CREATE EXTENSION postgis'

osm2pgsql -d fmosm --output=flex --style osm2pgsql/freemap-osm.lua \
  --slim --cache 4000 slovakia-latest.osm.pbf

psql -d fmosm -f sql/post-import.sql

cp .env.example .env   # then edit
pnpm install
pnpm dev
```

`--slim` keeps the middle tables, which is what `osm2pgsql-replication` needs
later; drop it (or add `--drop`) for a throwaway import.

Keeping the data up to date:

```sh
osm2pgsql-replication init -d fmosm            # reads the server from the imported file
osm2pgsql-replication update -d fmosm -- \
  --output=flex --style osm2pgsql/freemap-osm.lua --slim
```

`update` runs `osm2pgsql --append`, which recomputes `kv` for every changed row
through the generated column — nothing extra to maintain.

Slovakia, on a 24-core box: import 4m30s, `post-import.sql` 2m15s, 5.6M rows in
2.2 GB with a 21 MB `kv` index. `/v1/features` answers a city viewport in
30–45 ms.

## Deployment (fm5)

A push to `main` deploys: `.github/workflows/deploy.yml` connects as `freemap`
(repo secret `DEPLOY_SSH_KEY`, variables `DEPLOY_HOST`/`DEPLOY_PORT`), resets
`/opt/freemap-osm-api` to the pushed commit and runs `scripts/remote-deploy.sh`,
which installs, builds, restarts, and waits for `/v1/status` before calling it
done. The steps below are the first-time install that workflow assumes.

### Europe first, planet later

| | data | freshness | size |
| --- | --- | --- | --- |
| Europe extract + planet minutely diffs + `FM_REGION_QUERY` | Europe | ~1 min | ~630 GB |
| planet + planet minutely diffs | world | ~1 min | ~1.3 TB |

Sizes are the Slovakia import (7.0 GB) scaled by object count: `osm_object`
750 GB / middle ways 390 GB / middle rels 21 GB / flat-nodes 112 GB for planet;
330 / 175 / 10 / 112 for Europe.

Import Europe first — it fits in the 1.2 TB free beside the running Overpass, so
there is a fallback the whole time. Once the app is on it and Overpass is
retired (~2 TB free), re-import as planet and unset `FM_REGION_QUERY`; that also
ends the coverage gap, since the Overpass being replaced is a world instance
(`overpass_world_attic`, 862 GB on `/fm/data4`). Nothing else changes: same
Lua, same SQL, same units.

**An extract can take the planet's minutely diffs, but only with the locator.**
The diffs carry the nodes of foreign ways too, so their geometry assembles and
the table fills with a partial world map: measured on a Slovakia import, one
minute of unfiltered diffs added 353 objects outside the extract, and 25 minutes
added 6215. With `FM_REGION_QUERY` set, twelve minutes of the same diffs added
none while Slovak data kept updating. Geofabrik's own `europe-updates` is the
alternative, at one diff a day (sequence 4866 on 2026-08-03, one per day since
2013).

What the locator does *not* filter is the middle, which osm2pgsql fills before
the Lua sees anything: `planet_osm_ways` grows with every way edited anywhere,
measured at 424/min ≈ **6.4 GB/month**. Over a bridge of a few months that is
noise, and the planet re-import discards it. (`--flat-nodes` is already sized
by the planet's id space, so foreign nodes cost nothing.)

### Prerequisites

```sh
# osm2pgsql 2.3.1; trixie has 2.1.1, which has no locator. Backports is already
# in the sources — it just needs asking for, since backports pin at 100.
sudo apt install -t trixie-backports osm2pgsql
# Node 22+ (Debian ships 20), same fnm layout as fm6
sudo -u freemap bash -c 'curl -fsSL https://fnm.vercel.app/install | bash \
  && ~/.local/share/fnm/fnm install 22 && ~/.local/share/fnm/fnm default 22'
```

PostgreSQL 18 and PostGIS 3.x are already on the box; the cluster lives on
`/fm/data2`, which is too small for this, so the data goes in a tablespace on
`/fm/data4`.

### Database

```sh
# A system user of the same name, so import and replication reach the database
# by peer auth over the socket with no password anywhere.
sudo useradd --system --home-dir /fm/data4/osm-import --shell /usr/sbin/nologin osm
sudo mkdir -p /fm/data4/osm-import && sudo chown osm: /fm/data4/osm-import

# CREATE TABLESPACE needs the directory empty and 0700, owned by postgres.
sudo mkdir -p /fm/data4/pg_osm && sudo chown postgres: /fm/data4/pg_osm
sudo chmod 700 /fm/data4/pg_osm

sudo -u postgres psql <<'SQL'
CREATE TABLESPACE osm_ts LOCATION '/fm/data4/pg_osm';
CREATE ROLE osm LOGIN;
CREATE DATABASE osm OWNER osm TABLESPACE osm_ts;
SQL
sudo -u postgres psql -d osm -c 'CREATE EXTENSION postgis'
# The service runs as `freemap`, like photon, and only reads. The role may
# already exist on the box, so creating it is written to be repeatable.
sudo -u postgres psql -d osm <<'SQL'
DO $$ BEGIN
  CREATE ROLE freemap LOGIN;
EXCEPTION WHEN duplicate_object THEN
  RAISE NOTICE 'role freemap already exists';
END $$;
GRANT CONNECT ON DATABASE osm TO freemap;
GRANT USAGE ON SCHEMA public TO freemap;
ALTER DEFAULT PRIVILEGES FOR ROLE osm IN SCHEMA public
  GRANT SELECT ON TABLES TO freemap;
SQL
```

### The region (Europe import only)

The polygon the locator keeps objects inside: the **intersection** of the
extract's own boundary with `limit-europe-buffered.geojson`, the polygon
`freemap-outdoor-map` and GraphHopper already cut to.

```sh
cd /fm/data4/osm-import
sudo -u osm wget -O europe.poly https://download.geofabrik.de/europe.poly
sudo -u osm python3 /opt/freemap-osm-api/osm2pgsql/poly2wkt.py europe.poly \
  > /tmp/europe.wkt
sudo -u osm psql -d osm \
  -c "CREATE TABLE fm_region_geofabrik (geom geometry(MultiPolygon, 4326))" \
  -c "\copy fm_region_geofabrik (geom) FROM /tmp/europe.wkt"

sudo -u osm wget -O limit-europe-buffered.geojson \
  https://raw.githubusercontent.com/FreemapSlovakia/freemap-outdoor-map/main/limit-europe-buffered.geojson
sudo -u osm ogr2ogr -f PostgreSQL PG:"dbname=osm" limit-europe-buffered.geojson \
  -nln fm_limit -nlt PROMOTE_TO_MULTI -t_srs EPSG:4326 -overwrite

sudo -u osm psql -d osm \
  -c "CREATE TABLE fm_region AS
        SELECT ST_Multi(ST_CollectionExtract(ST_Intersection(
                 g.geom, ST_MakeValid(l.wkb_geometry)), 3))
               ::geometry(MultiPolygon, 4326) AS geom
        FROM fm_region_geofabrik g, fm_limit l" \
  -c "CREATE INDEX ON fm_region USING gist (geom)"
```

Neither polygon does the job alone. 11% of the buffered one lies outside the
extract — a buffer over North Africa and the Middle East where the import
leaves nothing and edits would trickle in one object at a time. 13% of the
extract lies outside the buffered one, and that part is Russia, which
`limit-europe-buffered` exists to drop. The intersection (2746 deg², against
3170 and 3099) is fully populated everywhere and Russia-free: Moscow and
St Petersburg fall outside it, Kyiv, Istanbul, Nicosia, Reykjavík, Tromsø and
Kaliningrad inside. The Canaries are outside both, so nothing is lost there
that the extract had.

Narrowing the region later needs no re-import for updates to stay correct, but
it does not retract what is already there: rows outside the new region sit in
`osm_object` until a diff happens to touch them. Widening needs a re-import.

The import fails outright if the query loads no regions — the alternative is an
empty table after several hours, since every object is then outside the region.

### Import

```sh
cd /fm/data4/osm-import
wget https://download.geofabrik.de/europe-latest.osm.pbf     # or planet-latest.osm.pbf

# Unset for a planet import; the locator is what keeps foreign objects out of
# an extract that takes the planet's diffs.
export FM_REGION_QUERY="SELECT 'europe', geom FROM fm_region"

sudo -u osm -E osm2pgsql -d osm --output=flex \
  --style /opt/freemap-osm-api/osm2pgsql/freemap-osm.lua \
  --slim --flat-nodes /fm/data4/osm-import/flat-nodes.bin \
  --cache 40000 --number-processes 16 \
  europe-latest.osm.pbf

sudo -u osm psql -d osm -f /opt/freemap-osm-api/sql/post-import.sql
```

`--slim` plus `--flat-nodes` is what makes updates possible; the flat-nodes file
is sized by the highest node id in the planet (~112 GB) whatever the extract, so
it must never be deleted while replication runs. Budget several hours for
Europe and the best part of a day for planet.

### Replication

Point it at the planet's minutely service explicitly — left alone, `init` takes
the daily Geofabrik URL out of the extract's header. `--start-at` in minutes
makes it use the database's own timestamp, rolled back that far:

```sh
sudo -u osm osm2pgsql-replication init -d osm \
  --server https://planet.openstreetmap.org/replication/minute --start-at 180

# Both units read this, so it is written once, here — before anything that
# needs it starts. Drop the FM_REGION_QUERY line for a planet import; each unit
# supplies its own PGUSER, since the API reads and the updater writes.
sudo tee /etc/freemap-osm-api.conf <<'CONF'
PGHOST=/var/run/postgresql
PGDATABASE=osm
HTTP_HOST=127.0.0.1
HTTP_PORT=3010
LOG_LEVEL=info
CORS_ORIGINS=https://www.freemap.sk,https://freemap.sk,https://www.freemap.eu,https://freemap.eu
FM_REGION_QUERY=SELECT 'europe', geom FROM fm_region
CONF

sudo cp systemd/freemap-osm-update.* /etc/systemd/system/
sudo systemctl enable --now freemap-osm-update.timer
systemctl list-timers freemap-osm-update.timer
```

`update` runs `osm2pgsql --append`, which recomputes `kv` for every changed row
through the generated column. `osm2pgsql-replication status -d osm` prints the
lag, and `/v1/status` serves the same timestamp to the app.

When the planet re-import happens, drop `FM_REGION_QUERY` from
`/etc/freemap-osm-api.conf` — leaving it set would keep filtering the planet
down to Europe.

### The service

```sh
sudo git clone https://github.com/FreemapSlovakia/freemap-osm-api /opt/freemap-osm-api
sudo chown -R freemap: /opt/freemap-osm-api
sudo -u freemap bash -c 'cd /opt/freemap-osm-api && pnpm install && pnpm build'

sudo cp systemd/freemap-osm-api.service /etc/systemd/system/
sudo systemctl enable --now freemap-osm-api

# So the deploy workflow can restart it. Exact argv, no wildcard.
echo 'freemap ALL=(root) NOPASSWD: /usr/bin/systemctl restart freemap-osm-api' \
  | sudo tee /etc/sudoers.d/freemap-osm-api
sudo chmod 0440 /etc/sudoers.d/freemap-osm-api
curl -s localhost:3010/v1/status
```

`/etc/freemap-osm-api.conf`, written in the previous step, is read by both units,
so the connection is configured in one place. `PGUSER` is the exception and lives
in each unit: the API connects as the read-only `freemap`, the update unit as the
owner `osm`. Writing it into the file would break the updater — an
`EnvironmentFile` overrides `Environment=`, so the file's value would win in both.

### nginx

```sh
sudo cp etc/nginx/conf.d/nginx-osm.conf /etc/nginx/conf.d/
sudo cp etc/nginx/osm.freemap.sk /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d osm.freemap.sk
```

CORS is the app's job (`CORS_ORIGINS`), not nginx's. The rate limit is 20 r/s
with a burst of 40, matching the Photon vhost — the objects layer fires one
request per pan.

### Then, in the app

Point `FM_OSM_API_URL` at it (it defaults to `https://osm.freemap.sk`) and
deploy. **The client is already switched over, so it must not ship before this
service answers.**
