import { z } from 'zod';
import { GitLabGraphQLClient } from './gitlab-client.js';
import { validateUserConfig, type UserConfig } from './config.js';

export interface Tool {
  name: string;
  description: string;
  inputSchema: z.ZodSchema;
  requiresAuth: boolean;
  requiresWrite: boolean;
  handler: (input: any, client: GitLabGraphQLClient, userConfig?: UserConfig) => Promise<any>;
}

// Schema for user credentials
const UserCredentialsSchema = z.object({
  gitlabUrl: z.string().url().optional(),
  accessToken: z.string().min(1),
}).optional();

// Helper to add user credentials to input schemas
const withUserAuth = (baseSchema: z.ZodObject<any>, required = false) => {
  if (required) {
    return baseSchema.extend({
      userCredentials: z.object({
        gitlabUrl: z.string().url().optional(),
        accessToken: z.string().min(1),
      }).describe('Your GitLab credentials (required for this operation)'),
    });
  } else {
    return baseSchema.extend({
      userCredentials: UserCredentialsSchema.describe('Your GitLab credentials (optional - uses shared token if not provided)'),
    });
  }
};

// Read-only tools (can use shared token)
const getCurrentUserTool: Tool = {
  name: 'get_current_user',
  description: 'Get information about the current authenticated GitLab user',
  requiresAuth: true,
  requiresWrite: false,
  inputSchema: withUserAuth(z.object({})),
  handler: async (input, client, userConfig) => {
    const credentials = input.userCredentials ? validateUserConfig(input.userCredentials) : userConfig;
    const result = await client.getCurrentUser(credentials);
    return result.currentUser;
  },
};

const getProjectTool: Tool = {
  name: 'get_project',
  description: 'Get detailed information about a specific GitLab project (read-only)',
  requiresAuth: false,
  requiresWrite: false,
  inputSchema: withUserAuth(z.object({
    fullPath: z.string().describe('Full path of the project (e.g., "group/project-name")'),
  })),
  handler: async (input, client, userConfig) => {
    const credentials = input.userCredentials ? validateUserConfig(input.userCredentials) : userConfig;
    const result = await client.getProject(input.fullPath, credentials);
    return result.project;
  },
};

const getProjectsTool: Tool = {
  name: 'get_projects',
  description: 'List projects accessible to the user (requires authentication to see private projects)',
  requiresAuth: true,
  requiresWrite: false,
  inputSchema: withUserAuth(z.object({
    first: z.number().min(1).max(100).default(20).describe('Number of projects to retrieve'),
    after: z.string().optional().describe('Cursor for pagination'),
  })),
  handler: async (input, client, userConfig) => {
    const credentials = input.userCredentials ? validateUserConfig(input.userCredentials) : userConfig;
    const result = await client.getProjects(input.first, input.after, credentials);
    return result.currentUser.projects;
  },
};

const getIssuesTool: Tool = {
  name: 'get_issues',
  description: 'Get issues from a specific GitLab project (read-only)',
  requiresAuth: false,
  requiresWrite: false,
  inputSchema: withUserAuth(z.object({
    projectPath: z.string().describe('Full path of the project (e.g., "group/project-name")'),
    first: z.number().min(1).max(100).default(20).describe('Number of issues to retrieve'),
    after: z.string().optional().describe('Cursor for pagination'),
  })),
  handler: async (input, client, userConfig) => {
    const credentials = input.userCredentials ? validateUserConfig(input.userCredentials) : userConfig;
    const result = await client.getIssues(input.projectPath, input.first, input.after, credentials);
    return result.project.issues;
  },
};

const getMergeRequestsTool: Tool = {
  name: 'get_merge_requests',
  description: 'Get merge requests from a specific GitLab project (read-only)',
  requiresAuth: false,
  requiresWrite: false,
  inputSchema: withUserAuth(z.object({
    projectPath: z.string().describe('Full path of the project (e.g., "group/project-name")'),
    first: z.number().min(1).max(100).default(20).describe('Number of merge requests to retrieve'),
    after: z.string().optional().describe('Cursor for pagination'),
  })),
  handler: async (input, client, userConfig) => {
    const credentials = input.userCredentials ? validateUserConfig(input.userCredentials) : userConfig;
    const result = await client.getMergeRequests(input.projectPath, input.first, input.after, credentials);
    return result.project.mergeRequests;
  },
};

