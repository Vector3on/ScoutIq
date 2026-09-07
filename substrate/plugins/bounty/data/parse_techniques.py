#!/usr/bin/env python3
"""Parse the 120-case PDF into techniques.json — one record per case, faithful to the PDF.

Source of truth: the extracted text (pdf_text.txt) + the 120 link annotations (urls.txt),
both in document order. We split on the 120 `Source:` delimiters, strip page furniture,
and derive mechanismFamilies + fingerprints from the case text (auditable: raw text kept).
"""
import json, re, sys

TEXT = open("pdf_text.txt").read()
URLS = [u.strip() for u in open("urls.txt").read().splitlines() if u.strip()]
assert len(URLS) == 120, f"expected 120 urls, got {len(URLS)}"

# --- section boundaries (global numbering 1..120) ---
SECTIONS = [
    (1, 16,  "A", "2025-2026 frontier methods"),
    (17, 51, "B", "Identity, web, cloud, CI, browser, and mobile"),
    (52, 85, "C", "Systems, hardware, supply chain, and firmware"),
    (86, 120,"D", "Blockchain, smart contracts, and decentralized systems"),
]
def section_of(n):
    for lo, hi, letter, name in SECTIONS:
        if lo <= n <= hi:
            return letter, name
    return "?", "?"

# --- strip page furniture ---
# Section headers wrap onto a 2nd line ("mobile", "AI agents", "distributed systems")
# which otherwise bleeds into each section's first case.
NOISE = re.compile(r"^(Research current to.*|NOVEL VULNERABILITY HUNTING|PUBLIC RESEARCH.*|A\. 2025.*|B\. Identity.*|C\. Systems.*|D\. Blockchain.*|mobile|AI agents|distributed systems|\d+ CASES|\d{1,3}|)$")

# Everything after the first case starts at "A. 2025-2026 frontier methods".
start = TEXT.index("A. 2025-2026 frontier methods")
body = TEXT[start:]

# Split into segments at each "Source:" line, keeping the source text.
# A case = text chunk ending at its Source line.
lines = body.splitlines()
cases = []
cur = []
for ln in lines:
    s = ln.strip()
    m = re.match(r"^Source:\s*(.+)$", s)
    if m:
        cases.append((cur, m.group(1).strip()))
        cur = []
    else:
        cur.append(ln)
# stop at 120 (epilogue after)
cases = cases[:120]
assert len(cases) == 120, f"expected 120 cases, got {len(cases)}"

# --- mechanismFamily keyword classifier (the join vocabulary) ---
FAMILIES = {
  "semantic/parser differential": r"differential|parser|canonicaliz|serializ|deseriali|sanitiz|polyglot|grammar|two parsers|disagree|interpretation|encoding|\bMIME\b|\bXML\b|normaliz|ambigu|footgun|transform",
  "stateful/race/desync": r"desync|desynchroniz|\brace\b|smuggl|stale|cache|state machine|rollback|retr(y|ies)|toctou|ordering|replay|backpressure|transition|timing|condition(ed|ing)|window|reentran",
  "trust-binding failure": r"bind|claim|oauth|oidc|saml|\bjwt\b|token|tenant|account[- ]link|redirect|subject|identit|session|alignment|\bidor\b|authoriz|mutable|takeover|cross-tenant|spoof|impersonat|forg(e|ed|ery)|signature",
  "secondary-channel/provenance": r"log injection|provenance|telemetry|email|\bcss\b|image proxy|error page|build artifact|callback|attestation|slsa|out-of-band|webhook|notification|side.?channel record|clipboard",
  "boundary-width/precision": r"integer|\bwidth\b|decimal|precision|signed|length field|overflow|underflow|round(ing)?|cross-vm|accounting|off-by|truncat|\bshares?\b|conversion|\bdecimals?\b|units?",
  "structured protocol fuzzing": r"fuzz|structured|protocol state|transcript|abstract interpret|compiler|call sequence|corpus|coverage-guided|state-aware|grammar-based|mutation",
  "historical supply-chain": r"supply.?chain|dependency confusion|stale domain|orphan|tarball|mutable tag|migration|runner persist|typosquat|namespace|registry|package|npm|pypi|maven|artifact|ci/cd|pipeline|workflow|actions",
  "confused-deputy": r"confused deputy|prompt inject|\bagent\b|tool call|\bssrf\b|metadata|deputy|retrieval|indirect prompt|over-privileg|on-behalf|proxy the|forwarded|impersonat|delegat",
  "cost/DoS asymmetry": r"denial of service|\bdos\b|amplif|resource exhaust|zip bomb|decompress|quadratic|asymmetr|complexity|exhaust|billion laughs|cost",
  "hardware abstraction leak": r"hardware|\bdma\b|speculative|rowhammer|baseband|firmware|microarchitect|voltage|glitch|peripheral|\bmmio\b|\bcpu\b|kernel|driver|hypervisor|\bvm\b escape|enclave|sgx|\btee\b|cache timing|electromagnetic|fault inject",
}
FAMILY_RE = {f: re.compile(p, re.I) for f, p in FAMILIES.items()}

# section-level prior (a hint, not a decision)
SECTION_PRIOR = {
  "A": ["semantic/parser differential", "stateful/race/desync"],
  "B": ["trust-binding failure", "confused-deputy"],
  "C": ["hardware abstraction leak", "historical supply-chain", "structured protocol fuzzing"],
  "D": ["boundary-width/precision", "trust-binding failure", "stateful/race/desync"],
}

