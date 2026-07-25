/**
 * Calculator MCP Server
 * 
 * Main entry point for the MCP server.
 * Uses the @McpApp decorator pattern for clean, NestJS-style architecture.
 * 
 * Transport Configuration:
 * - Development (NODE_ENV=development): STDIO only
 * - Production (NODE_ENV=production): Dual transport (STDIO + HTTP SSE)
 */

import 'dotenv/config';
import { McpApplicationFactory } from '@nitrostack/core';
import { AppModule } from './app.module.js';

/**
 * Bootstrap the application
 */
async function bootstrap() {
  // Create and start the MCP server
  const server = await McpApplicationFactory.create(AppModule);
  
  const transportMode = process.env.TRANSPORT_MODE || 'dual';
  const port = parseInt(process.env.PORT || '3002');
  
  // @ts-expect-error - The dual transport guide uses this signature but typings expect 0 args
  await server.start(transportMode as any, {
    port,
    host: '0.0.0.0',
    basePath: '/mcp',
  });
}

// Start the application
bootstrap().catch((error) => {
  console.error('❌ Failed to start server:', error);
  process.exit(1);
});
