#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { loadConfig } from './config.js';
import { GitLabGraphQLClient } from './gitlab-client.js';
import { tools } from './tools.js';

class GitLabMCPServer {
  private server: Server;
  private gitlabClient: GitLabGraphQLClient;

  constructor() {
    this.server = new Server(
      {
        name: 'gitlab-mcp-server',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupToolHandlers();
    this.setupErrorHandling();
  }

  private setupToolHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: tools.map(tool => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      
      const tool = tools.find(t => t.name === name);
      if (!tool) {
        throw new McpError(ErrorCode.MethodNotFound, `Tool ${name} not found`);
      }

      try {
        const validatedInput = tool.inputSchema.parse(args || {});
        // Extract user credentials if provided
        const userConfig = validatedInput.userCredentials;
        delete validatedInput.userCredentials; // Remove from input to avoid passing to handler
        
        const result = await tool.handler(validatedInput, this.gitlabClient, userConfig);
        
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        if (error instanceof Error) {
          throw new McpError(ErrorCode.InternalError, error.message);
        }
        throw new McpError(ErrorCode.InternalError, 'Unknown error occurred');
      }
    });
  }

  private setupErrorHandling(): void {
    this.server.onerror = (error) => {
      console.error('[MCP Error]', error);
    };

    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  async run(): Promise<void> {
    try {
      const config = loadConfig();
      this.gitlabClient = new GitLabGraphQLClient(config);
      
      // Try to introspect schema on startup if we have a shared token
      if (config.sharedAccessToken) {
        try {
          await this.gitlabClient.introspectSchema();
          console.error('GitLab GraphQL schema introspected successfully using shared token');
        } catch (error) {
          console.error('Warning: Failed to introspect schema with shared token:', error);
          console.error('Schema will be introspected when user credentials are provided');
        }
      } else {
        console.error('No shared access token provided. Schema will be introspected when user credentials are provided.');
      }
      
      const transport = new StdioServerTransport();
      await this.server.connect(transport);
      console.error('GitLab MCP Server running on stdio');
    } catch (error) {
      console.error('Failed to start server:', error);
      process.exit(1);
    }
  }
}

const server = new GitLabMCPServer();
server.run().catch((error) => {
  console.error('Server failed:', error);
  process.exit(1);
});