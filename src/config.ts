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
});

export type Config = z.infer<typeof ConfigSchema>;

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
      'Set exactly one (or neither, for strict per-user mode).'
    );
  }

  const config = {
    gitlabUrl: process.env.GITLAB_URL || 'https://gitlab.com',
    token,
    readToken,
    maxPageSize: parseInt(process.env.GITLAB_MAX_PAGE_SIZE || '50'),
    defaultTimeout: parseInt(process.env.GITLAB_TIMEOUT || '30000'),
  };

  return ConfigSchema.parse(config);
}

export function validateUserConfig(userCredentials: any): UserConfig {
  return UserConfigSchema.parse(userCredentials);
}
