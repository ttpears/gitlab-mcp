import { GraphQLClient, gql } from 'graphql-request';
import { buildClientSchema, getIntrospectionQuery, IntrospectionQuery } from 'graphql';
import type { Config, UserConfig } from './config.js';

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
    
    return new GraphQLClient(endpoint, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });
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
    try {
      const client = this.getClient(userConfig, requiresWrite);
      return await client.request<T>(query, variables);
    } catch (error) {
      throw new Error(`GraphQL query failed: ${error}`);
    }
  }

  async getCurrentUser(userConfig?: UserConfig): Promise<any> {
    const query = gql`
      query getCurrentUser {
        currentUser {
          id
          username
          name
          email
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
                author {
                  name
                  email
                }
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
            pageInfo {
              hasNextPage
              hasPreviousPage
              startCursor
              endCursor
            }
            nodes {
              id
              name
              description
              fullPath
              webUrl
              visibility
              createdAt
              updatedAt
              issuesEnabled
              mergeRequestsEnabled
            }
          }
      }
    `;
    return this.query(query, { first, after }, userConfig);
  }

  async getIssues(projectPath: string, first: number = 20, after?: string, userConfig?: UserConfig): Promise<any> {
    const query = gql`
      query getIssues($projectPath: ID!, $first: Int!, $after: String) {
        project(fullPath: $projectPath) {
          issues(first: $first, after: $after) {
            pageInfo {
              hasNextPage
              hasPreviousPage
              startCursor
              endCursor
            }
            nodes {
              id
              iid
              title
              description
              state
              createdAt
              updatedAt
              closedAt
              webUrl
              author {
                id
                username
                name
              }
              assignees {
                nodes {
                  id
                  username
                  name
                }
              }
              labels {
                nodes {
                  id
                  title
                  color
                  description
                }
              }
            }
          }
        }
      }
    `;
    return this.query(query, { projectPath, first, after }, userConfig);
  }

  async getMergeRequests(projectPath: string, first: number = 20, after?: string, userConfig?: UserConfig): Promise<any> {
    const query = gql`
      query getMergeRequests($projectPath: ID!, $first: Int!, $after: String) {
        project(fullPath: $projectPath) {
          mergeRequests(first: $first, after: $after) {
            pageInfo {
              hasNextPage
              hasPreviousPage
              startCursor
              endCursor
            }
            nodes {
              id
              iid
              title
              description
              state
              createdAt
              updatedAt
              mergedAt
              webUrl
              sourceBranch
              targetBranch
              author {
                id
                username
                name
              }
              assignees {
                nodes {
                  id
                  username
                  name
                }
              }
              reviewers {
                nodes {
                  id
                  username
                  name
                }
              }
              labels {
                nodes {
                  id
                  title
                  color
                  description
                }
              }
            }
          }
        }
      }
    `;
    return this.query(query, { projectPath, first, after }, userConfig);
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

  // Search methods
  async globalSearch(searchTerm?: string, scope?: string, userConfig?: UserConfig): Promise<any> {
    const query = gql`
      query globalSearch($search: String, $first: Int!) {
        projects(search: $search, first: $first) {
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
        issues(search: $search, first: $first) {
          nodes {
            id
            iid
            title
            description
            state
            webUrl
            createdAt
            updatedAt
            author {
              username
              name
            }
            project {
              fullPath
            }
          }
        }
        mergeRequests(search: $search, first: $first) {
          nodes {
            id
            iid
            title
            description
            state
            webUrl
            createdAt
            updatedAt
            author {
              username
              name
            }
            project {
              fullPath
            }
          }
        }
      }
    `;
    
    return this.query(query, { 
      search: searchTerm || undefined, 
      first: this.config.maxPageSize 
    }, userConfig);
  }

  async searchProjects(searchTerm: string, first: number = 20, after?: string, userConfig?: UserConfig): Promise<any> {
    const query = gql`
      query searchProjects($search: String!, $first: Int!, $after: String) {
        projects(search: $search, first: $first, after: $after) {
          pageInfo {
            hasNextPage
            hasPreviousPage
            startCursor
            endCursor
          }
          nodes {
            id
            name
            fullPath
            description
            webUrl
            visibility
            createdAt
            updatedAt
            lastActivityAt
            issuesEnabled
            mergeRequestsEnabled
            starCount
            forksCount
          }
        }
      }
    `;
    
    return this.query(query, { search: searchTerm, first, after }, userConfig);
  }

  private getTypeName(t: any): string | undefined {
    if (!t) return undefined;
    return t.name || (t.ofType ? this.getTypeName(t.ofType) : undefined);
  }

  async searchIssues(
    searchTerm: string, 
    projectPath?: string, 
    state?: string, 
    first: number = 20, 
    after?: string, 
    userConfig?: UserConfig
  ): Promise<any> {
    await this.introspectSchema(userConfig);
    const mappedState = state && state.toLowerCase() !== 'all' ? state.toUpperCase() : undefined;

    if (projectPath) {
      const projectType = this.schema.getType('Project');
      const projFields = projectType?.getFields?.() || {};
      const issuesField = projFields['issues'];
      const stateArgType = issuesField?.args?.find((a: any) => a.name === 'state')?.type;
      const stateEnum = this.getTypeName(stateArgType) || 'IssueState';

      const query = gql`
        query searchIssuesProject($projectPath: ID!, $search: String, $state: ${stateEnum}, $first: Int!, $after: String) {
          project(fullPath: $projectPath) {
            issues(search: $search, state: $state, first: $first, after: $after) {
              pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
              nodes {
                id iid title description state webUrl createdAt updatedAt closedAt
                author { id username name }
                assignees { nodes { username name } }
                labels { nodes { title color description } }
              }
            }
          }
        }
      `;
      return this.query(query, { projectPath, search: searchTerm, state: mappedState, first, after }, userConfig);
    } else {
      const queryType = this.schema.getQueryType();
      const qFields = queryType?.getFields?.() || {};
      const issuesField = qFields['issues'];
      const stateArgType = issuesField?.args?.find((a: any) => a.name === 'state')?.type;
      const stateEnum = this.getTypeName(stateArgType) || (this.schema.getType('IssuableState') ? 'IssuableState' : 'IssueState');

      const query = gql`
        query searchIssuesGlobal($search: String, $state: ${stateEnum}, $first: Int!, $after: String) {
          issues(search: $search, state: $state, first: $first, after: $after) {
            pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
            nodes {
              id iid title description state webUrl createdAt updatedAt closedAt
              author { id username name }
              assignees { nodes { username name } }
              labels { nodes { title color description } }
            }
          }
        }
      `;
      return this.query(query, { search: searchTerm, state: mappedState, first, after }, userConfig);
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
              pageInfo {
                hasNextPage
                hasPreviousPage
                startCursor
                endCursor
              }
              nodes {
                id
                iid
                title
                description
                state
                webUrl
                createdAt
                updatedAt
                mergedAt
                sourceBranch
                targetBranch
                author {
                  id
                  username
                  name
                }
                assignees {
                  nodes {
                    username
                    name
                  }
                }
                reviewers {
                  nodes {
                    username
                    name
                  }
                }
                labels {
                  nodes {
                    title
                    color
                    description
                  }
                }
              }
            }
          }
        }
      `;
      return this.query(query, { 
        projectPath, 
        search: searchTerm, 
        state: mappedState, 
        first, 
        after 
      }, userConfig);
    } else {
      const query = gql`
        query searchMergeRequestsGlobal($search: String, $state: MergeRequestState, $first: Int!, $after: String) {
          mergeRequests(search: $search, state: $state, first: $first, after: $after) {
            pageInfo {
              hasNextPage
              hasPreviousPage
              startCursor
              endCursor
            }
            nodes {
              id
              iid
              title
              description
              state
              webUrl
              createdAt
              updatedAt
              mergedAt
              sourceBranch
              targetBranch
              author {
                id
                username
                name
              }
              project {
                fullPath
                name
              }
              assignees {
                nodes {
                  username
                  name
                }
              }
              reviewers {
                nodes {
                  username
                  name
                }
              }
              labels {
                nodes {
                  title
                  color
                  description
                }
              }
            }
          }
        }
      `;
      return this.query(query, { 
        search: searchTerm, 
        state: mappedState, 
        first, 
        after 
      }, userConfig);
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
          repository {
            tree(path: $path, ref: $ref, recursive: true) {
              blobs {
                nodes {
                  name
                  path
                  type
                  mode
                  webUrl
                }
              }
              trees {
                nodes {
                  name
                  path
                  type
                  webUrl
                }
              }
            }
          }
        }
      }
    `;
    
    // Note: This searches file names. For content search, we'd need to use the search API
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
          repository {
            blobs(paths: [$path], ref: $ref) {
              nodes {
                name
                path
                rawBlob
                size
                webUrl
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
            email
            avatarUrl
            webUrl
            publicEmail
            location
            bio
          }
        }
      }
    `;
    
    return this.query(query, { search: searchTerm, first }, userConfig);
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
            avatarUrl
            createdAt
          }
        }
      }
    `;
    
    return this.query(query, { search: searchTerm, first }, userConfig);
  }
}