import os
import json
from typing import Any, Dict, List, Optional, Tuple
from functools import lru_cache

# GeoJSON uses [lng, lat]
Coordinate = Tuple[float, float]

def _resolve_zones_path(zones_path: Optional[str] = None) -> str:
	if zones_path and os.path.isfile(zones_path):
		return zones_path
	here = os.path.dirname(__file__)
	candidate = os.path.join(here, "zones.geojson")
	return candidate

def _point_in_ring(lng: float, lat: float, ring: List[List[float]]) -> bool:
	"""
	Ray casting algorithm for a ring (closed or open).
	ring: list of [lng,lat]
	"""
	n = len(ring)
	if n < 3:
		return False
	inside = False
	# ensure we iterate edges (i -> j)
	j = n - 1
	for i in range(n):
		xi, yi = ring[i][0], ring[i][1]
		xj, yj = ring[j][0], ring[j][1]
		# Check if edge (i,j) straddles scanline at lat
		intersect = ((yi > lat) != (yj > lat)) and (lng < (xj - xi) * (lat - yi) / ((yj - yi) if (yj - yi) != 0 else 1e-12) + xi)
		if intersect:
			inside = not inside
		j = i
	return inside

def _point_in_polygon(lng: float, lat: float, polygon: List[List[List[float]]]) -> bool:
	"""
	Polygon with holes: first ring is outer, subsequent are holes.
	"""
	if not polygon:
		return False
	outer = polygon[0]
	if not _point_in_ring(lng, lat, outer):
		return False
	# If in any hole, treat as outside
	for k in range(1, len(polygon)):
		if _point_in_ring(lng, lat, polygon[k]):
			return False
	return True

def _point_in_multipolygon(lng: float, lat: float, multipolygon: List[List[List[List[float]]]]) -> bool:
	for polygon in multipolygon or []:
		if _point_in_polygon(lng, lat, polygon):
			return True
	return False

@lru_cache(maxsize=1)
def load_zones(zones_path: Optional[str] = None) -> Dict[str, Any]:
	"""
	Load and return the parsed zones GeoJSON.
	Result format:
	{
	  "features": [
	    {"properties": {...}, "geometry": {"type": "Polygon|MultiPolygon", "coordinates": ...}}
	  ]
	}
	"""
	path = _resolve_zones_path(zones_path)
	with open(path, "r", encoding="utf-8") as f:
		return json.load(f)

def find_zone_match(lng: float, lat: float, zones: Optional[Dict[str, Any]] = None) -> Optional[Dict[str, Any]]:
	"""
	Return the properties of the first matching zone feature, else None.
	"""
	data = zones or load_zones()
	features = (data or {}).get("features") or []
	for feat in features:
		props = feat.get("properties") or {}
		geom = feat.get("geometry") or {}
		gtype = (geom.get("type") or "").strip()
		coords = geom.get("coordinates")
		if not coords:
			continue
		try:
			if gtype == "Polygon":
				if _point_in_polygon(lng, lat, coords):  # type: ignore[arg-type]
					return props
			elif gtype == "MultiPolygon":
				if _point_in_multipolygon(lng, lat, coords):  # type: ignore[arg-type]
					return props
			else:
				continue
		except Exception:
			continue
	return None


