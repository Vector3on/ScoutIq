export type ChangeType =
  | "new_program"
  | "new_target"
  | "scope_updated"
  | "reward_up"
  | "reactivated"
  | "baseline";

export type RadarTarget = {
  key: string;
  type: string;
  value: string;
  eligible: boolean | null;
  impact?: string | null;
  description?: string | null;
  firstSeenAt?: string | null;
  addedAt?: string | null;
  hardeningIndex?: number;
  freshCodeIndex?: number;
  knownIssueRisk?: number;
  payableSeverityCeiling?: Severity;
  programFloorSeverity?: Severity;
  workflow?: Workflow;
  findableClass?: string;
  pFindable?: number;
  pPayable?: number;
  pFirst?: number;
  evScore?: number;
  traps?: string[];
  excludeReason?: string | null;
  reason?: string;
  repoSignals?: RepoSignals | null;
  liveState?: LiveState | null;
};

export type Severity = "INFORMATIVE" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export type Workflow =
  | "static-source"
  | "static-source-hardened"
  | "live-web"
  | "live-api"
  | "live-contract"
  | "ai-agent";

export type RepoSignals = {
  status: "ok" | "pending";
  provider?: "github" | "gitlab";
  fullName?: string;
  url?: string;
  fetchedAt?: string | null;
  createdAt?: string | null;
  pushedAt?: string | null;
  ageY?: number | null;
  stars?: number;
  forks?: number;
  contributorsCount?: number;
  releases?: number;
  defaultBranch?: string | null;
  languages?: Record<string, number>;
  commits7d?: number;
  commits30d?: number;
  commits90d?: number;
  filesTouched90d?: number;
  filesAdded90d?: number;
  filesAdded90dList?: string[];
  files90dTruncated?: boolean;
  mergedPrs90d?: number;
  maxMergedPrAdditions90d?: number;
  secTooling?: boolean;
  securityMd?: boolean;
  fuzzPath?: boolean;
  fuzzFunction?: boolean;
  securityWorkflows?: string[];
  advisories?: { open: number; resolved: number; total: number };
  advisoryCoverage?: string;
  trapHits?: Array<{ type: string; path: string }>;
  trapTags?: string[];
  devKnown?: boolean;
  securityFixGated?: boolean;
  openRecentAdvisoryPathMatch?: boolean;
  lastError?: string;
};

export type LiveState = {
  status?: "ok" | "pending";
  deployed: boolean | null;
  verified: boolean | null;
  tx30d: number | null;
  tvl: number | null;
  balance?: number | null;
  lastActivity?: string | null;
  chainId?: number | string | null;
  address?: string;
};

export type ScoreBreakdown = {
  freshness: number;
  reward: number;
  inspectability: number;
  authorization: number;
  friction: number;
};

export type RadarProgram = {
  id: string;
  name: string;
  platform: string;
  url: string;
  status: string;
  paid: boolean;
  currency: string | null;
  minReward: number | null;
  maxReward: number | null;
  safeHarbor: string | null;
  disclosureAllowed: boolean | null;
  sourceIds: string[];
  sourceCode: boolean;
  repositoryCount: number;
  targetCount: number;
  tags: string[];
  languages: string[];
  targets: RadarTarget[];
  firstSeenAt: string;
  lastSeenAt: string;
  lastChangedAt: string;
  change: {
    type: ChangeType;
    label: string;
    at: string;
    addedTargets?: number;
    removedTargets?: number;
  };
  score: number;
  scoreBreakdown: ScoreBreakdown;
  reasons: string[];
  attentionPressure: "lower" | "medium" | "high" | "unknown";
  hardeningIndex?: number;
  freshCodeIndex?: number;
  knownIssueRisk?: number;
  payableSeverityCeiling?: Severity;
  programFloorSeverity?: Severity;
  programFloorSource?: string;
  workflow?: Workflow;
  findableClass?: string;
  pFindable?: number;
  pPayable?: number;
  pFirst?: number;
  evScore?: number;
  traps?: string[];
  repoSignals?: RepoSignals | null;
  liveState?: LiveState | null;
  excludeReason?: string | null;
  honestReason?: string;
  bestTargetKey?: string;
  sample?: boolean;
};

export type RadarMeta = {
  generatedAt: string;
  mode: "seed" | "live";
  sourceCount: number;
  healthySourceCount: number;
  programCount: number;
  targetCount: number;
  eventCount: number;
  rankedProgramCount?: number;
  excludedProgramCount?: number;
  enrichmentMode?: string;
  repoEnrichment?: { discovered: number; attempted: number; updated: number; failed: number; pending: number; rateLimited?: boolean };
  policyEnrichment?: { discovered: number; attempted: number; updated: number; failed: number; pending: number };
  liveEnrichment?: { configured: number; attempted: number; updated: number; failed: number };
  sources: Array<{
    id: string;
    label: string;
    status: "ok" | "error" | "seed";
    count: number;
    error?: string;
  }>;
};

export type RadarPayload = {
  meta: RadarMeta;
  programs: RadarProgram[];
  preferences: {
    reviewedPrograms: string[];
    minReward: number;
  };
};
