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

  async getProjects(first: number = 20, after?: string, userConfig?: UserConfig): Promise<any> {
    const query = gql`
      query getProjects($first: Int!, $after: String) {
        projects(first: $first, after: $after) {
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
    return this.query(query, { first: Math.min(first, 50), after }, userConfig);
  }

  async getIssues(projectPath: string, first: number = 20, after?: string, userConfig?: UserConfig): Promise<any> {
    const query = gql`
      query getIssues($projectPath: ID!, $first: Int!, $after: String) {
        project(fullPath: $projectPath) {
          issues(first: $first, after: $after) {
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
    return this.query(query, { projectPath, first: Math.min(first, 50), after }, userConfig);
  }

  async getMergeRequests(projectPath: string, first: number = 20, after?: string, userConfig?: UserConfig): Promise<any> {
    const query = gql`
      query getMergeRequests($projectPath: ID!, $first: Int!, $after: String) {
        project(fullPath: $projectPath) {
          mergeRequests(first: $first, after: $after) {
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
    return this.query(query, { projectPath, first: Math.min(first, 50), after }, userConfig);
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

  async globalSearch(searchTerm?: string, scope?: string, userConfig?: UserConfig): Promise<any> {
    const query = gql`
      query globalSearch($search: String, $first: Int!) {
        projects(search: $search, first: $first) {
          nodes {
            id
            name
            fullPath
            webUrl
            visibility
          }
        }
        issues(search: $search, first: $first) {
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
      first: Math.min(this.config.maxPageSize, 25)
    }, userConfig);
  }

  async searchProjects(searchTerm: string, first: number = 20, after?: string, userConfig?: UserConfig): Promise<any> {
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
    
    return this.query(query, { search: searchTerm, first: Math.min(first, 50), after }, userConfig);
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
    userConfig?: UserConfig,
    assigneeUsernames?: string[],
    authorUsername?: string,
    labelNames?: string[]
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
        query searchIssuesProject($projectPath: ID!, $search: String, $state: ${stateEnum}, $first: Int!, $after: String, $assigneeUsernames: [String!], $authorUsername: String, $labelName: [String!]) {
          project(fullPath: $projectPath) {
            issues(search: $search, state: $state, first: $first, after: $after, assigneeUsernames: $assigneeUsernames, authorUsername: $authorUsername, labelName: $labelName) {
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
      return this.query(query, {
        projectPath,
        search: searchTerm,
        state: mapped,
        first,
        after,
        assigneeUsernames,
        authorUsername,
        labelName: labelNames
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
        query searchIssuesGlobal($search: String, $state: ${stateEnum}, $first: Int!, $after: String, $assigneeUsernames: [String!], $authorUsername: String, $labelName: [String!]) {
          issues(search: $search, state: $state, first: $first, after: $after, assigneeUsernames: $assigneeUsernames, authorUsername: $authorUsername, labelName: $labelName) {
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
      return this.query(query, {
        search: searchTerm,
        state: mapped,
        first, // Respect user's requested limit - no forced cap
        after,
        assigneeUsernames,
        authorUsername,
        labelName: labelNames
      }, userConfig);
    }
  }

  async searchMergeRequests(
    searchTerm: string,
    projectPath?: string,
    state?: string,
    first: number = 20,
    after?: string,
    userConfig?: UserConfig
  ): Promise<any> {
    const mappedState = state && state.toLowerCase() !== 'all' ? state.toUpperCase() : undefined;

    if (projectPath) {
      const query = gql`
        query searchMergeRequestsProject($projectPath: ID!, $search: String, $state: MergeRequestState, $first: Int!, $after: String) {
          project(fullPath: $projectPath) {
            mergeRequests(search: $search, state: $state, first: $first, after: $after) {
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
      return this.query(query, {
        projectPath,
        search: searchTerm,
        state: mappedState,
        first: Math.min(first, 50),
        after
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
          const result = await this.query(query, {
            username,
            first: Math.min(first, 50),
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

  async searchUsers(searchTerm: string, first: number = 20, userConfig?: UserConfig): Promise<any> {
    const query = gql`
      query searchUsers($search: String!, $first: Int!) {
        users(search: $search, first: $first) {
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
    
    return this.query(query, { search: searchTerm, first: Math.min(first, 50) }, userConfig);
  }

  async searchGroups(searchTerm: string, first: number = 20, userConfig?: UserConfig): Promise<any> {
    const query = gql`
      query searchGroups($search: String!, $first: Int!) {
        groups(search: $search, first: $first) {
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

    return this.query(query, { search: searchTerm, first: Math.min(first, 50) }, userConfig);
  }

  // ============================================================================
  // CI/CD Pipelines
  // ============================================================================

  async getPipelines(
    projectPath: string,
    status?: string,
    ref?: string,
    first: number = 20,
    after?: string,
    userConfig?: UserConfig
  ): Promise<any> {
    const query = gql`
      query getPipelines($projectPath: ID!, $status: PipelineStatusEnum, $ref: String, $first: Int!, $after: String) {
        project(fullPath: $projectPath) {
          pipelines(status: $status, ref: $ref, first: $first, after: $after) {
            pageInfo {
              hasNextPage
              hasPreviousPage
              startCursor
              endCursor
            }
            nodes {
              id
              iid
              status
              ref
              sha
              createdAt
              updatedAt
              startedAt
              finishedAt
              duration
              webUrl
              user {
                username
                name
              }
            }
          }
        }
      }
    `;

    return this.query(query, {
      projectPath,
      status: status?.toUpperCase(),
      ref,
      first: Math.min(first, 50),
      after
    }, userConfig);
  }

  async getPipeline(
    projectPath: string,
    iid: string,
    userConfig?: UserConfig
  ): Promise<any> {
    const query = gql`
      query getPipeline($projectPath: ID!, $iid: ID!) {
        project(fullPath: $projectPath) {
          pipeline(iid: $iid) {
            id
            iid
            status
            ref
            sha
            createdAt
            updatedAt
            startedAt
            finishedAt
            duration
            coverage
            webUrl
            user {
              username
              name
            }
            jobs {
              nodes {
                id
                name
                status
                stage
                createdAt
                startedAt
                finishedAt
                duration
                webUrl
              }
            }
          }
        }
      }
    `;

    return this.query(query, { projectPath, iid }, userConfig);
  }

  async getPipelineJobs(
    projectPath: string,
    pipelineIid: string,
    first: number = 20,
    after?: string,
    userConfig?: UserConfig
  ): Promise<any> {
    const query = gql`
      query getPipelineJobs($projectPath: ID!, $iid: ID!, $first: Int!, $after: String) {
        project(fullPath: $projectPath) {
          pipeline(iid: $iid) {
            jobs(first: $first, after: $after) {
              pageInfo {
                hasNextPage
                hasPreviousPage
                startCursor
                endCursor
              }
              nodes {
                id
                name
                status
                stage
                createdAt
                startedAt
                finishedAt
                duration
                coverage
                webUrl
                artifacts {
                  nodes {
                    fileType
                    size
                  }
                }
              }
            }
          }
        }
      }
    `;

    return this.query(query, {
      projectPath,
      iid: pipelineIid,
      first: Math.min(first, 50),
      after
    }, userConfig);
  }

  async getJob(
    projectPath: string,
    jobId: string,
    userConfig?: UserConfig
  ): Promise<any> {
    const query = gql`
      query getJob($projectPath: ID!, $jobId: JobID!) {
        project(fullPath: $projectPath) {
          job(id: $jobId) {
            id
            name
            status
            stage
            createdAt
            startedAt
            finishedAt
            duration
            coverage
            webUrl
            pipeline {
              id
              iid
              status
            }
            artifacts {
              nodes {
                fileType
                size
              }
            }
          }
        }
      }
    `;

    return this.query(query, { projectPath, jobId }, userConfig);
  }

  async getJobArtifacts(
    projectPath: string,
    jobId: string,
    userConfig?: UserConfig
  ): Promise<any> {
    const query = gql`
      query getJobArtifacts($projectPath: ID!, $jobId: JobID!) {
        project(fullPath: $projectPath) {
          job(id: $jobId) {
            id
            name
            artifacts {
              nodes {
                fileType
                size
              }
            }
          }
        }
      }
    `;

    return this.query(query, { projectPath, jobId }, userConfig);
  }

  async triggerPipeline(
    projectPath: string,
    ref: string,
    variables?: Record<string, string>,
    userConfig?: UserConfig
  ): Promise<any> {
    await this.introspectSchema(userConfig);
    const mutationType = this.schema?.getMutationType();
    const fields = mutationType ? mutationType.getFields() : {};

    // Check for mutation existence (pipelineCreate is the standard mutation name)
    const mutationName = fields['pipelineCreate'] ? 'pipelineCreate' :
                        (fields['createPipeline'] ? 'createPipeline' : null);

    if (!mutationName) {
      throw new Error('Pipeline trigger mutation not available on this GitLab instance. Requires GitLab 15.0+');
    }

    // Convert variables to array format if provided
    const variableInputs = variables ? Object.entries(variables).map(([key, value]) => ({
      key,
      value
    })) : [];

    const mutation = gql`
      mutation triggerPipeline($input: PipelineCreateInput!) {
        ${mutationName}(input: $input) {
          pipeline {
            id
            iid
            status
            ref
            sha
            webUrl
          }
          errors
        }
      }
    `;

    const input = {
      projectPath,
      ref,
      variables: variableInputs.length > 0 ? variableInputs : undefined
    };

    const result = await this.query(mutation, { input }, userConfig, true);
    const payload = (result as any)[mutationName];

    if (payload.errors && payload.errors.length > 0) {
      throw new Error(`Failed to trigger pipeline: ${payload.errors.join(', ')}`);
    }

    return { [mutationName]: payload };
  }

  async retryPipeline(
    projectPath: string,
    pipelineId: string,
    userConfig?: UserConfig
  ): Promise<any> {
    await this.introspectSchema(userConfig);
    const mutationType = this.schema?.getMutationType();
    const fields = mutationType ? mutationType.getFields() : {};

    const mutationName = fields['pipelineRetry'] ? 'pipelineRetry' :
                        (fields['retryPipeline'] ? 'retryPipeline' : null);

    if (!mutationName) {
      throw new Error('Pipeline retry mutation not available on this GitLab instance');
    }

    const mutation = gql`
      mutation retryPipeline($input: PipelineRetryInput!) {
        ${mutationName}(input: $input) {
          pipeline {
            id
            iid
            status
            webUrl
          }
          errors
        }
      }
    `;

    const input = { id: pipelineId };
    const result = await this.query(mutation, { input }, userConfig, true);
    const payload = (result as any)[mutationName];

    if (payload.errors && payload.errors.length > 0) {
      throw new Error(`Failed to retry pipeline: ${payload.errors.join(', ')}`);
    }

    return { [mutationName]: payload };
  }

  async cancelPipeline(
    projectPath: string,
    pipelineId: string,
    userConfig?: UserConfig
  ): Promise<any> {
    await this.introspectSchema(userConfig);
    const mutationType = this.schema?.getMutationType();
    const fields = mutationType ? mutationType.getFields() : {};

    const mutationName = fields['pipelineCancel'] ? 'pipelineCancel' :
                        (fields['cancelPipeline'] ? 'cancelPipeline' : null);

    if (!mutationName) {
      throw new Error('Pipeline cancel mutation not available on this GitLab instance');
    }

    const mutation = gql`
      mutation cancelPipeline($input: PipelineCancelInput!) {
        ${mutationName}(input: $input) {
          pipeline {
            id
            iid
            status
            webUrl
          }
          errors
        }
      }
    `;

    const input = { id: pipelineId };
    const result = await this.query(mutation, { input }, userConfig, true);
    const payload = (result as any)[mutationName];

    if (payload.errors && payload.errors.length > 0) {
      throw new Error(`Failed to cancel pipeline: ${payload.errors.join(', ')}`);
    }

    return { [mutationName]: payload };
  }

  async retryJob(
    projectPath: string,
    jobId: string,
    userConfig?: UserConfig
  ): Promise<any> {
    await this.introspectSchema(userConfig);
    const mutationType = this.schema?.getMutationType();
    const fields = mutationType ? mutationType.getFields() : {};

    const mutationName = fields['jobRetry'] ? 'jobRetry' :
                        (fields['retryJob'] ? 'retryJob' : null);

    if (!mutationName) {
      throw new Error('Job retry mutation not available on this GitLab instance');
    }

    const mutation = gql`
      mutation retryJob($input: JobRetryInput!) {
        ${mutationName}(input: $input) {
          job {
            id
            name
            status
            webUrl
          }
          errors
        }
      }
    `;

    const input = { id: jobId };
    const result = await this.query(mutation, { input }, userConfig, true);
    const payload = (result as any)[mutationName];

    if (payload.errors && payload.errors.length > 0) {
      throw new Error(`Failed to retry job: ${payload.errors.join(', ')}`);
    }

    return { [mutationName]: payload };
  }

  async cancelJob(
    projectPath: string,
    jobId: string,
    userConfig?: UserConfig
  ): Promise<any> {
    await this.introspectSchema(userConfig);
    const mutationType = this.schema?.getMutationType();
    const fields = mutationType ? mutationType.getFields() : {};

    const mutationName = fields['jobCancel'] ? 'jobCancel' :
                        (fields['cancelJob'] ? 'cancelJob' : null);

    if (!mutationName) {
      throw new Error('Job cancel mutation not available on this GitLab instance');
    }

    const mutation = gql`
      mutation cancelJob($input: JobCancelInput!) {
        ${mutationName}(input: $input) {
          job {
            id
            name
            status
            webUrl
          }
          errors
        }
      }
    `;

    const input = { id: jobId };
    const result = await this.query(mutation, { input }, userConfig, true);
    const payload = (result as any)[mutationName];

    if (payload.errors && payload.errors.length > 0) {
      throw new Error(`Failed to cancel job: ${payload.errors.join(', ')}`);
    }

    return { [mutationName]: payload };
  }

  // ============================================================================
  // Merge Request Operations
  // ============================================================================

  async getMergeRequestDiff(
    projectPath: string,
    iid: string,
    userConfig?: UserConfig
  ): Promise<any> {
    const query = gql`
      query getMergeRequestDiff($projectPath: ID!, $iid: String!) {
        project(fullPath: $projectPath) {
          mergeRequest(iid: $iid) {
            id
            iid
            title
            diffStatsSummary {
              additions
              deletions
              changes
              fileCount
            }
            diffRefs {
              baseSha
              headSha
              startSha
            }
            diffHeadSha
            conflicts
          }
        }
      }
    `;

    return this.query(query, { projectPath, iid }, userConfig);
  }

  async getMergeRequestApprovals(
    projectPath: string,
    iid: string,
    userConfig?: UserConfig
  ): Promise<any> {
    const query = gql`
      query getMergeRequestApprovals($projectPath: ID!, $iid: String!) {
        project(fullPath: $projectPath) {
          mergeRequest(iid: $iid) {
            id
            iid
            title
            approved
            approvalsLeft
            approvalsRequired
            approvedBy {
              nodes {
                id
                username
                name
                avatarUrl
              }
            }
          }
        }
      }
    `;

    return this.query(query, { projectPath, iid }, userConfig);
  }

  async getMergeRequestChanges(
    projectPath: string,
    iid: string,
    first: number = 20,
    after?: string,
    userConfig?: UserConfig
  ): Promise<any> {
    const query = gql`
      query getMergeRequestChanges($projectPath: ID!, $iid: String!, $first: Int!, $after: String) {
        project(fullPath: $projectPath) {
          mergeRequest(iid: $iid) {
            id
            iid
            title
            diffStatsSummary {
              additions
              deletions
              changes
              fileCount
            }
            commits(first: $first, after: $after) {
              pageInfo {
                hasNextPage
                hasPreviousPage
                startCursor
                endCursor
              }
              nodes {
                id
                sha
                shortId
                title
                message
                authorName
                authoredDate
              }
            }
          }
        }
      }
    `;

    return this.query(query, {
      projectPath,
      iid,
      first: Math.min(first, 50),
      after
    }, userConfig);
  }

  async approveMergeRequest(
    projectPath: string,
    iid: string,
    userConfig?: UserConfig
  ): Promise<any> {
    await this.introspectSchema(userConfig);
    const mutationType = this.schema?.getMutationType();
    const fields = mutationType ? mutationType.getFields() : {};

    const mutationName = fields['mergeRequestApprove'] ? 'mergeRequestApprove' :
                        (fields['approveMergeRequest'] ? 'approveMergeRequest' : null);

    if (!mutationName) {
      throw new Error('MR approval mutation not available on this GitLab instance');
    }

    // Get the MR ID first
    const mrQuery = gql`
      query getMRId($projectPath: ID!, $iid: String!) {
        project(fullPath: $projectPath) {
          mergeRequest(iid: $iid) {
            id
          }
        }
      }
    `;

    const mrResult = await this.query(mrQuery, { projectPath, iid }, userConfig);
    const mergeRequestId = mrResult.project.mergeRequest.id;

    const mutation = gql`
      mutation approveMergeRequest($input: MergeRequestApproveInput!) {
        ${mutationName}(input: $input) {
          mergeRequest {
            id
            iid
            approved
            approvalsLeft
            approvalsRequired
            approvedBy {
              nodes {
                username
                name
              }
            }
          }
          errors
        }
      }
    `;

    const input = { projectPath, iid };
    const result = await this.query(mutation, { input }, userConfig, true);
    const payload = (result as any)[mutationName];

    if (payload.errors && payload.errors.length > 0) {
      throw new Error(`Failed to approve merge request: ${payload.errors.join(', ')}`);
    }

    return { [mutationName]: payload };
  }

  async unapproveMergeRequest(
    projectPath: string,
    iid: string,
    userConfig?: UserConfig
  ): Promise<any> {
    await this.introspectSchema(userConfig);
    const mutationType = this.schema?.getMutationType();
    const fields = mutationType ? mutationType.getFields() : {};

    const mutationName = fields['mergeRequestUnapprove'] ? 'mergeRequestUnapprove' :
                        (fields['unapproveMergeRequest'] ? 'unapproveMergeRequest' : null);

    if (!mutationName) {
      throw new Error('MR unapproval mutation not available on this GitLab instance');
    }

    const mutation = gql`
      mutation unapproveMergeRequest($input: MergeRequestUnapproveInput!) {
        ${mutationName}(input: $input) {
          mergeRequest {
            id
            iid
            approved
            approvedBy {
              nodes {
                username
                name
              }
            }
          }
          errors
        }
      }
    `;

    const input = { projectPath, iid };
    const result = await this.query(mutation, { input }, userConfig, true);
    const payload = (result as any)[mutationName];

    if (payload.errors && payload.errors.length > 0) {
      throw new Error(`Failed to unapprove merge request: ${payload.errors.join(', ')}`);
    }

    return { [mutationName]: payload };
  }

  async mergeMergeRequest(
    projectPath: string,
    iid: string,
    strategy?: 'merge' | 'squash' | 'rebase_merge',
    deleteSourceBranch?: boolean,
    userConfig?: UserConfig
  ): Promise<any> {
    await this.introspectSchema(userConfig);
    const mutationType = this.schema?.getMutationType();
    const fields = mutationType ? mutationType.getFields() : {};

    const mutationName = fields['mergeRequestMerge'] ? 'mergeRequestMerge' :
                        (fields['mergeMergeRequest'] ? 'mergeMergeRequest' : null);

    if (!mutationName) {
      throw new Error('MR merge mutation not available on this GitLab instance');
    }

    const mutation = gql`
      mutation mergeMergeRequest($input: MergeRequestMergeInput!) {
        ${mutationName}(input: $input) {
          mergeRequest {
            id
            iid
            state
            mergedAt
            mergedBy {
              username
              name
            }
          }
          errors
        }
      }
    `;

    const input: any = { projectPath, iid };

    if (strategy === 'squash') {
      input.squash = true;
    }
    if (deleteSourceBranch !== undefined) {
      input.shouldRemoveSourceBranch = deleteSourceBranch;
    }

    const result = await this.query(mutation, { input }, userConfig, true);
    const payload = (result as any)[mutationName];

    if (payload.errors && payload.errors.length > 0) {
      throw new Error(`Failed to merge merge request: ${payload.errors.join(', ')}`);
    }

    return { [mutationName]: payload };
  }

  async rebaseMergeRequest(
    projectPath: string,
    iid: string,
    userConfig?: UserConfig
  ): Promise<any> {
    await this.introspectSchema(userConfig);
    const mutationType = this.schema?.getMutationType();
    const fields = mutationType ? mutationType.getFields() : {};

    const mutationName = fields['mergeRequestRebase'] ? 'mergeRequestRebase' :
                        (fields['rebaseMergeRequest'] ? 'rebaseMergeRequest' : null);

    if (!mutationName) {
      throw new Error('MR rebase mutation not available on this GitLab instance');
    }

    const mutation = gql`
      mutation rebaseMergeRequest($input: MergeRequestRebaseInput!) {
        ${mutationName}(input: $input) {
          mergeRequest {
            id
            iid
            rebaseInProgress
          }
          errors
        }
      }
    `;

    const input = { projectPath, iid };
    const result = await this.query(mutation, { input }, userConfig, true);
    const payload = (result as any)[mutationName];

    if (payload.errors && payload.errors.length > 0) {
      throw new Error(`Failed to rebase merge request: ${payload.errors.join(', ')}`);
    }

    return { [mutationName]: payload };
  }

  // ============================================================================
  // Comments & Discussions
  // ============================================================================

  async getIssueNotes(
    projectPath: string,
    iid: string,
    first: number = 20,
    after?: string,
    userConfig?: UserConfig
  ): Promise<any> {
    const query = gql`
      query getIssueNotes($projectPath: ID!, $iid: String!, $first: Int!, $after: String) {
        project(fullPath: $projectPath) {
          issue(iid: $iid) {
            id
            iid
            title
            notes(first: $first, after: $after) {
              pageInfo {
                hasNextPage
                hasPreviousPage
                startCursor
                endCursor
              }
              nodes {
                id
                body
                createdAt
                updatedAt
                system
                author {
                  id
                  username
                  name
                  avatarUrl
                }
              }
            }
          }
        }
      }
    `;

    return this.query(query, {
      projectPath,
      iid,
      first: Math.min(first, 50),
      after
    }, userConfig);
  }

  async getMergeRequestNotes(
    projectPath: string,
    iid: string,
    first: number = 20,
    after?: string,
    userConfig?: UserConfig
  ): Promise<any> {
    const query = gql`
      query getMergeRequestNotes($projectPath: ID!, $iid: String!, $first: Int!, $after: String) {
        project(fullPath: $projectPath) {
          mergeRequest(iid: $iid) {
            id
            iid
            title
            notes(first: $first, after: $after) {
              pageInfo {
                hasNextPage
                hasPreviousPage
                startCursor
                endCursor
              }
              nodes {
                id
                body
                createdAt
                updatedAt
                system
                author {
                  id
                  username
                  name
                  avatarUrl
                }
              }
            }
          }
        }
      }
    `;

    return this.query(query, {
      projectPath,
      iid,
      first: Math.min(first, 50),
      after
    }, userConfig);
  }

  async getDiscussions(
    projectPath: string,
    iid: string,
    type: 'issue' | 'merge_request',
    first: number = 20,
    after?: string,
    userConfig?: UserConfig
  ): Promise<any> {
    const resourceType = type === 'issue' ? 'issue' : 'mergeRequest';

    const query = gql`
      query getDiscussions($projectPath: ID!, $iid: String!, $first: Int!, $after: String) {
        project(fullPath: $projectPath) {
          ${resourceType}(iid: $iid) {
            id
            iid
            discussions(first: $first, after: $after) {
              pageInfo {
                hasNextPage
                hasPreviousPage
                startCursor
                endCursor
              }
              nodes {
                id
                resolved
                notes {
                  nodes {
                    id
                    body
                    createdAt
                    system
                    author {
                      username
                      name
                      avatarUrl
                    }
                    position {
                      ... on DiffPosition {
                        filePath
                        oldLine
                        newLine
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;

    return this.query(query, {
      projectPath,
      iid,
      first: Math.min(first, 50),
      after
    }, userConfig);
  }

  async createIssueNote(
    projectPath: string,
    iid: string,
    body: string,
    userConfig?: UserConfig
  ): Promise<any> {
    await this.introspectSchema(userConfig);
    const mutationType = this.schema?.getMutationType();
    const fields = mutationType ? mutationType.getFields() : {};

    const mutationName = fields['createNote'] ? 'createNote' : null;

    if (!mutationName) {
      throw new Error('Note creation mutation not available on this GitLab instance');
    }

    // Get issue ID first
    const issueQuery = gql`
      query getIssueId($projectPath: ID!, $iid: String!) {
        project(fullPath: $projectPath) {
          issue(iid: $iid) {
            id
          }
        }
      }
    `;

    const issueResult = await this.query(issueQuery, { projectPath, iid }, userConfig);
    const noteableId = issueResult.project.issue.id;

    const mutation = gql`
      mutation createIssueNote($input: CreateNoteInput!) {
        ${mutationName}(input: $input) {
          note {
            id
            body
            createdAt
            author {
              username
              name
            }
          }
          errors
        }
      }
    `;

    const input = { noteableId, body };
    const result = await this.query(mutation, { input }, userConfig, true);
    const payload = (result as any)[mutationName];

    if (payload.errors && payload.errors.length > 0) {
      throw new Error(`Failed to create note: ${payload.errors.join(', ')}`);
    }

    return { [mutationName]: payload };
  }

  async createMergeRequestNote(
    projectPath: string,
    iid: string,
    body: string,
    position?: { filePath: string; newLine: number; oldLine?: number },
    userConfig?: UserConfig
  ): Promise<any> {
    await this.introspectSchema(userConfig);
    const mutationType = this.schema?.getMutationType();
    const fields = mutationType ? mutationType.getFields() : {};

    const mutationName = position ?
      (fields['createDiffNote'] ? 'createDiffNote' : fields['createNote'] ? 'createNote' : null) :
      (fields['createNote'] ? 'createNote' : null);

    if (!mutationName) {
      throw new Error('Note creation mutation not available on this GitLab instance');
    }

    // Get MR ID first
    const mrQuery = gql`
      query getMRId($projectPath: ID!, $iid: String!) {
        project(fullPath: $projectPath) {
          mergeRequest(iid: $iid) {
            id
          }
        }
      }
    `;

    const mrResult = await this.query(mrQuery, { projectPath, iid }, userConfig);
    const noteableId = mrResult.project.mergeRequest.id;

    const mutation = gql`
      mutation createMergeRequestNote($input: CreateNoteInput!) {
        ${mutationName}(input: $input) {
          note {
            id
            body
            createdAt
            author {
              username
              name
            }
          }
          errors
        }
      }
    `;

    const input: any = { noteableId, body };
    if (position) {
      input.position = {
        filePath: position.filePath,
        newLine: position.newLine,
        oldLine: position.oldLine
      };
    }

    const result = await this.query(mutation, { input }, userConfig, true);
    const payload = (result as any)[mutationName];

    if (payload.errors && payload.errors.length > 0) {
      throw new Error(`Failed to create note: ${payload.errors.join(', ')}`);
    }

    return { [mutationName]: payload };
  }

  async updateNote(
    noteId: string,
    body: string,
    userConfig?: UserConfig
  ): Promise<any> {
    await this.introspectSchema(userConfig);
    const mutationType = this.schema?.getMutationType();
    const fields = mutationType ? mutationType.getFields() : {};

    const mutationName = fields['updateNote'] ? 'updateNote' : null;

    if (!mutationName) {
      throw new Error('Note update mutation not available on this GitLab instance');
    }

    const mutation = gql`
      mutation updateNote($input: UpdateNoteInput!) {
        ${mutationName}(input: $input) {
          note {
            id
            body
            updatedAt
          }
          errors
        }
      }
    `;

    const input = { id: noteId, body };
    const result = await this.query(mutation, { input }, userConfig, true);
    const payload = (result as any)[mutationName];

    if (payload.errors && payload.errors.length > 0) {
      throw new Error(`Failed to update note: ${payload.errors.join(', ')}`);
    }

    return { [mutationName]: payload };
  }

  async deleteNote(
    noteId: string,
    userConfig?: UserConfig
  ): Promise<any> {
    await this.introspectSchema(userConfig);
    const mutationType = this.schema?.getMutationType();
    const fields = mutationType ? mutationType.getFields() : {};

    const mutationName = fields['destroyNote'] ? 'destroyNote' :
                        (fields['deleteNote'] ? 'deleteNote' : null);

    if (!mutationName) {
      throw new Error('Note deletion mutation not available on this GitLab instance');
    }

    const mutation = gql`
      mutation deleteNote($input: DestroyNoteInput!) {
        ${mutationName}(input: $input) {
          note {
            id
          }
          errors
        }
      }
    `;

    const input = { id: noteId };
    const result = await this.query(mutation, { input }, userConfig, true);
    const payload = (result as any)[mutationName];

    if (payload.errors && payload.errors.length > 0) {
      throw new Error(`Failed to delete note: ${payload.errors.join(', ')}`);
    }

    return { [mutationName]: payload };
  }

  async resolveDiscussion(
    discussionId: string,
    resolved: boolean,
    userConfig?: UserConfig
  ): Promise<any> {
    await this.introspectSchema(userConfig);
    const mutationType = this.schema?.getMutationType();
    const fields = mutationType ? mutationType.getFields() : {};

    const mutationName = fields['discussionToggleResolve'] ? 'discussionToggleResolve' : null;

    if (!mutationName) {
      throw new Error('Discussion resolve mutation not available on this GitLab instance');
    }

    const mutation = gql`
      mutation resolveDiscussion($input: DiscussionToggleResolveInput!) {
        ${mutationName}(input: $input) {
          discussion {
            id
            resolved
          }
          errors
        }
      }
    `;

    const input = { id: discussionId, resolve: resolved };
    const result = await this.query(mutation, { input }, userConfig, true);
    const payload = (result as any)[mutationName];

    if (payload.errors && payload.errors.length > 0) {
      throw new Error(`Failed to resolve discussion: ${payload.errors.join(', ')}`);
    }

    return { [mutationName]: payload };
  }
}