// Write operations (require user authentication)
const createIssueTool: Tool = {
  name: 'create_issue',
  description: 'Create a new issue in a GitLab project (requires user authentication with write permissions)',
  requiresAuth: true,
  requiresWrite: true,
  inputSchema: withUserAuth(z.object({
    projectPath: z.string().describe('Full path of the project (e.g., "group/project-name")'),
    title: z.string().min(1).describe('Title of the issue'),
    description: z.string().optional().describe('Description of the issue'),
  }), true), // true = required auth
  handler: async (input, client, userConfig) => {
    const credentials = input.userCredentials ? validateUserConfig(input.userCredentials) : userConfig;
    if (!credentials) {
      throw new Error('User authentication is required for creating issues. Please provide your GitLab credentials.');
    }
    const result = await client.createIssue(input.projectPath, input.title, input.description, credentials);
    if (result.issueCreate.errors && result.issueCreate.errors.length > 0) {
      throw new Error(`Failed to create issue: ${result.issueCreate.errors.join(', ')}`);
    }
    return result.issueCreate.issue;
  },
};

const createMergeRequestTool: Tool = {
  name: 'create_merge_request',
  description: 'Create a new merge request in a GitLab project (requires user authentication with write permissions)',
  requiresAuth: true,
  requiresWrite: true,
  inputSchema: withUserAuth(z.object({
    projectPath: z.string().describe('Full path of the project (e.g., "group/project-name")'),
    title: z.string().min(1).describe('Title of the merge request'),
    sourceBranch: z.string().min(1).describe('Source branch name'),
    targetBranch: z.string().min(1).describe('Target branch name'),
    description: z.string().optional().describe('Description of the merge request'),
  }), true), // true = required auth
  handler: async (input, client, userConfig) => {
    const credentials = input.userCredentials ? validateUserConfig(input.userCredentials) : userConfig;
    if (!credentials) {
      throw new Error('User authentication is required for creating merge requests. Please provide your GitLab credentials.');
    }
    const result = await client.createMergeRequest(
      input.projectPath,
      input.title,
      input.sourceBranch,
      input.targetBranch,
      input.description,
      credentials
    );
    if (result.mergeRequestCreate.errors && result.mergeRequestCreate.errors.length > 0) {
      throw new Error(`Failed to create merge request: ${result.mergeRequestCreate.errors.join(', ')}`);
    }
    return result.mergeRequestCreate.mergeRequest;
  },
};

// Advanced tools
const executeCustomQueryTool: Tool = {
  name: 'execute_custom_query',
  description: 'Execute a custom GraphQL query against the GitLab API (authentication may be required depending on query)',
  requiresAuth: false,
  requiresWrite: false,
  inputSchema: withUserAuth(z.object({
    query: z.string().describe('GraphQL query string'),
    variables: z.record(z.any()).optional().describe('Variables for the GraphQL query'),
    requiresWrite: z.boolean().default(false).describe('Set to true if this is a mutation that requires write permissions'),
  })),
  handler: async (input, client, userConfig) => {
    const credentials = input.userCredentials ? validateUserConfig(input.userCredentials) : userConfig;
    if (input.requiresWrite && !credentials) {
      throw new Error('User authentication is required for write operations. Please provide your GitLab credentials.');
    }
    return await client.query(input.query, input.variables, credentials, input.requiresWrite);
  },
};

const getAvailableQueriesTools: Tool = {
  name: 'get_available_queries',
  description: 'Get list of available GraphQL queries and mutations from the GitLab schema',
  requiresAuth: false,
  requiresWrite: false,
  inputSchema: withUserAuth(z.object({})),
  handler: async (input, client, userConfig) => {
    const credentials = input.userCredentials ? validateUserConfig(input.userCredentials) : userConfig;
    await client.introspectSchema(credentials);
    return {
      queries: client.getAvailableQueries(),
      mutations: client.getAvailableMutations(),
    };
  },
};

export const readOnlyTools: Tool[] = [
  getProjectTool,
  getIssuesTool,
  getMergeRequestsTool,
  executeCustomQueryTool,
  getAvailableQueriesTools,
];

