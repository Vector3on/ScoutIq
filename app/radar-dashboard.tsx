"use client";

import { type CSSProperties, useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  ArrowDownToLine,
  ArrowUpRight,
  Bookmark,
  Check,
  ChevronRight,
  CircleHelp,
  Copy,
  Database,
  GitBranch,
  Radar,
  RefreshCw,
  Search,
  ShieldCheck,
  TriangleAlert,
  Zap,
} from "lucide-react";

import type { ChangeType, RadarPayload, RadarProgram, Workflow } from "@/app/radar-types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

const TOP_LIMIT = 25;
const STORAGE_WATCHLIST = "scoutiq:watchlist";
const STORAGE_REVIEWED = "scoutiq:reviewed";
const LIVE_WORKFLOWS = new Set<Workflow>(["live-web", "live-api", "live-contract", "ai-agent"]);

const changeLabels: Record<ChangeType, string> = {
  new_program: "New program",
  new_target: "Target added",
  scope_updated: "Scope changed",
  reward_up: "Reward increased",
  reactivated: "Reactivated",
  baseline: "Tracked",
};

const workflowLabels: Record<Workflow, string> = {
  "live-web": "Live web",
  "live-api": "Live API",
  "live-contract": "Live contract",
  "ai-agent": "AI agent",
  "static-source": "Fresh source",
  "static-source-hardened": "Hardened source",
};

function workflowOf(program: RadarProgram): Workflow {
  return program.workflow ?? (program.sourceCode ? "static-source" : program.tags.includes("api") ? "live-api" : "live-web");
}

function readStoredSet(key: string) {
  try {
    const value = JSON.parse(window.localStorage.getItem(key) ?? "[]");
    return new Set<string>(Array.isArray(value) ? value : []);
  } catch {
    return new Set<string>();
  }
}

function writeStoredSet(key: string, value: Set<string>) {
  window.localStorage.setItem(key, JSON.stringify([...value]));
}

function relativeTime(value: string) {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "unknown";
  const seconds = Math.round((timestamp - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["year", 31_536_000], ["month", 2_592_000], ["day", 86_400], ["hour", 3_600], ["minute", 60],
  ];
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size || unit === "minute") return formatter.format(Math.round(seconds / size), unit);
  }
  return "just now";
}

function compactMoney(value: number, currency: string | null = "USD") {
  try {
    return new Intl.NumberFormat("en", {
      style: "currency",
      currency: currency || "USD",
      notation: Math.abs(value) >= 10_000 ? "compact" : "standard",
      maximumFractionDigits: value < 1_000 ? 0 : 1,
    }).format(value);
  } catch {
    return `${currency || "USD"} ${Math.round(value).toLocaleString()}`;
  }
}

function rewardLabel(program: RadarProgram) {
  if (program.minReward != null && program.maxReward != null) return `${compactMoney(program.minReward, program.currency)} to ${compactMoney(program.maxReward, program.currency)}`;
  if (program.maxReward != null) return `Up to ${compactMoney(program.maxReward, program.currency)}`;
  return program.paid ? "Paid, amount unparsed" : "No confirmed reward";
}

function evLabel(program: RadarProgram) {
  return compactMoney(Number(program.evScore ?? 0), program.currency);
}

function evTier(value: number) {
  if (value >= 5_000) return { label: "High EV", className: "tier-hot" };
  if (value >= 1_500) return { label: "Strong", className: "tier-strong" };
  if (value >= 500) return { label: "Plausible", className: "tier-possible" };
  return { label: "Thin", className: "tier-cold" };
}

