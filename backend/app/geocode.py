import os
import re
import json
from typing import Dict, Any, Optional, Tuple
from time import time as _now
import httpx

# 7 days TTL
_TTL_SECONDS = 7 * 24 * 60 * 60
_CACHE: Dict[str, Tuple[float, Dict[str, Any]]] = {}
_MAX_KEYS = 5000

def _normalize_spaces(text: str) -> str:
	"""Trim and collapse all internal whitespace to single spaces."""
	try:
		return re.sub(r"\s+", " ", (text or "").strip())
	except Exception:
		return (text or "").strip()

def _apply_city_alias(city: str, alias_map: Optional[Dict[str, str]] = None) -> str:
	clean = _normalize_spaces(city).lower()
	if not alias_map:
		return city.strip()
	try:
		for k, v in (alias_map or {}).items():
			if clean == (k or "").strip().lower():
				return (v or "").strip()
	except Exception:
		pass
	return city.strip()

def _join_non_empty(parts: list[str], sep: str = ", ") -> str:
	return sep.join([p for p in parts if p and str(p).strip()])

def _cache_get(key: str) -> Optional[Dict[str, Any]]:
	try:
		ts, val = _CACHE.get(key, (0.0, None))
		if not val:
			return None
		if (_now() - ts) > _TTL_SECONDS:
			try: del _CACHE[key]
			except Exception: pass
			return None
		return val
	except Exception:
		return None

def _cache_set(key: str, val: Dict[str, Any]) -> None:
	try:
		_CACHE[key] = (_now(), val)
		if len(_CACHE) > _MAX_KEYS:
			try:
				oldest_key = sorted(_CACHE.items(), key=lambda kv: kv[1][0])[0][0]
				del _CACHE[oldest_key]
			except Exception:
				pass
	except Exception:
		pass

async def geocode_order_address(
	address1: Optional[str],
	address2: Optional[str],
	city: Optional[str],
	province: Optional[str],
	zip_code: Optional[str],
	*,
	api_key: Optional[str] = None,
	region: str = "ma",
	alias_map: Optional[Dict[str, str]] = None,
) -> Dict[str, Any]:
	"""
	Attempt to geocode an order using Google Maps Geocoding.
	Builds a full address string then falls back to city-only.
	Returns a dict:
	{
	  "ok": bool,
	  "address_string": str,
	  "lat": float|None,
	  "lng": float|None,
	  "corrected_city": str|None,
	  "raw": Dict|None,
	  "reason": str|None
	}
	"""
	key = api_key or os.environ.get("GOOGLE_MAPS_API_KEY", "").strip()
	if not key:
		return {"ok": False, "address_string": "", "lat": None, "lng": None, "corrected_city": None, "raw": None, "reason": "no_api_key"}

	normalized_city = _apply_city_alias(_normalize_spaces(city or ""), alias_map=alias_map)
	addr_full = _join_non_empty([_normalize_spaces(address1 or ""), _normalize_spaces(address2 or ""), normalized_city, _normalize_spaces(province or ""), _normalize_spaces(zip_code or ""), "Morocco"])
	addr_city_only = _join_non_empty([normalized_city, "Morocco"])

	# Cache keys
	cache_key_full = f"GGEOCODE|{region}|{addr_full.lower()}"
	cache_key_city = f"GGEOCODE|{region}|{addr_city_only.lower()}"

	# Try cache
	cached = _cache_get(cache_key_full)
	if cached is not None:
		return cached

	async def _call(addr: str) -> Dict[str, Any]:
		url = "https://maps.googleapis.com/maps/api/geocode/json"
		params = {"address": addr, "region": region, "key": key}
		async with httpx.AsyncClient(timeout=30) as client:
			r = await client.get(url, params=params)
			r.raise_for_status()
			return r.json()

	def _extract_best(js: Dict[str, Any]) -> Tuple[Optional[float], Optional[float], Optional[str]]:
		try:
			results = js.get("results") or []
			if not results:
				return (None, None, None)
			best = results[0]
			loc = ((best.get("geometry") or {}).get("location") or {})
			lat = loc.get("lat")
			lng = loc.get("lng")
			# Prefer city-like components
			candidates = {"locality": None, "administrative_area_level_3": None, "administrative_area_level_2": None}
			for comp in (best.get("address_components") or []):
				types = comp.get("types") or []
				name = comp.get("long_name") or comp.get("short_name")
				if not name:
					continue
				if "locality" in types and candidates["locality"] is None:
					candidates["locality"] = name
				if "administrative_area_level_3" in types and candidates["administrative_area_level_3"] is None:
					candidates["administrative_area_level_3"] = name
				if "administrative_area_level_2" in types and candidates["administrative_area_level_2"] is None:
					candidates["administrative_area_level_2"] = name
			corrected = candidates["locality"] or candidates["administrative_area_level_3"] or candidates["administrative_area_level_2"]
			return (lat, lng, corrected)
		except Exception:
			return (None, None, None)

	# Try full address
	try:
		js = await _call(addr_full)
		status = (js.get("status") or "").upper()
		if status == "OK":
			lat, lng, corrected = _extract_best(js)
			resp = {"ok": True, "address_string": addr_full, "lat": lat, "lng": lng, "corrected_city": corrected, "raw": js, "reason": None}
			_cache_set(cache_key_full, resp)
			return resp
	except Exception:
		# fall through
		pass

	# Fallback: city-only
	cached_city = _cache_get(cache_key_city)
	if cached_city is not None:
		return cached_city
	try:
		js2 = await _call(addr_city_only)
		status2 = (js2.get("status") or "").upper()
		if status2 == "OK":
			lat, lng, corrected = _extract_best(js2)
			resp2 = {"ok": True, "address_string": addr_city_only, "lat": lat, "lng": lng, "corrected_city": corrected, "raw": js2, "reason": None}
			_cache_set(cache_key_city, resp2)
			return resp2
		reason = status2.lower() if status2 else "geocode_failed"
		resp3 = {"ok": False, "address_string": addr_city_only, "lat": None, "lng": None, "corrected_city": None, "raw": js2, "reason": reason}
		_cache_set(cache_key_city, resp3)
		return resp3
	except Exception as e:
		return {"ok": False, "address_string": addr_city_only, "lat": None, "lng": None, "corrected_city": None, "raw": None, "reason": "geocode_failed"}


