import os
import re
import json
import unicodedata
from typing import Dict, Any, Optional, Tuple, List
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

def _strip_diacritics(text: str) -> str:
	try:
		nfkd = unicodedata.normalize("NFKD", text)
		return "".join([c for c in nfkd if not unicodedata.combining(c)])
	except Exception:
		return text

def _apply_city_alias(city: str, alias_map: Optional[Dict[str, str]] = None) -> str:
	clean = _strip_diacritics(_normalize_spaces(city)).lower()
	if not alias_map:
		return city.strip()
	try:
		for k, v in (alias_map or {}).items():
			key_norm = _strip_diacritics(_normalize_spaces(k)).lower()
			if clean == key_norm:
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
	bounds: Optional[Tuple[Tuple[float, float], Tuple[float, float]]] = None,
	country: str = "Morocco",
) -> Dict[str, Any]:
	"""
	Attempt to geocode an order using Google Maps Geocoding.
	Builds multiple candidate strings (full, city+province, city, zip), includes diacritic-stripped variants, and uses cache per candidate.
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
	norm_city_no_diac = _strip_diacritics(normalized_city)
	norm_province = _normalize_spaces(province or "")
	norm_zip = _normalize_spaces(zip_code or "")
	norm_addr1 = _normalize_spaces(address1 or "")
	norm_addr2 = _normalize_spaces(address2 or "")
	country_val = _normalize_spaces(country or "Morocco")

	candidates: List[str] = []
	# Full
	candidates.append(_join_non_empty([norm_addr1, norm_addr2, normalized_city, norm_province, norm_zip, country_val]))
	# City + province + country
	candidates.append(_join_non_empty([normalized_city, norm_province, country_val]))
	# City + country
	candidates.append(_join_non_empty([normalized_city, country_val]))
	# Zip + country
	if norm_zip:
		candidates.append(_join_non_empty([norm_zip, country_val]))
	# Diacritic-stripped variants
	if norm_city_no_diac.lower() != normalized_city.lower():
		candidates.append(_join_non_empty([norm_addr1, norm_addr2, norm_city_no_diac, norm_province, norm_zip, country_val]))
		candidates.append(_join_non_empty([norm_city_no_diac, norm_province, country_val]))
		candidates.append(_join_non_empty([norm_city_no_diac, country_val]))

	def _cache_key(addr: str) -> str:
		return f"GGEOCODE|{region}|{addr.lower()}"

	async def _call(addr: str) -> Dict[str, Any]:
		url = "https://maps.googleapis.com/maps/api/geocode/json"
		params = {"address": addr, "region": region, "key": key}
		if bounds:
			try:
				sw, ne = bounds
				params["bounds"] = f"{sw[0]},{sw[1]}|{ne[0]},{ne[1]}"
			except Exception:
				pass
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

	for cand in candidates:
		if not cand:
			continue
		ck = _cache_key(cand)
		cached = _cache_get(ck)
		if cached is not None:
			if cached.get("ok"):
				return cached
			else:
				continue
		try:
			js = await _call(cand)
			status = (js.get("status") or "").upper()
			if status == "OK":
				lat, lng, corrected = _extract_best(js)
				resp = {"ok": True, "address_string": cand, "lat": lat, "lng": lng, "corrected_city": corrected, "raw": js, "reason": None}
				_cache_set(ck, resp)
				return resp
			else:
				resp = {"ok": False, "address_string": cand, "lat": None, "lng": None, "corrected_city": None, "raw": js, "reason": status.lower() if status else "geocode_failed"}
				_cache_set(ck, resp)
		except Exception:
			resp = {"ok": False, "address_string": cand, "lat": None, "lng": None, "corrected_city": None, "raw": None, "reason": "geocode_failed"}
			_cache_set(ck, resp)
			continue

	return {"ok": False, "address_string": "", "lat": None, "lng": None, "corrected_city": None, "raw": None, "reason": "geocode_failed"}


