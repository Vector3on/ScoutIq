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
