import { z } from 'zod';
import { GitLabGraphQLClient } from './gitlab-client.js';
import { validateUserConfig, type UserConfig } from './config.js';

export interface Tool {
  name: string;
  description: string;
  inputSchema: z.ZodSchema;
  requiresAuth: boolean;
  requiresWrite: boolean;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
  };
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
  })),
  handler: async (input, client, userConfig) => {
    const credentials = input.userCredentials ? validateUserConfig(input.userCredentials) : userConfig;
    const result = await client.getProjects(input.first, input.after, credentials);
    return result.projects;
  },
};

const getIssuesTool: Tool = {
  name: 'get_issues',
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
  })),
  handler: async (input, client, userConfig) => {
    const credentials = input.userCredentials ? validateUserConfig(input.userCredentials) : userConfig;
    const result = await client.getIssues(input.projectPath, input.first, input.after, credentials);
    if (!result || !result.project || !result.project.issues) {
      throw new Error('Project not found or issues are not accessible for the provided path');
    }
    return result.project.issues;
  },
};

const getMergeRequestsTool: Tool = {
  name: 'get_merge_requests',
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
  })),
  handler: async (input, client, userConfig) => {
    const credentials = input.userCredentials ? validateUserConfig(input.userCredentials) : userConfig;
    const result = await client.getMergeRequests(input.projectPath, input.first, input.after, credentials);
    if (!result || !result.project || !result.project.mergeRequests) {
      throw new Error('Project not found or merge requests are not accessible for the provided path');
    }
    return result.project.mergeRequests;
  },
};

// Write operations (require user authentication)
const createIssueTool: Tool = {
  name: 'create_issue',
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

const updateIssueTool: Tool = {
  name: 'update_issue',
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
  })),
  handler: async (input, client, userConfig) => {
    const credentials = input.userCredentials ? validateUserConfig(input.userCredentials) : userConfig;
    const result = await client.globalSearch(input.searchTerm, undefined, credentials);
    return {
      searchTerm: input.searchTerm,
      projects: result.projects.nodes,
      issues: result.issues.nodes,
      totalResults: result.projects.nodes.length + result.issues.nodes.length,
      _note: 'This is a text search only. For filtering by assignee/author/labels, use search_issues or get_user_issues. For MRs, use search_merge_requests with username.'
    };
  },
};

const searchProjectsTool: Tool = {
  name: 'search_projects',
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
  })),
  handler: async (input, client, userConfig) => {
    const credentials = input.userCredentials ? validateUserConfig(input.userCredentials) : userConfig;
    const result = await client.searchProjects(input.searchTerm, input.first, input.after, credentials);
    return result.projects;
  },
};

const searchIssuesTool: Tool = {
  name: 'search_issues',
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
  })),
  handler: async (input, client, userConfig) => {
    const credentials = input.userCredentials ? validateUserConfig(input.userCredentials) : userConfig;
    const result = await client.searchIssues(
      input.searchTerm,
      input.projectPath,
      input.state,
      input.first,
      input.after,
      credentials,
      input.assigneeUsernames,
      input.authorUsername,
      input.labelNames
    );

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
      credentials
    );

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
  })),
  handler: async (input, client, userConfig) => {
    const credentials = input.userCredentials ? validateUserConfig(input.userCredentials) : userConfig;
    const result = await client.searchUsers(input.searchTerm, input.first, credentials);
    return result.users;
  },
};

const searchGroupsTool: Tool = {
  name: 'search_groups',
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

// Helper functions for common user queries
const getUserIssuesTool: Tool = {
  name: 'get_user_issues',
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
    first: z.number().min(1).max(100).default(50).describe('Number of issues to retrieve'),
    after: z.string().optional().describe('Cursor for pagination'),
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
      credentials,
      [input.username], // assigneeUsernames
      undefined, // authorUsername
      undefined  // labelNames
    );

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
    first: z.number().min(1).max(100).default(50).describe('Number of merge requests to retrieve'),
    after: z.string().optional().describe('Cursor for pagination'),
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
      credentials
    );

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

// ============================================================================
// Merge Request Operations Tools
// ============================================================================

