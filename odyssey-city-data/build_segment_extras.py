#!/usr/bin/env python3
"""
Odyssey: per-segment extras for the preference-aware router (Phase 2).

path_segments.json (17 MB) is left untouched. This script writes one small
extra file keyed by segment id, holding facts the questionnaire's preferences
need and the main pipeline does not export (surface, incline and cover already
come from path_segments.json):

  g   fraction (0-1) of the segment's length inside a mapped green space
      (basemap.geojson, kind "green": parks, commons, woods, gardens,
      cemeteries, allotments, grass). Sampled every ~10 m. Holes in
      multipolygons are not modelled.
  up  1 = pedestrian-type way mapped as an underpass (tunnel=yes/culvert).
  ps  1 = pedestrian-type way mapped as an enclosed passage
      (tunnel=building_passage/covered or covered=yes).
  sh  shared walking+cycling path: 1 = shared, 2 = shared but segregated
      (segregated=yes). From foot/bicycle/segregated tags on cycleways,
      footways and paths.
  cx  1 = mapped road crossing way (footway=crossing). Crossing POINTS are not
      in our data, so this undercounts. Stored for later; not used for routing.
  mr  1 = beside a main road: the segment is a primary/secondary road, or at
      least half of a path-type segment lies within 15 m of one. This is
      distance to main roads, NOT measured traffic.

Only segments with at least one of these are stored. Inputs are the files the
main pipeline already produced plus its raw OpenStreetMap cache (which is
git-ignored). Nothing is fetched from the internet.

Usage (from odyssey-city-data/):
    python3 build_segment_extras.py --osm /path/to/cache_osm.json.gz
Writes entities/segment_extras.json and ../odyssey-app/data/segment_extras.json
(use --no-app-copy to skip the second file).
"""
import argparse, gzip, json, math, os, shutil
from collections import defaultdict

PATH_TYPES = ("footway", "path", "cycleway", "steps", "pedestrian")
NEAR_MAIN_M = 15.0
SAMPLE_M = 10.0


def metres_per_deg(lat):
    return 111320.0, 111320.0 * math.cos(math.radians(lat))


def dist_m(a, b):
    ky, kx = metres_per_deg((a[0] + b[0]) / 2)
    return math.hypot((a[0] - b[0]) * ky, (a[1] - b[1]) * kx)


