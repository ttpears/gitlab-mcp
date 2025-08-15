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
          defaultBranch
          issuesEnabled
          mergeRequestsEnabled
          wikiEnabled
          snippetsEnabled
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
        currentUser {
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
              defaultBranch
              issuesEnabled
              mergeRequestsEnabled
            }
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
    const mutation = gql`
      mutation createIssue($input: IssueCreateInput!) {
        issueCreate(input: $input) {
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
    
    return this.query(mutation, { input }, userConfig, true);
  }

  async createMergeRequest(
    projectPath: string, 
    title: string, 
    sourceBranch: string, 
    targetBranch: string,
    description?: string,
    userConfig?: UserConfig
  ): Promise<any> {
    const mutation = gql`
      mutation createMergeRequest($input: MergeRequestCreateInput!) {
        mergeRequestCreate(input: $input) {
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
    
    return this.query(mutation, { input }, userConfig, true);
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

  // Search methods
  async globalSearch(searchTerm: string, scope?: string, userConfig?: UserConfig): Promise<any> {
    const query = gql`
      query globalSearch($search: String!, $first: Int!) {
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
      search: searchTerm, 
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
            defaultBranch
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

  async searchIssues(
    searchTerm: string, 
    projectPath?: string, 
    state?: string, 
    first: number = 20, 
    after?: string, 
    userConfig?: UserConfig
  ): Promise<any> {
    const query = gql`
      query searchIssues($search: String!, $projectPath: ID, $state: IssueState, $first: Int!, $after: String) {
        project(fullPath: $projectPath) @include(if: ${!!projectPath}) {
          issues(search: $search, state: $state, first: $first, after: $after) {
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
              closedAt
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
        issues(search: $search, state: $state, first: $first, after: $after) @skip(if: ${!!projectPath}) {
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
            closedAt
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
      projectPath, 
      state: state?.toUpperCase(), 
      first, 
      after 
    }, userConfig);
  }

  async searchMergeRequests(
    searchTerm: string, 
    projectPath?: string, 
    state?: string, 
    first: number = 20, 
    after?: string, 
    userConfig?: UserConfig
  ): Promise<any> {
    const query = gql`
      query searchMergeRequests($search: String!, $projectPath: ID, $state: MergeRequestState, $first: Int!, $after: String) {
        project(fullPath: $projectPath) @include(if: ${!!projectPath}) {
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
        mergeRequests(search: $search, state: $state, first: $first, after: $after) @skip(if: ${!!projectPath}) {
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
      projectPath, 
      state: state?.toUpperCase(), 
      first, 
      after 
    }, userConfig);
  }

  async searchRepositoryFiles(
    projectPath: string, 
    searchTerm: string, 
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
      path: "", 
      ref: ref || "HEAD" 
    }, userConfig);
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