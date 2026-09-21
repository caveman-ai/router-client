// Wire types for the Caveman Router API. These mirror the server structs
// (the router's route, task and delegate structs) field for field: the
// server is closed source, so this file is the published shape of the contract
// and is the only place either package spells the wire out.

export type Slider = "cheapest" | "cheaper" | "balanced" | "careful" | "never_cheaper";

/** Canonical outcome kinds accepted by POST /v1/route/outcomes. */
export type OutcomeKind = "retry" | "test_pass" | "test_fail" | "abandoned" | "completed";

// --- POST /v1/route ---------------------------------------------------------

export interface RouteMessage {
  role: string;
  /** A string or an array of provider content blocks; sent through untouched. */
  content: unknown;
}

export interface RouteCacheHint {
  model: string;
  read_tokens: number;
}

export interface RouteRequest {
  text?: string;
  messages?: RouteMessage[];
  models: string[];
  tools?: unknown[];
  cache?: RouteCacheHint;
  slider?: Slider;
}

export interface RouteClassification {
  task: string;
  task_confidence: number;
  tier: string;
  complexity: number;
  high_stakes: number;
  quality_demand: number;
  speed_demand: number;
  classifier: string;
  artifact_sha256: string;
  latency_ms: number;
}

export interface EvidenceSource {
  name: string;
  via?: string;
  as_of?: string;
}

export interface RouteEvidence {
  /** tenant | pooled | external | ladder */
  layer: string;
  /** measured | external | inferred */
  basis: string;
  /** fresh | stale */
  freshness: string;
  sources?: EvidenceSource[];
  age_days?: number;
}

export interface RouteResponse {
  decision_id: string;
  request_id: string;
  trace_id: string;
  span_id: string;
  model: string;
  reason: string;
  router_version: string;
  window_version: number;
  profile_sha256?: string;
  model_pool_sha256: string;
  /** Which picker answered — not the same fact as `evidence_detail`. */
  evidence: string;
  evidence_detail?: RouteEvidence;
  learning_collected: boolean;
  outcome_token?: string;
  classification?: RouteClassification;
}

// --- POST /v1/route/task ----------------------------------------------------

export interface TaskParent {
  model: string;
  effort?: string;
  context_tokens?: number;
  cache_read_tokens?: number;
  turn?: number;
}

export interface Harness {
  kind?: string;
}

export interface TaskRequest {
  ask: string;
  parent: TaskParent;
  harness?: Harness;
  models?: string[];
  tools?: unknown[];
  slider?: Slider;
}

export interface TaskAction {
  model: string;
  effort?: string;
}

export interface TaskPick extends TaskAction {
  reason: string;
}

export interface TaskCandidate extends TaskAction {
  quality: number;
  layer: string;
  est_usd: number;
  /** below_allowance | cross_provider_disabled | unsupported | unproven | unpriced */
  excluded?: string;
}

export interface TaskParentView {
  baseline: TaskAction;
  model: string;
  effort?: string;
  effort_state: string;
  reason: string;
  candidates: TaskCandidate[];
  allowance: number;
  slider: string;
  /** Present only when the harness pinned the model itself. */
  auto_would_pick?: TaskPick;
}

export interface TaskAssumptions {
  turns: number;
  context_tokens: number;
  output_per_turn: number;
  effort_index: number;
  /** Prose, not a number: the per-request estimate has no cache buckets. */
  cache_read_tokens: string;
}

export interface TaskEstimate {
  usd: number;
  assumptions: TaskAssumptions;
}

export interface TaskLearning {
  outcomes_for_task: number;
  needed: number;
}

export interface TaskResponse {
  ask_id: string;
  ask_id_kind: string;
  classification: RouteClassification;
  parent: TaskParentView;
  estimate: TaskEstimate;
  evidence: RouteEvidence;
  learning: TaskLearning;
  collect: boolean;
  decision_id: string;
  router_version: string;
}

// --- POST /v1/route/delegate ------------------------------------------------

export interface DelegateParent {
  model: string;
  effort?: string;
  context_tokens: number;
  cache_read_tokens?: number;
  turn?: number;
  window?: number;
  children_active?: number;
}

export interface DelegateTask {
  agent?: string;
  description?: string;
  prompt: string;
  model?: string;
  /** The model came from the definition's frontmatter: a human's choice. */
  model_declared?: boolean;
  background?: boolean;
}

export interface DelegateRequest {
  parent: DelegateParent;
  task: DelegateTask;
  models?: string[];
  harness?: Harness;
  tools?: unknown[];
  /** Without it the endpoint only reports inline_recommended; the caller owns the deny. */
  veto?: boolean;
  slider?: Slider;
}

export interface DelegateChild {
  model: string;
  /** null in v1: the child's effort is its definition's. */
  effort: string | null;
  context: string;
}

export interface DelegatePriors {
  remaining_turns: number;
  child_turns: number;
  material_tokens: number;
  summary_tokens: number;
  child_base_tokens: number;
  parent_context_tokens: number;
  proposal_fallback?: string;
  window_basis?: string;
}

export interface DelegateEstimate {
  inline_usd: number;
  fresh_usd: number;
  fresh_on_proposed_usd: number;
  assumptions: DelegatePriors;
}

export interface DelegateClassification {
  task: string;
  task_confidence: number;
  tier: string;
  complexity: number;
  high_stakes: number;
  needs_parent_context: number;
  scope: number;
  material: number;
  classifier: string;
  artifact_sha256: string;
  latency_ms: number;
}

export interface DelegateResponse {
  decision: string;
  delegate: DelegateChild;
  reason: string;
  evidence: RouteEvidence;
  estimate: DelegateEstimate;
  classification: DelegateClassification;
  /** Developer-facing sentence; empty when nothing changed. */
  line: string;
  /** Model-facing sentence, non-empty only when inline is recommended. */
  deny_line: string;
  collect: boolean;
  decision_id: string;
  line_channel: string;
  inline_recommended: boolean;
  router_version: string;
}

// --- outcomes ---------------------------------------------------------------

export interface DelegateChildUsage {
  model: string;
  input_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  output_tokens: number;
  turns: number;
  tool_calls: number;
  result_chars: number;
}
