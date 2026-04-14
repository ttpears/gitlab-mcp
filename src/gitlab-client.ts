import { GraphQLClient, gql, ClientError } from 'graphql-request';
import { buildClientSchema, getIntrospectionQuery, IntrospectionQuery } from 'graphql';
import type { Config, UserConfig } from './config.js';

// GitLab-specific error types for better handling
export interface GitLabGraphQLError {
  message: string;
  locations?: Array<{ line: number; column: number }>;
  path?: string[];
  extensions?: {
    code?: string;
    spam?: boolean;
    needsCaptchaResponse?: boolean;
    problems?: Array<{ path: string[]; explanation: string }>;
  };
}

export class GitLabAPIError extends Error {
  public readonly code: string;
  public readonly statusCode?: number;
  public readonly isRetryable: boolean;
  public readonly isRateLimited: boolean;
  public readonly retryAfter?: number;
  public readonly originalError?: Error;

  constructor(
    message: string,
    options: {
      code?: string;
      statusCode?: number;
      isRetryable?: boolean;
      isRateLimited?: boolean;
      retryAfter?: number;
      originalError?: Error;
    } = {}
  ) {
    super(message);
    this.name = 'GitLabAPIError';
    this.code = options.code || 'UNKNOWN_ERROR';
    this.statusCode = options.statusCode;
    this.isRetryable = options.isRetryable ?? false;
    this.isRateLimited = options.isRateLimited ?? false;
    this.retryAfter = options.retryAfter;
    this.originalError = options.originalError;
  }
}

// Retry configuration
const RETRY_CONFIG = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 10000,
  retryableStatusCodes: [408, 429, 500, 502, 503, 504],
  retryableErrorCodes: ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN'],
};

export interface PageInfo {
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  startCursor: string | null;
  endCursor: string | null;
}

export interface PaginatedResult<T> {
  nodes: T[];
  totalFetched: number;
  hasMore: boolean;
  pageInfo: PageInfo;
}

export class GitLabGraphQLClient {
  private baseClient: GraphQLClient | null = null;
  private config: Config;
  private schema: any = null;
  private userClients: Map<string, GraphQLClient> = new Map();

  constructor(config: Config) {
    this.config = config;
    
    // Create base client for shared operations (if shared token provided)
    if (config.sharedAccessToken) {
      this.baseClient = this.createClient(config.gitlabUrl, config.sharedAccessToken);
    }
  }

