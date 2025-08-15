import { z } from 'zod';

export const ConfigSchema = z.object({
  gitlabUrl: z.string().url().default('https://gitlab.com'),
  // Shared read-only token (optional - for read operations when no user token provided)
  sharedAccessToken: z.string().optional(),
  maxPageSize: z.number().min(1).max(100).default(50),
  defaultTimeout: z.number().min(1000).default(30000),
  // Authentication mode
  authMode: z.enum(['shared', 'per-user', 'hybrid']).default('hybrid'),
});

export type Config = z.infer<typeof ConfigSchema>;

// User-specific configuration for per-user authentication
export const UserConfigSchema = z.object({
  accessToken: z.string().min(1, 'User access token is required'),
  gitlabUrl: z.string().url().optional(), // Allow user to override GitLab URL if needed
});

export type UserConfig = z.infer<typeof UserConfigSchema>;

export function loadConfig(): Config {
  const config = {
    gitlabUrl: process.env.GITLAB_URL || 'https://gitlab.com',
    sharedAccessToken: process.env.GITLAB_SHARED_ACCESS_TOKEN || undefined,
    maxPageSize: parseInt(process.env.GITLAB_MAX_PAGE_SIZE || '50'),
    defaultTimeout: parseInt(process.env.GITLAB_TIMEOUT || '30000'),
    authMode: (process.env.GITLAB_AUTH_MODE as 'shared' | 'per-user' | 'hybrid') || 'hybrid',
  };

  return ConfigSchema.parse(config);
}

export function validateUserConfig(userCredentials: any): UserConfig {
  return UserConfigSchema.parse(userCredentials);
}