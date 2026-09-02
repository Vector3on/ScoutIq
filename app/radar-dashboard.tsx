"use client";

import {
  type CSSProperties,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
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
  Sparkles,
  Target,
  Zap,
} from "lucide-react";

import type {
  ChangeType,
  RadarPayload,
  RadarProgram,
} from "@/app/radar-types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

const PAGE_SIZE = 12;
const STORAGE_WATCHLIST = "scopepulse:watchlist";
const STORAGE_REVIEWED = "scopepulse:reviewed";

const changeLabels: Record<ChangeType, string> = {
  new_program: "New program",
  new_target: "Target added",
  scope_updated: "Scope changed",
  reward_up: "Reward increased",
  reactivated: "Reactivated",
  baseline: "Tracked",
};

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
    ["year", 31_536_000],
    ["month", 2_592_000],
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
  ];
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size || unit === "minute") {
      return formatter.format(Math.round(seconds / size), unit);
    }
  }
  return "just now";
}

function compactMoney(value: number, currency: string | null) {
  const code = currency || "USD";
  try {
    return new Intl.NumberFormat("en", {
      style: "currency",
      currency: code,
      notation: value >= 10_000 ? "compact" : "standard",
      maximumFractionDigits: 0,
    }).format(value);
  } catch {
    return `${code} ${value.toLocaleString()}`;
  }
}

function rewardLabel(program: RadarProgram) {
  if (!program.paid) return "No confirmed reward";
  if (program.minReward != null && program.maxReward != null) {
    return `${compactMoney(program.minReward, program.currency)} to ${compactMoney(
      program.maxReward,
      program.currency,
    )}`;
  }
  if (program.maxReward != null) {
    return `Up to ${compactMoney(program.maxReward, program.currency)}`;
  }
  return "Paid, amount unparsed";
}

function scoreTier(score: number) {
  if (score >= 78) return { label: "Strike now", className: "tier-hot" };
  if (score >= 62) return { label: "Strong", className: "tier-strong" };
  if (score >= 45) return { label: "Possible", className: "tier-possible" };
  return { label: "Cold", className: "tier-cold" };
}

