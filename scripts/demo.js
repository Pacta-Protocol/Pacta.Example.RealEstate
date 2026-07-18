'use strict';
// One-command demo: fresh seeded marketplace + provider/arbiter simulator +
// the LandBridge web app. Ctrl-C tears everything down.
const { spawn } = require('node:child_process');
const path = require('node:path');
const { config, requireLlmConfig, assertPactaDir } = require('../src/config');
const { seed } = require('./seed-demo');

requireLlmConfig();
assertPactaDir();

const children = [];
const prefix = (name, d) => d.toString().split('\n').filter((l) => l.trim()).map((l) => `[${name}] ${l}\n`).join('');
function launch(name, script, env = {}, cwd = path.join(__dirname, '..')) {
  const p = spawn(process.execPath, [script], { cwd, env: { ...process.env, ...env } });
  p.stdout.on('data', (d) => process.stdout.write(prefix(name, d)));
  p.stderr.on('data', (d) => process.stderr.write(prefix(name, d)));
  children.push(p);
  return p;
}
process.on('exit', () => children.forEach((p) => { try { p.kill(); } catch { /* gone */ } }));
process.on('SIGINT', () => process.exit(130));

async function waitFor(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { const r = await fetch(url); if (r.ok) return; } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`server at ${url} did not come up`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function main() {
  console.log('═'.repeat(72));
  console.log('  LANDBRIDGE - cross-border land acquisition on the Pacta protocol');
  console.log('═'.repeat(72));

  seed(config.DB_PATH);
  console.log(`[demo] fresh marketplace seeded (${config.DB_PATH})`);

  launch('marketplace', path.join(config.PACTA_DIR, 'server-pacta.js'),
    { PORT: String(config.PACTA_PORT), DB_PATH: config.DB_PATH, PACTA: '1' }, config.PACTA_DIR);
  await waitFor(`${config.PACTA_URL}/api/ledger/invariant`);
  console.log(`[demo] Pacta marketplace on ${config.PACTA_URL} (staking + registry verification on)`);

  launch('sim', path.join(__dirname, 'market-sim.js'));
  launch('landbridge', path.join(__dirname, '..', 'server.js'));
  await waitFor(`http://127.0.0.1:${config.PORT}/api/state`);

  console.log('─'.repeat(72));
  console.log(`  Open http://localhost:${config.PORT} and ask the copilot to run the`);
  console.log('  due diligence. Watch the protocol timeline on the right.');
  console.log('─'.repeat(72));
}

main().catch((err) => { console.error(`[demo] ${err.message}`); process.exit(1); });
