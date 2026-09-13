#!/usr/bin/env python3
"""Fetch the direct-download sources of the security reference corpus.

Populates (relative to the corpus root, i.e. the parent of this scripts/ directory):

  vulnerability-data/nvd/         CVE-<year>.json.xz + CVE-<year>.json   NVD CVE feeds (FKIE mirror)
  vulnerability-data/nvd/recent/  recent-modified.json                   optional: official NVD 2.0 API
  vulnerability-data/cisa-kev/    known_exploited_vulnerabilities.{json,csv}
  vulnerability-data/epss/        epss_scores-current.csv.gz + .csv      optional: FIRST EPSS
  frameworks/mitre-attack/        {enterprise,mobile,ics}-attack.json    ATT&CK STIX 2.1
  frameworks/mitre-cwe/           cwec_latest.xml.zip + cwec_latest.xml
  frameworks/mitre-capec/         capec_latest.xml (or stix-capec.json via the mitre/cti mirror)

Idempotent and resumable:

  * every download streams to "<file>.part" and is renamed into place only after it is
    complete (Content-Length checked) and verified (xz/zip/gzip integrity, JSON/XML parse);
  * an interrupted ".part" resumes with an HTTP Range request on the next attempt or run;
  * re-runs send If-None-Match / If-Modified-Since and skip files the origin reports
    unchanged (HTTP 304), so a refresh with nothing new is a handful of tiny requests;
  * provenance for every file (URL used, ETag, SHA-256, size, fetch time, record counts)
    is kept in <root>/manifest.json; `--status` renders it as Markdown.

Only the hosts listed in the corpus brief are contacted; nothing is crawled. Where the
brief names a public mirror (CISA KEV on github.com/cisagov/kev-data, CAPEC inside
github.com/mitre/cti) it is used automatically when the primary host is unreachable,
and the manifest records which one served the file.

The optional NVD 2.0 API path (--nvd-api-days) reads NVD_API_KEY from the environment.
Never hardcode the key.
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import gzip
import hashlib
import http.client
import json
import lzma
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
import zlib
from pathlib import Path
from typing import Callable

ROOT = Path(__file__).resolve().parent.parent
MANIFEST_PATH = ROOT / "manifest.json"
LAST_UPDATE_PATH = ROOT / ".last-update"

UA = "security-corpus-fetcher/1.0 (+https://github.com/vector3on/ScoutIq; authorized security research)"
FIRST_CVE_YEAR = 1999
THIS_YEAR = dt.datetime.now(dt.timezone.utc).year
CHUNK = 1 << 20
TIMEOUT = 120
MAX_ATTEMPTS = 5            # 1 try + 4 retries, backing off 2 s, 4 s, 8 s, 16 s
MIN_GAP_PER_HOST = 0.5      # seconds between consecutive requests to one host
RETRY_STATUSES = {408, 425, 429, 500, 502, 503, 504}
SOURCES = ("nvd", "kev", "attack", "cwe", "capec", "epss")

# The complete list of URLs this script may contact.
NVD_FEED_BASE = "https://github.com/fkie-cad/nvd-json-data-feeds/releases/latest/download"
NVD_API = "https://services.nvd.nist.gov/rest/json/cves/2.0"
KEV_PRIMARY = "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities"
KEV_MIRROR = "https://raw.githubusercontent.com/cisagov/kev-data/main/known_exploited_vulnerabilities"
ATTACK_BASE = "https://raw.githubusercontent.com/mitre-attack/attack-stix-data/master"
CWE_ZIP_URL = "https://cwe.mitre.org/data/xml/cwec_latest.xml.zip"
CAPEC_XML_URL = "https://capec.mitre.org/data/xml/capec_latest.xml"
CAPEC_STIX_MIRROR = "https://raw.githubusercontent.com/mitre/cti/master/capec/2.1/stix-capec.json"
EPSS_PAGE = "https://www.first.org/epss/"
# Where the EPSS CSV lived when this script was written; the page above is consulted
# first because FIRST has moved the download host before.
EPSS_KNOWN_URL = "https://epss.empiricalsecurity.com/epss_scores-current.csv.gz"

Verifier = Callable[[Path, str], dict]


class FetchError(Exception):
    """A download could not be completed from this URL."""


class VerifyError(Exception):
    """A completed download failed its integrity or format checks."""


class Truncated(Exception):
    """The connection closed before Content-Length bytes arrived (retry and resume)."""


# --------------------------------------------------------------------------- helpers
def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def human(n: float) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024:
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} TB"


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(CHUNK), b""):
            digest.update(block)
    return digest.hexdigest()


def rel(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def part_of(path: Path) -> Path:
    return path.with_name(path.name + ".part")


def first_bytes(path: Path, n: int = 4096) -> bytes:
    with open(path, "rb") as f:
        return f.read(n)


def count_occurrences(path: Path, needle: bytes) -> int:
    """Count `needle` in a file without loading it whole (handles chunk boundaries)."""
    total, tail = 0, b""
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(CHUNK), b""):
            buf = tail + block
            total += buf.count(needle)
            tail = buf[-(len(needle) - 1):]
    return total


# -------------------------------------------------------------------------- manifest
def load_manifest() -> dict:
    if MANIFEST_PATH.exists():
        try:
            data = json.loads(MANIFEST_PATH.read_text())
            if isinstance(data, dict) and isinstance(data.get("files"), dict):
                return data
        except (OSError, json.JSONDecodeError):
            pass
        print(f"  .. ignoring unreadable {MANIFEST_PATH.name}")
    return {"generated_by": "scripts/fetch_data.py", "files": {}}


def save_manifest(manifest: dict) -> None:
    manifest["updated_at"] = now_iso()
    tmp = MANIFEST_PATH.with_name(MANIFEST_PATH.name + ".tmp")
    tmp.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    os.replace(tmp, MANIFEST_PATH)


# ------------------------------------------------------------------------------ HTTP
_last_request_at: dict[str, float] = {}


def open_url(url: str, headers: dict | None = None, timeout: int = TIMEOUT):
    """urlopen with our User-Agent and a polite gap between requests to one host."""
    host = urllib.parse.urlsplit(url).hostname or ""
    wait = _last_request_at.get(host, 0.0) + MIN_GAP_PER_HOST - time.monotonic()
    if wait > 0:
        time.sleep(wait)
    _last_request_at[host] = time.monotonic()
    req = urllib.request.Request(url, headers={"User-Agent": UA, **(headers or {})})
    return urllib.request.urlopen(req, timeout=timeout)


def content_range_total(value: str | None) -> int | None:
    match = re.fullmatch(r"bytes \d+-\d+/(\d+)", value or "")
    return int(match.group(1)) if match else None


def retry_delay(attempt: int, err: urllib.error.HTTPError | None = None) -> float:
    retry_after = err.headers.get("Retry-After") if err is not None and err.headers else None
    if retry_after and retry_after.isdigit():
        return min(float(retry_after), 120.0)
    return float(2 ** attempt)


def is_permanent(err: urllib.error.URLError) -> bool:
    """Failures that will not resolve by waiting a few seconds: DNS, or an egress
    proxy refusing the host (policy denial)."""
    reason = str(getattr(err, "reason", err))
    return any(s in reason for s in ("Tunnel connection failed", "Name or service not known",
                                     "nodename nor servname", "getaddrinfo failed"))


def download(url: str, dest: Path, conditional: dict | None = None) -> dict | None:
    """Stream `url` into `dest.part`, resuming and retrying as needed.

    `conditional` is the manifest entry of the copy already on disk (fetched from the
    same URL); its ETag / Last-Modified are sent so an unchanged origin answers 304.

    Returns None on 304 (nothing to do), otherwise a dict describing the completed
    .part file.  Raises FetchError when the URL cannot be fetched.
    """
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = part_of(dest)
    attempt = 0
    while True:
        attempt += 1
        headers: dict[str, str] = {}
        resume_from = part.stat().st_size if part.exists() else 0
        if resume_from:
            headers["Range"] = f"bytes={resume_from}-"
        elif conditional and dest.exists():
            if conditional.get("etag"):
                headers["If-None-Match"] = conditional["etag"]
            if conditional.get("last_modified"):
                headers["If-Modified-Since"] = conditional["last_modified"]
        try:
            with open_url(url, headers) as resp:
                if resp.status == 206:
                    mode, total = "ab", content_range_total(resp.headers.get("Content-Range"))
                else:  # 200: full body (nothing to resume, or the server ignored Range)
                    mode, resume_from = "wb", 0
                    length = resp.headers.get("Content-Length")
                    total = int(length) if length and length.isdigit() else None
                written = resume_from
                with open(part, mode) as out:
                    for block in iter(lambda: resp.read(CHUNK), b""):
                        out.write(block)
                        written += len(block)
                meta = {
                    "etag": resp.headers.get("ETag"),
                    "last_modified": resp.headers.get("Last-Modified"),
                    "size": written,
                    "final_url": resp.url,
                }
            if total is not None and written != total:
                raise Truncated(f"received {written:,} of {total:,} bytes")
            return meta
        except urllib.error.HTTPError as e:
            if e.code == 304:
                return None
            if e.code == 416:  # our .part no longer matches the remote object; start over
                part.unlink(missing_ok=True)
                reason, delay = "HTTP 416, restarting the download", 0.0
            elif e.code in RETRY_STATUSES:
                reason, delay = f"HTTP {e.code}", retry_delay(attempt, e)
            else:
                raise FetchError(f"HTTP {e.code} {e.reason}") from None
        except urllib.error.URLError as e:
            if is_permanent(e):
                raise FetchError(f"unreachable: {e.reason}") from None
            reason, delay = f"{type(e).__name__}: {e.reason}", retry_delay(attempt)
        except (http.client.HTTPException, ConnectionError, TimeoutError, Truncated) as e:
            reason, delay = f"{type(e).__name__}: {e}", retry_delay(attempt)
        if attempt >= MAX_ATTEMPTS:
            raise FetchError(f"{reason} (gave up after {attempt} attempts)")
        print(f"  .. {reason}; retry {attempt}/{MAX_ATTEMPTS - 1} in {delay:.0f}s")
        time.sleep(delay)


def fetch(label: str, candidates: list[tuple[str, Path, Verifier | None]], manifest: dict) -> bool:
    """Fetch one logical file, trying each (url, dest, verify) candidate in order.

    The first candidate is the primary source; later ones are the mirrors named in the
    brief.  Returns True once a candidate is on disk and verified (or unchanged).
    """
    files = manifest["files"]
    for index, (url, dest, verify) in enumerate(candidates):
        source = "primary" if index == 0 else "mirror"
        key = rel(dest)
        entry = files.get(key)
        conditional = entry if entry and entry.get("url") == url else None
        try:
            meta = download(url, dest, conditional)
        except FetchError as e:
            print(f"  !! {source} {url}\n     {e}")
            continue
        if meta is None:
            if entry is not None:
                entry["checked_at"] = now_iso()
            print(f"  ==  {key}  unchanged (HTTP 304)")
            return True
        part = part_of(dest)
        digest = sha256_of(part)
        try:
            info = verify(part, digest) if verify else {}
        except VerifyError as e:
            print(f"  !! {source} {url}\n     verification failed: {e}")
            part.unlink(missing_ok=True)
            continue
        os.replace(part, dest)
        files[key] = {
            "url": url,
            "source": source,
            "final_url": meta["final_url"],
            "etag": meta["etag"],
            "last_modified": meta["last_modified"],
            "size": meta["size"],
            "sha256": digest,
            "fetched_at": now_iso(),
            "info": info,
        }
        via = "" if source == "primary" else "  [via mirror]"
        same = "  (content unchanged)" if entry and entry.get("sha256") == digest else ""
        print(f"  ok  {key}  {human(meta['size'])}{via}{same}")
        return True
    print(f"  !! {label}: no source could be fetched")
    return False


# --------------------------------------------------------------------------- verifiers
def load_json(part: Path):
    try:
        with open(part, "rb") as f:
            return json.load(f)
    except (ValueError, UnicodeDecodeError) as e:
        raise VerifyError(f"not valid JSON: {e}") from None


def verify_kev_json(part: Path, _digest: str) -> dict:
    data = load_json(part)
    vulns = data.get("vulnerabilities") if isinstance(data, dict) else None
    if not isinstance(vulns, list) or not vulns:
        raise VerifyError("no 'vulnerabilities' array")
    return {
        "catalog_version": data.get("catalogVersion"),
        "date_released": data.get("dateReleased"),
        "entries": len(vulns),
    }


def verify_kev_csv(part: Path, _digest: str) -> dict:
    with open(part, newline="", encoding="utf-8", errors="replace") as f:
        reader = csv.reader(f)
        header = next(reader, None)
        if not header or "cveID" not in header:
            raise VerifyError("CSV header does not contain cveID")
        rows = sum(1 for _ in reader)
    if rows == 0:
        raise VerifyError("CSV has no data rows")
    return {"entries": rows}


def verify_stix_bundle(part: Path, _digest: str) -> dict:
    data = load_json(part)
    objects = data.get("objects") if isinstance(data, dict) else None
    if not isinstance(objects, list) or not objects:
        raise VerifyError("no STIX 'objects' array")
    info = {
        "objects": len(objects),
        "attack_patterns": sum(1 for o in objects if o.get("type") == "attack-pattern"),
    }
    for o in objects:
        if o.get("type") == "x-mitre-collection":
            info["version"] = o.get("x_mitre_version")
            info["modified"] = o.get("modified")
            break
    return info


def verify_capec_xml(part: Path, _digest: str) -> dict:
    head = first_bytes(part, 8192)
    if not head.lstrip().startswith(b"<?xml") or b"Attack_Pattern_Catalog" not in head:
        raise VerifyError("not a CAPEC Attack_Pattern_Catalog XML document")
    version = re.search(rb'Version="([^"]+)"', head)
    return {
        "version": version.group(1).decode() if version else None,
        "attack_patterns": count_occurrences(part, b"<Attack_Pattern ID="),
    }


def make_verify_cwe_zip(xml_dest: Path) -> Verifier:
    """Test the zip, then extract the XML next to it (so it is greppable offline)."""

    def verify(part: Path, _digest: str) -> dict:
        tmp = part_of(xml_dest)
        try:
            with zipfile.ZipFile(part) as z:
                bad = z.testzip()
                if bad:
                    raise VerifyError(f"corrupt zip member {bad}")
                members = [n for n in z.namelist() if n.lower().endswith(".xml")]
                if not members:
                    raise VerifyError("no XML member in the archive")
                with z.open(members[0]) as src, open(tmp, "wb") as dst:
                    shutil.copyfileobj(src, dst, CHUNK)
        except zipfile.BadZipFile as e:
            raise VerifyError(f"bad zip: {e}") from None
        head = first_bytes(tmp, 8192)
        if b"Weakness_Catalog" not in head:
            tmp.unlink(missing_ok=True)
            raise VerifyError("archive member is not a CWE Weakness_Catalog")
        version = re.search(rb'Version="([^"]+)"', head)
        os.replace(tmp, xml_dest)
        return {
            "version": version.group(1).decode() if version else None,
            "member": members[0],
            "weaknesses": count_occurrences(xml_dest, b"<Weakness ID="),
        }

    return verify


def nvd_head_info(head: bytes) -> dict:
    count = re.search(rb'"cve_count":\s*(\d+)', head)
    stamp = re.search(rb'"timestamp":\s*"([^"]+)"', head)
    return {
        "cve_count": int(count.group(1)) if count else None,
        "feed_timestamp": stamp.group(1).decode() if stamp else None,
    }


def decompress_xz(xz_path: Path, json_dest: Path) -> dict:
    """Stream-decompress an NVD feed (xz verifies its own CRC64 while doing so)."""
    tmp = part_of(json_dest)
    try:
        with lzma.open(xz_path, "rb") as src, open(tmp, "wb") as dst:
            shutil.copyfileobj(src, dst, CHUNK)
    except (lzma.LZMAError, EOFError) as e:
        tmp.unlink(missing_ok=True)
        raise VerifyError(f"xz decompression failed: {e}") from None
    size = tmp.stat().st_size
    with open(tmp, "rb") as f:
        head = f.read(1024)
        f.seek(max(0, size - 64))
        tail = f.read()
    if not head.lstrip().startswith(b"{") or not tail.rstrip().endswith(b"}"):
        tmp.unlink(missing_ok=True)
        raise VerifyError("decompressed feed is not a JSON object")
    os.replace(tmp, json_dest)
    return {**nvd_head_info(head), "json_size": size}


def xz_integrity(xz_path: Path) -> dict:
    """Full integrity pass without writing the decompressed feed (--no-decompress)."""
    head = b""
    try:
        with lzma.open(xz_path, "rb") as src:
            for block in iter(lambda: src.read(CHUNK), b""):
                if not head:
                    head = block[:1024]
    except (lzma.LZMAError, EOFError) as e:
        raise VerifyError(f"xz integrity check failed: {e}") from None
    return nvd_head_info(head)


def make_verify_nvd_xz(json_dest: Path, previous: dict | None, decompress: bool) -> Verifier:
    def verify(part: Path, digest: str) -> dict:
        if previous and previous.get("sha256") == digest and json_dest.exists():
            return previous.get("info", {})  # identical archive; JSON already extracted
        if not decompress:
            return xz_integrity(part)
        return decompress_xz(part, json_dest)

    return verify


def make_verify_epss_gz(csv_dest: Path) -> Verifier:
    def verify(part: Path, _digest: str) -> dict:
        tmp = part_of(csv_dest)
        try:
            with gzip.open(part, "rb") as src, open(tmp, "wb") as dst:
                shutil.copyfileobj(src, dst, CHUNK)
        except (gzip.BadGzipFile, EOFError, zlib.error) as e:
            tmp.unlink(missing_ok=True)
            raise VerifyError(f"gzip decompression failed: {e}") from None
        with open(tmp, encoding="utf-8", errors="replace") as f:
            first = f.readline().strip()
            second = f.readline().strip()
            header = second if first.startswith("#") else first
            if not header.startswith("cve,epss,percentile"):
                tmp.unlink(missing_ok=True)
                raise VerifyError(f"unexpected CSV header {header[:60]!r}")
            rows = sum(1 for line in f if line.strip())
            if not first.startswith("#"):
                rows += 1  # `second` was already a data row
        info: dict = {"rows": rows}
        if first.startswith("#"):  # "#model_version:v2025.03.14,score_date:2026-09-13T00:00:00+0000"
            for item in first.lstrip("#").split(","):
                k, _, v = item.partition(":")
                if k and v:
                    info[k.strip()] = v.strip()
        os.replace(tmp, csv_dest)
        return info

    return verify


# ----------------------------------------------------------------------------- sources
def fetch_nvd_feeds(years: list[int], manifest: dict, *, decompress: bool = True) -> bool:
    print(f"[NVD] CVE JSON feeds {years[0]}-{years[-1]} via the FKIE mirror "
          "(github.com/fkie-cad/nvd-json-data-feeds)")
    out = ROOT / "vulnerability-data" / "nvd"
    ok = True
    for year in years:
        xz, js = out / f"CVE-{year}.json.xz", out / f"CVE-{year}.json"
        previous = manifest["files"].get(rel(xz))
        verify = make_verify_nvd_xz(js, previous, decompress)
        if not fetch(f"CVE-{year}", [(f"{NVD_FEED_BASE}/CVE-{year}.json.xz", xz, verify)], manifest):
            ok = False
            continue
        if decompress and xz.exists() and not js.exists():  # e.g. 304, but the JSON was deleted
            try:
                manifest["files"][rel(xz)]["info"] = decompress_xz(xz, js)
                print(f"  ok  {rel(js)}  re-extracted ({human(js.stat().st_size)})")
            except VerifyError as e:
                print(f"  !! {rel(js)}: {e}")
                ok = False
    return ok


def fetch_cisa_kev(manifest: dict) -> bool:
    print("[CISA] Known Exploited Vulnerabilities catalog (cisa.gov; mirror github.com/cisagov/kev-data)")
    out = ROOT / "vulnerability-data" / "cisa-kev"
    ok = True
    for ext, verify in (("json", verify_kev_json), ("csv", verify_kev_csv)):
        dest = out / f"known_exploited_vulnerabilities.{ext}"
        candidates = [(f"{KEV_PRIMARY}.{ext}", dest, verify), (f"{KEV_MIRROR}.{ext}", dest, verify)]
        ok = fetch(f"KEV {ext}", candidates, manifest) and ok
    return ok


def fetch_mitre_attack(manifest: dict) -> bool:
    print("[MITRE] ATT&CK STIX 2.1 bundles (github.com/mitre-attack/attack-stix-data)")
    out = ROOT / "frameworks" / "mitre-attack"
    ok = True
    for domain in ("enterprise-attack", "mobile-attack", "ics-attack"):
        candidates = [(f"{ATTACK_BASE}/{domain}/{domain}.json", out / f"{domain}.json", verify_stix_bundle)]
        ok = fetch(domain, candidates, manifest) and ok
    return ok


def fetch_mitre_cwe(manifest: dict) -> bool:
    print("[MITRE] CWE weakness catalog (cwe.mitre.org)")
    out = ROOT / "frameworks" / "mitre-cwe"
    candidates = [(CWE_ZIP_URL, out / "cwec_latest.xml.zip", make_verify_cwe_zip(out / "cwec_latest.xml"))]
    return fetch("CWE", candidates, manifest)


def fetch_mitre_capec(manifest: dict) -> bool:
    print("[MITRE] CAPEC attack-pattern catalog (capec.mitre.org; STIX mirror github.com/mitre/cti)")
    out = ROOT / "frameworks" / "mitre-capec"
    candidates = [
        (CAPEC_XML_URL, out / "capec_latest.xml", verify_capec_xml),
        (CAPEC_STIX_MIRROR, out / "stix-capec.json", verify_stix_bundle),
    ]
    return fetch("CAPEC", candidates, manifest)


def resolve_epss_url() -> str:
    """The EPSS download host has moved before; read the current link off first.org."""
    try:
        with open_url(EPSS_PAGE) as resp:
            page = resp.read(2_000_000).decode("utf-8", "replace")
        match = re.search(r"https?://[^\s\"'<>]+/epss_scores-current\.csv\.gz", page)
        if match:
            return match.group(0)
        print(f"  .. {EPSS_PAGE} has no epss_scores-current.csv.gz link; using the known host")
    except (urllib.error.URLError, http.client.HTTPException, ConnectionError, TimeoutError) as e:
        print(f"  .. could not read {EPSS_PAGE} ({getattr(e, 'reason', e)}); using the known host")
    return EPSS_KNOWN_URL


def fetch_epss(manifest: dict) -> bool:
    print("[FIRST] EPSS daily exploit-probability scores (optional)")
    out = ROOT / "vulnerability-data" / "epss"
    url = resolve_epss_url()
    candidates = [(url, out / "epss_scores-current.csv.gz", make_verify_epss_gz(out / "epss_scores-current.csv"))]
    return fetch("EPSS", candidates, manifest)


def api_get_json(url: str, headers: dict) -> dict | None:
    attempt = 0
    while True:
        attempt += 1
        try:
            with open_url(url, headers) as resp:
                return json.loads(resp.read())
        except urllib.error.HTTPError as e:
            # NVD answers 403 when the key is bad *and* when a client is throttled.
            if e.code not in RETRY_STATUSES | {403}:
                print(f"  !! HTTP {e.code} {e.reason}")
                return None
            reason, delay = f"HTTP {e.code}", retry_delay(attempt, e)
        except urllib.error.URLError as e:
            if is_permanent(e):
                print(f"  !! unreachable: {e.reason}")
                return None
            reason, delay = f"{type(e).__name__}: {e.reason}", retry_delay(attempt)
        except (http.client.HTTPException, ConnectionError, TimeoutError, ValueError) as e:
            reason, delay = f"{type(e).__name__}: {e}", retry_delay(attempt)
        if attempt >= MAX_ATTEMPTS:
            print(f"  !! {reason} (gave up after {attempt} attempts)")
            return None
        print(f"  .. {reason}; retry {attempt}/{MAX_ATTEMPTS - 1} in {delay:.0f}s")
        time.sleep(delay)


def fetch_nvd_api_incremental(days: int, manifest: dict) -> bool:
    """Pull CVEs modified in the last `days` days via the official NVD 2.0 API.

    Uses NVD_API_KEY from the environment if set (50 requests / 30 s instead of 5).
    The FKIE feeds above remain the primary source; this adds same-day deltas.
    """
    key = os.environ.get("NVD_API_KEY")
    days = min(days, 120)  # the API rejects lastModified windows longer than 120 days
    print(f"[NVD] 2.0 API: CVEs modified in the last {days} days ({'with' if key else 'without'} NVD_API_KEY)")
    headers = {"apiKey": key} if key else {}
    end = dt.datetime.now(dt.timezone.utc)
    start = end - dt.timedelta(days=days)
    fmt = "%Y-%m-%dT%H:%M:%S.000"
    out = ROOT / "vulnerability-data" / "nvd" / "recent" / "recent-modified.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    per_page, start_index, total = 2000, 0, None
    collected: list = []
    pause = 0.6 if key else 6.0
    while total is None or start_index < total:
        query = urllib.parse.urlencode({
            "lastModStartDate": start.strftime(fmt),
            "lastModEndDate": end.strftime(fmt),
            "resultsPerPage": per_page,
            "startIndex": start_index,
        }, safe=":")
        page = api_get_json(f"{NVD_API}?{query}", headers)
        if page is None:
            return False
        total = int(page.get("totalResults", 0))
        collected.extend(page.get("vulnerabilities", []))
        start_index += per_page
        print(f"  .. {min(start_index, total):,}/{total:,}")
        if start_index < total:
            time.sleep(pause)
    tmp = part_of(out)
    with open(tmp, "w") as f:
        json.dump({
            "fetched_at": now_iso(),
            "last_mod_start": start.strftime(fmt),
            "last_mod_end": end.strftime(fmt),
            "total_results": total,
            "vulnerabilities": collected,
        }, f)
    os.replace(tmp, out)
    manifest["files"][rel(out)] = {
        "url": NVD_API,
        "source": "primary",
        "size": out.stat().st_size,
        "sha256": sha256_of(out),
        "fetched_at": now_iso(),
        "info": {"cves": len(collected), "window_days": days},
    }
    print(f"  ok  {rel(out)}  ({len(collected):,} CVEs)")
    return True


# ------------------------------------------------------------------------------ status
DATASETS = [
    ("vulnerability-data/nvd/recent/recent-modified.json", "NVD 2.0 API deltas (optional)"),
    ("vulnerability-data/cisa-kev/known_exploited_vulnerabilities.json", "CISA KEV (JSON)"),
    ("vulnerability-data/cisa-kev/known_exploited_vulnerabilities.csv", "CISA KEV (CSV)"),
    ("vulnerability-data/epss/epss_scores-current.csv.gz", "EPSS scores (optional)"),
    ("frameworks/mitre-attack/enterprise-attack.json", "ATT&CK Enterprise"),
    ("frameworks/mitre-attack/mobile-attack.json", "ATT&CK Mobile"),
    ("frameworks/mitre-attack/ics-attack.json", "ATT&CK ICS"),
    ("frameworks/mitre-cwe/cwec_latest.xml.zip", "CWE"),
    ("frameworks/mitre-capec/capec_latest.xml", "CAPEC (XML)"),
    ("frameworks/mitre-capec/stix-capec.json", "CAPEC (STIX 2.1, mitre/cti mirror)"),
]
DETAIL_LABELS = {
    "cve_count": "{:,} CVEs", "cves": "{:,} CVEs", "entries": "{:,} entries", "rows": "{:,} rows",
    "objects": "{:,} STIX objects", "attack_patterns": "{:,} attack patterns",
    "weaknesses": "{:,} weaknesses", "version": "version {}", "catalog_version": "catalog {}",
    "date_released": "released {}", "feed_timestamp": "feed built {}", "modified": "modified {}",
    "model_version": "model {}", "score_date": "scored {}", "window_days": "last {} days",
}


def describe(info: dict) -> str:
    parts = []
    for key, value in info.items():
        if value is None or key in ("json_size", "member"):
            continue
        parts.append(DETAIL_LABELS.get(key, key + " {}").format(value))
    return ", ".join(parts)


def served_by(entry: dict) -> str:
    host = urllib.parse.urlsplit(entry.get("url", "")).hostname or "?"
    return host if entry.get("source") == "primary" else f"{host} (mirror)"


def short_time(stamp: str | None) -> str:
    return (stamp or "")[:16].replace("T", " ")


def dir_size(path: Path) -> int:
    try:
        out = subprocess.run(["du", "-sk", str(path)], capture_output=True, text=True, check=True).stdout
        return int(out.split()[0]) * 1024
    except (OSError, subprocess.CalledProcessError, ValueError, IndexError):
        return sum(p.stat().st_size for p in path.rglob("*") if p.is_file())


def git(dest: Path, *args: str) -> str:
    try:
        return subprocess.run(["git", "-C", str(dest), *args], capture_output=True,
                              text=True, check=True).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return ""


def status_markdown() -> str:
    files = load_manifest().get("files", {})
    stamp = LAST_UPDATE_PATH.read_text().strip() if LAST_UPDATE_PATH.exists() \
        else "Never updated (run scripts/update.sh)"
    out = [f"_{stamp}. Generated by `scripts/fetch_data.py --status`; `scripts/update.sh` refreshes it._", ""]

    out += ["**Data feeds** (provenance in `manifest.json`)", "",
            "| Dataset | File(s) | Served by | Size | Fetched (UTC) | Details |",
            "|---|---|---|---|---|---|"]
    nvd = {k: v for k, v in files.items() if re.fullmatch(r"vulnerability-data/nvd/CVE-\d{4}\.json\.xz", k)}
    if nvd:
        years = sorted(int(k[-12:-8]) for k in nvd)
        infos = [v.get("info", {}) for v in nvd.values()]
        cves = sum(i.get("cve_count") or 0 for i in infos)
        size = sum(v.get("size", 0) for v in nvd.values()) + sum(i.get("json_size") or 0 for i in infos)
        built = max((i.get("feed_timestamp") or "" for i in infos), default="")
        fetched = max(v.get("fetched_at", "") for v in nvd.values())
        mirrored = any(v.get("source") != "primary" for v in nvd.values())
        out.append(f"| NVD CVE feeds {years[0]}-{years[-1]} ({len(years)} years) | "
                   f"`vulnerability-data/nvd/CVE-<year>.json(.xz)` | github.com (FKIE mirror{', mirror' if mirrored else ''}) | "
                   f"{human(size)} | {short_time(fetched)} | {cves:,} CVEs, feed built {short_time(built)} |")
    else:
        out.append("| NVD CVE feeds | `vulnerability-data/nvd/` | | | | not fetched |")
    for key, label in DATASETS:
        entry = files.get(key)
        if entry:
            size = entry.get("size", 0) + (entry.get("info", {}).get("json_size") or 0)
            out.append(f"| {label} | `{key}` | {served_by(entry)} | {human(size)} | "
                       f"{short_time(entry.get('fetched_at'))} | {describe(entry.get('info', {}))} |")
        elif "optional" not in label and "mirror" not in label:
            out.append(f"| {label} | `{key}` | | | | not fetched |")
    if nvd:
        out += ["", "<details><summary>NVD feed per year</summary>", "",
                "| Year | CVEs | .xz | .json | Feed built | Fetched (UTC) |", "|---|---|---|---|---|---|"]
        for key in sorted(nvd):
            v, info = nvd[key], nvd[key].get("info", {})
            out.append(f"| {key[-12:-8]} | {info.get('cve_count') or 0:,} | {human(v.get('size', 0))} | "
                       f"{human(info.get('json_size') or 0)} | {short_time(info.get('feed_timestamp'))} | "
                       f"{short_time(v.get('fetched_at'))} |")
        out += ["", "</details>"]

    out += ["", "**Git repositories** (shallow clones, `--depth=1`)", "",
            "| Repository | Local path | Commit | Committed | Size |", "|---|---|---|---|---|"]
    repos = 0
    for parent in ("methodology", "wordlists", "writeups", "exploits-reference"):
        base = ROOT / parent
        if not base.is_dir():
            continue
        for d in sorted(p for p in base.iterdir() if (p / ".git").exists()):
            url = git(d, "remote", "get-url", "origin").removesuffix(".git")
            name = url.split("://", 1)[-1]
            out.append(f"| [{name}]({url}) | `{rel(d)}/` | `{git(d, 'rev-parse', '--short', 'HEAD')}` | "
                       f"{git(d, 'log', '-1', '--format=%cs')} | {human(dir_size(d))} |")
            repos += 1
    if not repos:
        out.append("| _none cloned yet (run `scripts/clone_repos.sh`)_ | | | | |")

    out += ["", "**Storage**", "", "| Folder | Size |", "|---|---|"]
    total = 0
    for d in sorted(p for p in ROOT.iterdir() if p.is_dir() and not p.name.startswith(".") and p.name != "scripts"):
        size = dir_size(d)
        total += size
        out.append(f"| `{d.name}/` | {human(size)} |")
    out.append(f"| **total** | **{human(total)}** |")
    return "\n".join(out)


# -------------------------------------------------------------------------------- main
def parse_years(spec: str) -> list[int]:
    match = re.fullmatch(r"(\d{4})(?:-(\d{4}))?", spec.strip())
    if not match:
        raise SystemExit(f"--years expects YYYY or YYYY-YYYY, got {spec!r}")
    first, last = int(match.group(1)), int(match.group(2) or match.group(1))
    if not FIRST_CVE_YEAR <= first <= last <= THIS_YEAR:
        raise SystemExit(f"--years must lie within {FIRST_CVE_YEAR}-{THIS_YEAR}")
    return list(range(first, last + 1))


def parse_args(argv: list[str] | None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Fetch the direct-download sources of the security reference corpus.",
        epilog="With no options every source is refreshed; unchanged files are skipped.")
    p.add_argument("--only", action="append", choices=SOURCES, metavar="SOURCE",
                   help=f"fetch only this source (repeatable): {', '.join(SOURCES)}")
    p.add_argument("--years", default=f"{FIRST_CVE_YEAR}-{THIS_YEAR}", metavar="YYYY[-YYYY]",
                   help="NVD feed years to fetch (default: all, %(default)s)")
    p.add_argument("--no-decompress", action="store_true",
                   help="keep the NVD feeds as .xz only (about a tenth of the space)")
    p.add_argument("--no-epss", action="store_true", help="skip the optional EPSS daily CSV")
    p.add_argument("--nvd-api-days", type=int, metavar="N",
                   help="also pull CVEs modified in the last N days from the official NVD 2.0 API "
                        "(reads NVD_API_KEY from the environment if set)")
    p.add_argument("--status", action="store_true",
                   help="print a Markdown status report from manifest.json and exit (no network)")
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if args.status:
        print(status_markdown())
        return 0
    sys.stdout.reconfigure(line_buffering=True)
    years = parse_years(args.years)
    selected = set(args.only or SOURCES)
    if args.no_epss:
        selected.discard("epss")
    manifest = load_manifest()
    steps = [
        ("nvd", lambda: fetch_nvd_feeds(years, manifest, decompress=not args.no_decompress)),
        ("kev", lambda: fetch_cisa_kev(manifest)),
        ("attack", lambda: fetch_mitre_attack(manifest)),
        ("cwe", lambda: fetch_mitre_cwe(manifest)),
        ("capec", lambda: fetch_mitre_capec(manifest)),
        ("epss", lambda: fetch_epss(manifest)),
    ]
    if args.nvd_api_days:
        steps.append(("nvd-api", lambda: fetch_nvd_api_incremental(args.nvd_api_days, manifest)))
        selected.add("nvd-api")
    started = time.monotonic()
    results: dict[str, bool] = {}
    for name, step in steps:
        if name not in selected:
            continue
        try:
            results[name] = step()
        except KeyboardInterrupt:
            save_manifest(manifest)
            print("\ninterrupted; partial downloads will resume on the next run")
            return 130
        except Exception as e:  # keep going with the remaining sources
            print(f"  !! {name}: unexpected error: {e!r}")
            results[name] = False
        save_manifest(manifest)
    failed = [name for name, ok in results.items() if not ok]
    elapsed = time.monotonic() - started
    print(f"\nDone in {elapsed / 60:.1f} min: {len(results) - len(failed)} source(s) OK, {len(failed)} failed"
          f"{' (' + ', '.join(failed) + ')' if failed else ''}. Provenance: {rel(MANIFEST_PATH)}")
    if failed:
        print("A failed host is usually blocked by a local egress policy or temporarily down; "
              "re-running scripts/update.sh resumes and retries only what is missing.")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
