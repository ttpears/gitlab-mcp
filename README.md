# GitLab MCP Server

A Model Context Protocol (MCP) server for GitLab that leverages GraphQL with automatic schema discovery and supports self-hosted GitLab instances. **Perfect for LLM-powered GitLab exploration and analysis.**

## ✨ **Key Features for LLMs**

- 🔍 **Comprehensive Search**: Global search across projects, issues, merge requests, users, and groups
- 📂 **Code Exploration**: Browse repository structure and read file contents
- 🤝 **Dual Authentication**: Shared read-only access + per-user authentication for write operations
- 🧠 **LLM-Optimized**: Tools designed specifically for AI analysis and exploration
- 🔄 **GraphQL Discovery**: Automatic schema introspection for dynamic capabilities

## Features

- **Search & Discovery**: Global search, project search, issue/MR search, code browsing
- **GraphQL-first approach** with automatic schema introspection
- **Self-hosted GitLab support** with configurable base URLs
- **Comprehensive GitLab operations** (projects, issues, merge requests)
- **Custom query execution** for advanced use cases
- **Docker & LibreChat integration** ready
- **Smithery install support** for easy deployment

## Installation

### 📁 **File Structure Note**
- **`Dockerfile`** - Standard Dockerfile (copy as `Dockerfile.mcp-gitlab` for LibreChat integration)
- **`smithery.yaml`** - Smithery.ai configuration with both stdio and Docker integration options

### Docker (Recommended for LibreChat)

1. **Copy Dockerfile to your LibreChat directory:**
```bash
# Copy and rename the Dockerfile for LibreChat integration
cp Dockerfile /path/to/librechat/Dockerfile.mcp-gitlab
```

2. **Add GitLab environment variables to your LibreChat `.env` file:**
```bash
# GitLab MCP Configuration
GITLAB_URL=https://gitlab.com
GITLAB_AUTH_MODE=hybrid
GITLAB_SHARED_ACCESS_TOKEN=your-optional-shared-token
GITLAB_MAX_PAGE_SIZE=50
GITLAB_TIMEOUT=30000
PORT=8008
MCP_TRANSPORT=http
```

3. **Add service to your LibreChat `docker-compose.override.yml`:**
```yaml
services:
  gitlab-mcp:
    build:
      context: .
      dockerfile: Dockerfile.mcp-gitlab
    env_file:
      - .env
    ports:
      - "8008:8008"
    networks:
      - librechat
    restart: unless-stopped
```

4. **Configure in your LibreChat `librechat.yml`:**
```yaml
mcpServers:
  gitlab:
    type: streamable-http
    url: "http://localhost:8008/message"
    customUserVars:
      GITLAB_ACCESS_TOKEN:
        title: "GitLab Personal Access Token"
        type: password
        required: false
```

5. **Restart LibreChat:**
```bash
docker compose down && docker compose -f docker-compose.yml -f docker-compose.override.yml up -d
```

### Smithery.ai (Recommended for Easy Installation)