export const userAuthTools: Tool[] = [
  getCurrentUserTool,
  getProjectsTool,
];

export const writeTools: Tool[] = [
  createIssueTool,
  createMergeRequestTool,
];

// Search tools - comprehensive search capabilities for LLMs
const globalSearchTool: Tool = {
  name: 'search_gitlab',
  description: 'Search across all of GitLab (projects, issues, merge requests) with a single query - ideal for LLM exploration',
  requiresAuth: false,
  requiresWrite: false,
  inputSchema: withUserAuth(z.object({
    searchTerm: z.string().min(1).describe('Search term to find across GitLab (searches projects, issues, and merge requests)'),
  })),
  handler: async (input, client, userConfig) => {
    const credentials = input.userCredentials ? validateUserConfig(input.userCredentials) : userConfig;
    const result = await client.globalSearch(input.searchTerm, undefined, credentials);
    return {
      searchTerm: input.searchTerm,
      projects: result.projects.nodes,
      issues: result.issues.nodes,
      mergeRequests: result.mergeRequests.nodes,
      totalResults: result.projects.nodes.length + result.issues.nodes.length + result.mergeRequests.nodes.length
    };
  },
};

const searchProjectsTool: Tool = {
  name: 'search_projects',
  description: 'Search for GitLab projects by name or description - great for finding specific repositories',
  requiresAuth: false,
  requiresWrite: false,
  inputSchema: withUserAuth(z.object({
    searchTerm: z.string().min(1).describe('Search term to find projects by name or description'),
    first: z.number().min(1).max(100).default(20).describe('Number of projects to retrieve'),
    after: z.string().optional().describe('Cursor for pagination'),
  })),
  handler: async (input, client, userConfig) => {
    const credentials = input.userCredentials ? validateUserConfig(input.userCredentials) : userConfig;
    const result = await client.searchProjects(input.searchTerm, input.first, input.after, credentials);
    return result.projects;
  },
};

const searchIssuesTool: Tool = {
  name: 'search_issues',
  description: 'Search for issues across GitLab or within a specific project - perfect for finding bugs, features, or discussions',
  requiresAuth: false,
  requiresWrite: false,
  inputSchema: withUserAuth(z.object({
    searchTerm: z.string().min(1).describe('Search term to find issues by title or description'),
    projectPath: z.string().optional().describe('Limit search to specific project (e.g., "group/project-name"). Leave empty to search globally.'),
    state: z.enum(['opened', 'closed', 'all']).default('all').describe('Filter by issue state'),
    first: z.number().min(1).max(100).default(20).describe('Number of issues to retrieve'),
    after: z.string().optional().describe('Cursor for pagination'),
  })),
  handler: async (input, client, userConfig) => {
    const credentials = input.userCredentials ? validateUserConfig(input.userCredentials) : userConfig;
    const result = await client.searchIssues(
      input.searchTerm, 
      input.projectPath, 
      input.state, 
      input.first, 
      input.after, 
      credentials
    );
    
    // Return the issues from either project-specific or global search
    if (input.projectPath) {
      return result.project.issues;
    } else {
      return result.issues;
    }
  },
};

const searchMergeRequestsTool: Tool = {
  name: 'search_merge_requests',
  description: 'Search for merge requests across GitLab or within a specific project - ideal for finding code changes and reviews',
  requiresAuth: false,
  requiresWrite: false,
  inputSchema: withUserAuth(z.object({
    searchTerm: z.string().min(1).describe('Search term to find merge requests by title or description'),
    projectPath: z.string().optional().describe('Limit search to specific project (e.g., "group/project-name"). Leave empty to search globally.'),
    state: z.enum(['opened', 'closed', 'merged', 'all']).default('all').describe('Filter by merge request state'),
    first: z.number().min(1).max(100).default(20).describe('Number of merge requests to retrieve'),
    after: z.string().optional().describe('Cursor for pagination'),
  })),
  handler: async (input, client, userConfig) => {
    const credentials = input.userCredentials ? validateUserConfig(input.userCredentials) : userConfig;
    const result = await client.searchMergeRequests(
      input.searchTerm, 
      input.projectPath, 
      input.state, 
      input.first, 
      input.after, 
      credentials
    );
    
    // Return the merge requests from either project-specific or global search
    if (input.projectPath) {
      return result.project.mergeRequests;
    } else {
      return result.mergeRequests;
    }
  },
};

