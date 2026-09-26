import type {
  DelegateChildUsage,
  DelegateRequest,
  DelegateResponse,
  OutcomeKind,
  RouteRequest,
  RouteResponse,
  Slider,
  TaskRequest,
  TaskResponse,
} from "./types.js";

export * from "./types.js";
export * from "./daemon.js";

export const DEFAULT_ROUTER_URL = "https://router.caveman.so";

export interface RouterClientOptions {
  url?: string;
  apiKey?: string;
  /** Scopes an ask id to a session: the same text in two sessions is two asks. */
  sessionId?: string;
  userHash?: string;
  slider?: Slider;
  timeoutMs?: number;
}

export interface CallOptions {
  /** Milliseconds left in the CALLER's deadline: the server shortens its
   * classifier call to fit, and the request is aborted at the same instant. */
  budgetMs?: number;
}

/** Every call answers; a failure is a value, never a throw. A harness that gets
 * no answer must be able to change nothing without catching anything. */
export type RouterResult<T> = { ok: true; data: T } | { ok: false; reason: string };

const DEFAULT_TIMEOUT_MS = 10_000;

export class RouterClient {
  private readonly url: string;
  private readonly apiKey: string;
  private readonly sessionId?: string;
  private readonly userHash?: string;
  private readonly slider?: Slider;
  private readonly timeoutMs: number;

  constructor(options: RouterClientOptions = {}) {
    this.url = (options.url ?? process.env.ROUTER_URL ?? DEFAULT_ROUTER_URL).replace(/\/+$/, "");
    this.apiKey = options.apiKey ?? process.env.ROUTER_API_KEY ?? "";
    this.sessionId = options.sessionId;
    this.userHash = options.userHash;
    this.slider = options.slider;
    this.timeoutMs = options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  }

  route(request: RouteRequest, options?: CallOptions): Promise<RouterResult<RouteResponse>> {
    return this.post("/v1/route", this.withSlider(request), options);
  }

  task(request: TaskRequest, options?: CallOptions): Promise<RouterResult<TaskResponse>> {
    return this.post("/v1/route/task", this.withSlider(request), options);
  }

  delegate(request: DelegateRequest, options?: CallOptions): Promise<RouterResult<DelegateResponse>> {
    return this.post("/v1/route/delegate", this.withSlider(request), options);
  }

  outcome(outcomeToken: string, outcomeKind: OutcomeKind, options?: CallOptions): Promise<RouterResult<unknown>> {
    return this.post("/v1/route/outcomes", { outcome_token: outcomeToken, outcome_kind: outcomeKind }, options);
  }

  delegateOutcome(decisionId: string, child: DelegateChildUsage, options?: CallOptions): Promise<RouterResult<unknown>> {
    return this.post("/v1/route/delegate/outcomes", { decision_id: decisionId, child }, options);
  }

  // The client-level slider is a default the call can override, so one client
  // can serve a project stop and a one-off careful decision.
  private withSlider<T extends { slider?: Slider }>(request: T): T {
    return this.slider && !request.slider ? { ...request, slider: this.slider } : request;
  }

  private async post<T>(path: string, body: unknown, options?: CallOptions): Promise<RouterResult<T>> {
    if (!this.apiKey) return { ok: false, reason: "no_api_key" };
    const budget = options?.budgetMs;
    if (budget !== undefined && !(budget > 0)) return { ok: false, reason: "no_budget" };
    const timeout = budget !== undefined ? Math.min(budget, this.timeoutMs) : this.timeoutMs;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-cave-api-key": this.apiKey,
    };
    if (this.sessionId) headers["x-cave-session-id"] = this.sessionId;
    if (this.userHash) headers["x-cave-user-hash"] = this.userHash;
    if (budget !== undefined) headers["x-cave-budget-ms"] = String(Math.round(budget));
    try {
      const response = await fetch(`${this.url}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
      });
      if (!response.ok) return { ok: false, reason: `http_${response.status}` };
      const parsed = (await response.json()) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, reason: "bad_body" };
      return { ok: true, data: parsed as T };
    } catch (error) {
      const name = (error as Error)?.name ?? "";
      return { ok: false, reason: name === "TimeoutError" || name === "AbortError" ? "timeout" : "network" };
    }
  }
}