  private createClient(gitlabUrl: string, accessToken: string): GraphQLClient {
    const endpoint = `${gitlabUrl.replace(/\/$/, '')}/api/graphql`;
    const timeoutMs = this.config.defaultTimeout || 30000;
    
    return new GraphQLClient(endpoint, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      // Configure fetch with timeout using AbortController
      fetch: (url, options) => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        
        return fetch(url, {
          ...options,
          signal: controller.signal,
        }).finally(() => clearTimeout(timeoutId));
      },
    });
  }

  /**
   * Parse GraphQL/HTTP errors into structured GitLabAPIError
   */
  private parseError(error: unknown): GitLabAPIError {
    // Handle ClientError from graphql-request (contains response details)
    if (error instanceof ClientError) {
      const response = error.response;
      const statusCode = response.status;
      const errors = response.errors as GitLabGraphQLError[] | undefined;
      
      if (statusCode === 429) {
        const headers = response.headers as Record<string, string> | undefined;
        const retryAfterHeader = headers?.['retry-after'] || '60';
        const retryAfter = parseInt(retryAfterHeader, 10);
        return new GitLabAPIError(
          `Rate limited by GitLab. Retry after ${retryAfter}s`,
          { code: 'RATE_LIMITED', statusCode, isRetryable: true, isRateLimited: true, retryAfter, originalError: error }
        );
      }

      // Check for authentication errors (401)
      if (statusCode === 401) {
        const message = errors?.[0]?.message || 'Invalid or expired token';
        return new GitLabAPIError(
          `Authentication failed: ${message}. Ensure your token has 'read_api' or 'api' scope.`,
          { code: 'AUTH_FAILED', statusCode, isRetryable: false, originalError: error }
        );
      }

      // Check for forbidden (403) - often scope issues
      if (statusCode === 403) {
        return new GitLabAPIError(
          'Access forbidden. Your token may lack required scopes (need read_api for queries, api for mutations).',
          { code: 'FORBIDDEN', statusCode, isRetryable: false, originalError: error }
        );
      }

      // Check for query complexity errors
      const complexityError = errors?.find(e => 
        e.message?.includes('complexity') || e.message?.includes('Query has complexity')
      );
      if (complexityError) {
        return new GitLabAPIError(
          `Query too complex: ${complexityError.message}. Try reducing the number of fields or pagination size.`,
          { code: 'COMPLEXITY_EXCEEDED', statusCode, isRetryable: false, originalError: error }
        );
      }

      // Check for timeout errors
      if (errors?.some(e => e.message?.includes('timeout') || e.message?.includes('Timeout'))) {
        return new GitLabAPIError(
          'Query timed out. Try reducing pagination size or query complexity.',
          { code: 'TIMEOUT', statusCode, isRetryable: true, originalError: error }
        );
      }

      // Check for server errors (5xx) - retryable
      if (statusCode >= 500) {
        return new GitLabAPIError(
          `GitLab server error (${statusCode}): ${errors?.[0]?.message || 'Internal server error'}`,
          { code: 'SERVER_ERROR', statusCode, isRetryable: true, originalError: error }
        );
      }

      // Generic GraphQL errors
      if (errors?.length) {
        const messages = errors.map(e => e.message).join('; ');
        return new GitLabAPIError(
          `GraphQL error: ${messages}`,
          { code: 'GRAPHQL_ERROR', statusCode, isRetryable: false, originalError: error }
        );
      }

      return new GitLabAPIError(
        `HTTP ${statusCode}: ${error.message}`,
        { code: 'HTTP_ERROR', statusCode, isRetryable: RETRY_CONFIG.retryableStatusCodes.includes(statusCode), originalError: error }
      );
    }

    // Handle abort/timeout errors
    if (error instanceof Error) {
      if (error.name === 'AbortError') {
        return new GitLabAPIError(
          'Request timed out. GitLab has a 30s server limit; try reducing query complexity.',
          { code: 'TIMEOUT', isRetryable: true, originalError: error }
        );
      }

      // Network errors
      const errorCode = (error as any).code;
      if (errorCode && RETRY_CONFIG.retryableErrorCodes.includes(errorCode)) {
        return new GitLabAPIError(
          `Network error: ${error.message}`,
          { code: errorCode, isRetryable: true, originalError: error }
        );
      }

      return new GitLabAPIError(
        error.message,
        { code: 'UNKNOWN_ERROR', isRetryable: false, originalError: error }
      );
    }

    return new GitLabAPIError(
      String(error),
      { code: 'UNKNOWN_ERROR', isRetryable: false }
    );
  }

  /**
   * Execute request with exponential backoff retry
   */
  private async executeWithRetry<T>(
    fn: () => Promise<T>,
    context: string = 'GraphQL query'
  ): Promise<T> {
    let lastError: GitLabAPIError | undefined;

    for (let attempt = 0; attempt <= RETRY_CONFIG.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = this.parseError(error);

        // Don't retry non-retryable errors
        if (!lastError.isRetryable) {
          throw lastError;
        }

        // Don't retry if we've exhausted attempts
        if (attempt >= RETRY_CONFIG.maxRetries) {
          throw new GitLabAPIError(
            `${context} failed after ${RETRY_CONFIG.maxRetries + 1} attempts: ${lastError.message}`,
            { ...lastError, code: 'MAX_RETRIES_EXCEEDED' }
          );
        }

        // Calculate delay with exponential backoff and jitter
        let delay: number;
        if (lastError.isRateLimited && lastError.retryAfter) {
          delay = lastError.retryAfter * 1000;
        } else {
          delay = Math.min(
            RETRY_CONFIG.baseDelayMs * Math.pow(2, attempt) + Math.random() * 1000,
            RETRY_CONFIG.maxDelayMs
          );
        }

        console.error(
          `[GitLab] ${context} failed (attempt ${attempt + 1}/${RETRY_CONFIG.maxRetries + 1}): ${lastError.code}. Retrying in ${Math.round(delay / 1000)}s...`
        );

        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    // TypeScript: should never reach here, but just in case
    throw lastError || new GitLabAPIError('Unknown error during retry');
  }

  private getUserClient(userConfig: UserConfig): GraphQLClient {
    const userKey = `${userConfig.gitlabUrl || this.config.gitlabUrl}:${userConfig.accessToken}`;
    
    if (!this.userClients.has(userKey)) {
      const client = this.createClient(
        userConfig.gitlabUrl || this.config.gitlabUrl,
        userConfig.accessToken
      );
      this.userClients.set(userKey, client);
    }
    
    return this.userClients.get(userKey)!;
  }

  private getClient(userConfig?: UserConfig, requiresWrite = false): GraphQLClient {
    // If user config provided, use user-specific client
    if (userConfig) {
      return this.getUserClient(userConfig);
    }
    
    // If write operation required, user must provide credentials
    if (requiresWrite) {
      throw new Error('Write operations require user authentication. Please provide your GitLab credentials.');
    }
    
    // For read operations, try shared client first
    if (this.baseClient && this.config.authMode !== 'per-user') {
      return this.baseClient;
    }
    
    // If no shared client and hybrid/per-user mode, require user auth
    if (this.config.authMode === 'per-user' || this.config.authMode === 'hybrid') {
      throw new Error('This operation requires user authentication. Please provide your GitLab credentials.');
    }
    
    throw new Error('No authentication configured. Please provide GitLab credentials or configure a shared access token.');
  }

  async introspectSchema(userConfig?: UserConfig): Promise<void> {
    if (this.schema) return;

    try {
      const client = this.getClient(userConfig);
      const introspectionResult = await client.request<IntrospectionQuery>(
        getIntrospectionQuery()
      );
      this.schema = buildClientSchema(introspectionResult);
    } catch (error) {
      throw new Error(`Failed to introspect GitLab GraphQL schema: ${error}`);
    }
  }

  async query<T = any>(query: string, variables?: any, userConfig?: UserConfig, requiresWrite = false): Promise<T> {
    const client = this.getClient(userConfig, requiresWrite);
    return this.executeWithRetry(
      () => client.request<T>(query, variables),
      'GraphQL query'
    );
  }

  async fetchAllPages<T = any>(
    query: string,
    variables: Record<string, any>,
    connectionPath: string,
    options: {
      maxItems?: number;
      pageSize?: number;
      userConfig?: UserConfig;
    } = {}
  ): Promise<PaginatedResult<T>> {
    const maxItems = options.maxItems ?? 100;
    const pageSize = Math.min(options.pageSize ?? 50, this.config.maxPageSize);
    const allNodes: T[] = [];
    let after: string | undefined = undefined;
    let lastPageInfo: PageInfo = { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null };

    while (allNodes.length < maxItems) {
      const remaining = maxItems - allNodes.length;
      const currentPageSize = Math.min(pageSize, remaining);

      const result = await this.query(query, { ...variables, first: currentPageSize, after }, options.userConfig);

      // Navigate to the connection using the dot-separated path
      const connection = connectionPath.split('.').reduce((obj: any, key: string) => obj?.[key], result);
      if (!connection || !connection.nodes) {
        break;
      }

      allNodes.push(...connection.nodes);
      lastPageInfo = connection.pageInfo || lastPageInfo;

      if (!lastPageInfo.hasNextPage || allNodes.length >= maxItems) {
        break;
      }

      after = lastPageInfo.endCursor ?? undefined;
    }

    return {
      nodes: allNodes,
      totalFetched: allNodes.length,
      hasMore: lastPageInfo.hasNextPage && allNodes.length >= maxItems,
      pageInfo: lastPageInfo,
    };
  }

  async getCurrentUser(userConfig?: UserConfig): Promise<any> {
    const query = gql`
      query getCurrentUser {
        currentUser {
          id
          username
          name
          avatarUrl
          webUrl
        }
      }
    `;
    return this.query(query, undefined, userConfig);
  }

  async getProject(fullPath: string, userConfig?: UserConfig): Promise<any> {
    const query = gql`
      query getProject($fullPath: ID!) {
        project(fullPath: $fullPath) {
          id
          name
          description
          fullPath
          webUrl
          createdAt
          updatedAt
          visibility
          repository {
            tree {
              lastCommit {
                sha
                message
                authoredDate
                authorName
              }
            }
          }
        }
      }
    `;
    return this.query(query, { fullPath }, userConfig);
  }

  async getProjects(first: number = 20, after?: string, fetchAll = false, userConfig?: UserConfig, sort?: string): Promise<any> {
    const query = gql`
      query getProjects($first: Int!, $after: String, $sort: String) {
        projects(first: $first, after: $after, sort: $sort) {
            pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
            nodes {
              id
              name
              fullPath
              webUrl
              visibility
              lastActivityAt
            }
          }
      }
    `;

    if (fetchAll) {
      return this.fetchAllPages(query, { sort }, 'projects', {
        maxItems: first,
        pageSize: this.config.maxPageSize,
        userConfig,
      });
    }

    return this.query(query, { first: Math.min(first, this.config.maxPageSize), after, sort }, userConfig);
  }

  async getIssues(projectPath: string, first: number = 20, after?: string, fetchAll = false, userConfig?: UserConfig, sort?: string): Promise<any> {
    const query = gql`
      query getIssues($projectPath: ID!, $first: Int!, $after: String, $sort: IssueSort) {
        project(fullPath: $projectPath) {
          issues(first: $first, after: $after, sort: $sort) {
            pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
            nodes {
              id
              iid
              title
              state
              createdAt
              updatedAt
              webUrl
              author { username name }
            }
          }
        }
      }
    `;

    if (fetchAll) {
      return this.fetchAllPages(query, { projectPath, sort: sort || 'UPDATED_DESC' }, 'project.issues', {
        maxItems: first,
        pageSize: this.config.maxPageSize,
        userConfig,
      });
    }

    return this.query(query, { projectPath, first: Math.min(first, this.config.maxPageSize), after, sort: sort || 'UPDATED_DESC' }, userConfig);
  }

  async getMergeRequests(projectPath: string, first: number = 20, after?: string, fetchAll = false, userConfig?: UserConfig, sort?: string): Promise<any> {
    const query = gql`
      query getMergeRequests($projectPath: ID!, $first: Int!, $after: String, $sort: MergeRequestSort) {
        project(fullPath: $projectPath) {
          mergeRequests(first: $first, after: $after, sort: $sort) {
            pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
            nodes {
              id
              iid
              title
              state
              createdAt
              updatedAt
              mergedAt
              webUrl
              sourceBranch
              targetBranch
              author { username name }
            }
          }
        }
      }
    `;

    if (fetchAll) {
      return this.fetchAllPages(query, { projectPath, sort: sort || 'UPDATED_DESC' }, 'project.mergeRequests', {
        maxItems: first,
        pageSize: this.config.maxPageSize,
        userConfig,
      });
    }

    return this.query(query, { projectPath, first: Math.min(first, this.config.maxPageSize), after, sort: sort || 'UPDATED_DESC' }, userConfig);
  }

  async getWorkItem(id: string, userConfig?: UserConfig): Promise<any> {
    const gid = id.startsWith('gid://') ? id : `gid://gitlab/WorkItem/${id}`;
    const query = gql`
      query getWorkItem($id: WorkItemID!) {
        workItem(id: $id) {
          id
          iid
          title
          state
          confidential
          createdAt
          updatedAt
          closedAt
          webUrl
          workItemType { id name iconName }
          author { username name }
          namespace { id fullPath }
          widgets {
            type
            ... on WorkItemWidgetDescription { description descriptionHtml }
            ... on WorkItemWidgetAssignees {
              assignees { nodes { username name webUrl } }
            }
            ... on WorkItemWidgetLabels {
              labels { nodes { id title color description } }
            }
            ... on WorkItemWidgetHierarchy {
              hasChildren
              hasParent
              parent { id iid title workItemType { name } webUrl }
              children {
                nodes { id iid title state workItemType { name } webUrl }
              }
            }
            ... on WorkItemWidgetMilestone {
              milestone { id title state dueDate webPath }
            }
            ... on WorkItemWidgetStartAndDueDate { startDate dueDate }
            ... on WorkItemWidgetNotes {
              discussions(first: 5) {
                nodes {
                  id
                  notes { nodes { id body author { username } createdAt } }
                }
              }
            }
          }
        }
      }
    `;
    return this.query(query, { id: gid }, userConfig);
  }

  async listWorkItems(
    fullPath: string,
    opts: {
      first?: number;
      after?: string;
      fetchAll?: boolean;
      types?: string[];
      state?: string;
      sort?: string;
    } = {},
    userConfig?: UserConfig
  ): Promise<any> {
    const { first = 20, after, fetchAll = false, types, state, sort = 'UPDATED_DESC' } = opts;
    const query = gql`
      query listWorkItems(
        $fullPath: ID!
        $first: Int!
        $after: String
        $types: [IssueType!]
        $state: IssuableState
        $sort: WorkItemSort
      ) {
        namespace(fullPath: $fullPath) {
          id
          fullPath
          workItems(first: $first, after: $after, types: $types, state: $state, sort: $sort) {
            pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
            nodes {
              id
              iid
              title
              state
              confidential
              createdAt
              updatedAt
              webUrl
              workItemType { name iconName }
              author { username name }
            }
          }
        }
      }
    `;

    const variables: Record<string, any> = { fullPath, types, state, sort };

    if (fetchAll) {
      return this.fetchAllPages(query, variables, 'namespace.workItems', {
        maxItems: first,
        pageSize: this.config.maxPageSize,
        userConfig,
      });
    }

    return this.query(
      query,
      { ...variables, first: Math.min(first, this.config.maxPageSize), after },
      userConfig
    );
  }

  async createIssue(projectPath: string, title: string, description?: string, userConfig?: UserConfig): Promise<any> {
    await this.introspectSchema(userConfig);
    const mutationType = this.schema?.getMutationType();
    const fields = mutationType ? mutationType.getFields() : {};

    const fieldName = fields['createIssue'] ? 'createIssue' : (fields['issueCreate'] ? 'issueCreate' : null);
    if (!fieldName) {
      throw new Error('Neither createIssue nor issueCreate mutation is available on this GitLab instance');
    }

    const hasCreateInput = !!this.schema.getType('CreateIssueInput');
    const hasLegacyInput = !!this.schema.getType('IssueCreateInput');
    const inputType = hasCreateInput ? 'CreateIssueInput' : (hasLegacyInput ? 'IssueCreateInput' : null);
    if (!inputType) {
      throw new Error('Neither CreateIssueInput nor IssueCreateInput input type is available on this GitLab instance');
    }

    const mutation = gql`
      mutation createIssue($input: ${inputType}!) {
        ${fieldName}(input: $input) {
          issue {
            id
            iid
            title
            description
            webUrl
            state
            createdAt
          }
          errors
        }
      }
    `;

    const input = {
      projectPath,
      title,
      description,
    };

    const result = await this.query(mutation, { input }, userConfig, true);
    // Normalize payload to { createIssue: ... }
    const payload = (result as any)[fieldName];
    return { createIssue: payload };
  }

  async createMergeRequest(
    projectPath: string, 
    title: string, 
    sourceBranch: string, 
    targetBranch: string,
    description?: string,
    userConfig?: UserConfig
  ): Promise<any> {
    await this.introspectSchema(userConfig);
    const mutationType = this.schema?.getMutationType();
    const fields = mutationType ? mutationType.getFields() : {};

    const fieldName = fields['createMergeRequest'] ? 'createMergeRequest' : (fields['mergeRequestCreate'] ? 'mergeRequestCreate' : null);
    if (!fieldName) {
      throw new Error('Neither createMergeRequest nor mergeRequestCreate mutation is available on this GitLab instance');
    }

    const hasCreateInput = !!this.schema.getType('CreateMergeRequestInput');
    const hasLegacyInput = !!this.schema.getType('MergeRequestCreateInput');
    const inputType = hasCreateInput ? 'CreateMergeRequestInput' : (hasLegacyInput ? 'MergeRequestCreateInput' : null);
    if (!inputType) {
      throw new Error('Neither CreateMergeRequestInput nor MergeRequestCreateInput input type is available on this GitLab instance');
    }

    const mutation = gql`
      mutation createMergeRequest($input: ${inputType}!) {
        ${fieldName}(input: $input) {
          mergeRequest {
            id
            iid
            title
            description
            webUrl
            state
            sourceBranch
            targetBranch
            createdAt
          }
          errors
        }
      }
    `;
    
    const input = {
      projectPath,
      title,
      sourceBranch,
      targetBranch,
      description,
    };
    
    const result = await this.query(mutation, { input }, userConfig, true);
    // Normalize payload to { createMergeRequest: ... }
    const payload = (result as any)[fieldName];
    return { createMergeRequest: payload };
  }

  getSchema() {
    return this.schema;
  }

  getAvailableQueries(): string[] {
    if (!this.schema) return [];
    
    const queryType = this.schema.getQueryType();
    if (!queryType) return [];
    
    return Object.keys(queryType.getFields());
  }

  getAvailableMutations(): string[] {
    if (!this.schema) return [];
    
    const mutationType = this.schema.getMutationType();
    if (!mutationType) return [];
    
    return Object.keys(mutationType.getFields());
  }

  // Helpers for updates
  async getIssueId(projectPath: string, iid: string, userConfig?: UserConfig): Promise<string> {
    const query = gql`
      query issueId($projectPath: ID!, $iid: String!) {
        project(fullPath: $projectPath) {
          issue(iid: $iid) { id }
        }
      }
    `;
    const result = await this.query(query, { projectPath, iid }, userConfig);
    const id = result?.project?.issue?.id;
    if (!id) throw new Error('Issue not found');
    return id;
  }

  async getUserIdsByUsernames(usernames: string[], userConfig?: UserConfig): Promise<Record<string, string>> {
    const ids: Record<string, string> = {};
    if (!usernames || usernames.length === 0) return ids;
    const query = gql`
      query users($search: String!, $first: Int!) {
        users(search: $search, first: $first) { nodes { id username } }
      }
    `;
    for (const name of usernames) {
      const res = await this.query(query, { search: name, first: 20 }, userConfig);
      const node = res?.users?.nodes?.find((u: any) => u.username === name);
      if (node?.id) ids[name] = node.id;
    }
    return ids;
  }

  async getLabelIds(projectPath: string, labelNames: string[], userConfig?: UserConfig): Promise<Record<string, string>> {
    const ids: Record<string, string> = {};
    if (!labelNames || labelNames.length === 0) return ids;
    const query = gql`
      query projLabels($projectPath: ID!, $search: String!, $first: Int!) {
        project(fullPath: $projectPath) {
          labels(search: $search, first: $first) { nodes { id title } }
        }
      }
    `;
    for (const title of labelNames) {
      const res = await this.query(query, { projectPath, search: title, first: 50 }, userConfig);
      const node = res?.project?.labels?.nodes?.find((l: any) => l.title === title);
      if (node?.id) ids[title] = node.id;
    }
    return ids;
  }

  async updateIssueComposite(
    projectPath: string,
    iid: string,
    options: {
      title?: string;
      description?: string;
      assigneeUsernames?: string[];
      labelNames?: string[];
      dueDate?: string;
    },
    userConfig?: UserConfig
  ): Promise<any> {
    await this.introspectSchema(userConfig);
    const mutationType = this.schema?.getMutationType();
    const fields = mutationType ? mutationType.getFields() : {};

    const issueId = await this.getIssueId(projectPath, iid, userConfig);
    const assigneeIdsMap = await this.getUserIdsByUsernames(options.assigneeUsernames || [], userConfig);
    const assigneeIds = Object.values(assigneeIdsMap);
    const labelIdsMap = await this.getLabelIds(projectPath, options.labelNames || [], userConfig);
    const labelIds = Object.values(labelIdsMap);

    const results: any = { iid, projectPath };

    // Title/description/dueDate via updateIssue if available
    if (fields['updateIssue']) {
      const mutation = gql`
        mutation UpdateIssue($input: UpdateIssueInput!) {
          updateIssue(input: $input) {
            issue { id iid title description dueDate webUrl updatedAt }
            errors
          }
        }
      `;
      const input: any = { projectPath, iid };
      if (options.title) input.title = options.title;
      if (options.description) input.description = options.description;
      if (options.dueDate) input.dueDate = options.dueDate;
      if (labelIds.length > 0) input.labelIds = labelIds;
      if (assigneeIds.length > 0) input.assigneeIds = assigneeIds;
      const res = await this.query(mutation, { input }, userConfig, true);
      results.updateIssue = res.updateIssue;
    } else {
      // Fallback to granular mutations if present
      if (assigneeIds.length > 0 && fields['issueSetAssignees']) {
        const mutation = gql`
          mutation SetAssignees($input: IssueSetAssigneesInput!) {
            issueSetAssignees(input: $input) { issue { id iid assignees { nodes { username } } } errors }
          }
        `;
        const res = await this.query(mutation, { input: { issueId, assigneeIds } }, userConfig, true);
        results.issueSetAssignees = res.issueSetAssignees;
      }
      if (labelIds.length > 0 && fields['issueSetLabels']) {
        const mutation = gql`
          mutation SetLabels($input: IssueSetLabelsInput!) {
            issueSetLabels(input: $input) { issue { id iid labels { nodes { title } } } errors }
          }
        `;
        const res = await this.query(mutation, { input: { issueId, labelIds } }, userConfig, true);
        results.issueSetLabels = res.issueSetLabels;
      }
      if (options.dueDate && fields['issueSetDueDate']) {
        const mutation = gql`
          mutation SetDueDate($input: IssueSetDueDateInput!) {
            issueSetDueDate(input: $input) { issue { id iid dueDate } errors }
          }
        `;
        const res = await this.query(mutation, { input: { issueId, dueDate: options.dueDate } }, userConfig, true);
        results.issueSetDueDate = res.issueSetDueDate;
      }
    }

    return results;
  }

  async getMergeRequestId(projectPath: string, iid: string, userConfig?: UserConfig): Promise<string> {
    const query = gql`
      query mrId($projectPath: ID!, $iid: String!) {
        project(fullPath: $projectPath) {
          mergeRequest(iid: $iid) { id }
        }
      }
    `;
    const result = await this.query(query, { projectPath, iid }, userConfig);
    const id = result?.project?.mergeRequest?.id;
    if (!id) throw new Error('Merge request not found');
    return id;
  }

  async updateMergeRequestComposite(
    projectPath: string,
    iid: string,
    options: {
      title?: string;
      description?: string;
      assigneeUsernames?: string[];
      reviewerUsernames?: string[];
      labelNames?: string[];
    },
    userConfig?: UserConfig
  ): Promise<any> {
    await this.introspectSchema(userConfig);
    const mutationType = this.schema?.getMutationType();
    const fields = mutationType ? mutationType.getFields() : {};

    const mrId = await this.getMergeRequestId(projectPath, iid, userConfig);
    const assigneeIdsMap = await this.getUserIdsByUsernames(options.assigneeUsernames || [], userConfig);
    const assigneeIds = Object.values(assigneeIdsMap);
    const reviewerIdsMap = await this.getUserIdsByUsernames(options.reviewerUsernames || [], userConfig);
    const reviewerIds = Object.values(reviewerIdsMap);
    const labelIdsMap = await this.getLabelIds(projectPath, options.labelNames || [], userConfig);
    const labelIds = Object.values(labelIdsMap);

    const results: any = { iid, projectPath };

    if (fields['updateMergeRequest']) {
      const mutation = gql`
        mutation UpdateMergeRequest($input: UpdateMergeRequestInput!) {
          updateMergeRequest(input: $input) {
            mergeRequest { id iid title description webUrl updatedAt labels { nodes { title } } assignees { nodes { username } } }
            errors
          }
        }
      `;
      const input: any = { projectPath, iid };
      if (options.title) input.title = options.title;
      if (options.description) input.description = options.description;
      if (labelIds.length > 0) input.labelIds = labelIds;
      if (assigneeIds.length > 0) input.assigneeIds = assigneeIds;
      const res = await this.query(mutation, { input }, userConfig, true);
      results.updateMergeRequest = res.updateMergeRequest;
    } else {
      if (assigneeIds.length > 0 && fields['mergeRequestSetAssignees']) {
        const mutation = gql`
          mutation SetMRAssignees($input: MergeRequestSetAssigneesInput!) {
            mergeRequestSetAssignees(input: $input) { mergeRequest { id iid assignees { nodes { username } } } errors }
          }
        `;
        const res = await this.query(mutation, { input: { mergeRequestId: mrId, assigneeIds } }, userConfig, true);
        results.mergeRequestSetAssignees = res.mergeRequestSetAssignees;
      }
      if (labelIds.length > 0 && fields['mergeRequestSetLabels']) {
        const mutation = gql`
          mutation SetMRLabels($input: MergeRequestSetLabelsInput!) {
            mergeRequestSetLabels(input: $input) { mergeRequest { id iid labels { nodes { title } } } errors }
          }
        `;
        const res = await this.query(mutation, { input: { mergeRequestId: mrId, labelIds } }, userConfig, true);
        results.mergeRequestSetLabels = res.mergeRequestSetLabels;
      }
      if (reviewerIds.length > 0 && fields['mergeRequestSetReviewers']) {
        const mutation = gql`
          mutation SetMRReviewers($input: MergeRequestSetReviewersInput!) {
            mergeRequestSetReviewers(input: $input) { mergeRequest { id iid reviewers { nodes { username } } } errors }
          }
        `;
        const res = await this.query(mutation, { input: { mergeRequestId: mrId, reviewerIds } }, userConfig, true);
        results.mergeRequestSetReviewers = res.mergeRequestSetReviewers;
      }
      if (options.title || options.description) {
        // Attempt legacy/update fallback if available
        const legacyName = fields['mergeRequestUpdate'] ? 'mergeRequestUpdate' : undefined;
        if (legacyName) {
          const mutation = gql`
            mutation LegacyMRUpdate($input: MergeRequestUpdateInput!) {
              mergeRequestUpdate(input: $input) { mergeRequest { id iid title description } errors }
            }
          `;
          const input: any = { mergeRequestId: mrId };
          if (options.title) input.title = options.title;
          if (options.description) input.description = options.description;
          const res = await this.query(mutation, { input }, userConfig, true);
          results.mergeRequestUpdate = res.mergeRequestUpdate;
        }
      }
    }

    return results;
  }

  getTypeFields(typeName: string): string[] {
    if (!this.schema) return [];
    const type = this.schema.getType(typeName);
    if (!type || typeof (type as any).getFields !== 'function') return [];
    const fields = (type as any).getFields();
    return Object.keys(fields);
  }

  async globalSearch(searchTerm?: string, first: number = 20, after?: string, userConfig?: UserConfig): Promise<any> {
    const query = gql`
      query globalSearch($search: String, $first: Int!, $after: String) {
        projects(search: $search, first: $first, after: $after) {
          pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
          nodes {
            id
            name
            fullPath
            webUrl
            visibility
          }
        }
        issues(search: $search, first: $first, after: $after) {
          pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
          nodes {
            id
            iid
            title
            state
            webUrl
            createdAt
          }
        }
      }
    `;

    return this.query(query, {
      search: searchTerm || undefined,
      first: Math.min(first, this.config.maxPageSize),
      after
    }, userConfig);
  }

  async globalSearchAll(searchTerm?: string, maxItems: number = 100, userConfig?: UserConfig): Promise<{
    projects: PaginatedResult<any>;
    issues: PaginatedResult<any>;
  }> {
    const projectsQuery = gql`
      query globalSearchProjects($search: String, $first: Int!, $after: String) {
        projects(search: $search, first: $first, after: $after) {
          pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
          nodes { id name fullPath webUrl visibility }
        }
      }
    `;
    const issuesQuery = gql`
      query globalSearchIssues($search: String, $first: Int!, $after: String) {
        issues(search: $search, first: $first, after: $after) {
          pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
          nodes { id iid title state webUrl createdAt }
        }
      }
    `;
    const [projects, issues] = await Promise.all([
      this.fetchAllPages(projectsQuery, { search: searchTerm || undefined }, 'projects', { maxItems, userConfig }),
      this.fetchAllPages(issuesQuery, { search: searchTerm || undefined }, 'issues', { maxItems, userConfig }),
    ]);
    return { projects, issues };
  }

  async searchProjects(searchTerm: string, first: number = 20, after?: string, fetchAll = false, userConfig?: UserConfig): Promise<any> {
    const query = gql`
      query searchProjects($search: String!, $first: Int!, $after: String) {
        projects(search: $search, first: $first, after: $after) {
          pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
          nodes {
            id
            name
            fullPath
            description
            webUrl
            visibility
            lastActivityAt
          }
        }
      }
    `;

    if (fetchAll) {
      return this.fetchAllPages(query, { search: searchTerm }, 'projects', {
        maxItems: first,
        pageSize: this.config.maxPageSize,
        userConfig,
      });
    }

    return this.query(query, { search: searchTerm, first: Math.min(first, this.config.maxPageSize), after }, userConfig);
  }

  private getTypeName(t: any): string | undefined {
    if (!t) return undefined;
    return t.name || (t.ofType ? this.getTypeName(t.ofType) : undefined);
  }

  private getEnumValues(enumTypeName: string | undefined): string[] {
    if (!enumTypeName || !this.schema) return [];
    const enumType = this.schema.getType(enumTypeName);
    const values = (enumType && typeof (enumType as any).getValues === 'function') ? (enumType as any).getValues() : [];
    return Array.isArray(values) ? values.map((v: any) => v.name) : [];
  }

  async searchIssues(
    searchTerm?: string,
    projectPath?: string,
    state?: string,
    first: number = 20,
    after?: string,
    fetchAll = false,
    userConfig?: UserConfig,
    assigneeUsernames?: string[],
    authorUsername?: string,
    labelNames?: string[],
    sort?: string
  ): Promise<any> {
    await this.introspectSchema(userConfig);
    const mappedState = state && state.toLowerCase() !== 'all' ? state.toUpperCase() : undefined;

    if (projectPath) {
      const projectType = this.schema.getType('Project');
      const projFields = projectType?.getFields?.() || {};
      const issuesField = projFields['issues'];
      const stateArgType = issuesField?.args?.find((a: any) => a.name === 'state')?.type;
      const stateEnum = this.getTypeName(stateArgType) || 'IssueState';
      const allowed = this.getEnumValues(stateEnum).map(v => String(v));
      const mapped = state
        ? (allowed.find(v => v.toLowerCase() === state.toLowerCase()) || undefined)
        : undefined;

      const query = gql`
        query searchIssuesProject($projectPath: ID!, $search: String, $state: ${stateEnum}, $first: Int!, $after: String, $assigneeUsernames: [String!], $authorUsername: String, $labelName: [String!], $sort: IssueSort) {
          project(fullPath: $projectPath) {
            issues(search: $search, state: $state, first: $first, after: $after, assigneeUsernames: $assigneeUsernames, authorUsername: $authorUsername, labelName: $labelName, sort: $sort) {
              pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
              nodes {
                id
                iid
                title
                state
                webUrl
                createdAt
                updatedAt
                author { username name }
                labels { nodes { title } }
              }
            }
          }
        }
      `;
      if (fetchAll) {
        return this.fetchAllPages(query, {
          projectPath,
          search: searchTerm,
          state: mapped,
          assigneeUsernames,
          authorUsername,
          labelName: labelNames,
          sort: sort || 'UPDATED_DESC'
        }, 'project.issues', {
          maxItems: first,
          pageSize: this.config.maxPageSize,
          userConfig,
        });
      }

      return this.query(query, {
        projectPath,
        search: searchTerm,
        state: mapped,
        first,
        after,
        assigneeUsernames,
        authorUsername,
        labelName: labelNames,
        sort: sort || 'UPDATED_DESC'
      }, userConfig);
    } else {
      const queryType = this.schema.getQueryType();
      const qFields = queryType?.getFields?.() || {};
      const issuesField = qFields['issues'];
      const stateArgType = issuesField?.args?.find((a: any) => a.name === 'state')?.type;
      const stateEnum = this.getTypeName(stateArgType) || (this.schema.getType('IssuableState') ? 'IssuableState' : 'IssueState');
      const allowed = this.getEnumValues(stateEnum).map(v => String(v));
      const mapped = state
        ? (allowed.find(v => v.toLowerCase() === state.toLowerCase()) || undefined)
        : undefined;

      // OPTIMIZATION: Reduce query complexity for global searches to prevent timeouts
      // According to GitLab best practices, avoid fetching deeply nested collections
      // We keep description for AI context but limit nested collections (assignees/labels)
      // Note: Global Issue type doesn't have 'project' field - only project-scoped queries do
      const query = gql`
        query searchIssuesGlobal($search: String, $state: ${stateEnum}, $first: Int!, $after: String, $assigneeUsernames: [String!], $authorUsername: String, $labelName: [String!], $sort: IssueSort) {
          issues(search: $search, state: $state, first: $first, after: $after, assigneeUsernames: $assigneeUsernames, authorUsername: $authorUsername, labelName: $labelName, sort: $sort) {
            pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
            nodes {
              id
              iid
              title
              description
              state
              webUrl
              createdAt
              updatedAt
              closedAt
              author { username name }
            }
          }
        }
      `;
      // Note: Global search returns streamlined fields (no assignees/labels/project) for performance.
      // For full details and project attribution, search within a specific project using projectPath.
      if (fetchAll) {
        return this.fetchAllPages(query, {
          search: searchTerm,
          state: mapped,
          assigneeUsernames,
          authorUsername,
          labelName: labelNames,
          sort: sort || 'UPDATED_DESC'
        }, 'issues', {
          maxItems: first,
          pageSize: this.config.maxPageSize,
          userConfig,
        });
      }

      return this.query(query, {
        search: searchTerm,
        state: mapped,
        first, // Respect user's requested limit - no forced cap
        after,
        assigneeUsernames,
        authorUsername,
        labelName: labelNames,
        sort: sort || 'UPDATED_DESC'
      }, userConfig);
    }
  }

  async searchMergeRequests(
    searchTerm: string,
    projectPath?: string,
    state?: string,
    first: number = 20,
    after?: string,
    fetchAll = false,
    userConfig?: UserConfig,
    sort?: string
  ): Promise<any> {
    const mappedState = state && state.toLowerCase() !== 'all' ? state.toUpperCase() : undefined;

    if (projectPath) {
      const query = gql`
        query searchMergeRequestsProject($projectPath: ID!, $search: String, $state: MergeRequestState, $first: Int!, $after: String, $sort: MergeRequestSort) {
          project(fullPath: $projectPath) {
            mergeRequests(search: $search, state: $state, first: $first, after: $after, sort: $sort) {
              pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
              nodes {
                id
                iid
                title
                state
                webUrl
                createdAt
                updatedAt
                mergedAt
                sourceBranch
                targetBranch
                author { username name }
              }
            }
          }
        }
      `;
      if (fetchAll) {
        return this.fetchAllPages(query, {
          projectPath,
          search: searchTerm,
          state: mappedState,
          sort: sort || 'UPDATED_DESC'
        }, 'project.mergeRequests', {
          maxItems: first,
          pageSize: this.config.maxPageSize,
          userConfig,
        });
      }

      return this.query(query, {
        projectPath,
        search: searchTerm,
        state: mappedState,
        first: Math.min(first, this.config.maxPageSize),
        after,
        sort: sort || 'UPDATED_DESC'
      }, userConfig);
    } else {
      // GitLab GraphQL API does NOT support global MR search at root level
      // Best approach: Try user-based search for username queries
      // Supports: "username", "author:username", "assignee:username"

      // Detect search type and extract username
      let username = searchTerm;
      let searchType: 'author' | 'assignee' = 'author'; // Default to author

      if (searchTerm.includes(':')) {
        const parts = searchTerm.split(':');
        if (parts[0] === 'author') {
          searchType = 'author';
          username = parts[1].trim();
        } else if (parts[0] === 'assignee') {
          searchType = 'assignee';
          username = parts[1].trim();
        }
      }

      const isValidUsername = /^[a-zA-Z0-9_-]+$/.test(username);
      if (isValidUsername) {
        const fieldName = searchType === 'author' ? 'authoredMergeRequests' : 'assignedMergeRequests';

        const query = gql`
          query searchUserMergeRequests($username: String!, $first: Int!, $after: String, $state: MergeRequestState) {
            user(username: $username) {
              ${fieldName}(first: $first, after: $after, state: $state) {
                pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
                nodes {
                  id
                  iid
                  title
                  state
                  webUrl
                  createdAt
                  updatedAt
                  mergedAt
                  sourceBranch
                  targetBranch
                  author { username name }
                  project { fullPath }
                }
              }
            }
          }
        `;

        try {
          if (fetchAll) {
            const connectionPath = `user.${fieldName}`;
            return this.fetchAllPages(query, {
              username,
              state: mappedState
            }, connectionPath, {
              maxItems: first,
              pageSize: this.config.maxPageSize,
              userConfig,
            });
          }

          const result = await this.query(query, {
            username,
            first: Math.min(first, this.config.maxPageSize),
            after,
            state: mappedState
          }, userConfig);

          if (result?.user?.[fieldName]) {
            return result.user[fieldName];
          }
        } catch (e) {
          if (e instanceof GitLabAPIError && !e.isRetryable) {
            throw e;
          }
        }
      }

      // If not a username search or user query failed, return helpful error
      return {
        pageInfo: { hasNextPage: false, hasPreviousPage: false },
        nodes: [],
        _note: `GitLab does not support global text searches for merge requests. Please either: (1) provide a projectPath for text search, or (2) search by username (e.g., "cdhanlon", "author:cdhanlon", "assignee:cdhanlon").`
      };
    }
  }

  async searchRepositoryFiles(
    projectPath: string, 
    path: string, 
    ref?: string, 
    userConfig?: UserConfig
  ): Promise<any> {
    const query = gql`
      query searchRepositoryFiles($projectPath: ID!, $path: String, $ref: String) {
        project(fullPath: $projectPath) {
          webUrl
          repository {
            tree(path: $path, ref: $ref, recursive: true) {
              blobs {
                nodes {
                  name
                  path
                  type
                  mode
                }
              }
              trees {
                nodes {
                  name
                  path
                  type
                }
              }
            }
          }
        }
      }
    `;
    
    return this.query(query, { 
      projectPath, 
      path: path || "", 
      ref: ref || "HEAD" 
    }, userConfig);
  }

  async resolvePath(fullPath: string, first: number = 20, after?: string, userConfig?: UserConfig): Promise<any> {
    const query = gql`
      query resolvePath($fullPath: ID!, $first: Int!, $after: String) {
        project: project(fullPath: $fullPath) {
          id
          name
          fullPath
          webUrl
          description
          visibility
        }
        group: group(fullPath: $fullPath) {
          id
          name
          fullPath
          webUrl
          description
          projects(first: $first, after: $after) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              id
              name
              fullPath
              webUrl
              visibility
              lastActivityAt
            }
          }
        }
      }
    `;
    return this.query(query, { fullPath, first, after }, userConfig);
  }

  async getGroup(fullPath: string, first: number = 20, after?: string, searchTerm?: string, userConfig?: UserConfig): Promise<any> {
    const query = gql`
      query getGroup($fullPath: ID!, $first: Int!, $after: String, $search: String) {
        group(fullPath: $fullPath) {
          id
          name
          fullPath
          webUrl
          description
          projects(first: $first, after: $after, search: $search) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              id
              name
              fullPath
              webUrl
              visibility
              lastActivityAt
            }
          }
        }
      }
    `;
    return this.query(query, { fullPath, first, after, search: searchTerm }, userConfig);
  }

  async getFileContent(
    projectPath: string, 
    filePath: string, 
    ref?: string, 
    userConfig?: UserConfig
  ): Promise<any> {
    const query = gql`
      query getFileContent($projectPath: ID!, $path: String!, $ref: String) {
        project(fullPath: $projectPath) {
          webUrl
          repository {
            blobs(paths: [$path], ref: $ref) {
              nodes {
                name
                path
                rawBlob
                size
                lfsOid
              }
            }
          }
        }
      }
    `;
    
    return this.query(query, { 
      projectPath, 
      path: filePath, 
      ref: ref || "HEAD" 
    }, userConfig);
  }

  async searchUsers(searchTerm: string, first: number = 20, after?: string, fetchAll = false, userConfig?: UserConfig): Promise<any> {
    const query = gql`
      query searchUsers($search: String!, $first: Int!, $after: String) {
        users(search: $search, first: $first, after: $after) {
          pageInfo {
            hasNextPage
            hasPreviousPage
            startCursor
            endCursor
          }
          nodes {
            id
            username
            name
            avatarUrl
            webUrl
            state
          }
        }
      }
    `;

    if (fetchAll) {
      return this.fetchAllPages(query, { search: searchTerm }, 'users', {
        maxItems: first,
        pageSize: this.config.maxPageSize,
        userConfig,
      });
    }

    return this.query(query, { search: searchTerm, first: Math.min(first, this.config.maxPageSize), after }, userConfig);
  }

  async searchGroups(searchTerm: string, first: number = 20, after?: string, fetchAll = false, userConfig?: UserConfig): Promise<any> {
    const query = gql`
      query searchGroups($search: String!, $first: Int!, $after: String) {
        groups(search: $search, first: $first, after: $after) {
          pageInfo {
            hasNextPage
            hasPreviousPage
            startCursor
            endCursor
          }
          nodes {
            id
            name
            fullName
            fullPath
            description
            webUrl
            visibility
          }
        }
      }
    `;

    if (fetchAll) {
      return this.fetchAllPages(query, { search: searchTerm }, 'groups', {
        maxItems: first,
        pageSize: this.config.maxPageSize,
        userConfig,
      });
    }

    return this.query(query, { search: searchTerm, first: Math.min(first, this.config.maxPageSize), after }, userConfig);
  }

  // ── CI/CD Pipelines ──────────────────────────────────────────────────

  async getMergeRequestPipelines(
    projectPath: string,
    iid: string,
    first: number = 20,
    after?: string,
    fetchAll = false,
    userConfig?: UserConfig
  ): Promise<any> {
    const query = gql`
      query getMergeRequestPipelines($projectPath: ID!, $iid: String!, $first: Int!, $after: String) {
        project(fullPath: $projectPath) {
          mergeRequest(iid: $iid) {
            pipelines(first: $first, after: $after) {
              pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
              nodes {
                id
                iid
                status
                duration
                createdAt
                finishedAt
                ref
                sha
                detailedStatus {
                  text
                  label
                  icon
                  group
                  detailsPath
                }
                stages {
                  nodes {
                    name
                    status
                    detailedStatus {
                      text
                      label
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;
    if (fetchAll) {
      return this.fetchAllPages(query, { projectPath, iid }, 'project.mergeRequest.pipelines', {
        maxItems: first,
        pageSize: this.config.maxPageSize,
        userConfig,
      });
    }

    return this.query(query, { projectPath, iid, first: Math.min(first, this.config.maxPageSize), after }, userConfig);
  }

  async getPipelineJobs(
    projectPath: string,
    pipelineIid: string,
    first: number = 20,
    after?: string,
    fetchAll = false,
    userConfig?: UserConfig
  ): Promise<any> {
    const query = gql`
      query getPipelineJobs($projectPath: ID!, $pipelineIid: ID!, $first: Int!, $after: String) {
        project(fullPath: $projectPath) {
          pipeline(iid: $pipelineIid) {
            id
            iid
            status
            jobs(first: $first, after: $after) {
              pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
              nodes {
                id
                name
                status
                stage {
                  name
                }
                duration
                queuedDuration
                createdAt
                startedAt
                finishedAt
                retryable
                cancelable
                webPath
                detailedStatus {
                  text
                  label
                  icon
                  group
                  detailsPath
                }
              }
            }
          }
        }
      }
    `;
    if (fetchAll) {
      return this.fetchAllPages(query, { projectPath, pipelineIid }, 'project.pipeline.jobs', {
        maxItems: first,
        pageSize: this.config.maxPageSize,
        userConfig,
      });
    }

    return this.query(query, { projectPath, pipelineIid, first: Math.min(first, this.config.maxPageSize), after }, userConfig);
  }

  async getPipelineId(projectPath: string, pipelineIid: string, userConfig?: UserConfig): Promise<string> {
    const query = gql`
      query pipelineId($projectPath: ID!, $pipelineIid: ID!) {
        project(fullPath: $projectPath) {
          pipeline(iid: $pipelineIid) { id }
        }
      }
    `;
    const result = await this.query(query, { projectPath, pipelineIid }, userConfig);
    const id = result?.project?.pipeline?.id;
    if (!id) throw new Error('Pipeline not found');
    return id;
  }

  async managePipeline(
    projectPath: string,
    pipelineIid: string,
    action: 'retry' | 'cancel',
    userConfig?: UserConfig
  ): Promise<any> {
    await this.introspectSchema(userConfig);
    const mutationType = this.schema?.getMutationType();
    const fields = mutationType ? mutationType.getFields() : {};

    const pipelineGlobalId = await this.getPipelineId(projectPath, pipelineIid, userConfig);

    if (action === 'retry') {
      const fieldName = fields['pipelineRetry'] ? 'pipelineRetry' : null;
      if (!fieldName) {
        throw new Error('pipelineRetry mutation is not available on this GitLab instance');
      }
      const mutation = gql`
        mutation retryPipeline($input: PipelineRetryInput!) {
          pipelineRetry(input: $input) {
            pipeline { id iid status }
            errors
          }
        }
      `;
      const result = await this.query(mutation, { input: { id: pipelineGlobalId } }, userConfig, true);
      const payload = result.pipelineRetry;
      if (payload.errors && payload.errors.length > 0) {
        throw new Error(`Failed to retry pipeline: ${payload.errors.join(', ')}`);
      }
      return payload;
    } else {
      const fieldName = fields['pipelineCancel'] ? 'pipelineCancel' : null;
      if (!fieldName) {
        throw new Error('pipelineCancel mutation is not available on this GitLab instance');
      }
      const mutation = gql`
        mutation cancelPipeline($input: PipelineCancelInput!) {
          pipelineCancel(input: $input) {
            errors
          }
        }
      `;
      const result = await this.query(mutation, { input: { id: pipelineGlobalId } }, userConfig, true);
      const payload = result.pipelineCancel;
      if (payload.errors && payload.errors.length > 0) {
        throw new Error(`Failed to cancel pipeline: ${payload.errors.join(', ')}`);
      }
      return payload;
    }
  }

  // ── MR Diffs & Commits ───────────────────────────────────────────────

  async getMergeRequestDiffs(
    projectPath: string,
    iid: string,
    userConfig?: UserConfig
  ): Promise<any> {
    const query = gql`
      query getMergeRequestDiffs($projectPath: ID!, $iid: String!) {
        project(fullPath: $projectPath) {
          mergeRequest(iid: $iid) {
            diffStatsSummary {
              additions
              deletions
              fileCount
            }
            diffStats {
              path
              additions
              deletions
            }
            diffRefs {
              baseSha
              headSha
              startSha
            }
          }
        }
      }
    `;
    return this.query(query, { projectPath, iid }, userConfig);
  }

  async getMergeRequestCommits(
    projectPath: string,
    iid: string,
    first: number = 20,
    after?: string,
    fetchAll = false,
    userConfig?: UserConfig
  ): Promise<any> {
    const query = gql`
      query getMergeRequestCommits($projectPath: ID!, $iid: String!, $first: Int!, $after: String) {
        project(fullPath: $projectPath) {
          mergeRequest(iid: $iid) {
            commitCount
            commitsWithoutMergeCommits(first: $first, after: $after) {
              pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
              nodes {
                sha
                shortId
                title
                message
                authorName
                authoredDate
                webUrl
              }
            }
          }
        }
      }
    `;
    if (fetchAll) {
      return this.fetchAllPages(query, { projectPath, iid }, 'project.mergeRequest.commitsWithoutMergeCommits', {
        maxItems: first,
        pageSize: this.config.maxPageSize,
        userConfig,
      });
    }

    return this.query(query, { projectPath, iid, first: Math.min(first, this.config.maxPageSize), after }, userConfig);
  }

  // ── Work Item Notes ──────────────────────────────────────────────────

  async getNotes(
    projectPath: string,
    noteableType: 'issue' | 'merge_request',
    iid: string,
    first: number = 20,
    after?: string,
    fetchAll = false,
    userConfig?: UserConfig
  ): Promise<any> {
    if (noteableType === 'issue') {
      const query = gql`
        query getIssueNotes($projectPath: ID!, $iid: String!, $first: Int!, $after: String) {
          project(fullPath: $projectPath) {
            issue(iid: $iid) {
              notes(first: $first, after: $after) {
                pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
                nodes {
                  id
                  body
                  author { username name }
                  createdAt
                  updatedAt
                  system
                  internal
                  url
                }
              }
            }
          }
        }
      `;
      if (fetchAll) {
        return this.fetchAllPages(query, { projectPath, iid }, 'project.issue.notes', {
          maxItems: first,
          pageSize: this.config.maxPageSize,
          userConfig,
        });
      }

      return this.query(query, { projectPath, iid, first: Math.min(first, this.config.maxPageSize), after }, userConfig);
    } else {
      const query = gql`
        query getMergeRequestNotes($projectPath: ID!, $iid: String!, $first: Int!, $after: String) {
          project(fullPath: $projectPath) {
            mergeRequest(iid: $iid) {
              notes(first: $first, after: $after) {
                pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
                nodes {
                  id
                  body
                  author { username name }
                  createdAt
                  updatedAt
                  system
                  internal
                  url
                  position {
                    filePath
                    newLine
                    oldLine
                  }
                }
              }
            }
          }
        }
      `;
      if (fetchAll) {
        return this.fetchAllPages(query, { projectPath, iid }, 'project.mergeRequest.notes', {
          maxItems: first,
          pageSize: this.config.maxPageSize,
          userConfig,
        });
      }

      return this.query(query, { projectPath, iid, first: Math.min(first, this.config.maxPageSize), after }, userConfig);
    }
  }

  async createNote(
    projectPath: string,
    noteableType: 'issue' | 'merge_request',
    iid: string,
    body: string,
    internal: boolean = false,
    userConfig?: UserConfig
  ): Promise<any> {
    await this.introspectSchema(userConfig);
    const mutationType = this.schema?.getMutationType();
    const fields = mutationType ? mutationType.getFields() : {};

    const fieldName = fields['createNote'] ? 'createNote' : null;
    if (!fieldName) {
      throw new Error('createNote mutation is not available on this GitLab instance');
    }

    // Resolve the noteable IID to a global ID
    const noteableId = noteableType === 'issue'
      ? await this.getIssueId(projectPath, iid, userConfig)
      : await this.getMergeRequestId(projectPath, iid, userConfig);

    const mutation = gql`
      mutation createNote($input: CreateNoteInput!) {
        createNote(input: $input) {
          note {
            id
            body
            author { username name }
            createdAt
            url
            internal
          }
          errors
        }
      }
    `;

    const input: any = {
      noteableId,
      body,
    };
    if (internal) {
      input.internal = true;
    }

    const result = await this.query(mutation, { input }, userConfig, true);
    return result.createNote;
  }

  // ── Milestones ─────────────────────────────────────────────────────

  async listMilestones(
    fullPath: string,
    isProject: boolean,
    state?: string,
    search?: string,
    includeAncestors: boolean = false,
    first: number = 20,
    after?: string,
    fetchAll = false,
    userConfig?: UserConfig
  ): Promise<any> {
    const milestoneFields = `
      pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
      nodes {
        id
        iid
        title
        description
        state
        dueDate
        startDate
        expired
        upcoming
        webPath
        stats {
          totalIssuesCount
          closedIssuesCount
        }
        createdAt
        updatedAt
      }
    `;

    if (isProject) {
      const query = gql`
        query listProjectMilestones($fullPath: ID!, $state: MilestoneStateEnum, $searchTitle: String, $includeAncestors: Boolean, $first: Int!, $after: String) {
          project(fullPath: $fullPath) {
            milestones(state: $state, searchTitle: $searchTitle, includeAncestors: $includeAncestors, first: $first, after: $after) {
              ${milestoneFields}
            }
          }
        }
      `;
      if (fetchAll) {
        return this.fetchAllPages(query, {
          fullPath,
          state: state?.toLowerCase(),
          searchTitle: search,
          includeAncestors,
        }, 'project.milestones', {
          maxItems: first,
          pageSize: this.config.maxPageSize,
          userConfig,
        });
      }

      return this.query(query, {
        fullPath,
        state: state?.toLowerCase(),
        searchTitle: search,
        includeAncestors,
        first: Math.min(first, this.config.maxPageSize),
        after,
      }, userConfig);
    } else {
      const query = gql`
        query listGroupMilestones($fullPath: ID!, $state: MilestoneStateEnum, $searchTitle: String, $includeAncestors: Boolean, $first: Int!, $after: String) {
          group(fullPath: $fullPath) {
            milestones(state: $state, searchTitle: $searchTitle, includeAncestors: $includeAncestors, first: $first, after: $after) {
              ${milestoneFields}
            }
          }
        }
      `;
      if (fetchAll) {
        return this.fetchAllPages(query, {
          fullPath,
          state: state?.toLowerCase(),
          searchTitle: search,
          includeAncestors,
        }, 'group.milestones', {
          maxItems: first,
          pageSize: this.config.maxPageSize,
          userConfig,
        });
      }

      return this.query(query, {
        fullPath,
        state: state?.toLowerCase(),
        searchTitle: search,
        includeAncestors,
        first: Math.min(first, this.config.maxPageSize),
        after,
      }, userConfig);
    }
  }

  // ── Iterations ────────────────────────────────────────────────────

  async listIterations(
    groupPath: string,
    state?: string,
    first: number = 20,
    after?: string,
    fetchAll = false,
    userConfig?: UserConfig
  ): Promise<any> {
    const query = gql`
      query listIterations($groupPath: ID!, $state: IterationState, $first: Int!, $after: String) {
        group(fullPath: $groupPath) {
          iterations(state: $state, first: $first, after: $after) {
            pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
            nodes {
              id
              iid
              title
              description
              state
              startDate
              dueDate
              webUrl
              scopedPath
              iterationCadence {
                id
                title
                active
                durationInWeeks
              }
              createdAt
              updatedAt
            }
          }
        }
      }
    `;
    if (fetchAll) {
      return this.fetchAllPages(query, {
        groupPath,
        state: state?.toLowerCase(),
      }, 'group.iterations', {
        maxItems: first,
        pageSize: this.config.maxPageSize,
        userConfig,
      });
    }

    return this.query(query, {
      groupPath,
      state: state?.toLowerCase(),
      first: Math.min(first, this.config.maxPageSize),
      after,
    }, userConfig);
  }

  // ── Time Tracking ─────────────────────────────────────────────────

  async getTimeTracking(
    projectPath: string,
    resourceType: 'issue' | 'merge_request',
    iid: string,
    includeTimelogs: boolean = true,
    first: number = 20,
    after?: string,
    userConfig?: UserConfig
  ): Promise<any> {
    const timelogFields = includeTimelogs ? `
      timelogs(first: $first, after: $after) {
        pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
        nodes {
          id
          timeSpent
          summary
          spentAt
          user {
            username
            name
          }
        }
      }
    ` : '';

    if (resourceType === 'issue') {
      const query = gql`
        query getIssueTimeTracking($projectPath: ID!, $iid: String!, $first: Int!, $after: String) {
          project(fullPath: $projectPath) {
            issue(iid: $iid) {
              iid
              title
              webUrl
              timeEstimate
              totalTimeSpent
              humanTimeEstimate
              humanTotalTimeSpent
              ${timelogFields}
            }
          }
        }
      `;
      return this.query(query, { projectPath, iid, first: Math.min(first, this.config.maxPageSize), after }, userConfig);
    } else {
      const query = gql`
        query getMergeRequestTimeTracking($projectPath: ID!, $iid: String!, $first: Int!, $after: String) {
          project(fullPath: $projectPath) {
            mergeRequest(iid: $iid) {
              iid
              title
              webUrl
              timeEstimate
              totalTimeSpent
              humanTimeEstimate
              humanTotalTimeSpent
              ${timelogFields}
            }
          }
        }
      `;
      return this.query(query, { projectPath, iid, first: Math.min(first, this.config.maxPageSize), after }, userConfig);
    }
  }

  // ── MR Reviewers & Approvals ──────────────────────────────────────

  async getMergeRequestReviewers(
    projectPath: string,
    iid: string,
    userConfig?: UserConfig
  ): Promise<any> {
    const query = gql`
      query getMergeRequestReviewers($projectPath: ID!, $iid: String!) {
        project(fullPath: $projectPath) {
          mergeRequest(iid: $iid) {
            iid
            title
            webUrl
            state
            approved
            approvalsRequired
            approvalsLeft
            approvedBy {
              nodes {
                username
                name
                avatarUrl
                webUrl
              }
            }
            reviewers {
              nodes {
                username
                name
                avatarUrl
                webUrl
                mergeRequestInteraction {
                  reviewState
                  approved
                  reviewed
                }
              }
            }
          }
        }
      }
    `;
    return this.query(query, { projectPath, iid }, userConfig);
  }

  // ── Project Statistics ────────────────────────────────────────────

  async getProjectStatistics(
    projectPath: string,
    userConfig?: UserConfig
  ): Promise<any> {
    const query = gql`
      query getProjectStatistics($projectPath: ID!) {
        project(fullPath: $projectPath) {
          id
          name
          fullPath
          webUrl
          starCount
          forksCount
          openIssuesCount
          statistics {
            repositorySize
            lfsObjectsSize
            buildArtifactsSize
            packagesSize
            wikiSize
            snippetsSize
            uploadsSize
            containerRegistrySize
            commitCount
          }
          openMergeRequests: mergeRequests(state: opened) {
            count
          }
          lastPipeline: pipelines(first: 1) {
            nodes {
              id
              iid
              status
              createdAt
              finishedAt
              ref
              detailedStatus {
                text
                label
              }
            }
          }
          releaseCount: releases {
            count
          }
          languages {
            name
            share
            color
          }
        }
      }
    `;
    return this.query(query, { projectPath }, userConfig);
  }

  // ── Group Members ─────────────────────────────────────────────────

  async listGroupMembers(
    groupPath: string,
    search?: string,
    first: number = 20,
    after?: string,
    fetchAll = false,
    userConfig?: UserConfig
  ): Promise<any> {
    const query = gql`
      query listGroupMembers($groupPath: ID!, $search: String, $first: Int!, $after: String) {
        group(fullPath: $groupPath) {
          groupMembers(search: $search, first: $first, after: $after) {
            pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
            nodes {
              id
              accessLevel {
                stringValue
                integerValue
              }
              createdAt
              expiresAt
              user {
                username
                name
                avatarUrl
                webUrl
                state
              }
            }
          }
        }
      }
    `;
    if (fetchAll) {
      return this.fetchAllPages(query, {
        groupPath,
        search: search || undefined,
      }, 'group.groupMembers', {
        maxItems: first,
        pageSize: this.config.maxPageSize,
        userConfig,
      });
    }

    return this.query(query, {
      groupPath,
      search: search || undefined,
      first: Math.min(first, this.config.maxPageSize),
      after,
    }, userConfig);
  }

  // ── Label Search ─────────────────────────────────────────────────────

  async searchLabels(
    fullPath: string,
    isProject: boolean,
    search?: string,
    first: number = 20,
    after?: string,
    fetchAll = false,
    userConfig?: UserConfig
  ): Promise<any> {
    if (isProject) {
      const query = gql`
        query searchProjectLabels($fullPath: ID!, $search: String, $first: Int!, $after: String) {
          project(fullPath: $fullPath) {
            labels(searchTerm: $search, first: $first, after: $after) {
              pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
              nodes {
                id
                title
                description
                color
                textColor
                createdAt
                updatedAt
              }
            }
          }
        }
      `;
      if (fetchAll) {
        return this.fetchAllPages(query, { fullPath, search }, 'project.labels', {
          maxItems: first,
          pageSize: this.config.maxPageSize,
          userConfig,
        });
      }

      return this.query(query, { fullPath, search, first: Math.min(first, this.config.maxPageSize), after }, userConfig);
    } else {
      const query = gql`
        query searchGroupLabels($fullPath: ID!, $search: String, $first: Int!, $after: String) {
          group(fullPath: $fullPath) {
            labels(searchTerm: $search, first: $first, after: $after) {
              pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
              nodes {
                id
                title
                description
                color
                textColor
                createdAt
                updatedAt
              }
            }
          }
        }
      `;
      if (fetchAll) {
        return this.fetchAllPages(query, { fullPath, search }, 'group.labels', {
          maxItems: first,
          pageSize: this.config.maxPageSize,
          userConfig,
        });
      }

      return this.query(query, { fullPath, search, first: Math.min(first, this.config.maxPageSize), after }, userConfig);
    }
  }

  /**
   * Resolve the GitLab base URL and access token for a REST call, honoring
   * per-request user credentials and falling back to the shared token.
   */
  private resolveRestAuth(userConfig?: UserConfig, requiresWrite = false): { baseUrl: string; token: string } {
    if (userConfig) {
      return {
        baseUrl: userConfig.gitlabUrl || this.config.gitlabUrl,
        token: userConfig.accessToken,
      };
    }
    if (requiresWrite) {
      throw new Error('Write operations require user authentication. Please provide your GitLab credentials.');
    }
    if (this.config.sharedAccessToken && this.config.authMode !== 'per-user') {
      return { baseUrl: this.config.gitlabUrl, token: this.config.sharedAccessToken };
    }
    throw new Error('This operation requires user authentication. Please provide your GitLab credentials.');
  }

  /**
   * Perform a GitLab REST API v4 request. Used for endpoints not exposed via GraphQL
   * (e.g., broadcast messages).
   */
  private async restRequest<T = any>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    options: { body?: any; query?: Record<string, any>; userConfig?: UserConfig; requiresWrite?: boolean } = {}
  ): Promise<T> {
    const { baseUrl, token } = this.resolveRestAuth(options.userConfig, options.requiresWrite);
    const url = new URL(`${baseUrl.replace(/\/$/, '')}/api/v4${path}`);
    if (options.query) {
      for (const [k, v] of Object.entries(options.query)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      }
    }

    const timeoutMs = this.config.defaultTimeout || 30000;

    return this.executeWithRetry(async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(url.toString(), {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
          signal: controller.signal,
        });

        if (!response.ok) {
          const statusCode = response.status;
          let message = `${response.statusText}`;
          try {
            const errBody: any = await response.json();
            message = errBody?.message || errBody?.error || JSON.stringify(errBody);
          } catch {
            // non-JSON body
          }
          const retryable = RETRY_CONFIG.retryableStatusCodes.includes(statusCode);
          throw new GitLabAPIError(`GitLab REST ${method} ${path} failed (${statusCode}): ${message}`, {
            code: statusCode === 401 ? 'AUTH_FAILED' : statusCode === 403 ? 'FORBIDDEN' : 'HTTP_ERROR',
            statusCode,
            isRetryable: retryable,
          });
        }

        if (response.status === 204) return undefined as unknown as T;
        const text = await response.text();
        return (text ? JSON.parse(text) : undefined) as T;
      } finally {
        clearTimeout(timeoutId);
      }
    }, `REST ${method} ${path}`);
  }

  async listBroadcastMessages(page = 1, perPage = 20, userConfig?: UserConfig): Promise<any> {
    return this.restRequest('GET', '/broadcast_messages', {
      query: { page, per_page: Math.min(perPage, this.config.maxPageSize) },
      userConfig,
    });
  }

  async getBroadcastMessage(id: number, userConfig?: UserConfig): Promise<any> {
    return this.restRequest('GET', `/broadcast_messages/${id}`, { userConfig });
  }

  async createBroadcastMessage(input: {
    message: string;
    starts_at?: string;
    ends_at?: string;
    color?: string;
    font?: string;
    target_access_levels?: number[];
    target_path?: string;
    broadcast_type?: 'banner' | 'notification';
    dismissable?: boolean;
    theme?: string;
  }, userConfig?: UserConfig): Promise<any> {
    return this.restRequest('POST', '/broadcast_messages', { body: input, userConfig, requiresWrite: true });
  }

  async updateBroadcastMessage(id: number, input: {
    message?: string;
    starts_at?: string;
    ends_at?: string;
    color?: string;
    font?: string;
    target_access_levels?: number[];
    target_path?: string;
    broadcast_type?: 'banner' | 'notification';
    dismissable?: boolean;
    theme?: string;
  }, userConfig?: UserConfig): Promise<any> {
    return this.restRequest('PUT', `/broadcast_messages/${id}`, { body: input, userConfig, requiresWrite: true });
  }

  async deleteBroadcastMessage(id: number, userConfig?: UserConfig): Promise<any> {
    return this.restRequest('DELETE', `/broadcast_messages/${id}`, { userConfig, requiresWrite: true });
  }

  async listMyEvents(
    params: {
      action?: string;
      target_type?: string;
      before?: string;
      after?: string;
      scope?: 'all';
      sort?: 'asc' | 'desc';
      page?: number;
      per_page?: number;
    },
    userConfig?: UserConfig
  ): Promise<any> {
    return this.restRequest('GET', '/events', {
      query: {
        action: params.action,
        target_type: params.target_type,
        before: params.before,
        after: params.after,
        scope: params.scope,
        sort: params.sort,
        page: params.page ?? 1,
        per_page: Math.min(params.per_page ?? 20, this.config.maxPageSize),
      },
      userConfig,
    });
  }

  async listUserEvents(
    userIdOrUsername: string | number,
    params: {
      action?: string;
      target_type?: string;
      before?: string;
      after?: string;
      sort?: 'asc' | 'desc';
      page?: number;
      per_page?: number;
    },
    userConfig?: UserConfig
  ): Promise<any> {
    return this.restRequest('GET', `/users/${encodeURIComponent(String(userIdOrUsername))}/events`, {
      query: {
        action: params.action,
        target_type: params.target_type,
        before: params.before,
        after: params.after,
        sort: params.sort,
        page: params.page ?? 1,
        per_page: Math.min(params.per_page ?? 20, this.config.maxPageSize),
      },
      userConfig,
    });
  }

  async listProjectEvents(
    projectIdOrPath: string | number,
    params: {
      action?: string;
      target_type?: string;
      before?: string;
      after?: string;
      sort?: 'asc' | 'desc';
      page?: number;
      per_page?: number;
    },
    userConfig?: UserConfig
  ): Promise<any> {
    return this.restRequest('GET', `/projects/${encodeURIComponent(String(projectIdOrPath))}/events`, {
      query: {
        action: params.action,
        target_type: params.target_type,
        before: params.before,
        after: params.after,
        sort: params.sort,
        page: params.page ?? 1,
        per_page: Math.min(params.per_page ?? 20, this.config.maxPageSize),
      },
      userConfig,
    });
  }

  async listOpenMergeRequestsForReviewQueue(
    scope: { type: 'group' | 'project'; fullPath: string },
    opts: { maxItems?: number } = {},
    userConfig?: UserConfig,
  ): Promise<PaginatedResult<any>> {
    const maxItems = opts.maxItems ?? 1000;
    const groupQuery = gql`
      query reviewQueueGroup($fullPath: ID!, $first: Int!, $after: String) {
        group(fullPath: $fullPath) {
          mergeRequests(state: opened, sort: UPDATED_ASC, first: $first, after: $after) {
            pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
            nodes {
              iid
              title
              webUrl
              draft
              createdAt
              updatedAt
              author { username }
              reviewers { nodes { username } }
              project { fullPath }
            }
          }
        }
      }
    `;
    const projectQuery = gql`
      query reviewQueueProject($fullPath: ID!, $first: Int!, $after: String) {
        project(fullPath: $fullPath) {
          fullPath
          mergeRequests(state: opened, sort: UPDATED_ASC, first: $first, after: $after) {
            pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
            nodes {
              iid
              title
              webUrl
              draft
              createdAt
              updatedAt
              author { username }
              reviewers { nodes { username } }
            }
          }
        }
      }
    `;
    if (scope.type === 'group') {
      return this.fetchAllPages(
        groupQuery,
        { fullPath: scope.fullPath },
        'group.mergeRequests',
        { maxItems, pageSize: this.config.maxPageSize, userConfig },
      );
    }
    return this.fetchAllPages(
      projectQuery,
      { fullPath: scope.fullPath },
      'project.mergeRequests',
      { maxItems, pageSize: this.config.maxPageSize, userConfig },
    );
  }
}