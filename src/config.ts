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
    pinHost: parseBoolEnv(process.env.GITLAB_PIN_HOST, true),
    allowSharedEscapeHatch: parseBoolEnv(process.env.GITLAB_ALLOW_SHARED_ESCAPE_HATCH, false),
  };

  return ConfigSchema.parse(config);
}

export function validateUserConfig(userCredentials: any): UserConfig {
  return UserConfigSchema.parse(userCredentials);
}