const searchUsersTool: Tool = {
  name: 'search_users',
  description: 'Search for GitLab users by username or name - useful for finding team members or contributors',
  requiresAuth: false,
  requiresWrite: false,
  inputSchema: withUserAuth(z.object({
    searchTerm: z.string().min(1).describe('Search term to find users by username or name'),
    first: z.number().min(1).max(100).default(20).describe('Number of users to retrieve'),
  })),
  handler: async (input, client, userConfig) => {
    const credentials = input.userCredentials ? validateUserConfig(input.userCredentials) : userConfig;
    const result = await client.searchUsers(input.searchTerm, input.first, credentials);
    return result.users;
  },
};

const searchGroupsTool: Tool = {
  name: 'search_groups',
  description: 'Search for GitLab groups and organizations - helpful for exploring team structures',
  requiresAuth: false,
  requiresWrite: false,
  inputSchema: withUserAuth(z.object({
    searchTerm: z.string().min(1).describe('Search term to find groups by name or path'),
    first: z.number().min(1).max(100).default(20).describe('Number of groups to retrieve'),
  })),
  handler: async (input, client, userConfig) => {
    const credentials = input.userCredentials ? validateUserConfig(input.userCredentials) : userConfig;
    const result = await client.searchGroups(input.searchTerm, input.first, credentials);
    return result.groups;
  },
};

const browseRepositoryTool: Tool = {
  name: 'browse_repository',
  description: 'Browse repository files and folders - essential for exploring codebase structure',
  requiresAuth: false,
  requiresWrite: false,
  inputSchema: withUserAuth(z.object({
    projectPath: z.string().describe('Full path of the project (e.g., "group/project-name")'),
    path: z.string().default('').describe('Directory path to browse (empty for root)'),
    ref: z.string().default('HEAD').describe('Git reference (branch, tag, or commit SHA)'),
  })),
  handler: async (input, client, userConfig) => {
    const credentials = input.userCredentials ? validateUserConfig(input.userCredentials) : userConfig;
    const result = await client.searchRepositoryFiles(input.projectPath, '', input.ref, credentials);
    return {
      project: input.projectPath,
      path: input.path,
      ref: input.ref,
      files: result.project.repository.tree.blobs.nodes,
      directories: result.project.repository.tree.trees.nodes
    };
  },
};

const getFileContentTool: Tool = {
  name: 'get_file_content',
  description: 'Get the content of a specific file from a GitLab repository - crucial for code analysis',
  requiresAuth: false,
  requiresWrite: false,
  inputSchema: withUserAuth(z.object({
    projectPath: z.string().describe('Full path of the project (e.g., "group/project-name")'),
    filePath: z.string().describe('Path to the file within the repository (e.g., "src/main.js")'),
    ref: z.string().default('HEAD').describe('Git reference (branch, tag, or commit SHA)'),
  })),
  handler: async (input, client, userConfig) => {
    const credentials = input.userCredentials ? validateUserConfig(input.userCredentials) : userConfig;
    const result = await client.getFileContent(input.projectPath, input.filePath, input.ref, credentials);
    
    if (result.project.repository.blobs.nodes.length === 0) {
      throw new Error(`File not found: ${input.filePath} in ${input.projectPath} at ${input.ref}`);
    }
    
    const file = result.project.repository.blobs.nodes[0];
    return {
      project: input.projectPath,
      path: file.path,
      name: file.name,
      size: file.size,
      content: file.rawBlob,
      webUrl: file.webUrl,
      ref: input.ref,
      isLFS: !!file.lfsOid
    };
  },
};

export const searchTools: Tool[] = [
  globalSearchTool,
  searchProjectsTool,
  searchIssuesTool,
  searchMergeRequestsTool,
  searchUsersTool,
  searchGroupsTool,
  browseRepositoryTool,
  getFileContentTool,
];

export const tools: Tool[] = [
  ...readOnlyTools,
  ...userAuthTools,
  ...writeTools,
  ...searchTools,
];