const getMergeRequestDiffTool: Tool = {
  name: 'get_merge_request_diff',
  description: 'Get file changes and diff statistics for a merge request',
  requiresAuth: false,
  requiresWrite: false,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
  inputSchema: withUserAuth(z.object({
    projectPath: z.string().describe('Full path of the project (e.g., "group/project-name")'),
    iid: z.string().describe('Merge request IID (internal ID visible in GitLab UI)'),
  })),
  handler: async (input, client, userConfig) => {
    const credentials = input.userCredentials ? validateUserConfig(input.userCredentials) : userConfig;
    const result = await client.getMergeRequestDiff(input.projectPath, input.iid, credentials);
    return result.project.mergeRequest;
  },
};

const getMergeRequestApprovalsTool: Tool = {
  name: 'get_merge_request_approvals',
  description: 'Get approval status and list of approvers for a merge request',
  requiresAuth: false,
  requiresWrite: false,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
  inputSchema: withUserAuth(z.object({
    projectPath: z.string().describe('Full path of the project (e.g., "group/project-name")'),
    iid: z.string().describe('Merge request IID (internal ID visible in GitLab UI)'),
  })),
  handler: async (input, client, userConfig) => {
    const credentials = input.userCredentials ? validateUserConfig(input.userCredentials) : userConfig;
    const result = await client.getMergeRequestApprovals(input.projectPath, input.iid, credentials);
    return result.project.mergeRequest;
  },
};

const getMergeRequestChangesTool: Tool = {
  name: 'get_merge_request_changes',
  description: 'Get detailed change summary including commits and diff stats for a merge request',
  requiresAuth: false,
  requiresWrite: false,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
  inputSchema: withUserAuth(z.object({
    projectPath: z.string().describe('Full path of the project (e.g., "group/project-name")'),
    iid: z.string().describe('Merge request IID (internal ID visible in GitLab UI)'),
    first: z.number().min(1).max(100).default(20).describe('Number of commits to retrieve'),
    after: z.string().optional().describe('Cursor for pagination (from pageInfo.endCursor)'),
  })),
  handler: async (input, client, userConfig) => {
    const credentials = input.userCredentials ? validateUserConfig(input.userCredentials) : userConfig;
    const result = await client.getMergeRequestChanges(
      input.projectPath,
      input.iid,
      input.first,
      input.after,
      credentials
    );
    return result.project.mergeRequest;
  },
};

const approveMergeRequestTool: Tool = {
  name: 'approve_merge_request',
  description: 'Approve a merge request (idempotent - safe to call multiple times)',
  requiresAuth: true,
  requiresWrite: true,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
  inputSchema: withUserAuth(z.object({
    projectPath: z.string().describe('Full path of the project (e.g., "group/project-name")'),
    iid: z.string().describe('Merge request IID (internal ID visible in GitLab UI)'),
  }), false),
  handler: async (input, client, userConfig) => {
    const credentials = input.userCredentials ? validateUserConfig(input.userCredentials) : userConfig;
    if (!credentials) {
      throw new Error('User authentication is required for approving merge requests. Please provide your GitLab credentials.');
    }
    const result = await client.approveMergeRequest(input.projectPath, input.iid, credentials);
    const mutationName = Object.keys(result)[0];
    const payload = result[mutationName];
    return payload.mergeRequest;
  },
};

const unapproveMergeRequestTool: Tool = {
  name: 'unapprove_merge_request',
  description: 'Remove your approval from a merge request',
  requiresAuth: true,
  requiresWrite: true,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
  inputSchema: withUserAuth(z.object({
    projectPath: z.string().describe('Full path of the project (e.g., "group/project-name")'),
    iid: z.string().describe('Merge request IID (internal ID visible in GitLab UI)'),
  }), false),
  handler: async (input, client, userConfig) => {
    const credentials = input.userCredentials ? validateUserConfig(input.userCredentials) : userConfig;
    if (!credentials) {
      throw new Error('User authentication is required for unapproving merge requests. Please provide your GitLab credentials.');
    }
    const result = await client.unapproveMergeRequest(input.projectPath, input.iid, credentials);
    const mutationName = Object.keys(result)[0];
    const payload = result[mutationName];
    return payload.mergeRequest;
  },
};

