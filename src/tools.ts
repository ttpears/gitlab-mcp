import { z } from 'zod';
import { GitLabGraphQLClient } from './gitlab-client.js';
import { validateUserConfig, type UserConfig } from './config.js';
import {
  resolveWindow,
  fetchUserEventsInWindow,
  bucketBy,
  countByAction,
  buildEnvelope,
  type NormalizedEvent,
} from './analytics.js';

export interface Tool {
  name: string;
  title?: string;  // Human-friendly display name (MCP 2025-11-25)
  description: string;
  inputSchema: z.ZodSchema;
  outputSchema?: z.ZodSchema;  // Structured output schema (MCP 2025-11-25)
  requiresAuth: boolean;
  requiresWrite: boolean;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
  };
  icon?: {
    type: 'base64' | 'url';
    mediaType?: string;
    data: string;
  };  // Tool icon (MCP 2025-11-25)
  handler: (input: any, client: GitLabGraphQLClient, userConfig?: UserConfig) => Promise<any>;
}

// Schema for user credentials (empty object coerces to undefined for header-based auth)
const UserCredentialsSchema = z.object({
  gitlabUrl: z.string().url().optional(),
  accessToken: z.string().min(1).optional(),
})
  .nullable()
  .optional()
  .transform((val) => {
    if (!val || !val.accessToken) return undefined;
    return val as { gitlabUrl?: string; accessToken: string };
  });

