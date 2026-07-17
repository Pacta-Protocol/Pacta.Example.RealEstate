'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Load .env if present (Node 22 built-in; no dotenv dependency).
const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const ROOT = path.join(__dirname, '..');
const PACTA_DIR = path.resolve(ROOT, process.env.PACTA_DIR || '../../protocol');

const config = {
  ROOT,
  // The protocol clone this example builds on. Never modified - only consumed.
  PACTA_DIR,
  PACTA_PORT: Number(process.env.PACTA_PORT || 3240),
  get PACTA_URL() { return `http://127.0.0.1:${this.PACTA_PORT}`; },
  PORT: Number(process.env.PORT || 3300),
  DB_PATH: process.env.DB_PATH || path.join(ROOT, 'data', 'landbridge-demo.db'),
  MODEL: process.env.LANDBRIDGE_MODEL || 'claude-opus-4-8',
  SIM_STEP_DELAY_MS: Number(process.env.SIM_STEP_DELAY_MS || 1200),
  SIM_RULING_DELAY_MS: Number(process.env.SIM_RULING_DELAY_MS || 1500),
};

function requireApiKey() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
      '\n  ANTHROPIC_API_KEY is not set.\n\n' +
      '  LandBridge uses your own Claude API key (bring-your-own-key):\n' +
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

module.exports = { config, requireApiKey, assertPactaDir };