function normalized(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function honestReason(program: RadarProgram) {
  return program.honestReason ?? program.reasons?.[0] ?? `${workflowLabels[workflowOf(program)]} + ${program.payableSeverityCeiling ?? "unknown"} ceiling`;
}

function buildBrief(program: RadarProgram) {
  const targetLines = program.targets.slice(0, 10).map((target) =>
    `- [${target.workflow ?? target.type}] ${target.value} | EV ${compactMoney(target.evScore ?? 0, program.currency)}${target.excludeReason ? ` | EXCLUDED: ${target.excludeReason}` : ""}`,
  ).join("\n");
  return `SCOUTIQ PAYABLE-BUG TRIAGE PACKET

Program: ${program.name}
Official policy: ${program.url}
Workflow: ${workflowLabels[workflowOf(program)]}
Reward ceiling: ${rewardLabel(program)}
Reward used for EV: ${compactMoney(program.effectiveReward ?? program.maxReward ?? 0, program.currency)}${program.rewardCapped ? " (capped)" : ""}
Payable severity ceiling: ${program.payableSeverityCeiling ?? "unknown"}
Program floor: ${program.programFloorSeverity ?? "unknown"} (${program.programFloorSource ?? "unknown source"})
EV estimate: ${evLabel(program)}
P(findable): ${Math.round((program.pFindable ?? 0) * 100)}%
P(payable): ${Math.round((program.pPayable ?? 0) * 100)}%
P(first): ${Math.round((program.pFirst ?? 0) * 100)}%
Reason: ${honestReason(program)}

Target routes:
${targetLines || "- No structured target was available"}

Task:
1. Re-open the official policy and verify current scope, payout table, safe harbor, account limits, and researcher eligibility.
2. Work only on the selected ${workflowOf(program)} route. Do not broaden into unrelated core libraries.
3. Form three hypotheses that can reach ${program.programFloorSeverity ?? "the payable floor"}; discard pure low-impact DoS immediately.
4. For live services, use only your own accounts and policy-approved traffic. For contracts, confirm deployed activity and value first.
5. Search tests, issues, advisories, and feature flags for prior developer knowledge before building a PoC.
6. Stop after 90 minutes if exploitability, novelty, severity, or payout eligibility cannot be evidenced.

Return a go/no-go decision with exact evidence and links.`;
}

function downloadText(filename: string, text: string, type: string) {
  const blob = new Blob([text], { type });
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(href);
}

function programsToCsv(programs: RadarProgram[]) {
  const fields = ["ev_score", "name", "platform", "workflow", "ceiling", "program_floor", "p_findable", "p_payable", "p_first", "hardening", "fresh_code", "known_issue_risk", "effective_reward", "max_reward", "reward_capped", "reason", "url"];
  const escape = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  return [fields.join(","), ...programs.map((program) => [
    program.evScore, program.name, program.platform, workflowOf(program), program.payableSeverityCeiling,
    program.programFloorSeverity, program.pFindable, program.pPayable, program.pFirst, program.hardeningIndex,
    program.freshCodeIndex, program.knownIssueRisk, program.effectiveReward, program.maxReward, program.rewardCapped, honestReason(program), program.url,
  ].map(escape).join(","))].join("\n");
}

function Meter({ label, value, tone = "good" }: { label: string; value: number | null; tone?: "good" | "risk" }) {
  const measured = value != null;
  const display = measured ? Math.round(value) : "Unknown";
  const width = measured ? Math.max(0, Math.min(100, value)) : 0;
  return (
    <div className="score-row">
      <div className="flex items-center justify-between gap-4 text-sm">
        <span>{label}</span>
        <span className={`font-mono text-[13px] ${measured ? tone === "risk" ? "text-[var(--hot)]" : "text-[var(--signal)]" : "text-[var(--muted-foreground)]"}`}>{display}</span>
      </div>
      <div className={`score-track ${tone === "risk" ? "score-track-risk" : ""}`} aria-hidden="true"><span style={{ width: `${width}%` }} /></div>
    </div>
  );
}

function Probability({ label, value }: { label: string; value: number }) {
  return <div className="probability-cell"><span>{label}</span><strong>{Math.round(value * 100)}%</strong></div>;
}

function ProgramCard({ program, watched, onWatch, onOpen }: { program: RadarProgram; watched: boolean; onWatch: () => void; onOpen: () => void }) {
  const probability = Math.min(100, Math.round((program.pFindable ?? 0) * (program.pPayable ?? 0) * (program.pFirst ?? 0) * 100));
  const scoreStyle = { "--score": `${probability}%` } as CSSProperties;
  const tier = evTier(Number(program.evScore ?? 0));
  const workflow = workflowOf(program);
  return (
    <article className="program-card group">
      <div className="flex min-w-0 items-start gap-4">
        <div className="score-orbit ev-orbit" style={scoreStyle} aria-label={`Combined payable probability ${probability} percent`}>
          <div><strong>{evLabel(program)}</strong><span>EV</span></div>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge className="workflow-badge"><span className="pulse-dot" />{workflowLabels[workflow]}</Badge>
            <span className="meta-copy">{changeLabels[program.change.type]} · {relativeTime(program.change.at)}</span>
            {program.sample ? <span className="sample-flag">PREVIEW</span> : null}
          </div>
          <h2 className="mt-3 truncate text-xl font-semibold tracking-[-0.03em] text-white">{program.name}</h2>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-[var(--muted-foreground)]"><span>{program.platform}</span><span>·</span><span>{rewardLabel(program)}</span></p>
        </div>
        <Button variant="ghost" size="icon" className={`watch-button ${watched ? "is-watched" : ""}`} aria-label={watched ? `Remove ${program.name} from watchlist` : `Watch ${program.name}`} aria-pressed={watched} onClick={onWatch}><Bookmark className={watched ? "fill-current" : ""} /></Button>
      </div>

      <div className="mt-5 rounded-xl border border-white/[0.07] bg-black/20 p-3.5">
        <div className="flex items-center justify-between gap-3">
          <span className={`tier-label ${tier.className}`}>{tier.label}</span>
          <span className="font-mono text-xs text-[var(--muted-foreground)]">{program.payableSeverityCeiling ?? "?"} ceiling</span>
        </div>
        <p className="mt-2.5 line-clamp-2 min-h-10 text-sm leading-5 text-[var(--foreground)]">{honestReason(program)}</p>
      </div>

      <div className="mt-4 flex min-h-7 flex-wrap gap-1.5">
        <span className="data-chip">H {program.hardeningIndex == null ? "?" : Math.round(program.hardeningIndex)}</span>
        <span className="data-chip">F {Math.round(program.freshCodeIndex ?? 0)}</span>
        <span className={(program.knownIssueRisk ?? 0) > 0 ? "risk-chip" : "data-chip"}>K {Math.round(program.knownIssueRisk ?? 0)}</span>
        {program.repoSignals?.fullName ? <span className="language-chip">{program.repoSignals.fullName}</span> : null}
      </div>

      <div className="mt-5 flex items-center justify-between border-t border-white/[0.07] pt-4">
        <div className="flex items-center gap-2 text-xs text-[var(--muted-foreground)]">
          {program.safeHarbor ? <ShieldCheck className="size-4 text-[var(--signal)]" /> : <CircleHelp className="size-4" />}
          <span>{program.safeHarbor ? "Safe-harbor field present" : "Verify safe harbor"}</span>
        </div>
        <Button variant="ghost" size="sm" className="open-button" onClick={onOpen}>Inspect <ChevronRight /></Button>
      </div>
    </article>
  );
}

export function RadarDashboard({ initialPayload }: { initialPayload: RadarPayload }) {
  const [payload, setPayload] = useState(initialPayload);
  const [loadState, setLoadState] = useState<"seed" | "live" | "error">(initialPayload.meta.mode);
  const [query, setQuery] = useState("");
  const [platform, setPlatform] = useState("all");
  const [workflow, setWorkflow] = useState("all");
  const [minimumEv, setMinimumEv] = useState("0");
  const [sort, setSort] = useState("ev");
  const [tab, setTab] = useState("top");
  const [hideReviewed, setHideReviewed] = useState(true);
  const [watchlist, setWatchlist] = useState<Set<string>>(new Set());
  const [reviewed, setReviewed] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<RadarProgram | null>(null);
  const [methodOpen, setMethodOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const loadData = useCallback(async () => {
    try {
      const response = await fetch("./data/programs.json", { cache: "no-store" });
      if (!response.ok) throw new Error(`Data request failed: ${response.status}`);
      const nextPayload = (await response.json()) as RadarPayload;
      if (!Array.isArray(nextPayload.programs) || !nextPayload.meta) throw new Error("Invalid radar payload");
      setPayload(nextPayload);
      setLoadState(nextPayload.meta.mode);
    } catch {
      setLoadState("error");
    }
  }, []);

  useEffect(() => {
    const lane = new URL(window.location.href).searchParams.get("lane");
    queueMicrotask(() => {
      setWatchlist(readStoredSet(STORAGE_WATCHLIST));
      setReviewed(readStoredSet(STORAGE_REVIEWED));
      if (lane === "live") setTab("live");
      if (lane === "fresh-source") setTab("fresh-source");
      void loadData();
    });
  }, [loadData]);

  const platforms = useMemo(() => [...new Set(payload.programs.map((program) => program.platform))].sort(), [payload.programs]);
  const initialReviewedNames = useMemo(() => new Set(payload.preferences.reviewedPrograms.map(normalized)), [payload.preferences.reviewedPrograms]);

  const filtered = useMemo(() => {
    const floor = Number(minimumEv) || 0;
    const term = query.trim().toLowerCase();
    return payload.programs.filter((program) => {
      const route = workflowOf(program);
      if (program.excludeReason || Number(program.evScore ?? 0) <= 0) return false;
      if (tab === "top" && route === "static-source-hardened") return false;
      if (tab === "live" && !LIVE_WORKFLOWS.has(route)) return false;
      if (tab === "fresh-source" && !(route === "static-source" && Number(program.freshCodeIndex ?? 0) > 50)) return false;
      if (tab === "watchlist" && !watchlist.has(program.id)) return false;
      if (platform !== "all" && program.platform !== platform) return false;
      if (workflow !== "all" && route !== workflow) return false;
      if (Number(program.evScore ?? 0) < floor) return false;
      if (hideReviewed && (reviewed.has(program.id) || initialReviewedNames.has(normalized(program.name)))) return false;
      if (term) {
        const haystack = [program.name, program.platform, route, program.findableClass, program.honestReason, ...program.tags, ...program.languages, ...program.targets.map((target) => target.value)].join(" ").toLowerCase();
        if (!haystack.includes(term)) return false;
      }
      return true;
    }).sort((a, b) => {
      if (sort === "reward") return (b.maxReward ?? 0) - (a.maxReward ?? 0);
      if (sort === "fresh") return Number(b.freshCodeIndex ?? 0) - Number(a.freshCodeIndex ?? 0);
      if (sort === "name") return a.name.localeCompare(b.name);
      return Number(b.evScore ?? 0) - Number(a.evScore ?? 0) || Number(b.pFindable ?? 0) - Number(a.pFindable ?? 0);
    });
  }, [hideReviewed, initialReviewedNames, minimumEv, payload.programs, platform, query, reviewed, sort, tab, watchlist, workflow]);

  const visiblePrograms = filtered.slice(0, TOP_LIMIT);
  const liveCount = payload.programs.filter((program) => !program.excludeReason && LIVE_WORKFLOWS.has(workflowOf(program))).length;
  const freshSourceCount = payload.programs.filter((program) => !program.excludeReason && workflowOf(program) === "static-source" && Number(program.freshCodeIndex ?? 0) > 50).length;
  const enrichedRepos = new Set(payload.programs.flatMap((program) => program.targets.map((target) => target.repoSignals?.status === "ok" ? target.repoSignals.fullName : null)).filter(Boolean)).size;

  function updateFilter<T>(setter: (value: T) => void, value: T) { setter(value); }

  function selectLane(value: string) {
    setTab(value);
    const url = new URL(window.location.href);
    if (value === "live" || value === "fresh-source") url.searchParams.set("lane", value);
    else url.searchParams.delete("lane");
    window.history.replaceState({}, "", url);
  }

  function toggleWatch(program: RadarProgram) {
    setWatchlist((current) => {
      const next = new Set(current);
      if (next.has(program.id)) next.delete(program.id); else next.add(program.id);
      writeStoredSet(STORAGE_WATCHLIST, next);
      return next;
    });
  }

  function markReviewed(program: RadarProgram) {
    setReviewed((current) => {
      const next = new Set(current).add(program.id);
      writeStoredSet(STORAGE_REVIEWED, next);
      return next;
    });
    setSelected(null);
  }

  async function copyBrief(program: RadarProgram) {
    await navigator.clipboard.writeText(buildBrief(program));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_600);
  }

  function exportResults(format: "json" | "csv") {
    if (format === "json") downloadText("scoutiq-shortlist.json", JSON.stringify(filtered, null, 2), "application/json");
    else downloadText("scoutiq-shortlist.csv", programsToCsv(filtered), "text/csv");
  }

  return (
    <main className="radar-shell min-h-screen">
      <div className="radar-noise" aria-hidden="true" />
      <div className="mx-auto w-full max-w-[1480px] px-4 py-4 sm:px-6 lg:px-8">
        <header className="topbar">
          <div className="flex min-w-0 items-center gap-3">
            <div className="brand-mark" aria-hidden="true"><Radar /></div>
            <div className="min-w-0">
              <div className="flex items-center gap-2"><h1 className="text-lg font-semibold tracking-[-0.04em] text-white sm:text-xl">ScoutIQ</h1><span className="version-chip">v2</span></div>
              <p className="truncate text-xs text-[var(--muted-foreground)]">Payable bug opportunity radar</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className={`sync-pill sync-${loadState}`}><span />{loadState === "live" ? "LIVE DATA" : loadState === "error" ? "SEED FALLBACK" : "SEED PREVIEW"}</div>
            <Button variant="ghost" size="icon" className="header-button" onClick={() => void loadData()} aria-label="Refresh data"><RefreshCw /></Button>
            <Button variant="ghost" size="icon" className="header-button" onClick={() => setMethodOpen(true)} aria-label="Open scoring method"><CircleHelp /></Button>
          </div>
        </header>

        {loadState !== "live" ? <div className="preview-notice"><TriangleAlert className="size-4" /><span>Live v2 data could not be loaded. These cards demonstrate the payable-EV schema only.</span></div> : null}

        <section className="overview-grid" aria-label="ScoutIQ summary">
          <div className="overview-primary">
            <div><p className="eyebrow">EXPECTED PAYABLE VALUE</p><h2 className="mt-2 max-w-3xl text-2xl font-semibold tracking-[-0.045em] text-white sm:text-3xl">Find the live or freshly changed surface where a bug can still be novel, severe, and paid.</h2></div>
            <div className="sync-copy"><span>LAST PIPELINE RUN</span><strong>{relativeTime(payload.meta.generatedAt)}</strong><small>{payload.meta.healthySourceCount}/{payload.meta.sourceCount} discovery sources healthy</small></div>
          </div>
          <div className="metric-strip">
            <div className="metric-cell"><Zap /><div><strong>{payload.meta.rankedProgramCount ?? payload.programs.filter((program) => !program.excludeReason).length}</strong><span>Payable candidates</span></div></div>
            <div className="metric-cell"><Activity /><div><strong>{liveCount}</strong><span>Live-lane candidates</span></div></div>
            <div className="metric-cell"><GitBranch /><div><strong>{freshSourceCount}</strong><span>Fresh-source candidates</span></div></div>
            <div className="metric-cell"><Database /><div><strong>{enrichedRepos}</strong><span>Repos enriched</span></div></div>
          </div>
        </section>

        <section className="control-deck" aria-label="Radar controls">
          <div className="control-topline">
            <Tabs value={tab} onValueChange={selectLane}>
              <TabsList variant="line" className="radar-tabs">
                <TabsTrigger value="top">Top 25</TabsTrigger>
                <TabsTrigger value="live">Live lane</TabsTrigger>
                <TabsTrigger value="fresh-source">Fresh source</TabsTrigger>
                <TabsTrigger value="watchlist">Watchlist {watchlist.size ? `(${watchlist.size})` : ""}</TabsTrigger>
              </TabsList>
            </Tabs>
            <div className="flex items-center gap-2"><Button variant="outline" size="sm" className="export-button" onClick={() => exportResults("csv")}><ArrowDownToLine /> CSV</Button><Button variant="outline" size="sm" className="export-button" onClick={() => exportResults("json")}>JSON</Button></div>
          </div>
          <div className="filter-grid">
            <label className="search-wrap"><span className="sr-only">Search programs and targets</span><Search aria-hidden="true" /><Input value={query} onChange={(event) => updateFilter(setQuery, event.target.value)} placeholder="Search program, route, class, target..." className="radar-input" /></label>
            <Select value={platform} onValueChange={(value) => updateFilter(setPlatform, value)}><SelectTrigger className="radar-select" aria-label="Filter by platform"><SelectValue placeholder="All platforms" /></SelectTrigger><SelectContent><SelectItem value="all">All platforms</SelectItem>{platforms.map((item) => <SelectItem value={item} key={item}>{item}</SelectItem>)}</SelectContent></Select>
            <Select value={workflow} onValueChange={(value) => updateFilter(setWorkflow, value)}><SelectTrigger className="radar-select" aria-label="Filter by workflow"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">All workflows</SelectItem>{Object.entries(workflowLabels).map(([value, label]) => <SelectItem value={value} key={value}>{label}</SelectItem>)}</SelectContent></Select>
            <Select value={minimumEv} onValueChange={(value) => updateFilter(setMinimumEv, value)}><SelectTrigger className="radar-select" aria-label="Filter by expected value"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="0">Any positive EV</SelectItem><SelectItem value="500">EV $500+</SelectItem><SelectItem value="1000">EV $1k+</SelectItem><SelectItem value="2500">EV $2.5k+</SelectItem><SelectItem value="5000">EV $5k+</SelectItem></SelectContent></Select>
            <Select value={sort} onValueChange={(value) => updateFilter(setSort, value)}><SelectTrigger className="radar-select" aria-label="Sort results"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="ev">Sort: EV</SelectItem><SelectItem value="fresh">Sort: Fresh code</SelectItem><SelectItem value="reward">Sort: Reward</SelectItem><SelectItem value="name">Sort: Name</SelectItem></SelectContent></Select>
            <label className="reviewed-switch"><Switch checked={hideReviewed} onCheckedChange={(value) => updateFilter(setHideReviewed, value)} /><span>Hide reviewed</span></label>
          </div>
        </section>

        <div className="results-line"><p>Showing <strong>{visiblePrograms.length}</strong> of {filtered.length} surviving candidates</p><p>Hard exclusions are removed before ranking. EV is a triage estimate, not promised payout.</p></div>

        {visiblePrograms.length ? <section className="program-grid" aria-label="Top payable bug candidates">{visiblePrograms.map((program) => <ProgramCard key={program.id} program={program} watched={watchlist.has(program.id)} onWatch={() => toggleWatch(program)} onOpen={() => setSelected(program)} />)}</section> : <section className="empty-state"><Radar /><h2>No payable candidate survives these filters.</h2><p>Try another lane or lower the EV floor. Excluded targets remain excluded.</p><Button variant="outline" onClick={() => { setQuery(""); setPlatform("all"); setWorkflow("all"); setMinimumEv("0"); setTab("top"); }}>Clear filters</Button></section>}

        <footer className="radar-footer"><p>Discovery data is never authorization. The linked official policy controls every test.</p><p>ScoutIQ stores watchlists and reviewed status only in this browser.</p></footer>
      </div>

      <Sheet open={Boolean(selected)} onOpenChange={(open) => { if (!open) setSelected(null); }}>
        <SheetContent className="detail-sheet w-[92vw] overflow-y-auto sm:max-w-[660px]">
          {selected ? <>
            <SheetHeader className="border-b border-white/[0.08] px-6 py-6">
              <div className="mb-2 flex flex-wrap items-center gap-2"><Badge className="workflow-badge">{workflowLabels[workflowOf(selected)]}</Badge><span className="sample-flag">{selected.platform.toUpperCase()}</span></div>
              <SheetTitle className="pr-8 text-2xl tracking-[-0.04em] text-white">{selected.name}</SheetTitle>
              <SheetDescription>{rewardLabel(selected)} · ceiling {selected.payableSeverityCeiling ?? "unknown"} · floor {selected.programFloorSeverity ?? "unknown"}</SheetDescription>
            </SheetHeader>
            <div className="space-y-7 px-6 pb-8">
              <section className="detail-score"><div><span>EXPECTED VALUE</span><strong>{evLabel(selected)}</strong></div><p>{selected.rewardCapped ? `The ${compactMoney(selected.maxReward ?? 0, selected.currency)} headline reward is capped at ${compactMoney(selected.effectiveReward ?? 50_000, selected.currency)} for ranking` : "Reward basis multiplied by the estimated chances we can find it, it is payable, and we are first"}.</p></section>
              <section><h3 className="detail-heading">Probability chain</h3><div className="probability-grid"><Probability label="P(findable)" value={selected.pFindable ?? 0} /><Probability label="P(payable)" value={selected.pPayable ?? 0} /><Probability label="P(first)" value={selected.pFirst ?? 0} /></div></section>
              <section><h3 className="detail-heading">Why it surfaced</h3><ul className="reason-list"><li><Zap />{honestReason(selected)}</li></ul></section>
              <section><h3 className="detail-heading">Anti-waste indices</h3><div className="space-y-3"><Meter label="Fresh code" value={selected.freshCodeIndex ?? 0} /><Meter label="Hardening" value={selected.hardeningIndex ?? null} tone="risk" /><Meter label="Known-issue risk" value={selected.knownIssueRisk ?? 0} tone="risk" /></div></section>

              {selected.repoSignals ? <section><h3 className="detail-heading">Repository evidence</h3><div className="signal-grid"><div><span>Repository</span><strong>{selected.repoSignals.fullName ?? "Pending"}</strong></div><div><span>Stars</span><strong>{selected.repoSignals.stars == null ? "Unknown" : selected.repoSignals.stars.toLocaleString()}</strong></div><div><span>Commits / 90d</span><strong>{selected.repoSignals.commits90d ?? "Unknown"}</strong></div><div><span>Files added / 90d</span><strong>{selected.repoSignals.filesAdded90d ?? "Unknown"}</strong></div><div><span>Security tooling</span><strong>{selected.repoSignals.secTooling == null ? "Unknown" : selected.repoSignals.secTooling ? "Present" : "Not detected"}</strong></div><div><span>GHSA</span><strong>{selected.repoSignals.advisories ? `${selected.repoSignals.advisories.open} open · ${selected.repoSignals.advisories.resolved} resolved` : "Unknown"}</strong></div><div><span>Trap scan</span><strong>{selected.repoSignals.trapScanStatus ?? "Unknown"}</strong></div></div>{selected.repoSignals.lastError ? <p className="mt-3 text-xs text-[var(--hot)]">Enrichment error: {selected.repoSignals.lastError}</p> : null}</section> : null}

              {selected.traps?.length ? <section className="exclusion-box"><TriangleAlert /><div><strong>Trap signals</strong><p>{selected.traps.join(", ")}</p></div></section> : null}

              <section><h3 className="detail-heading">Routed target preview</h3><div className="target-list">{selected.targets.length ? selected.targets.slice(0, 12).map((target) => <div key={target.key} className="target-row"><div><span>{target.workflow ?? target.type} · EV {compactMoney(target.evScore ?? 0, selected.currency)}</span><strong>{target.value}</strong>{target.excludeReason ? <p className="text-[var(--hot)]">Excluded: {target.excludeReason}</p> : target.reason ? <p>{target.reason}</p> : null}</div>{target.excludeReason ? <TriangleAlert className="size-4 text-[var(--hot)]" /> : <Check className="size-4 text-[var(--signal)]" />}</div>) : <p className="p-4 text-sm text-[var(--muted-foreground)]">No structured targets were available. Verify the official scope.</p>}</div></section>

              <section className="verification-box"><ShieldCheck /><div><strong>Verify before testing</strong><p>Confirm scope, payout floor, researcher eligibility, safe harbor, account rules, and the exact permitted environment on the official policy.</p></div></section>
              <div className="grid gap-2 sm:grid-cols-2"><Button asChild className="action-primary"><a href={selected.url} target="_blank" rel="noreferrer">Open official policy <ArrowUpRight /></a></Button><Button variant="outline" className="action-secondary" onClick={() => void copyBrief(selected)}>{copied ? <Check /> : <Copy />}{copied ? "Copied" : "Copy 90-min brief"}</Button><Button variant="ghost" className="sm:col-span-2" onClick={() => markReviewed(selected)}>Mark reviewed and hide</Button></div>
            </div>
          </> : null}
        </SheetContent>
      </Sheet>

      <Sheet open={methodOpen} onOpenChange={setMethodOpen}>
        <SheetContent className="detail-sheet w-[92vw] overflow-y-auto sm:max-w-[590px]">
          <SheetHeader className="border-b border-white/[0.08] px-6 py-6"><SheetTitle className="text-2xl tracking-[-0.04em] text-white">How ScoutIQ v2 ranks work</SheetTitle><SheetDescription>The score estimates a payable first finding, not how interesting a repository looks.</SheetDescription></SheetHeader>
          <div className="space-y-6 px-6 pb-8">
            <section className="formula-box"><span>EV</span><strong>min(reward, $50k) × P(findable) × P(payable) × P(first)</strong><p>Unmeasured repository hardening stays unknown and contributes no anti-hardening bonus. Each probability remains visible in the record.</p></section>
            <section><h3 className="detail-heading">Hard filters</h3><div className="method-grid"><div><strong>01</strong><span>Severity floor</span><p>Drop classes whose best plausible impact is below the program&apos;s payable floor.</p></div><div><strong>02</strong><span>Mature static trap</span><p>Drop hardening above 70 when fresh code remains below 25.</p></div><div><strong>03</strong><span>Known or dormant</span><p>Drop known-issue risk at 60+, audited targets without a 40-point fresh jump, and deployed contracts with zero use or value.</p></div><div><strong>04</strong><span>Eligibility</span><p>Drop invite-only, KYC-blocked, India-ineligible, closed, unpaid, and explicitly unsafe routes.</p></div></div></section>
            <section className="verification-box"><CircleHelp /><div><strong>Conservative defaults are labeled</strong><p>If a reward table cannot be parsed yet, the configured MEDIUM payable floor is used. Repository evidence is cached for seven days and fully refreshed every week.</p></div></section>
          </div>
        </SheetContent>
      </Sheet>
    </main>
  );
}