1. **Visit [smithery.ai](https://smithery.ai)**
2. **Search for "gitlab-mcp-server"**
3. **Select the server** from search results
4. **Navigate to the "Auto" tab** and select "LibreChat"
5. **Copy and run** the generated installation command:
   ```bash
   # Example command (actual command from Smithery)
   npx @smithery/cli install gitlab-mcp-server
   ```
6. **Configure in your `librechat.yml`** (Smithery will provide the exact configuration):
   ```yaml
   mcpServers:
     gitlab:
       command: npx
       args: ["gitlab-mcp-server"]
       type: stdio
       env:
         GITLAB_URL: "https://gitlab.com"
         GITLAB_AUTH_MODE: "hybrid"
         GITLAB_SHARED_ACCESS_TOKEN: "${GITLAB_SHARED_ACCESS_TOKEN:-}"
       customUserVars:
         GITLAB_ACCESS_TOKEN:
           title: "GitLab Personal Access Token"
           description: "Your GitLab PAT with 'api' or 'read_api' scope"
           type: password
           required: false
   ```
7. **Restart LibreChat** to initialize the server connection

### Manual Installation

1. Clone and build:
```bash
git clone <repository-url>
cd gitlab-mcp
npm install
npm run build
```

2. Run the server:
```bash
GITLAB_URL=https://your-gitlab.com GITLAB_ACCESS_TOKEN=your-token npm start
```

## Configuration

### Authentication Modes

The server supports three authentication modes:

#### 1. **Hybrid Mode (Recommended)**
- **Shared token**: Optional read-only token for public operations
- **Per-user auth**: Users provide their own tokens for private data and write operations
- **Best for**: LibreChat deployments where you want to provide basic GitLab access but allow users to authenticate for full functionality

#### 2. **Per-User Only Mode**
- All operations require user authentication
- **Best for**: High-security environments where no shared credentials are allowed

#### 3. **Shared Only Mode**
- Uses only the shared token for all operations
- No per-user authentication supported
- **Best for**: Single-user or trusted environments

### Environment Variables

| Variable | Description | Default | Auth Mode |
|----------|-------------|---------|-----------|
| `GITLAB_URL` | GitLab instance URL | `https://gitlab.com` | All |
| `GITLAB_AUTH_MODE` | Authentication mode | `hybrid` | All |
| `GITLAB_SHARED_ACCESS_TOKEN` | Shared token for read operations | - | Shared/Hybrid |
| `GITLAB_MAX_PAGE_SIZE` | Maximum items per page (1-100) | `50` | All |
| `GITLAB_TIMEOUT` | Request timeout in milliseconds | `30000` | All |

### GitLab Access Token Setup

#### For Shared/System Tokens
1. Go to your GitLab instance → **User Settings** → **Access Tokens**
2. Create a new token with **read_api** scope (read-only access)
3. Set as `GITLAB_SHARED_ACCESS_TOKEN`

#### For User Tokens (LibreChat Integration)
Users will be prompted to provide their own tokens with:
- **api** scope (full access for write operations)
- **read_api** scope (read-only access)

LibreChat will handle user credential collection and management automatically.

## Available Tools

### 🔍 **Search & Discovery Tools (Perfect for LLMs)**
Comprehensive search capabilities across your GitLab instance:
- `search_gitlab` - Global search across projects, issues, and merge requests
- `search_projects` - Find repositories by name or description
- `search_issues` - Search issues globally or within specific projects
- `search_merge_requests` - Find merge requests and code changes
- `search_users` - Locate team members and contributors
- `search_groups` - Discover groups and organizations
- `browse_repository` - Explore codebase structure and files
- `get_file_content` - Read specific files for code analysis

### 🔓 Read-Only Operations (Optional Authentication)
Can use shared token if available, or user credentials for private data:
- `get_project` - Get detailed project information
- `get_issues` - List project issues with pagination  
- `get_merge_requests` - List project merge requests with pagination
- `execute_custom_query` - Run custom GraphQL queries
- `get_available_queries` - Discover available GraphQL operations

### 🔒 User Authentication Required
Always require user-provided credentials:
- `get_current_user` - Get authenticated user information
- `get_projects` - List accessible projects (includes private projects)

### ✏️ Write Operations (User Authentication Required)
Always require user credentials with write permissions:
- `create_issue` - Create new issues
- `create_merge_request` - Create new merge requests

### Authentication Behavior by Mode

| Tool | Shared Mode | Per-User Mode | Hybrid Mode |
|------|-------------|---------------|-------------|
| Read-only tools | Uses shared token | Requires user auth | Uses shared token, falls back to user auth |
| User auth tools | Uses shared token | Requires user auth | Requires user auth |
| Write tools | Uses shared token | Requires user auth | Requires user auth |

## Usage Examples

### 🔍 **Search & Discovery (Perfect for LLMs)**

```typescript
// Global search across everything - ideal for LLM exploration
await callTool('search_gitlab', { 
  searchTerm: 'authentication bug'
  // Searches projects, issues, and merge requests simultaneously
})

// Search for specific projects
await callTool('search_projects', { 
  searchTerm: 'api gateway',
  first: 10
})

// Find issues related to a topic (globally or in specific project)
await callTool('search_issues', { 
  searchTerm: 'login error',
  state: 'opened',
  projectPath: 'backend/auth-service' // Optional: limit to specific project
})

// Search merge requests for code changes
await callTool('search_merge_requests', { 
  searchTerm: 'database migration',
  state: 'merged',
  first: 20
})

// Find team members
await callTool('search_users', { 
  searchTerm: 'john smith'
})

// Explore codebase structure
await callTool('browse_repository', { 
  projectPath: 'frontend/web-app',
  path: 'src/components', // Browse specific directory
  ref: 'main'
})

// Get file content for analysis
await callTool('get_file_content', { 
  projectPath: 'backend/api',
  filePath: 'src/auth/login.js',
  ref: 'develop'
})
```

### Basic Project Information
```typescript
// Get public project info (uses shared token if available)
await callTool('get_project', { 
  fullPath: 'group/project' 
})

// Get project with user authentication (for private projects)
await callTool('get_project', { 
  fullPath: 'group/private-project',
  userCredentials: {
    accessToken: 'your-personal-access-token'
  }
})

// Get current user (always requires user auth)
await callTool('get_current_user', {
  userCredentials: {
    accessToken: 'your-personal-access-token'
  }
})
```

### Issues and Merge Requests
```typescript
// List issues (uses shared token if available)
await callTool('get_issues', { 
  projectPath: 'group/project',
  first: 20 
})

// Create an issue (requires user authentication)
await callTool('create_issue', {
  projectPath: 'group/project',
  title: 'New feature request',
  description: 'Detailed description...',
  userCredentials: {
    accessToken: 'your-personal-access-token'
  }
})
```

### 🤖 **LLM Use Cases & Examples**

Perfect for AI-powered GitLab analysis and automation:

```typescript
// "Find all recent authentication-related issues"
await callTool('search_issues', { 
  searchTerm: 'auth login password',
  state: 'opened'
})

// "Show me the structure of the payment processing service"
await callTool('browse_repository', { 
  projectPath: 'backend/payment-service',
  path: 'src'
})

// "What's in the main configuration file?"
await callTool('get_file_content', { 
  projectPath: 'infrastructure/config',
  filePath: 'production.yml'
})

// "Find all projects related to machine learning"
await callTool('search_projects', { 
  searchTerm: 'ml machine learning AI'
})

// "Who worked on the database migration?"
await callTool('search_merge_requests', { 
  searchTerm: 'database migration',
  state: 'merged'
})
```

### LibreChat Integration
When using with LibreChat, users will be prompted for their credentials automatically:

```typescript
// LibreChat handles authentication prompts
await callTool('create_merge_request', {
  projectPath: 'group/project',
  title: 'Feature: Add new functionality',
  sourceBranch: 'feature-branch',
  targetBranch: 'main',
  description: 'Implementation details...'
  // userCredentials automatically provided by LibreChat
})
```

### Advanced GraphQL Queries
```typescript
// Discover available operations
await callTool('get_available_queries', {})

// Execute custom query
await callTool('execute_custom_query', {
  query: `
    query GetProjectStatistics($path: ID!) {
      project(fullPath: $path) {
        statistics {
          commitCount
          storageSize
          repositorySize
        }
      }
    }
  `,
  variables: { path: 'group/project' }
})
```

## LibreChat Integration

The GitLab MCP server integrates with LibreChat using the same pattern as the BookStack MCP server.

### **Docker Integration (Recommended)**

1. **Copy the Dockerfile** to your LibreChat root directory
2. **Add GitLab environment variables** to your LibreChat `.env`
3. **Add the service** to your `docker-compose.override.yml`
4. **Configure the MCP server** in your `librechat.yml`
5. **Restart LibreChat** with the override file

### **Environment Variables**
Add these to your LibreChat `.env` file:
```bash
# GitLab MCP Server Configuration
GITLAB_URL=https://your-gitlab.com           # Your GitLab instance
GITLAB_AUTH_MODE=hybrid                       # Authentication mode
GITLAB_SHARED_ACCESS_TOKEN=                   # Optional shared token
PORT=8008                                     # Server port
MCP_TRANSPORT=http                            # Use HTTP transport
```

### **LibreChat Configuration**
The server runs on HTTP port 8008 and integrates via `streamable-http` transport:
```yaml
mcpServers:
  gitlab:
    type: streamable-http
    url: "http://localhost:8008/message"
    customUserVars:
      GITLAB_ACCESS_TOKEN:
        title: "GitLab Personal Access Token"
        type: password
        required: false
```

### **User Authentication Flow**
- **Read operations**: Use shared token (if configured) or prompt for user token
- **Write operations**: Always prompt for user Personal Access Token
- **Private data**: Requires user authentication for access
- **LibreChat handles**: Automatic credential prompts and management

## GraphQL Schema Discovery

The server automatically introspects the GitLab GraphQL schema on startup, enabling:

- **Dynamic query discovery** - Find available operations
- **Schema-aware querying** - Leverage full GitLab API capabilities
- **Future-proof design** - Automatically supports new GitLab features

## Self-Hosted GitLab Support

Works with any GitLab instance:
- **GitLab.com** (default)
- **GitLab CE/EE** self-hosted instances
- **GitLab SaaS** custom domains

Simply set `GITLAB_URL` to your instance URL.

## Error Handling

The server includes comprehensive error handling:
- **Authentication errors** - Clear token validation messages
- **Rate limiting** - Respects GitLab API limits
- **Network issues** - Timeout and retry logic
- **GraphQL errors** - Detailed query error reporting

## Security Considerations

### Authentication Security
- **Per-user tokens** are never stored or logged by the server
- **Shared tokens** are only used for read-only operations when configured
- **Credential isolation** - Each user's credentials are handled separately
- **Scope separation** - Shared tokens should only have `read_api` scope

### Token Management
- **Shared Token**: 
  - Should have minimal `read_api` scope only
  - Used for public/read-only operations
  - Stored as environment variable on server
- **User Tokens**:
  - Can have `api` scope for full functionality  
  - Provided by users through LibreChat interface
  - Never persisted by the MCP server
  - Automatically handled by LibreChat's authentication system

### Deployment Security
- **Container security** - Runs as non-root user
- **Network isolation** - Docker network segmentation supported
- **Environment variables** - Use Docker secrets or secure environment management
- **HTTPS required** - Always use HTTPS for GitLab connections

### Recommended Security Practices
1. **Use hybrid mode** for LibreChat deployments
2. **Limit shared token scope** to `read_api` only
3. **Enable user authentication** for all write operations
4. **Use Docker secrets** for shared token storage
5. **Monitor token usage** through GitLab audit logs
6. **Rotate tokens regularly** according to your security policy

## Troubleshooting

### Common Issues

1. **Authentication Failed**
   - Verify `GITLAB_ACCESS_TOKEN` is correct
   - Ensure token has `read_api` or `api` scope
   - Check token hasn't expired

2. **Connection Issues**
   - Verify `GITLAB_URL` is accessible
   - Check firewall/proxy settings
   - Confirm SSL certificates are valid

3. **Schema Introspection Failed**
   - Ensure GitLab instance supports GraphQL
   - Verify API endpoint is `/api/graphql`
   - Check GitLab version compatibility

### Debug Logging

Set `NODE_ENV=development` for detailed logging:
```bash
NODE_ENV=development GITLAB_URL=https://your-gitlab.com npm start
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Add tests for new functionality
4. Submit a pull request

## License

MIT License - see LICENSE file for details.