const mergeMergeRequestTool: Tool = {
  name: 'merge_merge_request',
  description: 'Merge a merge request with optional squash and source branch deletion (destructive - cannot be undone)',
  requiresAuth: true,
  requiresWrite: true,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
  },
  inputSchema: withUserAuth(z.object({
    projectPath: z.string().describe('Full path of the project (e.g., "group/project-name")'),
    iid: z.string().describe('Merge request IID (internal ID visible in GitLab UI)'),
    strategy: z.enum(['merge', 'squash', 'rebase_merge']).optional().describe('Merge strategy: "merge" (default), "squash" (squash commits), or "rebase_merge" (rebase then merge)'),
    deleteSourceBranch: z.boolean().optional().describe('Whether to delete the source branch after merging'),
  }), false),
  handler: async (input, client, userConfig) => {
    const credentials = input.userCredentials ? validateUserConfig(input.userCredentials) : userConfig;
    if (!credentials) {
      throw new Error('User authentication is required for merging merge requests. Please provide your GitLab credentials.');
    }
    const result = await client.mergeMergeRequest(
      input.projectPath,
      input.iid,
      input.strategy,
      input.deleteSourceBranch,
      credentials
    );
    const mutationName = Object.keys(result)[0];
    const payload = result[mutationName];
    return payload.mergeRequest;
  },
};

const rebaseMergeRequestTool: Tool = {
  name: 'rebase_merge_request',
  description: 'Rebase a merge request onto its target branch',
  requiresAuth: true,
  requiresWrite: true,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
  inputSchema: withUserAuth(z.object({
    projectPath: z.string().describe('Full path of the project (e.g., "group/project-name")'),
    iid: z.string().describe('Merge request IID (internal ID visible in GitLab UI)'),
  }), false),
  handler: async (input, client, userConfig) => {
    const credentials = input.userCredentials ? validateUserConfig(input.userCredentials) : userConfig;
    if (!credentials) {
      throw new Error('User authentication is required for rebasing merge requests. Please provide your GitLab credentials.');
    }
    const result = await client.rebaseMergeRequest(input.projectPath, input.iid, credentials);
    const mutationName = Object.keys(result)[0];
    const payload = result[mutationName];
    return payload.mergeRequest;
  },
};

export const mergeRequestOperationsTools: Tool[] = [
  getMergeRequestDiffTool,
  getMergeRequestApprovalsTool,
  getMergeRequestChangesTool,
  approveMergeRequestTool,
  unapproveMergeRequestTool,
  mergeMergeRequestTool,
  rebaseMergeRequestTool,
];

// ============================================================================
// CI/CD Pipeline Tools
// ============================================================================

const getPipelinesTool: Tool = {
  name: 'get_pipelines',
  description: 'List CI/CD pipelines for a project with optional filtering by status (SUCCESS, FAILED, RUNNING, etc.) and git ref',
  requiresAuth: false,
  requiresWrite: false,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
  inputSchema: withUserAuth(z.object({
    projectPath: z.string().describe('Full path of the project (e.g., "group/project-name")'),
    status: z.string().optional().describe('Filter by pipeline status (SUCCESS, FAILED, RUNNING, PENDING, CANCELED, SKIPPED, MANUAL)'),
    ref: z.string().optional().describe('Filter by git reference (branch, tag, or commit SHA)'),
    first: z.number().min(1).max(100).default(20).describe('Number of pipelines to retrieve'),
    after: z.string().optional().describe('Cursor for pagination (from pageInfo.endCursor)'),
  })),
  handler: async (input, client, userConfig) => {
    const credentials = input.userCredentials ? validateUserConfig(input.userCredentials) : userConfig;
    const result = await client.getPipelines(
      input.projectPath,
      input.status,
      input.ref,
      input.first,
      input.after,
      credentials
    );
    return result.project.pipelines;
  },
};

