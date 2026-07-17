'use strict';
// LandBridge web server. Three jobs:
//   1. serve the UI (public/)
//   2. run the copilot's agentic turns, streamed to the browser as SSE
//   3. proxy a read-only protocol snapshot so the UI's timeline shows what
//      the PROTOCOL says happened - never what the agent claims.
// The Anthropic key never leaves this process; the browser only talks here.
const express = require('express');
const path = require('node:path');
const { config, requireApiKey, assertPactaDir } = require('./src/config');
const { connectPactaMcp } = require('./src/mcp');
const { createAgent } = require('./src/agent');
const { PROPERTY } = require('./src/scenario');

requireApiKey();
assertPactaDir();

async function main() {
  const mcp = await connectPactaMcp();
  const agent = createAgent(mcp);
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, 'public')));

  const market = async (p) => (await fetch(`${config.PACTA_URL}/api${p}`)).json();

  app.get('/api/state', async (req, res) => {
    res.json({ property: PROPERTY, model: config.MODEL, marketplace_url: config.PACTA_URL });
  });

  // Protocol truth for the timeline panel: engagements (enriched with the
  // provider's category so the UI can map them to closing steps), ledger
  // transactions, and provider stakes/vetted flags.
  app.get('/api/market/summary', async (req, res) => {
    try {
      const [engagements, ledger, users, agentAcct] = await Promise.all([
        market('/engagements'), market('/ledger'), market('/users'), market('/agents/1'),
      ]);
      const byId = new Map(users.smbs.map((s) => [s.id, s]));
      res.json({
        engagements: engagements.map((e) => ({ ...e, smb: { ...e.smb, ...byId.get(e.smb.id) } })),
        transactions: ledger.transactions,
        invariant: ledger.invariant,
        smbs: users.smbs,
        agent_balance_cents: agentAcct.balance_cents,
      });
    } catch (err) {
      res.status(502).json({ error: `marketplace unreachable: ${err.message}` });
    }
  });

  // One agentic turn, streamed as SSE. One turn at a time - it's a demo, not
  // a multi-tenant product.
  let busy = false;
  app.post('/api/agent/message', async (req, res) => {
    const text = String(req.body?.text || '').trim();
    if (!text) return res.status(400).json({ error: 'missing text' });
    if (busy) return res.status(409).json({ error: 'the copilot is already working - wait for the current turn' });
    busy = true;

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
    try {
      await agent.runTurn(text, send);
    } catch (err) {
      send({ type: 'error', message: err.message });
    } finally {
      busy = false;
      res.end();
    }
  });

  app.post('/api/agent/reset', (req, res) => {
    if (busy) return res.status(409).json({ error: 'turn in progress' });
    agent.reset();
    res.json({ ok: true });
  });

  app.listen(config.PORT, () => {
    console.log(`[landbridge] up at http://localhost:${config.PORT} (marketplace: ${config.PACTA_URL}, model: ${config.MODEL})`);
  });
}

main().catch((err) => {
  console.error(`[landbridge] failed to start: ${err.message}`);
  process.exit(1);
});