def samples(coords, step=SAMPLE_M, cap=400):
    """Points along a polyline, about `step` metres apart (vertices included)."""
    pts = [tuple(coords[0])]
    for a, b in zip(coords, coords[1:]):
        n = max(1, int(dist_m(a, b) // step))
        for i in range(1, n + 1):
            pts.append((a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n))
    if len(pts) > cap:                       # very long ways: thin out evenly
        k = len(pts) / cap
        pts = [pts[int(i * k)] for i in range(cap)]
    return pts


def inside(ring, x, y):
    c = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            c = not c
        j = i
    return c


class Greens:
    def __init__(self, basemap):
        self.polys = []
        G = 0.005
        self.G = G
        self.grid = defaultdict(list)
        for f in basemap["features"]:
            if f["properties"].get("kind") != "green" or f["geometry"]["type"] != "Polygon":
                continue
            ring = f["geometry"]["coordinates"][0]          # [lng, lat]
            xs = [p[0] for p in ring]
            ys = [p[1] for p in ring]
            idx = len(self.polys)
            self.polys.append((min(xs), max(xs), min(ys), max(ys), ring))
            for gx in range(int(min(xs) // G), int(max(xs) // G) + 1):
                for gy in range(int(min(ys) // G), int(max(ys) // G) + 1):
                    self.grid[(gx, gy)].append(idx)

    def contains(self, lat, lng):
        for idx in self.grid.get((int(lng // self.G), int(lat // self.G)), ()):
            x0, x1, y0, y1, ring = self.polys[idx]
            if x0 <= lng <= x1 and y0 <= lat <= y1 and inside(ring, lng, lat):
                return True
        return False


class MainRoads:
    """Densified points along primary/secondary roads, in a small grid."""
    def __init__(self, segs):
        self.C = 0.0002
        self.grid = defaultdict(list)
        for s in segs:
            if s["highway_type"] in ("primary", "secondary"):
                for p in samples(s["coordinates"], 8.0, cap=100000):
                    self.grid[(int(p[0] // self.C), int(p[1] // self.C))].append(p)

    def near(self, p, r=NEAR_MAIN_M):
        gx, gy = int(p[0] // self.C), int(p[1] // self.C)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for q in self.grid.get((gx + dx, gy + dy), ()):
                    if dist_m(p, q) <= r:
                        return True
        return False


def shared_class(hw, tags):
    foot, bike, seg = tags.get("foot"), tags.get("bicycle"), tags.get("segregated")
    ok = ("designated", "yes", "permissive")
    shared = (hw == "cycleway" and foot in ok) or (hw in ("footway", "path") and bike in ok)
    if not shared:
        return 0
    return 2 if seg == "yes" else 1


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser()
    ap.add_argument("--osm", default=os.path.join(here, "cache_osm.json.gz"),
                    help="raw Overpass cache written by build_odyssey_data.py (git-ignored)")
    ap.add_argument("--segments", default=os.path.join(here, "entities", "path_segments.json"))
    ap.add_argument("--basemap", default=os.path.join(here, "entities", "basemap.geojson"))
    ap.add_argument("--out", default=os.path.join(here, "entities", "segment_extras.json"))
    ap.add_argument("--no-app-copy", action="store_true")
    args = ap.parse_args()

    segs = json.load(open(args.segments))
    basemap = json.load(open(args.basemap))
    osm = json.load(gzip.open(args.osm))
    tags_by_way = {e["id"]: e.get("tags", {}) for e in osm["elements"] if e["type"] == "way"}
    greens, mains = Greens(basemap), MainRoads(segs)
    print(f"{len(segs)} segments, {len(greens.polys)} green polygons, {len(tags_by_way)} OSM ways")

    out, cov = {}, defaultdict(int)
    for s in segs:
        hw = s["highway_type"]
        tags = tags_by_way.get(s["osm_way_id"], {})
        e = {}
        pts = samples(s["coordinates"])
        if hw != "service":
            frac = sum(1 for p in pts if greens.contains(p[0], p[1])) / len(pts)
            if frac > 0:
                e["g"] = round(frac, 2)
        if hw in PATH_TYPES:
            tun = tags.get("tunnel")
            if tun in ("yes", "culvert"):
                e["up"] = 1
            if tun in ("building_passage", "covered") or tags.get("covered") == "yes":
                e["ps"] = 1
            sh = shared_class(hw, tags)
            if sh:
                e["sh"] = sh
            if tags.get("footway") == "crossing":
                e["cx"] = 1
        if hw in ("primary", "secondary"):
            e["mr"] = 1
        elif hw in PATH_TYPES:
            if sum(1 for p in pts if mains.near(p)) / len(pts) >= 0.5:
                e["mr"] = 1
        if e:
            out[s["id"]] = e
            for k in e:
                cov[k] += 1

    doc = {
        "version": 1,
        "osm_base": (osm.get("osm3s") or {}).get("timestamp_osm_base"),
        "definitions": "see the docstring of build_segment_extras.py",
        "coverage": dict(sorted(cov.items())),
        "seg": out,
    }
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w") as f:
        json.dump(doc, f, separators=(",", ":"), sort_keys=True)
    print(f"wrote {args.out}: {len(out)} segments with extras, {os.path.getsize(args.out) / 1024:.0f} KB")
    print("coverage:", dict(sorted(cov.items())))
    if not args.no_app_copy:
        dst = os.path.join(here, "..", "odyssey-app", "data", "segment_extras.json")
        shutil.copyfile(args.out, dst)
        print("copied to", os.path.normpath(dst))


if __name__ == "__main__":
    main()