const getPipelineTool: Tool = {
  name: 'get_pipeline',
  description: 'Get detailed information about a specific pipeline including its jobs and status',
  requiresAuth: false,
  requiresWrite: false,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
  inputSchema: withUserAuth(z.object({
    projectPath: z.string().describe('Full path of the project (e.g., "group/project-name")'),
    iid: z.string().describe('Pipeline IID (internal ID visible in GitLab UI)'),
  })),
  handler: async (input, client, userConfig) => {
    const credentials = input.userCredentials ? validateUserConfig(input.userCredentials) : userConfig;
    const result = await client.getPipeline(input.projectPath, input.iid, credentials);
    return result.project.pipeline;
  },
};

const getPipelineJobsTool: Tool = {
  name: 'get_pipeline_jobs',
  description: 'List all jobs in a specific pipeline with their status, stage, and artifact information',
  requiresAuth: false,
  requiresWrite: false,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
  inputSchema: withUserAuth(z.object({
    projectPath: z.string().describe('Full path of the project (e.g., "group/project-name")'),
    pipelineIid: z.string().describe('Pipeline IID (internal ID visible in GitLab UI)'),
    first: z.number().min(1).max(100).default(20).describe('Number of jobs to retrieve'),
    after: z.string().optional().describe('Cursor for pagination (from pageInfo.endCursor)'),
  })),
  handler: async (input, client, userConfig) => {
    const credentials = input.userCredentials ? validateUserConfig(input.userCredentials) : userConfig;
    const result = await client.getPipelineJobs(
      input.projectPath,
      input.pipelineIid,
      input.first,
      input.after,
      credentials
    );
    return result.project.pipeline.jobs;
  },
};

const getJobTool: Tool = {
  name: 'get_job',
  description: 'Get detailed information about a specific CI/CD job including status, duration, and logs',
  requiresAuth: false,
  requiresWrite: false,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
  inputSchema: withUserAuth(z.object({
    projectPath: z.string().describe('Full path of the project (e.g., "group/project-name")'),
    jobId: z.string().describe('Job ID (GraphQL global ID, format: "gid://gitlab/Ci::Build/123")'),
  })),
  handler: async (input, client, userConfig) => {
    const credentials = input.userCredentials ? validateUserConfig(input.userCredentials) : userConfig;
    const result = await client.getJob(input.projectPath, input.jobId, credentials);
    return result.project.job;
  },
};

const getJobArtifactsTool: Tool = {
  name: 'get_job_artifacts',
  description: 'List artifacts produced by a specific CI/CD job with file type and size information',
  requiresAuth: false,
  requiresWrite: false,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
  inputSchema: withUserAuth(z.object({
    projectPath: z.string().describe('Full path of the project (e.g., "group/project-name")'),
    jobId: z.string().describe('Job ID (GraphQL global ID, format: "gid://gitlab/Ci::Build/123")'),
  })),
  handler: async (input, client, userConfig) => {
    const credentials = input.userCredentials ? validateUserConfig(input.userCredentials) : userConfig;
    const result = await client.getJobArtifacts(input.projectPath, input.jobId, credentials);
    return result.project.job;
  },
};

const triggerPipelineTool: Tool = {
  name: 'trigger_pipeline',
  description: 'Trigger a new CI/CD pipeline on a specific branch, tag, or commit with optional variables',
  requiresAuth: true,
  requiresWrite: true,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
  inputSchema: withUserAuth(z.object({
    projectPath: z.string().describe('Full path of the project (e.g., "group/project-name")'),
    ref: z.string().describe('Git reference to run pipeline on (branch, tag, or commit SHA)'),
    variables: z.record(z.string()).optional().describe('Pipeline variables as key-value pairs (e.g., {"ENV": "production", "DEPLOY": "true"})'),
  }), false),
  handler: async (input, client, userConfig) => {
    const credentials = input.userCredentials ? validateUserConfig(input.userCredentials) : userConfig;
    if (!credentials) {
      throw new Error('User authentication is required for triggering pipelines. Please provide your GitLab credentials.');
    }
    const result = await client.triggerPipeline(
      input.projectPath,
      input.ref,
      input.variables,
      credentials
    );
    const mutationName = Object.keys(result)[0];
    const payload = result[mutationName];
    return payload.pipeline;
  },
};

