'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Load .env if present (Node 22 built-in; no dotenv dependency).
const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const ROOT = path.join(__dirname, '..');
const PACTA_DIR = path.resolve(ROOT, process.env.PACTA_DIR || '../../protocol');

// Which LLM drives the copilot. Two providers:
//   - 'openai':    any OpenAI-compatible endpoint (a local Ollama, vLLM,
//                  OpenRouter, ...) - selected whenever LLM_BASE_URL is set,
//                  or explicitly with LANDBRIDGE_PROVIDER=openai.
//   - 'anthropic': the Claude API - needs ANTHROPIC_API_KEY.
// Explicit LANDBRIDGE_PROVIDER wins; otherwise LLM_BASE_URL implies openai.
function resolveLlm() {
  const explicit = (process.env.LANDBRIDGE_PROVIDER || '').toLowerCase();
  const provider = explicit || (process.env.LLM_BASE_URL ? 'openai' : 'anthropic');
  return {
    provider,
    model: process.env.LANDBRIDGE_MODEL || (provider === 'openai' ? 'qwen3' : 'claude-opus-4-8'),
    baseUrl: process.env.LLM_BASE_URL || 'http://localhost:11434/v1',
    apiKey: process.env.LLM_API_KEY || '',
  };
}

const config = {
  ROOT,
  // The protocol clone this example builds on. Never modified - only consumed.
  PACTA_DIR,
  PACTA_PORT: Number(process.env.PACTA_PORT || 3240),
  get PACTA_URL() { return `http://127.0.0.1:${this.PACTA_PORT}`; },
  PORT: Number(process.env.PORT || 3300),
  DB_PATH: process.env.DB_PATH || path.join(ROOT, 'data', 'landbridge-demo.db'),
  LLM: resolveLlm(),
  SIM_STEP_DELAY_MS: Number(process.env.SIM_STEP_DELAY_MS || 1200),
  SIM_RULING_DELAY_MS: Number(process.env.SIM_RULING_DELAY_MS || 1500),
};

function requireLlmConfig() {
  if (config.LLM.provider === 'openai') return; // local endpoints need no key
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
      '\n  No LLM is configured. LandBridge runs on either:\n\n' +
      '  A fully local open-weights model (no key, no cloud):\n' +
      '    1. Install Ollama (https://ollama.com) and run: ollama pull qwen3\n' +
      '    2. In .env set LLM_BASE_URL=http://localhost:11434/v1 and LANDBRIDGE_MODEL=qwen3\n\n' +
      '  Or any OpenAI-compatible endpoint (vLLM, OpenRouter, ...):\n' +
      '    Set LLM_BASE_URL, LLM_API_KEY and LANDBRIDGE_MODEL in .env\n\n' +
      '  Or your own Claude API key:\n' +
      '    1. Get a key at https://console.anthropic.com\n' +
      '    2. cp .env.example .env\n' +
      '    3. Set ANTHROPIC_API_KEY=sk-ant-... in .env\n',
    );
    process.exit(1);
  }
}

function assertPactaDir() {
  const probe = path.join(PACTA_DIR, 'mcp', 'server.js');
  if (!fs.existsSync(probe)) {
    console.error(
      `\n  Pacta protocol clone not found at: ${PACTA_DIR}\n\n` +
      '  This example runs ON TOP of the protocol (no protocol code is copied).\n' +
      '    1. git clone https://github.com/Pacta-Protocol/Pacta.Protocol.git\n' +
      '    2. npm install inside it\n' +
      '    3. Point PACTA_DIR in .env at that clone\n',
    );
    process.exit(1);
  }
}

module.exports = { config, requireLlmConfig, assertPactaDir };