# --- fingerprint keyword tags (target observableSignals <-> technique.preconditions) ---
FINGERPRINTS = {
  "http": r"\bhttp\b|header|request|response|proxy|cdn|smuggl|desync|cache",
  "cache": r"cache|cdn|stale|vary",
  "oauth-oidc-saml": r"oauth|oidc|saml|sso|openid",
  "jwt-session": r"\bjwt\b|session|cookie|token",
  "xml": r"\bxml\b|saml|canonicaliz|xslt|svg",
  "email": r"email|smtp|dkim|dmarc|spf|webmail|mime",
  "cloud-iam": r"cloud|aws|azure|gcp|\biam\b|metadata|imds|tenant|s3|bucket",
  "ci-cd": r"ci/cd|github actions|runner|pipeline|workflow|build|slsa|artifact",
  "containers-k8s": r"kubernetes|k8s|container|pod|namespace|operator|helm",
  "ai-agent-mcp": r"\bai\b|\bllm\b|agent|prompt|\bmcp\b|retrieval|rag|tool call",
  "browser-ext": r"browser|extension|dom|xss|clickjack|content script|renderer",
  "supply-chain-pkg": r"npm|pypi|maven|package|dependency|registry|tarball|namespace",
  "smart-contract-evm": r"solidity|evm|smart contract|defi|vault|erc-|amm|pool|oracle|token accounting",
  "blockchain-consensus": r"consensus|validator|sequencer|rollup|bridge|l1|l2|block|chain reorg",
  "kernel-os": r"kernel|driver|syscall|linux|windows|hypervisor|\bvm\b|\bdma\b",
  "hardware-radio": r"baseband|cellular|\b5g\b|\blte\b|firmware|hardware|\bdma\b|rowhammer|glitch|electromagnetic|voltage",
  "dns-tls-pki": r"\bdns\b|\btls\b|\bpki\b|certificate|x\.509|dnssec|resolver",
  "database-storage": r"database|\bsql\b|postgres|mysql|row.?level|object storage|\bs3\b",
  "document-media": r"\bpdf\b|\bpng\b|\bzip\b|archive|image|media|font|codec|document",
  "messaging-queue": r"queue|kafka|rabbitmq|event stream|webhook|async|message",
}
FP_RE = {f: re.compile(p, re.I) for f, p in FINGERPRINTS.items()}

def classify_families(text, section):
    hits = [(f, len(FAMILY_RE[f].findall(text))) for f in FAMILIES]
    hits = [(f, c) for f, c in hits if c > 0]
    hits.sort(key=lambda x: -x[1])
    fams = [f for f, _ in hits]
    if not fams:  # fall back to the section prior so every case still joins
        fams = SECTION_PRIOR.get(section, [])[:1]
    # keep families with real support, but ensure the section's primary prior rides along if present in text
    return fams

def fingerprints(text):
    return [f for f in FINGERPRINTS if FP_RE[f].search(text)]

def clean_block(block_lines):
    kept = []
    for ln in block_lines:
        s = ln.strip()
        if not s:
            continue
        if NOISE.match(s):
            continue
        kept.append(s)
    return kept

records = []
for i, (block, source) in enumerate(cases):
    num = i + 1
    letter, secname = section_of(num)
    kept = clean_block(block)
    # The leading standalone number line was stripped by NOISE (\d{1,3}); join the rest.
    joined = " ".join(kept)
    joined = re.sub(r"\s+", " ", joined).strip()
    # title (year) - description
    m = re.match(r"^(.*?)\((\d{4})\)\s*[-–—]\s*(.*)$", joined)
    if m:
        title = m.group(1).strip().rstrip("-–— ").strip()
        year = int(m.group(2))
        desc = m.group(3).strip()
    else:
        # no year/dash; best-effort split
        title = joined[:80].strip()
        year = None
        desc = joined
    full = f"{title} {desc}"
    fams = classify_families(full, letter)
    rec = {
        "id": f"T{num:03d}",
        "number": num,
        "title": title,
        "year": year,
        "howFound": desc,           # the mechanism: how the bug was actually found
        "mechanismFamilies": fams,  # THE JOIN KEY to anatomy seams
        "fingerprints": fingerprints(full),  # preconditions <-> target observableSignals
        "section": letter,
        "domain": secname,
        "source": source,           # primary source attribution as printed
        "sourceUrl": URLS[i],       # the clickable primary-source link (annotation)
    }
    records.append(rec)

# --- validation ---
assert len(records) == 120
no_fam = [r["number"] for r in records if not r["mechanismFamilies"]]
no_year = [r["number"] for r in records if r["year"] is None]
short = [r["number"] for r in records if len(r["howFound"]) < 30]
print("records:", len(records))
print("no family:", no_fam)
print("no year:", no_year)
print("suspiciously short howFound:", short)
from collections import Counter
fc = Counter(f for r in records for f in r["mechanismFamilies"])
print("family distribution:")
for f, c in fc.most_common():
    print(f"  {c:3d}  {f}")
fpc = Counter(f for r in records for f in r["fingerprints"])
print("fingerprint distribution:")
for f, c in fpc.most_common():
    print(f"  {c:3d}  {f}")

json.dump(records, open("techniques.json", "w"), indent=2, ensure_ascii=False)
print("\n=== sample records ===")
for n in (1, 5, 17, 52, 86, 120):
    print(json.dumps(records[n-1], ensure_ascii=False))
