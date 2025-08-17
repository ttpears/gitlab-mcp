#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import * as http from 'http';
import { URL } from 'url';
import express from 'express';
import { zodToJsonSchema } from 'zod-to-json-schema';
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
  private gitlabClient!: GitLabGraphQLClient;
  private transports: Map<string, SSEServerTransport> = new Map();

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
          inputSchema: zodToJsonSchema(tool.inputSchema, { target: 'jsonSchema7' }),
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
      
      // Determine transport based on environment
      const port = process.env.GITLAB_MCP_PORT ? parseInt(process.env.GITLAB_MCP_PORT) : null;
      const useHttp = process.env.MCP_TRANSPORT === 'http' || port;
      
      if (useHttp && port) {
        // HTTP/SSE transport for LibreChat integration
        const app = express();
        
        app.use(express.json());
        app.use((req, res, next) => {
          res.header('Access-Control-Allow-Origin', '*');
          res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
          res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-session-id');
          if (req.method === 'OPTIONS') {
            res.sendStatus(200);
            return;
          }
          next();
        });

        app.get('/sse', async (req, res) => {
          try {
            console.error('New SSE connection request');
            
            const sessionId = req.query.sessionId as string;
            
            if (sessionId && this.transports.has(sessionId)) {
              console.error(`Session ${sessionId} already exists, closing connection`);
              res.status(409).send('Session already exists');
              return;
            }

            const transport = new SSEServerTransport('/message', res);
            this.transports.set(transport.sessionId, transport);

            console.error(`Created new session: ${transport.sessionId}`);

            transport.onclose = () => {
              console.error(`Session ${transport.sessionId} closed`);
              this.transports.delete(transport.sessionId);
            };

            await this.server.connect(transport);
            console.error(`Server connected for session: ${transport.sessionId}`);

          } catch (error) {
            console.error('Error in SSE endpoint:', error);
            if (!res.headersSent) {
              res.status(500).send('Internal server error');
            }
          }
        });

        app.post('/message', async (req, res) => {
          try {
            const url = new URL(req.url || '', `http://localhost:${port}`);
            const sessionId = url.searchParams.get('sessionId');
            
            if (!sessionId) {
              res.status(400).send('Missing session ID');
              return;
            }

            const transport = this.transports.get(sessionId);
            if (!transport) {
              res.status(404).send('Session not found');
              return;
            }

            await transport.handleMessage(req.body);
            res.sendStatus(200);

          } catch (error) {
            console.error('Error in message endpoint:', error);
            res.status(500).send('Internal server error');
          }
        });

        app.get('/health', (req, res) => {
          res.json({
            status: 'healthy',
            timestamp: new Date().toISOString(),
            activeSessions: this.transports.size
          });
        });

        app.listen(port, () => {
          console.error(`GitLab MCP Server running on HTTP port ${port}`);
          console.error(`SSE endpoint: http://localhost:${port}/sse`);
          console.error(`Message endpoint: http://localhost:${port}/message`);
          console.error(`Health check: http://localhost:${port}/health`);
        });
      } else {
        // Default to stdio transport
        const transport = new StdioServerTransport();
        await this.server.connect(transport);
        console.error('GitLab MCP Server running on stdio');
      }
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