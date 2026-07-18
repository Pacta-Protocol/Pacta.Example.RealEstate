'use strict';
// Bridge to the Pacta MCP server.
//
// This is the load-bearing integration of the whole example: the copilot's
// tool surface IS the protocol's MCP surface. `tools` carries the raw MCP
// descriptors; each LLM provider (src/llm.js) converts them to its own wire
// format mechanically. Nothing here knows what the tools do - add a tool to
// the protocol's MCP server and the agent gains it on next restart.
const path = require('node:path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { config } = require('./config');

async function connectPactaMcp({ marketplaceUrl = config.PACTA_URL, agentId = 1 } = {}) {
  const client = new Client({ name: 'landbridge-copilot', version: '0.1.0' });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [path.join(config.PACTA_DIR, 'mcp', 'server.js')],
    env: { ...process.env, MARKETPLACE_URL: marketplaceUrl, AGENT_ID: String(agentId) },
    stderr: 'ignore',
  }));
  const { tools } = await client.listTools();
  return {
    tools, // raw MCP descriptors: { name, description, inputSchema }
    // Returns { text, isError } - errors go back to the model as tool results
    // flagged as errors, so it can adapt (e.g. a vetting-gate 409).
    async call(name, args) {
      const res = await client.callTool({ name, arguments: args || {} });
      return { text: res.content?.[0]?.text ?? '', isError: Boolean(res.isError) };
    },
    close: () => client.close(),
  };
}

module.exports = { connectPactaMcp };