// Helper to add user credentials to input schemas
const withUserAuth = (baseSchema: z.ZodObject<any>, required = false) => {
  if (required) {
    return baseSchema.extend({
      userCredentials: z.object({
        gitlabUrl: z.string().url().optional(),
        accessToken: z.string().min(1),
      }).nullable().describe('Your GitLab credentials (required for this operation)'),
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
  title: 'Current User',
  description: 'Get information about the current authenticated GitLab user',
  requiresAuth: true,
  requiresWrite: false,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
  inputSchema: withUserAuth(z.object({}).strict()),
  handler: async (input, client, userConfig) => {
    const credentials = input.userCredentials ? validateUserConfig(input.userCredentials) : userConfig;
    const result = await client.getCurrentUser(credentials);
    return result.currentUser;
  },
};

const getProjectTool: Tool = {
  name: 'get_project',
  title: 'Project Details',
  description: 'Get detailed information about a specific GitLab project (read-only)',
  requiresAuth: false,
  requiresWrite: false,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
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
  title: 'List Projects',
  description: 'List projects accessible to the user (requires authentication to see private projects)',
  requiresAuth: true,
  requiresWrite: false,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
  inputSchema: withUserAuth(z.object({
    first: z.number().min(1).max(100).default(20).describe('Number of projects to retrieve'),
    after: z.string().optional().describe('Cursor for pagination'),
    sort: z.string().optional().describe('Sort order (e.g., UPDATED_DESC, CREATED_DESC, CREATED_ASC). Defaults to UPDATED_DESC for recency.'),
    fetchAll: z.boolean().default(false).describe('Fetch all pages up to 100 results'),
  })),
  handler: async (input, client, userConfig) => {
    const credentials = input.userCredentials ? validateUserConfig(input.userCredentials) : userConfig;
    const result = await client.getProjects(input.first, input.after, input.fetchAll, credentials, input.sort);
    if (input.fetchAll) {
      return result;
    }
    return result.projects;
  },
};

const getIssuesTool: Tool = {
  name: 'get_issues',
  title: 'Project Issues',
  description: 'Get issues from a specific GitLab project (read-only)',
  requiresAuth: false,
  requiresWrite: false,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
  inputSchema: withUserAuth(z.object({
    projectPath: z.string().describe('Full path of the project (e.g., "group/project-name")'),
    first: z.number().min(1).max(100).default(20).describe('Number of issues to retrieve'),
    after: z.string().optional().describe('Cursor for pagination'),
    sort: z.string().optional().describe('Sort order (e.g., UPDATED_DESC, CREATED_DESC, CREATED_ASC). Defaults to UPDATED_DESC for recency.'),
    fetchAll: z.boolean().default(false).describe('Fetch all pages up to 100 results'),
  })),
  handler: async (input, client, userConfig) => {
    const credentials = input.userCredentials ? validateUserConfig(input.userCredentials) : userConfig;
    const result = await client.getIssues(input.projectPath, input.first, input.after, input.fetchAll, credentials, input.sort);
    if (input.fetchAll) {
      return result;
    }
    if (!result || !result.project || !result.project.issues) {
      throw new Error('Project not found or issues are not accessible for the provided path');
    }
    return result.project.issues;
  },
};

const getMergeRequestsTool: Tool = {
  name: 'get_merge_requests',
  title: 'Merge Requests',
  description: 'Get merge requests from a specific GitLab project (read-only)',
  requiresAuth: false,
  requiresWrite: false,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
  inputSchema: withUserAuth(z.object({
    projectPath: z.string().describe('Full path of the project (e.g., "group/project-name")'),
    first: z.number().min(1).max(100).default(20).describe('Number of merge requests to retrieve'),
    after: z.string().optional().describe('Cursor for pagination'),
    sort: z.string().optional().describe('Sort order (e.g., UPDATED_DESC, CREATED_DESC, CREATED_ASC). Defaults to UPDATED_DESC for recency.'),
    fetchAll: z.boolean().default(false).describe('Fetch all pages up to 100 results'),
  })),
  handler: async (input, client, userConfig) => {
    const credentials = input.userCredentials ? validateUserConfig(input.userCredentials) : userConfig;
    const result = await client.getMergeRequests(input.projectPath, input.first, input.after, input.fetchAll, credentials, input.sort);
    if (input.fetchAll) {
      return result;
    }
    if (!result || !result.project || !result.project.mergeRequests) {
      throw new Error('Project not found or merge requests are not accessible for the provided path');
    }
    return result.project.mergeRequests;
  },
};

// Write operations (require user authentication)
const createIssueTool: Tool = {
  name: 'create_issue',
  title: 'Create Issue',
  description: 'Create a new issue in a GitLab project (requires user authentication with write permissions)',
  requiresAuth: true,
  requiresWrite: true,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
  inputSchema: withUserAuth(z.object({
    projectPath: z.string().describe('Full path of the project (e.g., "group/project-name")'),
    title: z.string().min(1).describe('Title of the issue'),
    description: z.string().optional().describe('Description of the issue'),
  })),
  handler: async (input, client, userConfig) => {
    const credentials = input.userCredentials ? validateUserConfig(input.userCredentials) : userConfig;
    if (!credentials) {
      throw new Error('User authentication is required for creating issues. Please provide your GitLab credentials.');
    }
    const result = await client.createIssue(input.projectPath, input.title, input.description, credentials);
    const payload = result.createIssue;
    if (payload.errors && payload.errors.length > 0) {
      throw new Error(`Failed to create issue: ${payload.errors.join(', ')}`);
    }
    return payload.issue;
  },
};

const createMergeRequestTool: Tool = {
  name: 'create_merge_request',
  title: 'Create Merge Request',
  description: 'Create a new merge request in a GitLab project (requires user authentication with write permissions)',
  requiresAuth: true,
  requiresWrite: true,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
  inputSchema: withUserAuth(z.object({
    projectPath: z.string().describe('Full path of the project (e.g., "group/project-name")'),
    title: z.string().min(1).describe('Title of the merge request'),
    sourceBranch: z.string().min(1).describe('Source branch name'),
    targetBranch: z.string().min(1).describe('Target branch name'),
    description: z.string().optional().describe('Description of the merge request'),
  })),
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
    const payload = result.createMergeRequest;
    if (payload.errors && payload.errors.length > 0) {
      throw new Error(`Failed to create merge request: ${payload.errors.join(', ')}`);
    }
    return payload.mergeRequest;
  },
};

// Advanced tools
const executeCustomQueryTool: Tool = {
  name: 'execute_custom_query',
  title: 'Custom GraphQL Query',
  description: 'Execute custom GraphQL queries for complex filtering (e.g., issues with assigneeUsernames: ["user"], labelName: ["bug"]). Use this for structured filtering by assignee/author/labels when search tools return 0 results. Use pagination and limit complexity to avoid timeouts.',
  requiresAuth: false,
  requiresWrite: false,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
  inputSchema: withUserAuth(z.object({
    query: z.string().describe('GraphQL query string. Example: query { issues(assigneeUsernames: ["cdhanlon"], state: opened, first: 50) { nodes { iid title webUrl } } }'),
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
  title: 'Available Queries',
  description: 'Get list of available GraphQL queries and mutations from the GitLab schema',
  requiresAuth: false,
  requiresWrite: false,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
  inputSchema: withUserAuth(z.object({}).strict()),
  handler: async (input, client, userConfig) => {
    const credentials = input.userCredentials ? validateUserConfig(input.userCredentials) : userConfig;
    await client.introspectSchema(credentials);
    return {
      queries: client.getAvailableQueries(),
      mutations: client.getAvailableMutations(),
    };
  },
};

const updateIssueTool: Tool = {
  name: 'update_issue',
  title: 'Update Issue',
  description: 'Update an issue (title, description, assignees, labels, due date) with schema-aware mutations',
  requiresAuth: true,
  requiresWrite: true,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
  inputSchema: withUserAuth(z.object({
    projectPath: z.string().describe('Full path of the project (e.g., "group/project-name")'),
    iid: z.string().describe('Issue IID (internal ID shown in the URL)'),
    title: z.string().optional(),
    description: z.string().optional(),
    assigneeUsernames: z.array(z.string()).optional(),
    labelNames: z.array(z.string()).optional(),
    dueDate: z.string().optional().describe('YYYY-MM-DD'),
  })),
  handler: async (input, client, userConfig) => {
    const credentials = input.userCredentials ? validateUserConfig(input.userCredentials) : userConfig;
    if (!credentials) {
      throw new Error('User authentication is required to update issues.');
    }
    const result = await client.updateIssueComposite(
      input.projectPath,
      input.iid,
      {
        title: input.title,
        description: input.description,
        assigneeUsernames: input.assigneeUsernames,
        labelNames: input.labelNames,
        dueDate: input.dueDate,
      },
      credentials
    );
    return result;
  },
};

const updateMergeRequestTool: Tool = {
  name: 'update_merge_request',
  title: 'Update Merge Request',
  description: 'Update a merge request (title, description, assignees, reviewers, labels) with schema-aware mutations',
  requiresAuth: true,
  requiresWrite: true,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
  inputSchema: withUserAuth(z.object({
    projectPath: z.string().describe('Full path of the project (e.g., "group/project-name")'),
    iid: z.string().describe('Merge Request IID (internal ID shown in the URL)'),
    title: z.string().optional(),
    description: z.string().optional(),
    assigneeUsernames: z.array(z.string()).optional(),
    reviewerUsernames: z.array(z.string()).optional(),
    labelNames: z.array(z.string()).optional(),
  })),
  handler: async (input, client, userConfig) => {
    const credentials = input.userCredentials ? validateUserConfig(input.userCredentials) : userConfig;
    if (!credentials) {
      throw new Error('User authentication is required to update merge requests.');
    }
    const result = await client.updateMergeRequestComposite(
      input.projectPath,
      input.iid,
      {
        title: input.title,
        description: input.description,
        assigneeUsernames: input.assigneeUsernames,
        reviewerUsernames: input.reviewerUsernames,
        labelNames: input.labelNames,
      },
      credentials
    );
    return result;
  },
};

// Discovery/introspection tools
const resolvePathTool: Tool = {
  name: 'resolve_path',
  title: 'Resolve Path',
  description: 'Resolve a GitLab path to either a project or group and list group projects when applicable',
  requiresAuth: false,
  requiresWrite: false,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
  inputSchema: withUserAuth(z.object({
    fullPath: z.string().min(1).describe('Project or group full path (e.g., "group/subgroup/project")'),
    first: z.number().min(1).max(100).default(20).describe('Number of items to retrieve when listing group projects'),
    after: z.string().optional().describe('Cursor for pagination'),
  })),
  handler: async (input, client, userConfig) => {
    const credentials = input.userCredentials ? validateUserConfig(input.userCredentials) : userConfig;
    const result = await client.resolvePath(input.fullPath, input.first, input.after, credentials);
    return result;
  },
};

const getGroupProjectsTool: Tool = {
  name: 'get_group_projects',
  title: 'Group Projects',
  description: 'List projects inside a GitLab group (optionally filter by search term)',
  requiresAuth: false,
  requiresWrite: false,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
  inputSchema: withUserAuth(z.object({
    fullPath: z.string().min(1).describe('Group full path (e.g., "group/subgroup")'),
    searchTerm: z.string().optional().transform(v => v?.trim() || undefined).describe('Optional search term to filter group projects'),
    first: z.number().min(1).max(100).default(20).describe('Number of projects to retrieve'),
    after: z.string().optional().describe('Cursor for pagination'),
  })),
  handler: async (input, client, userConfig) => {
    const credentials = input.userCredentials ? validateUserConfig(input.userCredentials) : userConfig;
    const result = await client.getGroup(input.fullPath, input.first, input.after, input.searchTerm, credentials);
    return result.group;
  },
};

const getTypeFieldsTool: Tool = {
  name: 'get_type_fields',
  title: 'GraphQL Type Fields',
  description: 'List available fields on a GraphQL type using introspected schema (requires schema to be introspected)',
  requiresAuth: false,
  requiresWrite: false,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
  inputSchema: withUserAuth(z.object({
    typeName: z.string().min(1).describe('GraphQL type name (e.g., "Project")'),
  })),
  handler: async (input, client, userConfig) => {
    const credentials = input.userCredentials ? validateUserConfig(input.userCredentials) : userConfig;
    await client.introspectSchema(credentials);
    return { typeName: input.typeName, fields: client.getTypeFields(input.typeName) };
  },
};

// Search tools - comprehensive search capabilities for LLMs
const globalSearchTool: Tool = {
  name: 'search_gitlab',
  title: 'Search GitLab',
  description: 'Text search across GitLab projects and issues (Note: Does not support filtering by assignee/labels - use search_issues for that. MRs cannot be searched globally - use search_merge_requests with username)',
  requiresAuth: false,
  requiresWrite: false,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
  inputSchema: withUserAuth(z.object({
    searchTerm: z.string().optional().transform(val => val?.trim() || undefined).describe('Search term (leave empty for recent activity)'),
    first: z.number().min(1).max(100).default(20).describe('Number of results to retrieve per category'),
    after: z.string().optional().describe('Cursor for pagination'),
    fetchAll: z.boolean().default(false).describe('Fetch all pages up to 100 results per category'),
  })),
  handler: async (input, client, userConfig) => {
    const credentials = input.userCredentials ? validateUserConfig(input.userCredentials) : userConfig;

    if (input.fetchAll) {
      const result = await client.globalSearchAll(input.searchTerm, undefined, credentials);
      return {
        searchTerm: input.searchTerm,
        projects: result.projects,
        issues: result.issues,
        totalResults: result.projects.totalFetched + result.issues.totalFetched,
      };
    }

    const result = await client.globalSearch(input.searchTerm, input.first, input.after, credentials);
    return {
      searchTerm: input.searchTerm,
      projects: result.projects,
      issues: result.issues,
      totalResults: (result.projects.nodes?.length || 0) + (result.issues.nodes?.length || 0),
      _note: 'This is a text search only. For filtering by assignee/author/labels, use search_issues or get_user_issues. For MRs, use search_merge_requests with username.'
    };
  },
};

const searchProjectsTool: Tool = {
  name: 'search_projects',
  title: 'Search Projects',
  description: 'Search for GitLab projects by name or description',
  requiresAuth: false,
  requiresWrite: false,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
  inputSchema: withUserAuth(z.object({
    searchTerm: z.string()
      .transform(val => val.trim())
      .refine(val => val.length > 0, { message: 'Search term cannot be empty' })
      .describe('Search term to find projects by name or description'),
    first: z.number().min(1).max(100).default(20).describe('Number of projects to retrieve'),
    after: z.string().optional().describe('Cursor for pagination'),
    fetchAll: z.boolean().default(false).describe('Fetch all pages up to 100 results'),
  })),
  handler: async (input, client, userConfig) => {
    const credentials = input.userCredentials ? validateUserConfig(input.userCredentials) : userConfig;
    const result = await client.searchProjects(input.searchTerm, input.first, input.after, input.fetchAll, credentials);
    if (input.fetchAll) {
      return result;
    }
    return result.projects;
  },
};

const searchIssuesTool: Tool = {
  name: 'search_issues',
  title: 'Search Issues',
  description: 'Search for issues with text search and/or structured filtering (assignee, author, labels, state). For filtering by assignee/author/labels without text search, leave searchTerm empty.',
  requiresAuth: false,
  requiresWrite: false,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
  inputSchema: withUserAuth(z.object({
    searchTerm: z.string().optional().transform(val => val?.trim() || undefined).describe('Text search term (optional - leave empty to filter by assignee/author/labels only)'),
    projectPath: z.string().optional().describe('Optional project path (e.g., "group/project"). Omit for global search.'),
    state: z.string().default('all').describe('Filter by issue state (opened, closed, all)'),
    assigneeUsernames: z.array(z.string()).optional().describe('Filter by assignee usernames (e.g., ["cdhanlon", "jsmith"])'),
    authorUsername: z.string().optional().describe('Filter by author username (e.g., "cdhanlon")'),
    labelNames: z.array(z.string()).optional().describe('Filter by label names (e.g., ["Priority::High", "bug"])'),
    first: z.number().min(1).max(100).default(20).describe('Number of issues to retrieve'),
    after: z.string().optional().describe('Cursor for pagination'),
    sort: z.string().optional().describe('Sort order (e.g., UPDATED_DESC, CREATED_DESC, CREATED_ASC). Defaults to UPDATED_DESC for recency.'),
    fetchAll: z.boolean().default(false).describe('Fetch all pages up to 100 results'),
  })),
  handler: async (input, client, userConfig) => {
    const credentials = input.userCredentials ? validateUserConfig(input.userCredentials) : userConfig;
    const result = await client.searchIssues(
      input.searchTerm,
      input.projectPath,
      input.state,
      input.first,
      input.after,
      input.fetchAll,
      credentials,
      input.assigneeUsernames,
      input.authorUsername,
      input.labelNames,
      input.sort
    );

    if (input.fetchAll) {
      return result;
    }

    // Return the issues from either project-specific or global search
    if (input.projectPath) {
      if (!result || !result.project || !result.project.issues) {
        throw new Error('Project not found or issues are not accessible for the provided path');
      }
      return result.project.issues;
    } else {
      const issues = result.issues;

      // If no results and filters were used, provide helpful error message
      if (issues.nodes.length === 0 && (input.assigneeUsernames || input.authorUsername || input.labelNames)) {
        return {
          ...issues,
          _note: 'No issues found with the specified filters. Try: (1) checking username/label spelling, (2) broadening filters, or (3) using execute_custom_query for complex filtering.'
        };
      }

      return issues;
    }
  },
};

const searchMergeRequestsTool: Tool = {
  name: 'search_merge_requests',
  title: 'Search Merge Requests',
  description: 'Search merge requests by username (supports "username", "author:username", "assignee:username") or search within a specific project. Note: GitLab does not support global text search for MRs - use projectPath for text searches.',
  requiresAuth: false,
  requiresWrite: false,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
  inputSchema: withUserAuth(z.object({
    searchTerm: z.string()
      .transform(val => val.trim())
      .refine(val => val.length > 0, { message: 'Search term cannot be empty' })
      .describe('Username (e.g., "cdhanlon", "author:username", "assignee:username") or text when projectPath provided'),
    projectPath: z.string().optional().describe('Project path (e.g., "group/project"). Required for text searches, optional for username searches.'),
    state: z.string().default('all').describe('Filter by merge request state (opened, closed, merged, all)'),
    first: z.number().min(1).max(100).default(20).describe('Number of merge requests to retrieve'),
    after: z.string().optional().describe('Cursor for pagination'),
    sort: z.string().optional().describe('Sort order (e.g., UPDATED_DESC, CREATED_DESC, CREATED_ASC). Defaults to UPDATED_DESC for recency.'),
    fetchAll: z.boolean().default(false).describe('Fetch all pages up to 100 results'),
  })),
  handler: async (input, client, userConfig) => {
    const credentials = input.userCredentials ? validateUserConfig(input.userCredentials) : userConfig;

    // If projectPath provided, search in that project
    // Otherwise, intelligently find projects matching search term and search their MRs
    const result = await client.searchMergeRequests(
      input.searchTerm,
      input.projectPath,
      input.state,
      input.first,
      input.after,
      input.fetchAll,
      credentials,
      input.sort
    );

    if (input.fetchAll) {
      return result;
    }

    // Handle project-specific search
    if (input.projectPath) {
      if (!result || !result.project || !result.project.mergeRequests) {
        throw new Error(`Project "${input.projectPath}" not found or merge requests are not accessible`);
      }
      return result.project.mergeRequests;
    }

    // Handle intelligent global search (username-based)
    // Provide helpful note if no results found
    if (result.nodes && result.nodes.length === 0) {
      return {
        ...result,
        _note: 'No merge requests found. For username searches, ensure the username is correct. For text searches, provide a projectPath.'
      };
    }

    return result;
  },
};

const searchUsersTool: Tool = {
  name: 'search_users',
  title: 'Search Users',
  description: 'Search for GitLab users by username or name - useful for finding team members or contributors',
  requiresAuth: false,
  requiresWrite: false,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
  inputSchema: withUserAuth(z.object({
    searchTerm: z.string()
      .transform(val => val.trim())
      .refine(val => val.length > 0, { message: 'Search term cannot be empty' })
      .describe('Search term to find users by username or name'),
    first: z.number().min(1).max(100).default(20).describe('Number of users to retrieve'),
    after: z.string().optional().describe('Cursor for pagination'),
    fetchAll: z.boolean().default(false).describe('Fetch all pages up to 100 results'),
  })),
  handler: async (input, client, userConfig) => {
    const credentials = input.userCredentials ? validateUserConfig(input.userCredentials) : userConfig;
    const result = await client.searchUsers(input.searchTerm, input.first, input.after, input.fetchAll, credentials);
    if (input.fetchAll) {
      return result;
    }
    return result.users;
  },
};

const searchGroupsTool: Tool = {
  name: 'search_groups',
  title: 'Search Groups',
  description: 'Search for GitLab groups and organizations',
  requiresAuth: false,
  requiresWrite: false,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
  inputSchema: withUserAuth(z.object({
    searchTerm: z.string()
      .transform(val => val.trim())
      .refine(val => val.length > 0, { message: 'Search term cannot be empty' })
      .describe('Search term to find groups by name or path'),
    first: z.number().min(1).max(100).default(20).describe('Number of groups to retrieve'),
    after: z.string().optional().describe('Cursor for pagination'),
    fetchAll: z.boolean().default(false).describe('Fetch all pages up to 100 results'),
  })),
  handler: async (input, client, userConfig) => {
    const credentials = input.userCredentials ? validateUserConfig(input.userCredentials) : userConfig;
    const result = await client.searchGroups(input.searchTerm, input.first, input.after, input.fetchAll, credentials);
    if (input.fetchAll) {
      return result;
    }
    return result.groups;
  },
};

const browseRepositoryTool: Tool = {
  name: 'browse_repository',
  title: 'Browse Repository',
  description: 'Browse repository files and folders - essential for exploring codebase structure',
  requiresAuth: false,
  requiresWrite: false,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
  inputSchema: withUserAuth(z.object({
    projectPath: z.string().describe('Full path of the project (e.g., "group/project-name")'),
    path: z.string().default('').describe('Directory path to browse (empty for root)'),
    ref: z.string().default('HEAD').describe('Git reference (branch, tag, or commit SHA)'),
  })),
  handler: async (input, client, userConfig) => {
    const credentials = input.userCredentials ? validateUserConfig(input.userCredentials) : userConfig;
    const result = await client.searchRepositoryFiles(input.projectPath, input.path, input.ref, credentials);
    const projectWebUrl = result.project.webUrl;
    const refParam = input.ref || 'HEAD';
    
    const files = result.project.repository.tree.blobs.nodes.map((f: any) => ({
      ...f,
      webUrl: `${projectWebUrl}/-/blob/${refParam}/${f.path}`
    }));
    const directories = result.project.repository.tree.trees.nodes.map((d: any) => ({
      ...d,
      webUrl: `${projectWebUrl}/-/tree/${refParam}/${d.path}`
    }));
    
    return {
      project: input.projectPath,
      path: input.path,
      ref: refParam,
      files,
      directories
    };
  },
};

const getFileContentTool: Tool = {
  name: 'get_file_content',
  title: 'File Content',
  description: 'Get the content of a specific file from a GitLab repository - crucial for code analysis',
  requiresAuth: false,
  requiresWrite: false,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
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
    const projectWebUrl = result.project.webUrl;
    const refParam = input.ref || 'HEAD';
    const fileWebUrl = `${projectWebUrl}/-/blob/${refParam}/${file.path}`;
    
    return {
      project: input.projectPath,
      path: file.path,
      name: file.name,
      size: file.size,
      content: file.rawBlob,
      webUrl: fileWebUrl,
      ref: refParam,
      isLFS: !!file.lfsOid
    };
  },
};

// CI/CD Pipeline tools
const getMergeRequestPipelinesTool: Tool = {
  name: 'get_merge_request_pipelines',
  title: 'MR Pipelines',
  description: 'Get CI/CD pipelines for a merge request, including status, duration, and stages',
  requiresAuth: false,
  requiresWrite: false,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
  inputSchema: withUserAuth(z.object({
    projectPath: z.string().describe('Full path of the project (e.g., "group/project-name")'),
    iid: z.string().describe('Merge request IID'),
    first: z.number().min(1).max(100).default(20).describe('Number of pipelines to retrieve'),
    after: z.string().optional().describe('Cursor for pagination'),
    fetchAll: z.boolean().default(false).describe('Fetch all pages up to 100 results'),
  })),
  handler: async (input, client, userConfig) => {
    const credentials = input.userCredentials ? validateUserConfig(input.userCredentials) : userConfig;
    const result = await client.getMergeRequestPipelines(input.projectPath, input.iid, input.first, input.after, input.fetchAll, credentials);
    if (input.fetchAll) {
      return result;
    }
    if (!result?.project?.mergeRequest) {
      throw new Error('Merge request not found');
    }
    return result.project.mergeRequest.pipelines;
  },
};

const getPipelineJobsTool: Tool = {
  name: 'get_pipeline_jobs',
  title: 'Pipeline Jobs',
  description: 'Get jobs for a specific pipeline, including status, stage, duration, and retry/cancel info',
  requiresAuth: false,
  requiresWrite: false,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
  inputSchema: withUserAuth(z.object({
    projectPath: z.string().describe('Full path of the project (e.g., "group/project-name")'),
    pipelineIid: z.string().describe('Pipeline IID'),
    first: z.number().min(1).max(100).default(20).describe('Number of jobs to retrieve'),
    after: z.string().optional().describe('Cursor for pagination'),
    fetchAll: z.boolean().default(false).describe('Fetch all pages up to 100 results'),
  })),
  handler: async (input, client, userConfig) => {
    const credentials = input.userCredentials ? validateUserConfig(input.userCredentials) : userConfig;
    const result = await client.getPipelineJobs(input.projectPath, input.pipelineIid, input.first, input.after, input.fetchAll, credentials);
    if (input.fetchAll) {
      return result;
    }
    if (!result?.project?.pipeline) {
      throw new Error('Pipeline not found');
    }
    return {
      pipeline: {
        id: result.project.pipeline.id,
        iid: result.project.pipeline.iid,
        status: result.project.pipeline.status,
      },
      jobs: result.project.pipeline.jobs,
    };
  },
};

const managePipelineTool: Tool = {
  name: 'manage_pipeline',
  title: 'Manage Pipeline',
  description: 'Retry or cancel a CI/CD pipeline (requires user authentication with write permissions)',
  requiresAuth: true,
  requiresWrite: true,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
  inputSchema: withUserAuth(z.object({
    projectPath: z.string().describe('Full path of the project (e.g., "group/project-name")'),
    pipelineIid: z.string().describe('Pipeline IID'),
    action: z.enum(['retry', 'cancel']).describe('Action to perform on the pipeline'),
  })),
  handler: async (input, client, userConfig) => {
    const credentials = input.userCredentials ? validateUserConfig(input.userCredentials) : userConfig;
    if (!credentials) {
      throw new Error('User authentication is required for pipeline management. Please provide your GitLab credentials.');
    }
    return await client.managePipeline(input.projectPath, input.pipelineIid, input.action, credentials);
  },
};

// MR Diffs & Commits tools
const getMergeRequestDiffsTool: Tool = {
  name: 'get_merge_request_diffs',
  title: 'MR Diffs',
  description: 'Get diff statistics for a merge request, including per-file additions/deletions and diff refs',
  requiresAuth: false,
  requiresWrite: false,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
  inputSchema: withUserAuth(z.object({
    projectPath: z.string().describe('Full path of the project (e.g., "group/project-name")'),
    iid: z.string().describe('Merge request IID'),
  })),
  handler: async (input, client, userConfig) => {
    const credentials = input.userCredentials ? validateUserConfig(input.userCredentials) : userConfig;
    const result = await client.getMergeRequestDiffs(input.projectPath, input.iid, credentials);
    if (!result?.project?.mergeRequest) {
      throw new Error('Merge request not found');
    }
    return result.project.mergeRequest;
  },
};

const getMergeRequestCommitsTool: Tool = {
  name: 'get_merge_request_commits',
  title: 'MR Commits',
  description: 'Get commits for a merge request (excluding merge commits), with commit count and details',
  requiresAuth: false,
  requiresWrite: false,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
  inputSchema: withUserAuth(z.object({
    projectPath: z.string().describe('Full path of the project (e.g., "group/project-name")'),
    iid: z.string().describe('Merge request IID'),
    first: z.number().min(1).max(100).default(20).describe('Number of commits to retrieve'),
    after: z.string().optional().describe('Cursor for pagination'),
    fetchAll: z.boolean().default(false).describe('Fetch all pages up to 100 results'),
  })),
  handler: async (input, client, userConfig) => {
    const credentials = input.userCredentials ? validateUserConfig(input.userCredentials) : userConfig;
    const result = await client.getMergeRequestCommits(input.projectPath, input.iid, input.first, input.after, input.fetchAll, credentials);
    if (input.fetchAll) {
      return result;
    }
    if (!result?.project?.mergeRequest) {
      throw new Error('Merge request not found');
    }
    return {
      commitCount: result.project.mergeRequest.commitCount,
      commits: result.project.mergeRequest.commitsWithoutMergeCommits,
    };
  },
};

// Work Item Notes tools
const getNotesTool: Tool = {
  name: 'get_notes',
  title: 'Notes/Comments',
  description: 'Get notes (comments) on an issue or merge request, including system notes and inline MR comments',
  requiresAuth: false,
  requiresWrite: false,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
  inputSchema: withUserAuth(z.object({
    projectPath: z.string().describe('Full path of the project (e.g., "group/project-name")'),
    noteableType: z.enum(['issue', 'merge_request']).describe('Type of item to get notes for'),
    iid: z.string().describe('Issue or merge request IID'),
    first: z.number().min(1).max(100).default(20).describe('Number of notes to retrieve'),
    after: z.string().optional().describe('Cursor for pagination'),
    fetchAll: z.boolean().default(false).describe('Fetch all pages up to 100 results'),
  })),
  handler: async (input, client, userConfig) => {
    const credentials = input.userCredentials ? validateUserConfig(input.userCredentials) : userConfig;
    const result = await client.getNotes(input.projectPath, input.noteableType, input.iid, input.first, input.after, input.fetchAll, credentials);
    if (input.fetchAll) {
      return result;
    }
    const noteable = input.noteableType === 'issue'
      ? result?.project?.issue
      : result?.project?.mergeRequest;
    if (!noteable) {
      throw new Error(`${input.noteableType === 'issue' ? 'Issue' : 'Merge request'} not found`);
    }
    return noteable.notes;
  },
};

const createNoteTool: Tool = {
  name: 'create_note',
  title: 'Create Note',
  description: 'Add a comment/note to an issue or merge request (requires user authentication)',
  requiresAuth: true,
  requiresWrite: true,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
  inputSchema: withUserAuth(z.object({
    projectPath: z.string().describe('Full path of the project (e.g., "group/project-name")'),
    noteableType: z.enum(['issue', 'merge_request']).describe('Type of item to add a note to'),
    iid: z.string().describe('Issue or merge request IID'),
    body: z.string().min(1).describe('Note body (supports Markdown)'),
    internal: z.boolean().default(false).describe('Whether the note is internal/confidential (only visible to project members)'),
  })),
  handler: async (input, client, userConfig) => {
    const credentials = input.userCredentials ? validateUserConfig(input.userCredentials) : userConfig;
    if (!credentials) {
      throw new Error('User authentication is required for creating notes. Please provide your GitLab credentials.');
    }
    const result = await client.createNote(input.projectPath, input.noteableType, input.iid, input.body, input.internal, credentials);
    if (result.errors && result.errors.length > 0) {
      throw new Error(`Failed to create note: ${result.errors.join(', ')}`);
    }
    return result.note;
  },
};

// ── Project Tracking & User Reporting tools ─────────────────────────

const listMilestonesTool: Tool = {
  name: 'list_milestones',
  title: 'Milestones',
  description: 'List milestones for a project or group with progress statistics (total/closed issue counts)',
  requiresAuth: false,
  requiresWrite: false,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
  inputSchema: withUserAuth(z.object({
    fullPath: z.string().describe('Full path of the project or group (e.g., "group/project-name" or "group")'),
    isProject: z.boolean().describe('Whether the path is a project (true) or group (false)'),
    state: z.string().optional().describe('Filter by state: active, closed (omit for all)'),
    search: z.string().optional().describe('Search milestones by title'),
    includeAncestors: z.boolean().default(false).describe('Include milestones from ancestor groups'),
    first: z.number().min(1).max(100).default(20).describe('Number of milestones to retrieve'),
    after: z.string().optional().describe('Cursor for pagination'),
    fetchAll: z.boolean().default(false).describe('Fetch all pages up to 100 results'),
  })),
  handler: async (input, client, userConfig) => {
    const credentials = input.userCredentials ? validateUserConfig(input.userCredentials) : userConfig;
    const result = await client.listMilestones(
      input.fullPath, input.isProject, input.state, input.search,
      input.includeAncestors, input.first, input.after, input.fetchAll, credentials
    );
    if (input.fetchAll) {
      return result;
    }
    const container = input.isProject ? result?.project : result?.group;
    if (!container) {
      throw new Error(`${input.isProject ? 'Project' : 'Group'} not found: ${input.fullPath}`);
    }
    return container.milestones;
  },
};

const listIterationsTool: Tool = {
  name: 'list_iterations',
  title: 'Iterations',
  description: 'List iterations (sprints) for a group with cadence info. Requires GitLab Premium/Ultimate.',
  requiresAuth: false,
  requiresWrite: false,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
  inputSchema: withUserAuth(z.object({
    groupPath: z.string().describe('Full path of the group (e.g., "my-group" or "parent/child-group")'),
    state: z.string().optional().describe('Filter by state: upcoming, current, opened, closed (omit for all)'),
    first: z.number().min(1).max(100).default(20).describe('Number of iterations to retrieve'),
    after: z.string().optional().describe('Cursor for pagination'),
    fetchAll: z.boolean().default(false).describe('Fetch all pages up to 100 results'),
  })),
  handler: async (input, client, userConfig) => {
    const credentials = input.userCredentials ? validateUserConfig(input.userCredentials) : userConfig;
    try {
      const result = await client.listIterations(input.groupPath, input.state, input.first, input.after, input.fetchAll, credentials);
      if (input.fetchAll) {
        return result;
      }
      if (!result?.group) {
        throw new Error(`Group not found: ${input.groupPath}`);
      }
      return result.group.iterations;
    } catch (error: any) {
      if (error.message?.includes('iterations') || error.message?.includes('does not exist')) {
        throw new Error(
          `Iterations are not available for "${input.groupPath}". ` +
          `This feature requires GitLab Premium or Ultimate. ` +
          `Original error: ${error.message}`
        );
      }
      throw error;
    }
  },
};

const getTimeTrackingTool: Tool = {
  name: 'get_time_tracking',
  title: 'Time Tracking',
  description: 'Get time tracking data (estimate, spent, timelogs) for an issue or merge request',
  requiresAuth: false,
  requiresWrite: false,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
  inputSchema: withUserAuth(z.object({
    projectPath: z.string().describe('Full path of the project (e.g., "group/project-name")'),
    resourceType: z.enum(['issue', 'merge_request']).describe('Type of resource to get time tracking for'),
    iid: z.string().describe('Issue or merge request IID'),
    includeTimelogs: z.boolean().default(true).describe('Whether to include individual timelog entries'),
    first: z.number().min(1).max(100).default(20).describe('Number of timelog entries to retrieve'),
    after: z.string().optional().describe('Cursor for pagination'),
  })),
  handler: async (input, client, userConfig) => {
    const credentials = input.userCredentials ? validateUserConfig(input.userCredentials) : userConfig;
    const result = await client.getTimeTracking(
      input.projectPath, input.resourceType, input.iid,
      input.includeTimelogs, input.first, input.after, credentials
    );
    const resource = input.resourceType === 'issue'
      ? result?.project?.issue
      : result?.project?.mergeRequest;
    if (!resource) {
      throw new Error(`${input.resourceType === 'issue' ? 'Issue' : 'Merge request'} not found`);
    }
    return resource;
  },
};

const getMergeRequestReviewersTool: Tool = {
  name: 'get_merge_request_reviewers',
  title: 'MR Reviewers',
  description: 'Get approval and reviewer status for a merge request, including who approved and review states',
  requiresAuth: false,
  requiresWrite: false,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
  inputSchema: withUserAuth(z.object({
    projectPath: z.string().describe('Full path of the project (e.g., "group/project-name")'),
    iid: z.string().describe('Merge request IID'),
  })),
  handler: async (input, client, userConfig) => {
    const credentials = input.userCredentials ? validateUserConfig(input.userCredentials) : userConfig;
    const result = await client.getMergeRequestReviewers(input.projectPath, input.iid, credentials);
    if (!result?.project?.mergeRequest) {
      throw new Error('Merge request not found');
    }
    return result.project.mergeRequest;
  },
};

const getProjectStatisticsTool: Tool = {
  name: 'get_project_statistics',
  title: 'Project Statistics',
  description: 'Get aggregate project statistics: open issues/MRs, star/fork counts, storage sizes, commit count, last pipeline status, release count, and language breakdown',
  requiresAuth: false,
  requiresWrite: false,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
  inputSchema: withUserAuth(z.object({
    projectPath: z.string().describe('Full path of the project (e.g., "group/project-name")'),
  })),
  handler: async (input, client, userConfig) => {
    const credentials = input.userCredentials ? validateUserConfig(input.userCredentials) : userConfig;
    const result = await client.getProjectStatistics(input.projectPath, credentials);
    if (!result?.project) {
      throw new Error(`Project not found: ${input.projectPath}`);
    }
    const p = result.project;
    return {
      id: p.id,
      name: p.name,
      fullPath: p.fullPath,
      webUrl: p.webUrl,
      starCount: p.starCount,
      forksCount: p.forksCount,
      openIssuesCount: p.openIssuesCount,
      openMergeRequestsCount: p.openMergeRequests?.count ?? null,
      commitCount: p.statistics?.commitCount ?? null,
      storage: p.statistics ? {
        repositorySize: p.statistics.repositorySize,
        lfsObjectsSize: p.statistics.lfsObjectsSize,
        buildArtifactsSize: p.statistics.buildArtifactsSize,
        packagesSize: p.statistics.packagesSize,
        wikiSize: p.statistics.wikiSize,
        snippetsSize: p.statistics.snippetsSize,
        uploadsSize: p.statistics.uploadsSize,
        containerRegistrySize: p.statistics.containerRegistrySize,
      } : null,
      lastPipeline: p.lastPipeline?.nodes?.[0] ?? null,
      releaseCount: p.releaseCount?.count ?? null,
      languages: p.languages ?? [],
    };
  },
};

const listGroupMembersTool: Tool = {
  name: 'list_group_members',
  title: 'Group Members',
  description: 'List group members with access levels, optionally filtered by search term',
  requiresAuth: false,
  requiresWrite: false,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
  inputSchema: withUserAuth(z.object({
    groupPath: z.string().describe('Full path of the group (e.g., "my-group" or "parent/child-group")'),
    search: z.string().optional().describe('Optional search term to filter members by name or username'),
    first: z.number().min(1).max(100).default(20).describe('Number of members to retrieve'),
    after: z.string().optional().describe('Cursor for pagination'),
    fetchAll: z.boolean().default(false).describe('Fetch all pages up to 100 results'),
  })),
  handler: async (input, client, userConfig) => {
    const credentials = input.userCredentials ? validateUserConfig(input.userCredentials) : userConfig;
    const result = await client.listGroupMembers(input.groupPath, input.search, input.first, input.after, input.fetchAll, credentials);
    if (input.fetchAll) {
      return result;
    }
    if (!result?.group) {
      throw new Error(`Group not found: ${input.groupPath}`);
    }
    return result.group.groupMembers;
  },
};

// Label Search tool
const searchLabelsTool: Tool = {
  name: 'search_labels',
  title: 'Search Labels',
  description: 'Search for labels in a project or group, with optional text filtering',
  requiresAuth: false,
  requiresWrite: false,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
  inputSchema: withUserAuth(z.object({
    fullPath: z.string().describe('Full path of the project or group (e.g., "group/project-name" or "group")'),
    isProject: z.boolean().describe('Whether the path is a project (true) or group (false)'),
    search: z.string().optional().describe('Optional search term to filter labels'),
    first: z.number().min(1).max(100).default(20).describe('Number of labels to retrieve'),
    after: z.string().optional().describe('Cursor for pagination'),
    fetchAll: z.boolean().default(false).describe('Fetch all pages up to 100 results'),
  })),
  handler: async (input, client, userConfig) => {
    const credentials = input.userCredentials ? validateUserConfig(input.userCredentials) : userConfig;
    const result = await client.searchLabels(input.fullPath, input.isProject, input.search, input.first, input.after, input.fetchAll, credentials);
    if (input.fetchAll) {
      return result;
    }
    const container = input.isProject ? result?.project : result?.group;
    if (!container) {
      throw new Error(`${input.isProject ? 'Project' : 'Group'} not found: ${input.fullPath}`);
    }
    return container.labels;
  },
};

// Helper functions for common user queries
const getUserIssuesTool: Tool = {
  name: 'get_user_issues',
  title: 'User Issues',
  description: 'Get all issues assigned to a specific user - uses proper GraphQL filtering for reliable results',
  requiresAuth: false,
  requiresWrite: false,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
  inputSchema: withUserAuth(z.object({
    username: z.string().describe('Username to find issues for (e.g., "cdhanlon")'),
    state: z.string().default('opened').describe('Filter by issue state (opened, closed, all)'),
    projectPath: z.string().optional().describe('Optional: limit search to a specific project'),
    first: z.number().min(1).max(100).default(20).describe('Number of issues to retrieve'),
    after: z.string().optional().describe('Cursor for pagination'),
    fetchAll: z.boolean().default(false).describe('Fetch all pages up to 100 results'),
  })),
  handler: async (input, client, userConfig) => {
    const credentials = input.userCredentials ? validateUserConfig(input.userCredentials) : userConfig;

    // Use the searchIssues method with assigneeUsernames filter
    const result = await client.searchIssues(
      undefined, // No text search
      input.projectPath,
      input.state,
      input.first,
      input.after,
      input.fetchAll,
      credentials,
      [input.username], // assigneeUsernames
      undefined, // authorUsername
      undefined  // labelNames
    );

    if (input.fetchAll) {
      return result;
    }

    if (input.projectPath) {
      if (!result || !result.project || !result.project.issues) {
        throw new Error('Project not found or issues are not accessible for the provided path');
      }
      return {
        username: input.username,
        state: input.state,
        projectPath: input.projectPath,
        ...result.project.issues
      };
    } else {
      return {
        username: input.username,
        state: input.state,
        ...result.issues
      };
    }
  },
};

const getUserMergeRequestsTool: Tool = {
  name: 'get_user_merge_requests',
  title: 'User Merge Requests',
  description: 'Get merge requests for a specific user (as author or assignee) - uses proper GraphQL filtering',
  requiresAuth: false,
  requiresWrite: false,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
  inputSchema: withUserAuth(z.object({
    username: z.string().describe('Username to find merge requests for (e.g., "cdhanlon")'),
    role: z.enum(['author', 'assignee']).default('author').describe('Whether to find MRs authored by or assigned to the user'),
    state: z.string().default('opened').describe('Filter by MR state (opened, closed, merged, all)'),
    projectPath: z.string().optional().describe('Optional: limit search to a specific project'),
    first: z.number().min(1).max(100).default(20).describe('Number of merge requests to retrieve'),
    after: z.string().optional().describe('Cursor for pagination'),
    fetchAll: z.boolean().default(false).describe('Fetch all pages up to 100 results'),
  })),
  handler: async (input, client, userConfig) => {
    const credentials = input.userCredentials ? validateUserConfig(input.userCredentials) : userConfig;

    // Use the searchMergeRequests method with author: or assignee: prefix
    const searchTerm = input.role === 'author' ? `author:${input.username}` : `assignee:${input.username}`;

    const result = await client.searchMergeRequests(
      searchTerm,
      input.projectPath,
      input.state,
      input.first,
      input.after,
      input.fetchAll,
      credentials
    );

    if (input.fetchAll) {
      return result;
    }

    if (input.projectPath) {
      if (!result || !result.project || !result.project.mergeRequests) {
        throw new Error(`Project "${input.projectPath}" not found or merge requests are not accessible`);
      }
      return {
        username: input.username,
        role: input.role,
        state: input.state,
        projectPath: input.projectPath,
        ...result.project.mergeRequests
      };
    }

    return {
      username: input.username,
      role: input.role,
      state: input.state,
      ...result
    };
  },
};

const BroadcastMessageFields = {
  message: z.string().min(1).describe('Message text to display'),
  starts_at: z.string().datetime().optional().describe('ISO 8601 timestamp when the message starts'),
  ends_at: z.string().datetime().optional().describe('ISO 8601 timestamp when the message ends'),
  color: z.string().optional().describe('Background color in hex format, e.g. "#E75E40"'),
  font: z.string().optional().describe('Foreground (font) color in hex format'),
  target_access_levels: z.array(z.number().int()).optional().describe('Access levels to target: 10=Guest, 20=Reporter, 30=Developer, 40=Maintainer, 50=Owner'),
  target_path: z.string().optional().describe('Path glob for pages where the message should appear'),
  broadcast_type: z.enum(['banner', 'notification']).optional().describe('Broadcast type: "banner" or "notification"'),
  dismissable: z.boolean().optional().describe('Whether users can dismiss the broadcast message'),
  theme: z.string().optional().describe('Theme name (GitLab 16.9+), e.g. "indigo", "red"'),
};

const listBroadcastMessagesTool: Tool = {
  name: 'list_broadcast_messages',
  title: 'List Broadcast Messages',
  description: 'List all GitLab broadcast messages (instance-wide announcements). Read-only.',
  requiresAuth: false,
  requiresWrite: false,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  inputSchema: withUserAuth(z.object({
    page: z.number().int().min(1).default(1).describe('Page number (1-based)'),
    perPage: z.number().int().min(1).max(100).default(20).describe('Results per page'),
  })),
  handler: async (input, client, userConfig) => {
    const credentials = input.userCredentials ? validateUserConfig(input.userCredentials) : userConfig;
    return client.listBroadcastMessages(input.page, input.perPage, credentials);
  },
};

const getBroadcastMessageTool: Tool = {
  name: 'get_broadcast_message',
  title: 'Get Broadcast Message',
  description: 'Get a specific GitLab broadcast message by ID.',
  requiresAuth: false,
  requiresWrite: false,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  inputSchema: withUserAuth(z.object({
    id: z.number().int().describe('Broadcast message ID'),
  })),
  handler: async (input, client, userConfig) => {
    const credentials = input.userCredentials ? validateUserConfig(input.userCredentials) : userConfig;
    return client.getBroadcastMessage(input.id, credentials);
  },
};

const createBroadcastMessageTool: Tool = {
  name: 'create_broadcast_message',
  title: 'Create Broadcast Message',
  description: 'Create a GitLab broadcast message. Requires administrator privileges on the GitLab instance.',
  requiresAuth: true,
  requiresWrite: true,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  inputSchema: withUserAuth(z.object(BroadcastMessageFields)),
  handler: async (input, client, userConfig) => {
    const credentials = input.userCredentials ? validateUserConfig(input.userCredentials) : userConfig;
    if (!credentials) {
      throw new Error('User authentication is required for creating broadcast messages.');
    }
    const { userCredentials, ...body } = input;
    return client.createBroadcastMessage(body, credentials);
  },
};

const updateBroadcastMessageTool: Tool = {
  name: 'update_broadcast_message',
  title: 'Update Broadcast Message',
  description: 'Update an existing GitLab broadcast message. Requires administrator privileges.',
  requiresAuth: true,
  requiresWrite: true,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  inputSchema: withUserAuth(z.object({
    id: z.number().int().describe('Broadcast message ID'),
    message: BroadcastMessageFields.message.optional(),
    starts_at: BroadcastMessageFields.starts_at,
    ends_at: BroadcastMessageFields.ends_at,
    color: BroadcastMessageFields.color,
    font: BroadcastMessageFields.font,
    target_access_levels: BroadcastMessageFields.target_access_levels,
    target_path: BroadcastMessageFields.target_path,
    broadcast_type: BroadcastMessageFields.broadcast_type,
    dismissable: BroadcastMessageFields.dismissable,
    theme: BroadcastMessageFields.theme,
  })),
  handler: async (input, client, userConfig) => {
    const credentials = input.userCredentials ? validateUserConfig(input.userCredentials) : userConfig;
    if (!credentials) {
      throw new Error('User authentication is required for updating broadcast messages.');
    }
    const { id, userCredentials, ...body } = input;
    return client.updateBroadcastMessage(id, body, credentials);
  },
};

const deleteBroadcastMessageTool: Tool = {
  name: 'delete_broadcast_message',
  title: 'Delete Broadcast Message',
  description: 'Delete a GitLab broadcast message by ID. Requires administrator privileges.',
  requiresAuth: true,
  requiresWrite: true,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  inputSchema: withUserAuth(z.object({
    id: z.number().int().describe('Broadcast message ID'),
  })),
  handler: async (input, client, userConfig) => {
    const credentials = input.userCredentials ? validateUserConfig(input.userCredentials) : userConfig;
    if (!credentials) {
      throw new Error('User authentication is required for deleting broadcast messages.');
    }
    await client.deleteBroadcastMessage(input.id, credentials);
    return { id: input.id, deleted: true };
  },
};

const getWorkItemTool: Tool = {
  name: 'get_work_item',
  title: 'Get Work Item',
  description:
    'Fetch a GitLab work item (issue, task, epic, incident, OKR) by global ID. Returns the raw widgets array so epic hierarchy, health status, iteration, milestone, and dates are all visible. Accepts either a numeric id or a full gid (gid://gitlab/WorkItem/123).',
  requiresAuth: false,
  requiresWrite: false,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  inputSchema: withUserAuth(z.object({
    id: z.string().describe('Work item ID — numeric (e.g. "123") or full gid (e.g. "gid://gitlab/WorkItem/123")'),
  })),
  handler: async (input, client, userConfig) => {
    const credentials = input.userCredentials ? validateUserConfig(input.userCredentials) : userConfig;
    const result = await client.getWorkItem(input.id, credentials);
    const wi = result.workItem;
    if (!wi) return { workItem: null };
    const widgetSummary = Array.isArray(wi.widgets)
      ? wi.widgets.map((w: any) => w.type).filter(Boolean)
      : [];
    return { workItem: wi, widgetTypes: widgetSummary };
  },
};

const listWorkItemsTool: Tool = {
  name: 'list_work_items',
  title: 'List Work Items',
  description:
    'List work items within a namespace (group or project fullPath). Supports filtering by type (ISSUE, TASK, EPIC, INCIDENT, OBJECTIVE, KEY_RESULT) and state, plus cursor pagination and fetchAll.',
  requiresAuth: false,
  requiresWrite: false,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  inputSchema: withUserAuth(z.object({
    fullPath: z.string().describe('Namespace full path — group (e.g. "my-group") or project (e.g. "my-group/my-project")'),
    types: z
      .array(z.enum(['ISSUE', 'TASK', 'EPIC', 'INCIDENT', 'OBJECTIVE', 'KEY_RESULT', 'TEST_CASE', 'REQUIREMENT']))
      .optional()
      .describe('Filter by work item types. Omit for all types.'),
    state: z.enum(['opened', 'closed', 'all']).optional().describe('Filter by state. "all" returns every state.'),
    first: z.number().int().min(1).max(100).default(20).describe('Page size (default 20, capped by server maxPageSize)'),
    after: z.string().optional().describe('Cursor for next page'),
    fetchAll: z.boolean().optional().describe('Auto-paginate up to first items'),
    sort: z.string().optional().describe('Sort enum, e.g. UPDATED_DESC (default), CREATED_DESC, TITLE_ASC'),
  })),
  handler: async (input, client, userConfig) => {
    const credentials = input.userCredentials ? validateUserConfig(input.userCredentials) : userConfig;
    const stateArg = input.state && input.state !== 'all' ? input.state : undefined;
    const result = await client.listWorkItems(
      input.fullPath,
      {
        first: input.first,
        after: input.after,
        fetchAll: input.fetchAll,
        types: input.types,
        state: stateArg,
        sort: input.sort,
      },
      credentials
    );
    return result;
  },
};

const EventActionEnum = z
  .enum([
    'approved',
    'closed',
    'commented',
    'created',
    'destroyed',
    'expired',
    'joined',
    'left',
    'merged',
    'pushed',
    'reopened',
    'updated',
  ])
  .optional()
  .describe('Filter by action type');

const EventTargetTypeEnum = z
  .enum(['issue', 'milestone', 'merge_request', 'note', 'project', 'snippet', 'user'])
  .optional()
  .describe('Filter by target resource type');

const EventCommonFields = {
  action: EventActionEnum,
  target_type: EventTargetTypeEnum,
  before: z.string().optional().describe('Only events before this date (YYYY-MM-DD)'),
  after: z.string().optional().describe('Only events after this date (YYYY-MM-DD)'),
  sort: z.enum(['asc', 'desc']).default('desc').describe('Sort order (default desc — newest first)'),
  page: z.number().int().min(1).default(1).describe('Page number (1-based)'),
  per_page: z.number().int().min(1).max(100).default(20).describe('Results per page'),
};

const listMyEventsTool: Tool = {
  name: 'list_my_events',
  title: 'My Events',
  description:
    'List the authenticated user\'s GitLab activity feed — pushes, MRs, comments, approvals, issue actions. Primary tool for "what did I just do". Requires user authentication.',
  requiresAuth: true,
  requiresWrite: false,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  inputSchema: withUserAuth(z.object({
    ...EventCommonFields,
    scope: z
      .enum(['all'])
      .optional()
      .describe('Set to "all" to include events from any project you have access to, not just your own authored events'),
  })),
  handler: async (input, client, userConfig) => {
    const credentials = input.userCredentials ? validateUserConfig(input.userCredentials) : userConfig;
    if (!credentials) {
      throw new Error('list_my_events requires user authentication — the feed is scoped to the caller.');
    }
    const { userCredentials, ...params } = input;
    return client.listMyEvents(params, credentials);
  },
};

const listUserEventsTool: Tool = {
  name: 'list_user_events',
  title: 'User Events',
  description:
    'List a specific user\'s public GitLab activity feed by username or numeric ID. Use for tracking what a teammate has been working on.',
  requiresAuth: false,
  requiresWrite: false,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  inputSchema: withUserAuth(z.object({
    user: z
      .string()
      .min(1)
      .describe('Username (e.g. "alice") or numeric user ID'),
    ...EventCommonFields,
  })),
  handler: async (input, client, userConfig) => {
    const credentials = input.userCredentials ? validateUserConfig(input.userCredentials) : userConfig;
    const { userCredentials, user, ...params } = input;
    return client.listUserEvents(user.trim(), params, credentials);
  },
};

const listProjectEventsTool: Tool = {
  name: 'list_project_events',
  title: 'Project Events',
  description:
    'List activity events for a single GitLab project — commits pushed, MRs opened/merged, issues touched, notes added. Accepts project full path or numeric ID.',
  requiresAuth: false,
  requiresWrite: false,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  inputSchema: withUserAuth(z.object({
    project: z
      .string()
      .min(1)
      .describe('Project full path (e.g. "group/my-project") or numeric project ID'),
    ...EventCommonFields,
  })),
  handler: async (input, client, userConfig) => {
    const credentials = input.userCredentials ? validateUserConfig(input.userCredentials) : userConfig;
    const { userCredentials, project, ...params } = input;
    return client.listProjectEvents(project.trim(), params, credentials);
  },
};

// ─── Analytics (computed aggregates) ─────────────────────────────────────────

const analyticsUserSummaryTool: Tool = {
  name: 'analytics_user_summary',
  title: 'User Activity Summary',
  description:
    'Aggregated activity summary for a user over a time window — totals by action type (pushes, MRs opened/merged, comments, approvals), breakdown by project and by day. Use this instead of list_user_events when you want counts rather than a raw event feed.',
  requiresAuth: false,
  requiresWrite: false,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  inputSchema: withUserAuth(z.object({
    user: z
      .string()
      .min(1)
      .describe('Username (e.g. "alice") or numeric user ID'),
    since: z
      .string()
      .describe('ISO date/datetime, inclusive lower bound (e.g. "2026-03-01" or "2026-03-01T00:00:00Z")'),
    until: z
      .string()
      .optional()
      .describe('ISO date/datetime, inclusive upper bound. Defaults to now.'),
    maxEvents: z
      .number()
      .int()
      .min(1)
      .max(5000)
      .optional()
      .describe('Cap on events fetched. Defaults to 2000; returned envelope has truncated:true if reached.'),
  })),
  handler: async (input, client, userConfig) => {
    const credentials = input.userCredentials ? validateUserConfig(input.userCredentials) : userConfig;
    const user = input.user.trim();
    const window = resolveWindow(input.since, input.until);

    const { events, truncated } = await fetchUserEventsInWindow(
      client,
      user,
      { window, maxEvents: input.maxEvents },
      credentials,
    );

    const byProject: Array<{
      projectId: number;
      projectPath: string | null;
      totals: ReturnType<typeof countByAction>;
    }> = [];
    for (const [projectId, bucket] of bucketBy(events, (e: NormalizedEvent) => e.projectId)) {
      byProject.push({ projectId, projectPath: null, totals: countByAction(bucket) });
    }
    byProject.sort((a, b) => b.totals.events - a.totals.events);

    const byDay: Array<{ date: string; totals: ReturnType<typeof countByAction> }> = [];
    for (const [date, bucket] of bucketBy(events, (e: NormalizedEvent) =>
      e.createdAt.toISOString().slice(0, 10),
    )) {
      byDay.push({ date, totals: countByAction(bucket) });
    }
    byDay.sort((a, b) => a.date.localeCompare(b.date));

    return buildEnvelope(
      { type: 'user', identifier: user },
      window,
      events,
      { byProject, byDay },
      truncated,
    );
  },
};

const REVIEW_BUCKETS = ['<1d', '1-3d', '3-7d', '7-14d', '>14d'] as const;
type ReviewBucket = typeof REVIEW_BUCKETS[number];

function emptyReviewBuckets(): Record<ReviewBucket, number> {
  return { '<1d': 0, '1-3d': 0, '3-7d': 0, '7-14d': 0, '>14d': 0 };
}

function bucketForAge(ageDays: number): ReviewBucket {
  if (ageDays < 1) return '<1d';
  if (ageDays < 3) return '1-3d';
  if (ageDays < 7) return '3-7d';
  if (ageDays < 14) return '7-14d';
  return '>14d';
}

const analyticsReviewBottlenecksTool: Tool = {
  name: 'analytics_review_bottlenecks',
  title: 'Review Bottlenecks',
  description:
    'Aggregate open (non-draft) merge requests across a group or project to surface review bottlenecks. Returns per-reviewer queue stats, age-bucket histogram, and the stalest MRs by updatedAt. MRs with no reviewer assigned are bucketed under "(unassigned)".',
  requiresAuth: false,
  requiresWrite: false,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  inputSchema: withUserAuth(z.object({
    group: z.string().optional().describe('Group full path (e.g. "my-group"). Mutually exclusive with `project`.'),
    project: z.string().optional().describe('Project full path (e.g. "my-group/my-project"). Mutually exclusive with `group`.'),
    staleAfterDays: z.number().int().min(0).default(3).describe('An MR counts as "stale" if its updatedAt is older than this many days. Default 3.'),
    topStalest: z.number().int().min(1).max(200).default(20).describe('Cap on the stalest[] list. Default 20.'),
    maxMRs: z.number().int().min(1).max(5000).default(1000).describe('Hard cap on MRs scanned. Envelope flags `truncated:true` if reached.'),
  })),
  handler: async (input, client, userConfig) => {
    const credentials = input.userCredentials ? validateUserConfig(input.userCredentials) : userConfig;
    const group = input.group?.trim();
    const project = input.project?.trim();
    if ((!group && !project) || (group && project)) {
      throw new Error('analytics_review_bottlenecks requires exactly one of `group` or `project`.');
    }
    const scope: { type: 'group' | 'project'; fullPath: string } = group
      ? { type: 'group', fullPath: group }
      : { type: 'project', fullPath: project! };

    const page = await client.listOpenMergeRequestsForReviewQueue(
      scope,
      { maxItems: input.maxMRs },
      credentials,
    );
    const truncated = !!page.hasMore;
    const rawNodes: any[] = Array.isArray(page.nodes) ? page.nodes : [];
    const mrs = rawNodes.filter((mr) => !mr.draft);

    const now = Date.now();
    const staleAfterMs = input.staleAfterDays * 86400000;

    type EnrichedMR = {
      projectFullPath: string;
      iid: string;
      title: string;
      webUrl: string;
      author: string | null;
      reviewers: string[];
      ageDays: number;
      ageMs: number;
      updatedAt: string;
      bucket: ReviewBucket;
    };

    const enriched: EnrichedMR[] = mrs.map((mr) => {
      const updatedAtStr: string = mr.updatedAt;
      const ageMs = now - new Date(updatedAtStr).getTime();
      const ageDays = Math.floor(ageMs / 86400000);
      const reviewers: string[] = Array.isArray(mr.reviewers?.nodes)
        ? mr.reviewers.nodes.map((r: any) => r?.username).filter(Boolean)
        : [];
      const projectFullPath: string =
        mr.project?.fullPath ?? (scope.type === 'project' ? scope.fullPath : '');
      return {
        projectFullPath,
        iid: String(mr.iid),
        title: mr.title,
        webUrl: mr.webUrl,
        author: mr.author?.username ?? null,
        reviewers,
        ageDays,
        ageMs,
        updatedAt: updatedAtStr,
        bucket: bucketForAge(ageDays),
      };
    });

    const totals = {
      mrs: enriched.length,
      stale: enriched.filter((m) => m.ageMs >= staleAfterMs).length,
      unassigned: enriched.filter((m) => m.reviewers.length === 0).length,
    };

    const buckets = emptyReviewBuckets();
    for (const m of enriched) buckets[m.bucket]++;

    type ReviewerAgg = {
      reviewer: string;
      total: number;
      stale: number;
      oldestAgeDays: number;
      buckets: Record<ReviewBucket, number>;
    };
    const reviewerMap = new Map<string, ReviewerAgg>();
    for (const m of enriched) {
      const keys = m.reviewers.length ? m.reviewers : ['(unassigned)'];
      for (const key of keys) {
        let agg = reviewerMap.get(key);
        if (!agg) {
          agg = { reviewer: key, total: 0, stale: 0, oldestAgeDays: 0, buckets: emptyReviewBuckets() };
          reviewerMap.set(key, agg);
        }
        agg.total++;
        if (m.ageMs >= staleAfterMs) agg.stale++;
        if (m.ageDays > agg.oldestAgeDays) agg.oldestAgeDays = m.ageDays;
        agg.buckets[m.bucket]++;
      }
    }
    const byReviewer = Array.from(reviewerMap.values()).sort((a, b) => {
      if (b.stale !== a.stale) return b.stale - a.stale;
      return b.total - a.total;
    });

    const stalest = enriched
      .slice()
      .sort((a, b) => b.ageMs - a.ageMs)
      .slice(0, input.topStalest)
      .map((m) => ({
        projectFullPath: m.projectFullPath,
        iid: m.iid,
        title: m.title,
        webUrl: m.webUrl,
        author: m.author,
        reviewers: m.reviewers,
        ageDays: m.ageDays,
        updatedAt: m.updatedAt,
      }));

    return {
      scope: { type: scope.type, fullPath: scope.fullPath },
      generatedAt: new Date().toISOString(),
      staleAfterDays: input.staleAfterDays,
      totals,
      buckets,
      byReviewer,
      stalest,
      truncated,
    };
  },
};

export const readOnlyTools: Tool[] = [
  getProjectTool,
  getIssuesTool,
  getMergeRequestsTool,
  executeCustomQueryTool,
  getAvailableQueriesTools,
  getMergeRequestPipelinesTool,
  getPipelineJobsTool,
  getMergeRequestDiffsTool,
  getMergeRequestCommitsTool,
  getNotesTool,
  listMilestonesTool,
  listIterationsTool,
  getTimeTrackingTool,
  getMergeRequestReviewersTool,
  getProjectStatisticsTool,
  listBroadcastMessagesTool,
  getBroadcastMessageTool,
  getWorkItemTool,
  listWorkItemsTool,
  listUserEventsTool,
  listProjectEventsTool,
  listMyEventsTool,
  analyticsUserSummaryTool,
  analyticsReviewBottlenecksTool,
];

export const userAuthTools: Tool[] = [
  getCurrentUserTool,
  getProjectsTool,
];

export const writeTools: Tool[] = [
  createIssueTool,
  createMergeRequestTool,
  createNoteTool,
  managePipelineTool,
  createBroadcastMessageTool,
  updateBroadcastMessageTool,
  deleteBroadcastMessageTool,
];

export const searchTools: Tool[] = [
  globalSearchTool,
  searchProjectsTool,
  searchIssuesTool,
  searchMergeRequestsTool,
  getUserIssuesTool,
  getUserMergeRequestsTool,
  searchUsersTool,
  searchGroupsTool,
  searchLabelsTool,
  browseRepositoryTool,
  getFileContentTool,
  listGroupMembersTool,
];

export const tools: Tool[] = [
  ...readOnlyTools,
  ...userAuthTools,
  ...writeTools,
  updateIssueTool,
  updateMergeRequestTool,
  resolvePathTool,
  getGroupProjectsTool,
  getTypeFieldsTool,
  ...searchTools,
];