function normalized(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function buildBrief(program: RadarProgram) {
  const targetLines = program.targets
    .slice(0, 10)
    .map(
      (target) =>
        `- [${target.type}] ${target.value}${
          target.impact ? ` (${target.impact})` : ""
        }`,
    )
    .join("\n");
  const reasons = program.reasons.map((reason) => `- ${reason}`).join("\n");

  return `PUBLIC BUG BOUNTY TRIAGE PACKET

Program: ${program.name}
Official policy: ${program.url}
Platform: ${program.platform}
Reward: ${rewardLabel(program)}
Status: ${program.status}
Latest signal: ${program.change.label} at ${program.change.at}
Safe harbor: ${program.safeHarbor ?? "not parsed, verify manually"}
Edge score: ${program.score}/100

Why it surfaced:
${reasons || "- No strong signal was extracted"}

In-scope preview:
${targetLines || "- Open the official policy and extract the exact scope"}

Task:
1. Open and verify the current official policy before touching the target.
2. Confirm this is paid, public, open, and allows the intended local or researcher-owned testing.
3. Identify the smallest inspectable repository or component matching the scope.
4. Spend no more than 90 minutes on buildability, architecture, prior audits, recent diffs, and three concrete vulnerability hypotheses.
5. Stop if authorization, payout, reproducibility, or novelty cannot be established.
6. Do not test third parties, other users, or production beyond what the policy explicitly permits.

Return a compact go/no-go decision with evidence and exact source links.`;
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
  const fields = [
    "score",
    "name",
    "platform",
    "change",
    "min_reward",
    "max_reward",
    "currency",
    "source_code",
    "targets",
    "url",
  ];
  const escape = (value: unknown) =>
    `"${String(value ?? "").replaceAll('"', '""')}"`;
  return [
    fields.join(","),
    ...programs.map((program) =>
      [
        program.score,
        program.name,
        program.platform,
        program.change.type,
        program.minReward,
        program.maxReward,
        program.currency,
        program.sourceCode,
        program.targetCount,
        program.url,
      ]
        .map(escape)
        .join(","),
    ),
  ].join("\n");
}

function ScoreBar({ label, value, max }: { label: string; value: number; max: number }) {
  return (
    <div className="score-row">
      <div className="flex items-center justify-between gap-4 text-sm">
        <span>{label}</span>
        <span className="font-mono text-[13px] text-[var(--signal)]">
          {value}/{max}
        </span>
      </div>
      <div className="score-track" aria-hidden="true">
        <span style={{ width: `${Math.min(100, (value / max) * 100)}%` }} />
      </div>
    </div>
  );
}

function ProgramCard({
  program,
  watched,
  onWatch,
  onOpen,
}: {
  program: RadarProgram;
  watched: boolean;
  onWatch: () => void;
  onOpen: () => void;
}) {
  const tier = scoreTier(program.score);
  const scoreStyle = { "--score": `${program.score}%` } as CSSProperties;

  return (
    <article className="program-card group">
      <div className="flex min-w-0 items-start gap-4">
        <div className="score-orbit" style={scoreStyle} aria-label={`Edge score ${program.score} out of 100`}>
          <div>
            <strong>{program.score}</strong>
            <span>EDGE</span>
          </div>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge className={`change-badge change-${program.change.type}`}>
              <span className="pulse-dot" />
              {changeLabels[program.change.type]}
            </Badge>
            <span className="meta-copy">{relativeTime(program.change.at)}</span>
            {program.sample ? <span className="sample-flag">PREVIEW</span> : null}
          </div>
          <h2 className="mt-3 truncate text-xl font-semibold tracking-[-0.03em] text-white">
            {program.name}
          </h2>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-[var(--muted-foreground)]">
            <span>{program.platform}</span>
            <span aria-hidden="true">·</span>
            <span>{rewardLabel(program)}</span>
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className={`watch-button ${watched ? "is-watched" : ""}`}
          aria-label={watched ? `Remove ${program.name} from watchlist` : `Watch ${program.name}`}
          aria-pressed={watched}
          onClick={onWatch}
        >
          <Bookmark className={watched ? "fill-current" : ""} />
        </Button>
      </div>

      <div className="mt-5 rounded-xl border border-white/[0.07] bg-black/20 p-3.5">
        <div className="flex items-center justify-between gap-3">
          <span className={`tier-label ${tier.className}`}>{tier.label}</span>
          <span className="font-mono text-xs text-[var(--muted-foreground)]">
            {program.targetCount} target{program.targetCount === 1 ? "" : "s"}
          </span>
        </div>
        <p className="mt-2.5 line-clamp-2 min-h-10 text-sm leading-5 text-[var(--foreground)]">
          {program.reasons[0] ?? "Tracked for material scope or reward movement."}
        </p>
      </div>

      <div className="mt-4 flex min-h-7 flex-wrap gap-1.5">
        {program.tags.slice(0, 4).map((tag) => (
          <span className="data-chip" key={tag}>
            {tag}
          </span>
        ))}
        {program.languages.slice(0, 2).map((language) => (
          <span className="language-chip" key={language}>
            {language}
          </span>
        ))}
      </div>

      <div className="mt-5 flex items-center justify-between border-t border-white/[0.07] pt-4">
        <div className="flex items-center gap-2 text-xs text-[var(--muted-foreground)]">
          {program.safeHarbor ? <ShieldCheck className="size-4 text-[var(--signal)]" /> : <CircleHelp className="size-4" />}
          <span>{program.safeHarbor ? `${program.safeHarbor} safe harbor` : "Verify safe harbor"}</span>
        </div>
        <Button variant="ghost" size="sm" className="open-button" onClick={onOpen}>
          Inspect
          <ChevronRight />
        </Button>
      </div>
    </article>
  );
}

export function RadarDashboard({ initialPayload }: { initialPayload: RadarPayload }) {
  const [payload, setPayload] = useState(initialPayload);
  const [loadState, setLoadState] = useState<"seed" | "live" | "error">(
    initialPayload.meta.mode,
  );
  const [query, setQuery] = useState("");
  const [platform, setPlatform] = useState("all");
  const [surface, setSurface] = useState("all");
  const [minimumReward, setMinimumReward] = useState(
    String(initialPayload.preferences.minReward),
  );
  const [sort, setSort] = useState("edge");
  const [tab, setTab] = useState("all");
  const [hideReviewed, setHideReviewed] = useState(true);
  const [watchlist, setWatchlist] = useState<Set<string>>(new Set());
  const [reviewed, setReviewed] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<RadarProgram | null>(null);
  const [methodOpen, setMethodOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [copied, setCopied] = useState(false);

  const loadData = useCallback(async () => {
    try {
      const response = await fetch("./data/programs.json", { cache: "no-store" });
      if (!response.ok) throw new Error(`Data request failed: ${response.status}`);
      const nextPayload = (await response.json()) as RadarPayload;
      if (!Array.isArray(nextPayload.programs) || !nextPayload.meta) {
        throw new Error("Invalid radar payload");
      }
      setPayload(nextPayload);
      setLoadState(nextPayload.meta.mode);
    } catch {
      setLoadState("error");
    }
  }, []);

  useEffect(() => {
    const storedWatchlist = readStoredSet(STORAGE_WATCHLIST);
    const storedReviewed = readStoredSet(STORAGE_REVIEWED);
    queueMicrotask(() => {
      setWatchlist(storedWatchlist);
      setReviewed(storedReviewed);
      void loadData();
    });
  }, [loadData]);

  const platforms = useMemo(
    () => [...new Set(payload.programs.map((program) => program.platform))].sort(),
    [payload.programs],
  );

  const initialReviewedNames = useMemo(
    () => new Set(payload.preferences.reviewedPrograms.map(normalized)),
    [payload.preferences.reviewedPrograms],
  );

  const filtered = useMemo(() => {
    const floor = Number(minimumReward) || 0;
    const term = query.trim().toLowerCase();
    const result = payload.programs.filter((program) => {
      if (tab === "fresh" && program.change.type === "baseline") return false;
      if (tab === "watchlist" && !watchlist.has(program.id)) return false;
      if (platform !== "all" && program.platform !== platform) return false;
      if (surface !== "all" && !program.tags.includes(surface)) return false;
      if ((program.maxReward ?? 0) < floor) return false;
      if (!program.paid) return false;
      if (program.status !== "open") return false;
      if (
        hideReviewed &&
        (reviewed.has(program.id) || initialReviewedNames.has(normalized(program.name)))
      ) {
        return false;
      }
      if (term) {
        const haystack = [
          program.name,
          program.platform,
          ...program.tags,
          ...program.languages,
          ...program.targets.map((target) => target.value),
        ]
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(term)) return false;
      }
      return true;
    });

    return result.sort((a, b) => {
      if (sort === "reward") return (b.maxReward ?? 0) - (a.maxReward ?? 0);
      if (sort === "fresh") {
        return new Date(b.lastChangedAt).getTime() - new Date(a.lastChangedAt).getTime();
      }
      if (sort === "name") return a.name.localeCompare(b.name);
      return b.score - a.score || new Date(b.lastChangedAt).getTime() - new Date(a.lastChangedAt).getTime();
    });
  }, [
    hideReviewed,
    initialReviewedNames,
    minimumReward,
    payload.programs,
    platform,
    query,
    reviewed,
    sort,
    surface,
    tab,
    watchlist,
  ]);

  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pages);
  const visiblePrograms = filtered.slice(
    (currentPage - 1) * PAGE_SIZE,
    currentPage * PAGE_SIZE,
  );
  const freshCount = payload.programs.filter(
    (program) => program.change.type !== "baseline",
  ).length;
  const sourceCodeCount = payload.programs.filter((program) => program.sourceCode).length;
  const newTargetCount = payload.programs.filter(
    (program) => program.change.type === "new_target",
  ).length;

  function updateFilter<T>(setter: (value: T) => void, value: T) {
    setter(value);
    setPage(1);
  }

  function toggleWatch(program: RadarProgram) {
    setWatchlist((current) => {
      const next = new Set(current);
      if (next.has(program.id)) next.delete(program.id);
      else next.add(program.id);
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
    window.setTimeout(() => setCopied(false), 1600);
  }

  function exportResults(format: "json" | "csv") {
    if (format === "json") {
      downloadText(
        "scopepulse-shortlist.json",
        JSON.stringify(filtered, null, 2),
        "application/json",
      );
      return;
    }
    downloadText("scopepulse-shortlist.csv", programsToCsv(filtered), "text/csv");
  }

  return (
    <main className="radar-shell min-h-screen">
      <div className="radar-noise" aria-hidden="true" />
      <div className="mx-auto w-full max-w-[1480px] px-4 py-4 sm:px-6 lg:px-8">
        <header className="topbar">
          <div className="flex min-w-0 items-center gap-3">
            <div className="brand-mark" aria-hidden="true">
              <Radar />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h1 className="text-lg font-semibold tracking-[-0.04em] text-white sm:text-xl">
                  ScopePulse
                </h1>
                <span className="version-chip">v0.1</span>
              </div>
              <p className="truncate text-xs text-[var(--muted-foreground)]">
                Public bounty change intelligence
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <div className={`sync-pill sync-${loadState}`}>
              <span />
              {loadState === "live" ? "LIVE DATA" : loadState === "error" ? "SEED FALLBACK" : "SEED PREVIEW"}
            </div>
            <Button variant="ghost" size="icon" className="header-button" onClick={() => void loadData()} aria-label="Refresh data">
              <RefreshCw />
            </Button>
            <Button variant="ghost" size="icon" className="header-button" onClick={() => setMethodOpen(true)} aria-label="Open scoring method">
              <CircleHelp />
            </Button>
          </div>
        </header>

        {loadState !== "live" ? (
          <div className="preview-notice" role="status">
            <Sparkles className="size-4" />
            <p>
              {loadState === "error"
                ? "Live JSON was unavailable, so the interface is showing its bundled preview records."
                : "This hosted preview uses representative records. The first GitHub refresh replaces them with your independent live dataset."}
            </p>
          </div>
        ) : null}

        <section className="overview-grid" aria-label="Radar summary">
          <div className="overview-primary">
            <div>
              <p className="eyebrow">RADAR STATUS</p>
              <p className="mt-2 max-w-2xl text-2xl font-semibold tracking-[-0.045em] text-white sm:text-3xl">
                Hunt change, not crowded directories.
              </p>
            </div>
            <div className="sync-copy">
              <span>Last sync</span>
              <strong>{relativeTime(payload.meta.generatedAt)}</strong>
              <small>
                {payload.meta.healthySourceCount}/{payload.meta.sourceCount} sources healthy
              </small>
            </div>
          </div>

          <div className="metric-strip">
            <div className="metric-cell">
              <Zap />
              <div><strong>{freshCount}</strong><span>Fresh signals</span></div>
            </div>
            <div className="metric-cell">
              <GitBranch />
              <div><strong>{newTargetCount}</strong><span>New targets</span></div>
            </div>
            <div className="metric-cell">
              <Database />
              <div><strong>{sourceCodeCount}</strong><span>Source-code scopes</span></div>
            </div>
            <div className="metric-cell">
              <Target />
              <div><strong>{payload.meta.targetCount.toLocaleString()}</strong><span>Targets watched</span></div>
            </div>
          </div>
        </section>

        <section className="control-deck" aria-label="Radar controls">
          <div className="control-topline">
            <Tabs value={tab} onValueChange={(value) => updateFilter(setTab, value)}>
              <TabsList variant="line" className="radar-tabs">
                <TabsTrigger value="all">All paid</TabsTrigger>
                <TabsTrigger value="fresh">Fresh changes</TabsTrigger>
                <TabsTrigger value="watchlist">Watchlist {watchlist.size ? `(${watchlist.size})` : ""}</TabsTrigger>
              </TabsList>
            </Tabs>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" className="export-button" onClick={() => exportResults("csv")}>
                <ArrowDownToLine /> CSV
              </Button>
              <Button variant="outline" size="sm" className="export-button" onClick={() => exportResults("json")}>
                JSON
              </Button>
            </div>
          </div>

          <div className="filter-grid">
            <label className="search-wrap">
              <span className="sr-only">Search programs and targets</span>
              <Search aria-hidden="true" />
              <Input value={query} onChange={(event) => updateFilter(setQuery, event.target.value)} placeholder="Search program, target, language..." className="radar-input" />
            </label>

            <Select value={platform} onValueChange={(value) => updateFilter(setPlatform, value)}>
              <SelectTrigger className="radar-select" aria-label="Filter by platform"><SelectValue placeholder="All platforms" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All platforms</SelectItem>
                {platforms.map((item) => <SelectItem value={item} key={item}>{item}</SelectItem>)}
              </SelectContent>
            </Select>

            <Select value={surface} onValueChange={(value) => updateFilter(setSurface, value)}>
              <SelectTrigger className="radar-select" aria-label="Filter by target type"><SelectValue placeholder="All surfaces" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All surfaces</SelectItem>
                <SelectItem value="source-code">Source code</SelectItem>
                <SelectItem value="api">API</SelectItem>
                <SelectItem value="smart-contract">Smart contract</SelectItem>
                <SelectItem value="hardware">Hardware</SelectItem>
                <SelectItem value="mobile">Mobile</SelectItem>
                <SelectItem value="web">Web</SelectItem>
              </SelectContent>
            </Select>

            <Select value={minimumReward} onValueChange={(value) => updateFilter(setMinimumReward, value)}>
              <SelectTrigger className="radar-select" aria-label="Filter by maximum reward"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="0">Any confirmed reward</SelectItem>
                <SelectItem value="1000">Max reward $1k+</SelectItem>
                <SelectItem value="5000">Max reward $5k+</SelectItem>
                <SelectItem value="10000">Max reward $10k+</SelectItem>
                <SelectItem value="25000">Max reward $25k+</SelectItem>
              </SelectContent>
            </Select>

            <Select value={sort} onValueChange={(value) => updateFilter(setSort, value)}>
              <SelectTrigger className="radar-select" aria-label="Sort results"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="edge">Sort: Edge score</SelectItem>
                <SelectItem value="fresh">Sort: Freshest</SelectItem>
                <SelectItem value="reward">Sort: Reward</SelectItem>
                <SelectItem value="name">Sort: Name</SelectItem>
              </SelectContent>
            </Select>

            <label className="reviewed-switch">
              <Switch checked={hideReviewed} onCheckedChange={(value) => updateFilter(setHideReviewed, value)} />
              <span>Hide reviewed</span>
            </label>
          </div>
        </section>

        <div className="results-line">
          <p><strong>{filtered.length}</strong> programs match</p>
          <p>Scores are explainable signals, never proof of low competition.</p>
        </div>

        {visiblePrograms.length ? (
          <section className="program-grid" aria-label="Matching bounty programs">
            {visiblePrograms.map((program) => (
              <ProgramCard
                key={program.id}
                program={program}
                watched={watchlist.has(program.id)}
                onWatch={() => toggleWatch(program)}
                onOpen={() => setSelected(program)}
              />
            ))}
          </section>
        ) : (
          <section className="empty-state">
            <Radar />
            <h2>No signal survives these filters.</h2>
            <p>Lower the reward floor, switch tabs, or search a broader surface.</p>
            <Button variant="outline" onClick={() => { setQuery(""); setPlatform("all"); setSurface("all"); setMinimumReward("0"); setTab("all"); }}>Clear filters</Button>
          </section>
        )}

        {pages > 1 ? (
          <Pagination className="mt-8">
            <PaginationContent>
              <PaginationItem>
                <PaginationPrevious href="#results" aria-disabled={currentPage === 1} className={currentPage === 1 ? "pointer-events-none opacity-40" : ""} onClick={(event) => { event.preventDefault(); setPage((value) => Math.max(1, value - 1)); }} />
              </PaginationItem>
              <PaginationItem><span className="page-count">Page {currentPage} of {pages}</span></PaginationItem>
              <PaginationItem>
                <PaginationNext href="#results" aria-disabled={currentPage === pages} className={currentPage === pages ? "pointer-events-none opacity-40" : ""} onClick={(event) => { event.preventDefault(); setPage((value) => Math.min(pages, value + 1)); }} />
              </PaginationItem>
            </PaginationContent>
          </Pagination>
        ) : null}

        <footer className="radar-footer">
          <p>Discovery data is never authorization. The linked official policy controls every test.</p>
          <p>ScopePulse stores watchlists and reviewed status only in this browser.</p>
        </footer>
      </div>

      <Sheet open={Boolean(selected)} onOpenChange={(open) => { if (!open) setSelected(null); }}>
        <SheetContent className="detail-sheet w-[92vw] overflow-y-auto sm:max-w-[620px]">
          {selected ? (
            <>
              <SheetHeader className="border-b border-white/[0.08] px-6 py-6">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <Badge className={`change-badge change-${selected.change.type}`}>{changeLabels[selected.change.type]}</Badge>
                  <span className="sample-flag">{selected.platform.toUpperCase()}</span>
                </div>
                <SheetTitle className="pr-8 text-2xl tracking-[-0.04em] text-white">{selected.name}</SheetTitle>
                <SheetDescription>{rewardLabel(selected)} · {selected.targetCount} tracked targets</SheetDescription>
              </SheetHeader>

              <div className="space-y-7 px-6 pb-8">
                <section className="detail-score">
                  <div>
                    <span>EDGE SCORE</span>
                    <strong>{selected.score}</strong>
                    <small>/100</small>
                  </div>
                  <p>A transparent prioritization score, not a vulnerability or payout prediction.</p>
                </section>

                <section>
                  <h3 className="detail-heading">Why it surfaced</h3>
                  <ul className="reason-list">
                    {selected.reasons.map((reason) => <li key={reason}><Zap />{reason}</li>)}
                  </ul>
                </section>

                <section>
                  <div className="mb-3 flex items-end justify-between gap-3">
                    <h3 className="detail-heading mb-0">Score anatomy</h3>
                    <button className="method-link" onClick={() => { setSelected(null); setMethodOpen(true); }}>Read method</button>
                  </div>
                  <div className="space-y-3">
                    <ScoreBar label="Freshness" value={selected.scoreBreakdown.freshness} max={32} />
                    <ScoreBar label="Reward signal" value={selected.scoreBreakdown.reward} max={22} />
                    <ScoreBar label="Inspectability" value={selected.scoreBreakdown.inspectability} max={24} />
                    <ScoreBar label="Authorization clarity" value={selected.scoreBreakdown.authorization} max={14} />
                    <ScoreBar label="Low-friction scope" value={selected.scoreBreakdown.friction} max={8} />
                  </div>
                </section>

                <section>
                  <h3 className="detail-heading">In-scope preview</h3>
                  <div className="target-list">
                    {selected.targets.length ? selected.targets.slice(0, 12).map((target) => (
                      <div key={target.key} className="target-row">
                        <div>
                          <span>{target.type}</span>
                          <strong>{target.value}</strong>
                          {target.description ? <p>{target.description}</p> : null}
                        </div>
                        {target.eligible === true ? <Check className="size-4 text-[var(--signal)]" aria-label="Bounty eligible" /> : null}
                      </div>
                    )) : <p className="text-sm text-[var(--muted-foreground)]">No structured targets were available. Verify scope on the official page.</p>}
                  </div>
                </section>

                <section className="verification-box">
                  <ShieldCheck />
                  <div>
                    <strong>Verify before testing</strong>
                    <p>Confirm paid status, current scope, safe harbor, account rules, and permitted environments on the official policy.</p>
                  </div>
                </section>

                <div className="grid gap-2 sm:grid-cols-2">
                  <Button asChild className="action-primary">
                    <a href={selected.url} target="_blank" rel="noreferrer">Open official policy <ArrowUpRight /></a>
                  </Button>
                  <Button variant="outline" className="action-secondary" onClick={() => void copyBrief(selected)}>
                    {copied ? <Check /> : <Copy />}{copied ? "Copied" : "Copy 90-min brief"}
                  </Button>
                  <Button variant="ghost" className="sm:col-span-2" onClick={() => markReviewed(selected)}>Mark reviewed and hide</Button>
                </div>
              </div>
            </>
          ) : null}
        </SheetContent>
      </Sheet>

      <Sheet open={methodOpen} onOpenChange={setMethodOpen}>
        <SheetContent className="detail-sheet w-[92vw] overflow-y-auto sm:max-w-[560px]">
          <SheetHeader className="border-b border-white/[0.08] px-6 py-6">
            <SheetTitle className="text-2xl tracking-[-0.04em] text-white">How the edge score works</SheetTitle>
            <SheetDescription>No secret model and no pretend hunter count.</SheetDescription>
          </SheetHeader>
          <div className="space-y-6 px-6 pb-8 text-sm leading-6 text-[var(--foreground)]">
            <p>ScopePulse ranks observable facts. It cannot know undisclosed reports, private researchers, or whether a target contains a valid vulnerability.</p>
            <div className="method-grid">
              <div><strong>32</strong><span>Freshness</span><p>New targets outrank new programs, reward changes, and ordinary edits.</p></div>
              <div><strong>22</strong><span>Reward</span><p>Confirmed and materially larger ceilings score higher.</p></div>
              <div><strong>24</strong><span>Inspectability</span><p>Source code, repositories, APIs, testnets, and local-build language help.</p></div>
              <div><strong>14</strong><span>Authorization</span><p>Open status, confirmed rewards, and explicit safe harbor increase confidence.</p></div>
              <div><strong>8</strong><span>Friction</span><p>Small, clearly typed scopes with parsed reward data are quicker to evaluate.</p></div>
            </div>
            <div className="verification-box"><CircleHelp /><div><strong>Unknown is not low risk</strong><p>“Attention pressure” is deliberately conservative. Only very fresh, inspectable targets receive a lower label.</p></div></div>
          </div>
        </SheetContent>
      </Sheet>
    </main>
  );
}
