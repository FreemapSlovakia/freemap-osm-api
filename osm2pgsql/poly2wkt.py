#!/usr/bin/env python3
"""Osmosis .poly to WKT, so an extract's own boundary can drive the locator.

The format is a name line, then one section per ring: a name (prefixed `!` for
a hole), coordinate lines, `END`, and a final `END`. A hole belongs to the
outer ring before it, which is how the files are written; PostGIS is left to
validate the result.

    python3 poly2wkt.py europe.poly
"""

import sys


def rings(path):
    with open(path, encoding="utf-8") as f:
        lines = [line.strip() for line in f if line.strip()]

    i = 1  # the file's own name
    while i < len(lines) and lines[i] != "END":
        hole = lines[i].startswith("!")
        i += 1

        coords = []
        # A truncated download ends mid-ring. Left unchecked that is an
        # IndexError over a half-written file, and the caller's redirect has
        # already created the output — so say what is wrong instead.
        while i < len(lines) and lines[i] != "END":
            lon, lat = lines[i].split()
            coords.append(f"{float(lon)} {float(lat)}")
            i += 1

        if i >= len(lines):
            raise SystemExit(f"{path}: ring not terminated by END")

        i += 1

        if not coords:
            raise SystemExit(f"{path}: ring with no coordinates")

        # A ring the file left open is closed here; WKT requires it.
        if coords[0] != coords[-1]:
            coords.append(coords[0])

        yield hole, coords


def main(path):
    polygons = []

    for hole, coords in rings(path):
        ring = "(" + ", ".join(coords) + ")"

        if hole and polygons:
            polygons[-1].append(ring)
        else:
            polygons.append([ring])

    if not polygons:
        raise SystemExit(f"{path}: no rings")

    print(
        "MULTIPOLYGON("
        + ", ".join("(" + ", ".join(p) + ")" for p in polygons)
        + ")"
    )


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: poly2wkt.py FILE.poly")

    main(sys.argv[1])
