import { GitLabGraphQLClient } from './gitlab-client.js';
import { UserConfig } from './config.js';

export interface Window {
  since: Date;
  until: Date;
}

export interface NormalizedEvent {
  id: number;
  createdAt: Date;
  action: CanonicalAction;
  rawAction: string;
  unknownAction: boolean;
  targetType: string | null;
  projectId: number | null;
  authorId: number | null;
  authorUsername: string | null;
  raw: any;
}

export type CanonicalAction =
  | 'push'
  | 'mr_opened'
  | 'mr_merged'
  | 'mr_closed'
  | 'mr_approved'
  | 'issue_opened'
  | 'issue_closed'
  | 'comment'
  | 'joined'
  | 'left'
  | 'other';

export interface AnalyticsScope {
  type: 'user' | 'project' | 'me';
  identifier: string;
}

export interface AnalyticsEnvelope<TBreakdowns = Record<string, unknown>> {
  window: { since: string; until: string };
  scope: AnalyticsScope;
  totals: Record<CanonicalAction, number> & { events: number };
  breakdowns: TBreakdowns;
  truncated: boolean;
  warnings: string[];
}

const MAX_EVENTS_DEFAULT = 2000;
const PAGE_SIZE = 100;

export function resolveWindow(since: string, until?: string): Window {
  const sinceDate = new Date(since);
  if (Number.isNaN(sinceDate.getTime())) {
    throw new Error(`Invalid 'since' date: ${since}`);
  }
  const untilDate = until ? new Date(until) : new Date();
  if (Number.isNaN(untilDate.getTime())) {
    throw new Error(`Invalid 'until' date: ${until}`);
  }
  if (untilDate < sinceDate) {
    throw new Error(`'until' (${until}) must not be before 'since' (${since})`);
  }
  return { since: sinceDate, until: untilDate };
}

const ACTION_MAP: Record<string, CanonicalAction> = {
  'pushed to': 'push',
  'pushed new': 'push',
  'pushed': 'push',
  'opened': 'other',
  'created': 'other',
  'closed': 'other',
  'reopened': 'other',
  'merged': 'mr_merged',
  'approved': 'mr_approved',
  'commented on': 'comment',
  'joined': 'joined',
  'left': 'left',
};

export function normalizeAction(
  rawAction: string,
  targetType: string | null,
): { action: CanonicalAction; unknown: boolean } {
  const base = ACTION_MAP[rawAction];
  const tt = (targetType ?? '').toLowerCase();

  if (base === 'other') {
    if (rawAction === 'opened' || rawAction === 'created') {
      if (tt === 'mergerequest') return { action: 'mr_opened', unknown: false };
      if (tt === 'issue') return { action: 'issue_opened', unknown: false };
    }
    if (rawAction === 'closed') {
      if (tt === 'mergerequest') return { action: 'mr_closed', unknown: false };
      if (tt === 'issue') return { action: 'issue_closed', unknown: false };
    }
    return { action: 'other', unknown: false };
  }

  if (base) return { action: base, unknown: false };
  return { action: 'other', unknown: true };
}

export function toNormalizedEvent(raw: any): NormalizedEvent {
  const { action, unknown } = normalizeAction(raw.action_name ?? '', raw.target_type ?? null);
  return {
    id: raw.id,
    createdAt: new Date(raw.created_at),
    action,
    rawAction: raw.action_name ?? '',
    unknownAction: unknown,
    targetType: raw.target_type ?? null,
    projectId: raw.project_id ?? null,
    authorId: raw.author_id ?? null,
    authorUsername: raw.author_username ?? raw.author?.username ?? null,
    raw,
  };
}

export interface FetchEventsOptions {
  window: Window;
  maxEvents?: number;
  action?: string;
  targetType?: string;
}

export interface FetchEventsResult {
  events: NormalizedEvent[];
  truncated: boolean;
}

type PageFetcher = (page: number, perPage: number) => Promise<any[]>;

async function paginateUntilWindow(
  fetcher: PageFetcher,
  window: Window,
  maxEvents: number,
): Promise<FetchEventsResult> {
  const out: NormalizedEvent[] = [];
  let page = 1;
  let truncated = false;
  outer: while (true) {
    const batch = await fetcher(page, PAGE_SIZE);
    if (!Array.isArray(batch) || batch.length === 0) break;

    let crossedSince = false;
    for (const raw of batch) {
      const ne = toNormalizedEvent(raw);
      if (ne.createdAt < window.since) {
        crossedSince = true;
        break;
      }
      if (ne.createdAt > window.until) continue;
      out.push(ne);
      if (out.length >= maxEvents) {
        truncated = true;
        break outer;
      }
    }

    if (crossedSince) break;
    if (batch.length < PAGE_SIZE) break;
    page++;
  }
  return { events: out, truncated };
}

