#!/usr/bin/env python3
"""Frozen GEO audit procedure. Python standard library only; no provider SDK.

Consumer mode prints prompts and accepts verbatim captures. Gemini API mode is
explicit opt-in for a billing-disabled project; never impersonates consumer UI.
Analyze, report and manifest operations are offline and deterministic.
"""
import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid

VERSION = "geo-audit-1"
ENGINES = {"chatgpt-consumer", "perplexity-consumer", "gemini-consumer", "gemini-api"}
STATUSES = {"ok", "blocked", "error", "unavailable"}


def digest(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def stable(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def validate_config(c):
    assert c["brand"] in [b["name"] for b in c["brands"]], "target brand missing"
    for key, rows in [("name", c["brands"]), ("id", c["queries"])]:
        assert len({r[key] for r in rows}) == len(rows), "duplicate config identifiers"
    assert c["queries"] and c["engines"] and set(c["engines"]) <= ENGINES
    for q in c["queries"]:
        assert q["prompt"].strip() and q["fixability_reason"].strip()
        for k in ("intent", "fixability"):
            assert type(q[k]) in (int, float) and math.isfinite(q[k]) and 0 <= q[k] <= 1
    for b in c["brands"]:
        assert b["aliases"] and all(a.strip() for a in b["aliases"])
        assert b["domains"] and all(re.fullmatch(r"[a-z0-9.-]+", d) for d in b["domains"])
    return c


def canonical_url(url):
    p = urllib.parse.urlsplit(url)
    if p.scheme not in ("http", "https") or not p.hostname or p.username or p.password:
        raise ValueError("citation must be a public HTTP(S) URL without credentials")
    host = p.hostname.lower().removeprefix("www.")
    query = urllib.parse.urlencode([(k, v) for k, v in urllib.parse.parse_qsl(p.query)
                                  if not k.lower().startswith("utm_")])
    return urllib.parse.urlunsplit((p.scheme, host, p.path or "/", query, ""))


def belongs(url, brand):
    host = urllib.parse.urlsplit(url).hostname or ""
    return any(host == d or host.endswith("." + d) for d in brand["domains"])


def answer_text(record):
    text = record["raw_answer"]
    if record["format"] == "dom-snapshot":
        # Source chips/drawers are citation evidence, not prose mentions.
        lines, skip_depth = [], None
        for line in text.splitlines():
            depth = len(line)-len(line.lstrip())
            if skip_depth is not None and depth > skip_depth:
                continue
            skip_depth = None
            if line.lstrip().startswith(('- dialog:', '- button "View source', '- link ')):
                skip_depth = depth
                continue
            if not line.lstrip().startswith('- /url:'):
                lines.append(line)
        return '\n'.join(lines)
    # A domain in a Markdown URL is not a textual brand mention.
    text = re.sub(r"\[([^\]]+)\]\(https?://[^)]+\)", r"\1", text)
    return re.sub(r"https?://\S+", "", text)


def mentions(text, brand):
    return any(re.search(r"(?<!\w)" + re.escape(a) + r"(?!\w)", text, re.I)
               for a in brand["aliases"])


def wilson(k, n):
    if not n:
        return None
    z = 1.959963984540054
    p = k / n
    den = 1 + z*z/n
    mid = (p + z*z/(2*n)) / den
    half = z * math.sqrt(p*(1-p)/n + z*z/(4*n*n)) / den
    return [max(0, mid-half), min(1, mid+half)]


def opportunity(data):
    n = data['n']
    if n == 0:
        return None
    return 100 * data['intent'] * data['fixability'] * (n - data['mentions'] + 1) / (n + 2)


def read_records(path, config):
    qs = {q["id"]: q for q in config["queries"]}
    records, seen, exclusions = [], {}, []
    for line_no, line in enumerate(Path(path).read_text().splitlines(), 1):
        if not line.strip():
            continue
        r = json.loads(line)
        for k in ("id", "query_id", "prompt", "engine", "model", "observed_at", "status",
                  "evidence_kind", "raw_answer", "sha256", "format", "context", "citation_coverage", "citations"):
            if k not in r:
                raise ValueError(f"line {line_no}: missing {k}")
        if r["evidence_kind"] != "measured":
            exclusions.append({"id": r["id"], "reason": "illustrative/synthetic: excluded"})
            continue
        if r["engine"] not in ENGINES or r["status"] not in STATUSES:
            raise ValueError("unknown engine or status")
        if r["query_id"] not in qs or r["prompt"] != qs[r["query_id"]]["prompt"]:
            raise ValueError("query text mismatch: make a new query id for a changed prompt")
        if r["sha256"] != digest(r["raw_answer"]):
            raise ValueError("raw evidence hash mismatch")
        stamp = datetime.fromisoformat(r["observed_at"].replace("Z", "+00:00"))
        if stamp.tzinfo is None:
            raise ValueError("capture time requires timezone")
        if not r["id"] or not r["model"] or not isinstance(r["context"], dict):
            raise ValueError("capture identity/model/context required")
        for k in ("session", "locale", "region", "search", "collector", "new_chat"):
            if k not in r["context"]:
                raise ValueError("missing collection context: " + k)
        if r["format"] not in ("text", "dom-snapshot") or r["citation_coverage"] not in ("complete", "visible-only", "unknown"):
            raise ValueError("unsupported capture format or citation coverage")
        if r["status"] == "ok" and not r["raw_answer"].strip():
            raise ValueError("empty answer cannot be a successful measurement")
        for cite in r["citations"]:
            canonical_url(cite["url"])
            if cite["url"] not in r["raw_answer"]:
                raise ValueError("citation URL missing from raw capture")
        for brand, review in r.get('sentiment_reviews', {}).items():
            if brand not in [b['name'] for b in config['brands']] or review.get('label') not in ('positive','negative','mixed','neutral'):
                raise ValueError('invalid sentiment annotation')
            if not review.get('quote') or review['quote'] not in r['raw_answer'] or not review.get('reviewer'):
                raise ValueError('sentiment annotation needs exact evidence and reviewer')
        identity = stable(r)
        if r["id"] in seen:
            if seen[r["id"]] != identity:
                raise ValueError("conflicting duplicate capture id")
            exclusions.append({"id": r["id"], "reason": "duplicate capture id"})
            continue
        seen[r["id"]] = identity
        records.append(r)
    return records, exclusions


def stratum(r):
    # Same-session repeats remain labelled; do not pretend they are independent users.
    return stable({"engine": r["engine"], "model": r["model"], "context": r["context"],
                   "citation_coverage": r["citation_coverage"]})


def analyze(config, records, exclusions=None):
    brands = config["brands"]
    target = next(b for b in brands if b["name"] == config["brand"])
    rows, facts, sources = [], [], {}
    measured = [r for r in records if r["evidence_kind"] == "measured"]
    for r in measured:
        if r["status"] != "ok":
            continue
        text = answer_text(r)
        urls = sorted({canonical_url(c["url"]) for c in r["citations"]})
        found = [b["name"] for b in brands if mentions(text, b)]
        for name in found:
            facts.append({"entity": name, "predicate": "mentioned", "status": "observed",
                          "capture_id": r["id"], "sha256": r["sha256"], "query_id": r["query_id"]})
        for url in urls:
            owner = next((b["name"] for b in brands if belongs(url, b)), None)
            s = sources.setdefault(url, {"url": url, "host": urllib.parse.urlsplit(url).hostname,
                "publisher": owner, "kind": "brand-owned" if owner == target["name"] else "competitor-owned" if owner else "unclassified-third-party",
                "capture_ids": [], "queries": [], "engines": [], "authority": None,
                "authority_note": "Not independently assessed; citation frequency is not authority."})
            s["capture_ids"].append(r["id"])
            s["queries"] = sorted(set(s["queries"] + [r["query_id"]]))
            s["engines"] = sorted(set(s["engines"] + [r["engine"]]))
            facts.append({"entity": r["query_id"], "predicate": "answer_links_source", "value": url,
                          "status": "observed", "capture_id": r["id"], "sha256": r["sha256"]})
    for q in config["queries"]:
        for engine in sorted(set(config["engines"]) | {r["engine"] for r in measured}):
            candidates = [r for r in measured if r["query_id"] == q["id"] and r["engine"] == engine]
            groups = sorted({stratum(r) for r in candidates}) or [None]
            for group in groups:
                attempts = [r for r in candidates if stratum(r) == group]
                good = [r for r in attempts if r["status"] == "ok"]
                n = len(good)
                counts = {b["name"]: sum(mentions(answer_text(r), b) for r in good) for b in brands}
                total = sum(counts.values())
                metrics = {}
                for b in brands:
                    m = counts[b["name"]]
                    citation_good = [r for r in good if r["citation_coverage"] != "unknown"]
                    cited = sum(any(belongs(canonical_url(c["url"]), b) for c in r["citations"]) for r in citation_good)
                    metrics[b["name"]] = {"mentions": m, "n": n, "visibility": m/n if n else None,
                        "wilson95": wilson(m, n), "share_of_voice": m/total if total else None,
                        "owned_domain_cited_answers": cited, "citation_n": len(citation_good),
                        "owned_domain_citation_rate": cited/len(citation_good) if citation_good else None,
                        "sentiment": dict(Counter(r['sentiment_reviews'][b['name']]['label'] for r in good if b['name'] in r.get('sentiment_reviews', {}))) or ("not-mentioned" if n and not m else "unassessed"),
                        "sentiment_review_n": sum(b['name'] in r.get('sentiment_reviews',{}) for r in good),
                        "sentiment_note": "Evidence-linked human/analyst annotations only; missing reviews are unassessed, not neutral."}
                m = counts[target["name"]]
                gap = (n-m+1)/(n+2) if n else None  # Beta(1,1) posterior mean absence
                score = opportunity({'n':n, 'mentions':m, 'intent':q['intent'], 'fixability':q['fixability']})
                urls = sorted({canonical_url(c["url"]) for r in good for c in r["citations"]})
                key = digest(stable([q["id"], engine, group]))[:16]
                rows.append({"id": key, "query_id": q["id"], "prompt": q["prompt"], "engine": engine,
                    "stratum": json.loads(group) if group else None, "n": n, "attempts": len(attempts),
                    "failed": len(attempts)-n, "metrics": metrics, "intent_prior": q["intent"],
                    "fixability_prior": q["fixability"], "fixability_reason": q["fixability_reason"],
                    "opportunity_score": score, "score_kind": "prior-weighted hypothesis, not measured ROI",
                    "absence_posterior_mean": gap, "evidence_ids": [r["id"] for r in good],
                    "source_urls": urls, "framing": q["framing"],
                    "status": "pilot-needs-replication" if n and n < 30 else "sampled" if n else "unmeasured"})
    rows.sort(key=lambda r: (r["opportunity_score"] is None, -(r["opportunity_score"] or 0), r["id"]))
    hypotheses = []
    for row in rows:
        if not row["n"]:
            continue
        third = [u for u in row["source_urls"] if not belongs(u, target)]
        mechanisms = [("positioning", "Test a truthful use-case page against the exact buyer constraints.")]
        if third:
            mechanisms.append(("source-coverage", "Review these cited pages for factual omissions and eligibility; propose corrections only where supported."))
        for mechanism, action in mechanisms:
            hypotheses.append({"id": row["id"]+"-"+mechanism, "query_id": row["query_id"],
                "engine": row["engine"], "mechanism": mechanism, "status": "untested-hypothesis",
                "priority": row["opportunity_score"], "evidence_ids": row["evidence_ids"], "sources": third,
                "action": action, "experiment": "Pre-register fixed prompts; collect fresh chats over multiple days before and after one factual change, with an unchanged comparison query. Log model/search conditions; report uncertainty. Do not infer causation from before/after alone."})
    contrasts = []
    for i, left in enumerate(rows):
        for right in rows[i+1:]:
            if not left['n'] or not right['n'] or left['stratum'] != right['stratum'] or left['query_id'] == right['query_id']:
                continue
            delta = right['metrics'][target['name']]['visibility'] - left['metrics'][target['name']]['visibility']
            if abs(delta) >= 0.25:
                contrasts.append({'left':left['query_id'], 'right':right['query_id'], 'engine':left['engine'],
                    'observed_visibility_difference':delta, 'sample_sizes':[left['n'],right['n']],
                    'status':'descriptive-contrast-not-causal', 'evidence_ids':left['evidence_ids']+right['evidence_ids'],
                    'hypothesis':'Visibility may depend on buyer framing. Test a bridge from the visible use case to the missing category, without claiming unsupported product capabilities.'})
    return {"version": VERSION, "brand": config["brand"], "category": config["category"],
        "methodology": config.get("methodology", "Operator supplied sampling design"),
        "records": measured, "exclusions": exclusions or [], "opportunity_queue": rows,
        "facts": facts, "sources": sorted(sources.values(), key=lambda s: (-len(s["capture_ids"]), s["url"])),
        "hypotheses": hypotheses, "framing_contrasts": contrasts}


def pct(x):
    return "unknown" if x is None else f"{100*x:.1f}%"


def md(text):
    return str(text).replace("|", "\\|").replace("\n", " ").replace("<", "&lt;")


def report(a):
    ok = [r for r in a["records"] if r["status"] == "ok"]
    lines = [f"# {md(a['brand'])}: AI visibility pilot audit", "", "## Measured evidence", "",
        f"{len(ok)} successful captured answers. This is a pilot, not a population visibility estimate.",
        a["methodology"], "", "Only measured captures enter this report. No illustrative engine answers are included.",
        "Models' factual claims and linked sources have not been independently verified. Raw capture hashes establish integrity, not authenticity of operator-supplied imports.",
        "", "| Query | Engine | Answers | Target mentions | Visibility | 95% Wilson interval* | Owned-domain link rate | Opportunity hypothesis /100 |",
        "|---|---|---:|---:|---|---|---|---:|"]
    for r in a["opportunity_queue"]:
        m = r["metrics"][a["brand"]]
        interval = "unknown" if m["wilson95"] is None else " to ".join(pct(x) for x in m["wilson95"])
        score = "unknown" if r["opportunity_score"] is None else f"{r['opportunity_score']:.1f}"
        lines.append(f"| {md(r['query_id'])} | {r['engine']} | {r['n']} | {m['mentions'] if r['n'] else 'unknown'} | {pct(m['visibility'])} | {interval} | {pct(m['owned_domain_citation_rate'])} | {score} |")
    lines += ["", "*Binomial interval assumes independent, identically distributed draws. Same-session repeats may be correlated; these intervals can understate uncertainty. Engine/model/context strata are separate rows. Failed requests never count as absence.",
        "Visible-only citation captures provide lower bounds on links; unexpanded source drawers may contain more. An owned-domain link is not the same as a third-party citation supporting a claim about the brand.",
        "", "## Competitor comparison", "", "Share of voice is binary brand-answer appearances divided by all tracked-brand appearances, within each stratum. Untracked brands are outside this denominator. Repeated mentions within one answer count once.", ""]
    for r in a["opportunity_queue"]:
        if not r["n"]:
            continue
        lines += [f"### {md(r['query_id'])} / {r['engine']} / {r['id']}", "",
                  "| Brand | Mentions / answers | Share of voice | Sentiment |", "|---|---:|---:|---|"]
        for brand, m in r["metrics"].items():
            lines.append(f"| {md(brand)} | {m['mentions']}/{m['n']} | {pct(m['share_of_voice'])} | {m['sentiment']} |")
    lines += ["", "## Observed source map", "", "Citation frequency is observed; source authority is unknown. Competitor-owned comparison pages are explicitly labelled, not treated as independent authorities.", "",
              "| Source | Publisher classification | Captured answers linking it | Authority |", "|---|---|---:|---|"]
    for s in a["sources"]:
        lines.append(f"| {md(s['url'])} | {s['kind']} | {len(s['capture_ids'])} | unassessed |")
    lines += ["", "## Proposed work, not measured results", "",
        "Opportunity = 100 × declared buyer-intent prior × declared fixability prior × posterior mean absence (Beta(1,1) prior). No data means unknown, never zero visibility. Scores express investigation priority, not causal lift or revenue.", ""]
    for c in a['framing_contrasts']:
        lines.append(f"- **Buyer-framing contrast:** {md(c['left'])} vs {md(c['right'])}, {c['engine']}, sample sizes {c['sample_sizes']}: observed difference {100*c['observed_visibility_difference']:.1f} percentage points (right minus left). Descriptive only. {c['hypothesis']}")
    for r in a["opportunity_queue"]:
        if r["n"]:
            lines.append(f"- {md(r['query_id'])}: intent prior {r['intent_prior']}; fixability prior {r['fixability_prior']}. {md(r['fixability_reason'])}")
    for h in a["hypotheses"][:6]:
        lines += ["", f"- **{md(h['query_id'])}: {h['mechanism']} (untested).** {h['action']} Evidence: {', '.join(h['evidence_ids'])}. {h['experiment']}"]
    lines += ["", "## Evidence register and gaps", ""]
    for r in a["records"]:
        lines.append(f"- {r['id']}: {r['engine']}, {r['observed_at']}, {r['status']}, model: {md(r['model'])}, SHA-256 `{r['sha256']}`. Context: `{stable(r['context'])}`.")
    for r in a["opportunity_queue"]:
        if not r["n"]:
            lines.append(f"- Unmeasured: {r['engine']} / {r['query_id']}; collect an answer before assessing visibility.")
    lines += ["", "Consumer captures require an accessible consumer session and operator assistance. The offline runner does not claim unattended access to ChatGPT, Perplexity or Gemini consumer products. Optional free-tier API output is a separate engine surface.",
              "No verified uplift, revenue effect, sentiment classifier or independent source-authority measurement is claimed.", ""]
    return "\n".join(lines)


def make_record(q, engine, raw, status="ok", citations=None, model="not-disclosed", context=None):
    return {"id": str(uuid.uuid4()), "query_id": q["id"], "prompt": q["prompt"], "engine": engine,
        "model": model, "observed_at": datetime.now(timezone.utc).isoformat(), "status": status,
        "evidence_kind": "measured", "raw_answer": raw, "sha256": digest(raw), "format": "text",
        "context": context or {"session": "operator-declared", "locale": "unknown", "region": "unknown", "search": "unknown", "collector": "manual-paste", "new_chat": "operator-declared"},
        "citation_coverage": "unknown", "citations": citations or []}


def collect(config, output, engine, repeats, api=False, model=None, billing_disabled=False):
    if not 1 <= repeats <= 10:
        raise ValueError("repeats must be 1..10 per invocation")
    if api and (not billing_disabled or not model or not os.environ.get("GEMINI_API_KEY")):
        raise ValueError("API requires --billing-disabled, --model and GEMINI_API_KEY; no paid fallback")
    if api and not re.fullmatch(r"[a-zA-Z0-9.-]+", model):
        raise ValueError("invalid model identifier")
    Path(output).parent.mkdir(parents=True, exist_ok=True)
    for q in config["queries"]:
        for _ in range(repeats):
            if api:
                endpoint = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
                request = urllib.request.Request(endpoint, data=json.dumps({"contents": [{"parts": [{"text": q["prompt"]}]}]}).encode(),
                    headers={"Content-Type": "application/json", "x-goog-api-key": os.environ["GEMINI_API_KEY"]})
                try:
                    with urllib.request.urlopen(request, timeout=60) as response:
                        payload = json.loads(response.read(2_000_001))
                    candidate = payload.get("candidates", [{}])[0]
                    raw = "\n".join(p.get("text", "") for p in candidate.get("content", {}).get("parts", []) if not p.get("thought"))
                    status = "ok" if raw.strip() and candidate.get("finishReason") == "STOP" else "error"
                    r = make_record(q, "gemini-api", raw or "No complete answer returned", status, model=payload.get("modelVersion", model))
                    r["context"].update({"collector": "gemini-generateContent", "search": "off", "new_chat": True, "session": "stateless-api"})
                    r["citation_coverage"] = "unknown"
                    r["provider_response"] = payload
                except (urllib.error.URLError, ValueError, TimeoutError) as exc:
                    # Do not persist exception strings that might echo credentials.
                    r = make_record(q, "gemini-api", f"Request failed: {type(exc).__name__}", "error", model=model)
            else:
                print(f"\nOpen a FRESH chat in {engine}. Submit exactly:\n{q['prompt']}\nPaste the answer (including visible URLs); finish with a line containing END. Type BLOCKED for an inaccessible engine.")
                lines = []
                while (line := input()) != "END":
                    lines.append(line)
                raw = "\n".join(lines)
                r = make_record(q, engine, raw, "blocked" if raw == "BLOCKED" else "ok")
                urls = re.findall(r"https?://[^\s<>\]\)]+", raw)
                r["citations"] = [{"url": u.rstrip(".,;")} for u in sorted(set(urls))]
                r["citation_coverage"] = "visible-only"
                r["context"]["session"] = input("Collection session label (reuse for same account/session): ").strip() or "unknown"
            with open(output, "a", encoding="utf-8") as stream:
                stream.write(stable(r)+"\n")
            if r["status"] != "ok":
                print("Stopped on unavailable/error response; no retries or paid fallback.")
                return


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("command", choices=["analyze", "collect", "battery"])
    p.add_argument("--config", required=True)
    p.add_argument("--captures")
    p.add_argument("--out", default="output")
    p.add_argument("--json", action="store_true")
    p.add_argument("--engine", choices=sorted(ENGINES), default="chatgpt-consumer")
    p.add_argument("--repeats", type=int, default=1)
    p.add_argument("--model")
    p.add_argument("--billing-disabled", action="store_true")
    args = p.parse_args()
    config = validate_config(json.loads(Path(args.config).read_text()))
    if args.command == "battery":
        print(json.dumps([{**q, "engine": e} for e in config["engines"] for q in config["queries"]], indent=2))
        return
    if not args.captures:
        p.error("--captures is required")
    if args.command == "collect":
        collect(config, args.captures, args.engine, args.repeats, args.engine == "gemini-api", args.model, args.billing_disabled)
    records, exclusions = read_records(args.captures, config)
    analysis = analyze(config, records, exclusions)
    if args.json:
        print(stable(analysis))
        return
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    for name, content in [("analysis.json", json.dumps(analysis, indent=2, ensure_ascii=False)),
                          ("opportunity-queue.json", json.dumps(analysis["opportunity_queue"], indent=2)),
                          ("audit.md", report(analysis))]:
        (out/name).write_text(content, encoding="utf-8")
    print(f"Wrote audit and opportunity queue to {out}")


if __name__ == "__main__":
    main()
