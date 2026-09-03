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
  hardeningIndex?: number | null;
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
  effectiveReward?: number;
  rewardCap?: number;
  rewardCapped?: boolean;
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
  stars?: number | null;
  forks?: number | null;
  contributorsCount?: number | null;
  releases?: number | null;
  defaultBranch?: string | null;
  languages?: Record<string, number>;
  commits7d?: number | null;
  commits30d?: number | null;
  commits90d?: number | null;
  filesTouched90d?: number | null;
  filesAdded90d?: number | null;
  filesAdded90dList?: string[];
  files90dTruncated?: boolean;
  mergedPrs90d?: number | null;
  maxMergedPrAdditions90d?: number | null;
  activityCoverage?: "graphql" | "rest-fallback";
  secTooling?: boolean | null;
  securityMd?: boolean | null;
  fuzzPath?: boolean | null;
  fuzzFunction?: boolean | null;
  securityWorkflows?: string[];
  advisories?: { open: number; resolved: number; total: number } | null;
  advisoryCoverage?: string;
  trapHits?: Array<{ type: string; path: string; line?: number; match?: string }>;
  trapTags?: string[];
  devKnown?: boolean | null;
  securityFixGated?: boolean | null;
  openRecentAdvisoryPathMatch?: boolean | null;
  scanCoverage?: { eligible?: number; selected?: number; filesRead?: number; selectedBytes?: number; complete?: boolean; failures?: number } | null;
  trapScanStatus?: "complete" | "bounded" | "partial" | "pending" | "unknown";
  scanErrors?: string[];
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
  hardeningIndex?: number | null;
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
  effectiveReward?: number;
  rewardCap?: number;
  rewardCapped?: boolean;
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
  repoEnrichment?: { discovered: number; stale?: number; scheduled?: number; deferred?: number; maxPerRun?: number; attempted: number; updated: number; failed: number; pending: number; rateLimited?: boolean; authenticated?: boolean; githubAuthSource?: string; github?: number; gitlab?: number; batchedQueries?: number; metadataBatchFallbacks?: number; startingRateLimit?: { coreRemaining: number | null; coreLimit: number | null; graphqlRemaining: number | null; graphqlLimit: number | null } | null };
  repositoryCoverage?: { discoveredTargets: number; numericHardeningTargets: number; requiredHardeningTargets: number; ratio: number; ready: boolean };
  trapVerification?: { electroneumTargets: number; electroneumDevKnown: boolean; managedDosTargets: number; dosCeilingConsistent: boolean; ready: boolean };
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