function widenWindowForRestParams(window: Window): { after: string; before: string } {
  // GitLab's events REST API takes date-only params (YYYY-MM-DD) and treats
  // `after` as exclusive (> date) and `before` as exclusive (< date). Widen
  // by one day on each side so sub-day precision in the in-memory filter
  // inside paginateUntilWindow is the source of truth.
  const after = new Date(window.since);
  after.setUTCDate(after.getUTCDate() - 1);
  const before = new Date(window.until);
  before.setUTCDate(before.getUTCDate() + 1);
  return { after: toDateParam(after), before: toDateParam(before) };
}

export async function fetchUserEventsInWindow(
  client: GitLabGraphQLClient,
  username: string,
  opts: FetchEventsOptions,
  userConfig?: UserConfig,
): Promise<FetchEventsResult> {
  const maxEvents = opts.maxEvents ?? MAX_EVENTS_DEFAULT;
  const { after, before } = widenWindowForRestParams(opts.window);
  return paginateUntilWindow(
    (page, per_page) =>
      client.listUserEvents(
        username,
        { action: opts.action, target_type: opts.targetType, after, before, sort: 'desc', page, per_page },
        userConfig,
      ),
    opts.window,
    maxEvents,
  );
}

export async function fetchProjectEventsInWindow(
  client: GitLabGraphQLClient,
  projectIdOrPath: string | number,
  opts: FetchEventsOptions,
  userConfig?: UserConfig,
): Promise<FetchEventsResult> {
  const maxEvents = opts.maxEvents ?? MAX_EVENTS_DEFAULT;
  const { after, before } = widenWindowForRestParams(opts.window);
  return paginateUntilWindow(
    (page, per_page) =>
      client.listProjectEvents(
        projectIdOrPath,
        { action: opts.action, target_type: opts.targetType, after, before, sort: 'desc', page, per_page },
        userConfig,
      ),
    opts.window,
    maxEvents,
  );
}

export async function fetchMyEventsInWindow(
  client: GitLabGraphQLClient,
  opts: FetchEventsOptions,
  userConfig?: UserConfig,
): Promise<FetchEventsResult> {
  const maxEvents = opts.maxEvents ?? MAX_EVENTS_DEFAULT;
  const { after, before } = widenWindowForRestParams(opts.window);
  return paginateUntilWindow(
    (page, per_page) =>
      client.listMyEvents(
        { action: opts.action, target_type: opts.targetType, after, before, sort: 'desc', page, per_page },
        userConfig,
      ),
    opts.window,
    maxEvents,
  );
}

function toDateParam(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function collectWarnings(events: NormalizedEvent[]): string[] {
  const unknowns = new Set<string>();
  for (const e of events) {
    if (e.unknownAction) unknowns.add(e.rawAction || '(empty)');
  }
  return unknowns.size
    ? [`Unrecognized event action(s): ${Array.from(unknowns).join(', ')}`]
    : [];
}

export function emptyTotals(): AnalyticsEnvelope['totals'] {
  return {
    events: 0,
    push: 0,
    mr_opened: 0,
    mr_merged: 0,
    mr_closed: 0,
    mr_approved: 0,
    issue_opened: 0,
    issue_closed: 0,
    comment: 0,
    joined: 0,
    left: 0,
    other: 0,
  };
}

export function countByAction(events: NormalizedEvent[]): AnalyticsEnvelope['totals'] {
  const totals = emptyTotals();
  for (const e of events) {
    totals.events++;
    totals[e.action]++;
  }
  return totals;
}

export function bucketBy<K extends string | number>(
  events: NormalizedEvent[],
  key: (e: NormalizedEvent) => K | null | undefined,
): Map<K, NormalizedEvent[]> {
  const out = new Map<K, NormalizedEvent[]>();
  for (const e of events) {
    const k = key(e);
    if (k == null) continue;
    const bucket = out.get(k);
    if (bucket) bucket.push(e);
    else out.set(k, [e]);
  }
  return out;
}

export function buildEnvelope<T>(
  scope: AnalyticsScope,
  window: Window,
  events: NormalizedEvent[],
  breakdowns: T,
  truncated: boolean,
): AnalyticsEnvelope<T> {
  return {
    window: { since: window.since.toISOString(), until: window.until.toISOString() },
    scope,
    totals: countByAction(events),
    breakdowns,
    truncated,
    warnings: collectWarnings(events),
  };
}
