# Freemap OSM API

A small read-only HTTP API over an osm2pgsql database, replacing the Overpass
instance the Freemap app used for its objects (POI) layer and for map details.
It is closed-form on purpose: no Overpass QL, only the three queries the app
actually makes.

## Endpoints

| Endpoint | Replaces |
| --- | --- |
| `GET /v1/features` | the objects layer's `nwr[…](bbox); out center` query |
| `GET /v1/features/at` | map details' `around:` + `is_in`/`pivot` pair, in one round trip |
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
What is *searchable* is decided by `fm_indexed_keys()` in
[`sql/post-import.sql`](sql/post-import.sql), which drives the generated `kv`
column: a bare `key` element per indexed key plus a `key=value` element per
value (lowercased, semicolon lists exploded). One GIN index over `kv` then
answers every predicate the API supports as an array-containment test — no
regex, no `LIKE`, no jsonb path scan.

To make another key searchable, edit `fm_indexed_keys()` and run:

```sql
ALTER TABLE osm_object ALTER COLUMN kv SET EXPRESSION AS (fm_kv(tags));
REINDEX INDEX CONCURRENTLY osm_object_kv_idx;
```

That rewrites the table but needs no re-import, because `tags` already holds
everything.

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

### Extract or planet — this decides the update cadence

**Minutely updates and a regional extract do not go together.** Geofabrik
publishes extract diffs once a day (europe-updates was at sequence 4866 on
2026-08-03, one per day since 2013), and planet minutely diffs cannot simply be
cut down to a region: there is no tool that spatially filters a change file
(`osmium extract` takes data files, not `.osc`), and even filtering the *output*
would not help, because osm2pgsql's middle ingests every changed way in the
world — about 130 GB a year of rows nothing ever reads. osm2pgsql's own manual
says as much: planet replication diffs cannot be applied to an extract database.

So it is one of:

| | data | freshness | size |
| --- | --- | --- | --- |
| Geofabrik `europe-latest` + `europe-updates` | Europe | ~1 day | ~630 GB |
| planet + `replication/minute` | world | ~1 min | ~1.3 TB |

Sizes are the Slovakia import (7.0 GB) scaled by object count: `osm_object`
750 GB / middle ways 390 GB / middle rels 21 GB / flat-nodes 112 GB for planet;
330 / 175 / 10 / 112 for Europe.

Planet also removes the coverage regression — the Overpass it replaces is a
world instance (`overpass_world_attic`, 862 GB on `/fm/data4`), so Europe-only
loses the objects layer and map details outside Europe.

**Recommended order**: import Europe first — it fits in the 1.2 TB free beside
the running Overpass, so there is a fallback the whole time. Once the app is on
it and Overpass is retired (~2 TB free), re-import as planet and point
replication at the minutely service. Nothing but the import command changes: the
Lua, the SQL and the units are identical either way. The direct planet route is
also defensible, since `/mnt/nfs/overpass_db_backup` holds a full copy of the
Overpass database to fall back on.

### Prerequisites

```sh
# osm2pgsql 2.3.1 (trixie has 2.1.1)
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
sudo -u postgres mkdir -p /fm/data4/pg_osm && sudo chown postgres: /fm/data4/pg_osm
sudo -u postgres psql <<'SQL'
CREATE TABLESPACE osm_ts LOCATION '/fm/data4/pg_osm';
CREATE ROLE osm LOGIN;
CREATE DATABASE osm OWNER osm TABLESPACE osm_ts;
SQL
sudo -u postgres psql -d osm -c 'CREATE EXTENSION postgis'
# The API only reads.
sudo -u postgres psql -d osm <<'SQL'
CREATE ROLE osmapi LOGIN;
GRANT CONNECT ON DATABASE osm TO osmapi;
GRANT USAGE ON SCHEMA public TO osmapi;
ALTER DEFAULT PRIVILEGES FOR ROLE osm IN SCHEMA public
  GRANT SELECT ON TABLES TO osmapi;
SQL
```

### Import

```sh
cd /fm/data4/osm-import
wget https://download.geofabrik.de/europe-latest.osm.pbf     # or planet-latest.osm.pbf

sudo -u osm osm2pgsql -d osm --output=flex \
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

```sh
sudo -u osm osm2pgsql-replication init -d osm   # reads the server from the .pbf header
sudo cp systemd/freemap-osm-update.* /etc/systemd/system/
sudo systemctl enable --now freemap-osm-update.timer
systemctl list-timers freemap-osm-update.timer
```

`update` runs `osm2pgsql --append`, which recomputes `kv` for every changed row
through the generated column. `osm2pgsql-replication status -d osm` prints the
lag, and `/v1/status` serves the same timestamp to the app.

### The service

```sh
sudo git clone https://github.com/FreemapSlovakia/freemap-osm-api /opt/freemap-osm-api
sudo chown -R freemap: /opt/freemap-osm-api
sudo -u freemap bash -c 'cd /opt/freemap-osm-api && pnpm install && pnpm build'

sudo tee /etc/freemap-osm-api.conf <<'CONF'
PGHOST=/var/run/postgresql
PGDATABASE=osm
PGUSER=osmapi
HTTP_HOST=127.0.0.1
HTTP_PORT=3010
LOG_LEVEL=info
CORS_ORIGINS=https://www.freemap.sk,https://freemap.sk,https://www.freemap.eu,https://freemap.eu
CONF

sudo cp systemd/freemap-osm-api.service /etc/systemd/system/
sudo systemctl enable --now freemap-osm-api
curl -s localhost:3010/v1/status
```

`/etc/freemap-osm-api.conf` is read by both units — the update unit takes its
`PG*` from it too, so the connection is configured in one place.

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