const retryPipelineTool: Tool = {
  name: 'retry_pipeline',
  description: 'Retry a failed pipeline to re-run all failed jobs (idempotent - safe to retry)',
  requiresAuth: true,
  requiresWrite: true,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
  inputSchema: withUserAuth(z.object({
    projectPath: z.string().describe('Full path of the project (e.g., "group/project-name")'),
    pipelineId: z.string().describe('Pipeline ID (GraphQL global ID, format: "gid://gitlab/Ci::Pipeline/123")'),
  }), false),
  handler: async (input, client, userConfig) => {
    const credentials = input.userCredentials ? validateUserConfig(input.userCredentials) : userConfig;
    if (!credentials) {
      throw new Error('User authentication is required for retrying pipelines. Please provide your GitLab credentials.');
    }
    const result = await client.retryPipeline(input.projectPath, input.pipelineId, credentials);
    const mutationName = Object.keys(result)[0];
    const payload = result[mutationName];
    return payload.pipeline;
  },
};

const cancelPipelineTool: Tool = {
  name: 'cancel_pipeline',
  description: 'Cancel a running pipeline and all its jobs (destructive - cannot be undone)',
  requiresAuth: true,
  requiresWrite: true,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
  },
  inputSchema: withUserAuth(z.object({
    projectPath: z.string().describe('Full path of the project (e.g., "group/project-name")'),
    pipelineId: z.string().describe('Pipeline ID (GraphQL global ID, format: "gid://gitlab/Ci::Pipeline/123")'),
  }), false),
  handler: async (input, client, userConfig) => {
    const credentials = input.userCredentials ? validateUserConfig(input.userCredentials) : userConfig;
    if (!credentials) {
      throw new Error('User authentication is required for canceling pipelines. Please provide your GitLab credentials.');
    }
    const result = await client.cancelPipeline(input.projectPath, input.pipelineId, credentials);
    const mutationName = Object.keys(result)[0];
    const payload = result[mutationName];
    return payload.pipeline;
  },
};

const retryJobTool: Tool = {
  name: 'retry_job',
  description: 'Retry a failed or canceled CI/CD job (idempotent - safe to retry)',
  requiresAuth: true,
  requiresWrite: true,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
  inputSchema: withUserAuth(z.object({
    projectPath: z.string().describe('Full path of the project (e.g., "group/project-name")'),
    jobId: z.string().describe('Job ID (GraphQL global ID, format: "gid://gitlab/Ci::Build/123")'),
  }), false),
  handler: async (input, client, userConfig) => {
    const credentials = input.userCredentials ? validateUserConfig(input.userCredentials) : userConfig;
    if (!credentials) {
      throw new Error('User authentication is required for retrying jobs. Please provide your GitLab credentials.');
    }
    const result = await client.retryJob(input.projectPath, input.jobId, credentials);
    const mutationName = Object.keys(result)[0];
    const payload = result[mutationName];
    return payload.job;
  },
};

const cancelJobTool: Tool = {
  name: 'cancel_job',
  description: 'Cancel a running or pending CI/CD job (destructive - cannot be undone)',
  requiresAuth: true,
  requiresWrite: true,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
  },
  inputSchema: withUserAuth(z.object({
    projectPath: z.string().describe('Full path of the project (e.g., "group/project-name")'),
    jobId: z.string().describe('Job ID (GraphQL global ID, format: "gid://gitlab/Ci::Build/123")'),
  }), false),
  handler: async (input, client, userConfig) => {
    const credentials = input.userCredentials ? validateUserConfig(input.userCredentials) : userConfig;
    if (!credentials) {
      throw new Error('User authentication is required for canceling jobs. Please provide your GitLab credentials.');
    }
    const result = await client.cancelJob(input.projectPath, input.jobId, credentials);
    const mutationName = Object.keys(result)[0];
    const payload = result[mutationName];
    return payload.job;
  },
};

export const cicdTools: Tool[] = [
  getPipelinesTool,
  getPipelineTool,
  getPipelineJobsTool,
  getJobTool,
  getJobArtifactsTool,
  triggerPipelineTool,
  retryPipelineTool,
  cancelPipelineTool,
  retryJobTool,
  cancelJobTool,
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
  browseRepositoryTool,
  getFileContentTool,
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
  ...mergeRequestOperationsTools,
  ...cicdTools,
  ...searchTools,
];