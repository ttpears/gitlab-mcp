import { z } from 'zod';

export const ConfigSchema = z.object({
  gitlabUrl: z.string().url().default('https://gitlab.com'),
  // Full-access fallback token: usable for reads and writes when no per-call
  // user credentials are provided. Mutually exclusive with readToken.
  token: z.string().optional(),
  // Read-only fallback token: writes against this token are always rejected.
  // Mutually exclusive with token.
  readToken: z.string().optional(),
  maxPageSize: z.number().min(1).max(100).default(50),
  defaultTimeout: z.number().min(1000).default(30000),
  // Cap in-flight requests; excess work enters a bounded queue. Overflow and
  // queue wait expiry fail explicitly, protecting shared deployments.
  // 0 = unlimited.
  maxConcurrency: z.number().min(0).default(16),
  maxQueuedRequests: z.number().int().min(0).default(128),
  maxQueueWaitMs: z.number().int().min(100).default(15000),
  maxResponseBytes: z.number().int().min(1024).default(16 * 1024 * 1024),
  maxHttpSessions: z.number().int().min(1).default(1000),
  maxSessionsPerIdentity: z.number().int().min(1).default(10),
  httpRequestsPerMinute: z.number().int().min(1).default(240),
  maxHttpRequestsPerIdentity: z.number().int().min(1).default(8),
  maxHttpInflight: z.number().int().min(1).default(256),
  // Cap on how many projects a single group-analytics fan-out will scan. High by
  // default to preserve deep data-mining; when a scan hits it the server logs that
  // coverage was bounded rather than silently truncating.
  analyticsMaxProjects: z.number().min(1).default(500),
  // When true (default), per-call/header-supplied gitlabUrl is ignored and every
  // request targets the configured gitlabUrl. This closes the SSRF vector where a
  // caller points the server at internal/metadata hosts via X-GitLab-Url. Set
  // GITLAB_PIN_HOST=false only if you intentionally serve multiple GitLab instances.
  pinHost: z.boolean().default(true),
  // The open-ended escape-hatch tools (execute_custom_query, execute_rest_read,
  // execute_rest_write) require per-call user credentials by default — they will not
  // run on the shared GITLAB_TOKEN unless this is enabled. Set
  // GITLAB_ALLOW_SHARED_ESCAPE_HATCH=true for single-operator/stdio setups where the
  // shared token is the operator's own.
  allowSharedEscapeHatch: z.boolean().default(false),
});

export type Config = z.infer<typeof ConfigSchema>;

/**
 * Parse a boolean environment variable. Unset/empty → fallback. Recognizes
 * "false"/"0"/"no"/"off" (case-insensitive) as false and "true"/"1"/"yes"/"on"
 * as true; anything else falls back to the default.
 */
function parseBoolEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  const v = value.trim().toLowerCase();
  if (['false', '0', 'no', 'off'].includes(v)) return false;
  if (['true', '1', 'yes', 'on'].includes(v)) return true;
  return fallback;
}

export const UserConfigSchema = z.object({
  accessToken: z.string().min(1, 'User access token is required'),
  gitlabUrl: z.string().url().optional(),
});

export type UserConfig = z.infer<typeof UserConfigSchema>;

export function loadConfig(): Config {
  // Deprecation warnings for removed env vars (1.14.0 breaking change)
  if (process.env.GITLAB_AUTH_MODE) {
    console.error(
      '[MCP] GITLAB_AUTH_MODE is removed in 1.14.0 and is being ignored. ' +
      'Use GITLAB_TOKEN (full-access) or GITLAB_READ_TOKEN (read-only) instead.'
    );
  }
  if (process.env.GITLAB_SHARED_ACCESS_TOKEN) {
    console.error(
      '[MCP] GITLAB_SHARED_ACCESS_TOKEN is removed in 1.14.0 and is being ignored. ' +
      'Rename to GITLAB_TOKEN (if it grants writes) or GITLAB_READ_TOKEN (if read-only).'
    );
  }

  const token = process.env.GITLAB_TOKEN || undefined;
  const readToken = process.env.GITLAB_READ_TOKEN || undefined;

  if (token && readToken) {
    throw new Error(
      'Configuration error: GITLAB_TOKEN and GITLAB_READ_TOKEN are mutually exclusive. ' +
      'Set exactly one (or neither, to require per-call user credentials for every request).'
    );
  }

  const config = {
    gitlabUrl: process.env.GITLAB_URL || 'https://gitlab.com',
    token,
    readToken,
    maxPageSize: parseInt(process.env.GITLAB_MAX_PAGE_SIZE || '50'),
    defaultTimeout: parseInt(process.env.GITLAB_TIMEOUT || '30000'),
    maxConcurrency: parseInt(process.env.GITLAB_MAX_CONCURRENCY || '16'),
    maxQueuedRequests: Number(process.env.GITLAB_MAX_QUEUED_REQUESTS || 128),
    maxQueueWaitMs: Number(process.env.GITLAB_MAX_QUEUE_WAIT_MS || 15000),
    maxResponseBytes: Number(process.env.GITLAB_MAX_RESPONSE_BYTES || 16 * 1024 * 1024),
    maxHttpSessions: Number(process.env.MCP_MAX_SESSIONS || 1000),
    maxSessionsPerIdentity: Number(process.env.MCP_MAX_SESSIONS_PER_IDENTITY || 10),
    httpRequestsPerMinute: Number(process.env.MCP_REQUESTS_PER_MINUTE || 240),
    maxHttpRequestsPerIdentity: Number(process.env.MCP_MAX_INFLIGHT_PER_IDENTITY || 8),
    maxHttpInflight: Number(process.env.MCP_MAX_INFLIGHT_REQUESTS || 256),
    analyticsMaxProjects: parseInt(process.env.GITLAB_ANALYTICS_MAX_PROJECTS || '500'),
    pinHost: parseBoolEnv(process.env.GITLAB_PIN_HOST, true),
    allowSharedEscapeHatch: parseBoolEnv(process.env.GITLAB_ALLOW_SHARED_ESCAPE_HATCH, false),
  };

  return ConfigSchema.parse(config);
}

export function validateUserConfig(userCredentials: any): UserConfig {
  return UserConfigSchema.parse(userCredentials);
}
