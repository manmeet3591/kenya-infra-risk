"""Small pure-Python geometry helpers (no numpy/shapely dependency)."""
import math


def _ring_contains(ring, x, y):
    inside = False
    n = len(ring)
    j = n - 1
    for i in range(n):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def polygon_contains(geom, x, y):
    """Point-in-polygon for GeoJSON Polygon / MultiPolygon geometries."""
    polys = [geom["coordinates"]] if geom["type"] == "Polygon" else geom["coordinates"]
    for poly in polys:
        if _ring_contains(poly[0], x, y) and not any(_ring_contains(h, x, y) for h in poly[1:]):
            return True
    return False


def bbox(geom):
    polys = [geom["coordinates"]] if geom["type"] == "Polygon" else geom["coordinates"]
    xs = [p[0] for poly in polys for p in poly[0]]
    ys = [p[1] for poly in polys for p in poly[0]]
    return min(xs), min(ys), max(xs), max(ys)


def centroid(geom):
    """Area-weighted centroid of the largest outer ring."""
    polys = [geom["coordinates"]] if geom["type"] == "Polygon" else geom["coordinates"]
    best, best_a = None, -1
    for poly in polys:
        ring = poly[0]
        a = cx = cy = 0.0
        for i in range(len(ring) - 1):
            x0, y0 = ring[i][0], ring[i][1]
            x1, y1 = ring[i + 1][0], ring[i + 1][1]
            f = x0 * y1 - x1 * y0
            a += f
            cx += (x0 + x1) * f
            cy += (y0 + y1) * f
        if a and abs(a) > best_a:
            best_a, best = abs(a), (cx / (3 * a), cy / (3 * a))
    return best


def haversine_km(lon1, lat1, lon2, lat2):
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


class CountyIndex:
    """Fast-ish county lookup using bbox prefilter + point-in-polygon."""

    def __init__(self, features):
        self.items = [(f, bbox(f["geometry"])) for f in features]

    def find(self, x, y):
        for f, (x0, y0, x1, y1) in self.items:
            if x0 <= x <= x1 and y0 <= y <= y1 and polygon_contains(f["geometry"], x, y):
                return f
        return None
