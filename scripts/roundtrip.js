'use strict';
// Self-verifying end-to-end roundtrip WITHOUT an LLM (no API key needed):
// a deterministic scripted buyer drives the exact same MCP tool surface the
// copilot uses - including the dispute path - then audits the outcome
// through the REST API. Exit code 0 only if every check passes.
//
//   npm run roundtrip
//
// What it proves: discover → contract → escrow → deliver → verify → the
// dishonest provider's fake proof is caught → dispute → refund + stake
// slashed to zero (badge revoked) → re-hire a vetted replacement → all three
// services completed and paid → ledger invariant intact.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { config, assertPactaDir } = require('../src/config');
const { seed } = require('./seed-demo');
const { connectPactaMcp } = require('../src/mcp');
const { BAD_PROVIDER } = require('../src/scenario');

assertPactaDir();

const PORT = Number(process.env.ROUNDTRIP_PORT || 3241);
const BASE = `http://127.0.0.1:${PORT}`;
const DB = path.join(config.ROOT, 'data', 'roundtrip.db');

const children = [];
const prefix = (name, d) => d.toString().split('\n').filter((l) => l.trim()).map((l) => `[${name}] ${l}\n`).join('');
function launch(name, script, env = {}, cwd = config.ROOT) {
  const p = spawn(process.execPath, [script], { cwd, env: { ...process.env, ...env } });
  p.stdout.on('data', (d) => process.stdout.write(prefix(name, d)));
  p.stderr.on('data', (d) => process.stderr.write(prefix(name, d)));
  children.push(p);
}
process.on('exit', () => children.forEach((p) => { try { p.kill(); } catch { /* gone */ } }));
process.on('SIGINT', () => process.exit(130));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function rest(p) { return (await fetch(`${BASE}/api${p}`)).json(); }
async function waitFor(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { const r = await fetch(url); if (r.ok) return; } catch { /* not up */ }
    if (Date.now() > deadline) throw new Error(`server at ${url} did not come up`);
    await sleep(250);
  }
}

// Registry references cited inside free-text proofs (e.g. CR-CN-2026-999999).
const REF_RE = /CR-[A-Z]+(?:-[A-Z]+)?-\d{4}-\d+/g;
const extractRefs = (text) => [...new Set(String(text || '').match(REF_RE) || [])];

const say = (msg) => console.log(`[buyer] ${msg}`);

async function hireCheapestVetted(mcp, { query, category }) {
  const search = JSON.parse((await mcp.call('search_offers', { query, category })).text);
  const vetted = search.results.filter((o) => o.provider.vetted);
  if (!vetted.length) throw new Error(`no vetted provider for ${category}`);
  const pick = vetted.reduce((a, b) => (parsePrice(a.price) <= parsePrice(b.price) ? a : b));
  say(`${category}: hiring "${pick.title}" from ${pick.provider.name} (${pick.price}, collateral ${pick.provider.collateral_at_stake})`);
  const draft = JSON.parse((await mcp.call('create_engagement', { offer_id: pick.offer_id })).text);
  await mcp.call('agree_to_contract', { engagement_id: draft.engagement_id });
  await mcp.call('fund_escrow', { engagement_id: draft.engagement_id });
  return draft.engagement_id;
}
const parsePrice = (s) => Number(String(s).replace(/[^0-9.]/g, ''));

// Waits for submission, verifies every proof (platform-anchored refs AND refs
// cited in free text), then approves or disputes. Returns 'completed'|'disputed'.
async function verifyAndSettle(mcp, engagementId) {
  const delivered = JSON.parse((await mcp.call('wait_for_provider_submission', { engagement_id: engagementId, timeout_seconds: 60 })).text);
  if (delivered.state !== 'submitted') throw new Error(`#${engagementId}: expected submission, got '${delivered.state}'`);

  let allOk = true;
  for (const step of delivered.steps) {
    const refs = new Set([...(step.registry_ref ? [step.registry_ref] : []), ...extractRefs(step.proof)]);
    for (const ref of refs) {
      const check = await mcp.call('verify_registry_reference', { ref });
      if (check.isError) { say(`#${engagementId} step ${step.position}: reference ${ref} NOT FOUND in public registry`); allOk = false; continue; }
      const record = JSON.parse(check.text);
      const kindOk = !step.requires_registry_proof || record.kind === step.requires_registry_proof;
      say(`#${engagementId} step ${step.position}: ${ref} ${kindOk ? 'VERIFIED' : 'KIND MISMATCH'} - "${record.title}"`);
      if (!kindOk) allOk = false;
    }
  }

  if (allOk) {
    await mcp.call('approve_and_release_payment', { engagement_id: engagementId });
    await mcp.call('rate_provider', { engagement_id: engagementId, value: 'good' });
    say(`#${engagementId}: proofs verified - payment released, provider rated good`);
    return 'completed';
  }
  await mcp.call('reject_and_open_dispute', { engagement_id: engagementId, reason: 'Proof cites a registry reference that does not exist in the public registry.' });
  say(`#${engagementId}: dispute opened, waiting for the arbiter...`);
  for (;;) {
    const e = JSON.parse((await mcp.call('get_engagement', { engagement_id: engagementId })).text);
    if (e.state === 'resolved') { say(`#${engagementId}: arbiter ruled '${e.resolution}'`); break; }
    await sleep(500);
  }
  await mcp.call('rate_provider', { engagement_id: engagementId, value: 'bad' });
  return 'disputed';
}

async function main() {
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) fs.rmSync(f, { force: true });
  seed(DB);
  launch('marketplace', path.join(config.PACTA_DIR, 'server-pacta.js'),
    { PORT: String(PORT), DB_PATH: DB, PACTA: '1' }, config.PACTA_DIR);
  await waitFor(`${BASE}/api/ledger/invariant`);
  launch('sim', path.join(__dirname, 'market-sim.js'), { MARKETPLACE_URL: BASE });

  const before = await rest('/agents/1');
  const mcp = await connectPactaMcp({ marketplaceUrl: BASE });

  // Contract & fund all three services (cheapest vetted per category), then
  // verify each as it delivers - same playbook the LLM copilot follows.
  const services = [
    { query: 'title study lien search', category: 'title-study' },
    { query: 'land survey plano catastrado', category: 'survey' },
    { query: 'transfer deed escritura notary', category: 'notary' },
  ];
  const outcomes = [];
  const ids = [];
  for (const s of services) ids.push(await hireCheapestVetted(mcp, s));
  for (const id of ids) outcomes.push(await verifyAndSettle(mcp, id));

  // The dishonest surveyor was slashed - re-hire a vetted replacement.
  if (outcomes.includes('disputed')) {
    say('re-hiring the survey from the next vetted provider...');
    const replacement = await hireCheapestVetted(mcp, { query: 'cadastral survey catastro', category: 'survey' });
    const outcome = await verifyAndSettle(mcp, replacement);
    if (outcome !== 'completed') throw new Error('replacement survey did not complete');
  }
  await mcp.close();

  // ---- Independent audit via REST (not the buyer's own claims) -------------
  console.log('\n' + '─'.repeat(72));
  console.log('  INDEPENDENT AUDIT');
  console.log('─'.repeat(72));
  const checks = [];
  const check = (name, cond, detail) => {
    checks.push(cond);
    console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`);
  };

  const engagements = await rest('/engagements?agent_id=1');
  const completed = engagements.filter((e) => e.state === 'completed');
  const resolved = engagements.filter((e) => e.state === 'resolved');
  check('three services completed', completed.length === 3, completed.map((e) => `#${e.id}`).join(', '));
  check('exactly one dispute, resolved', resolved.length === 1, resolved[0] && `#${resolved[0].id} → ${resolved[0].resolution}`);
  check('dispute was a refund', resolved[0]?.resolution === 'refund');
  check('every completed engagement fully proven',
    completed.every((e) => e.steps_done === e.steps_total && e.escrow_balance_cents === 0));

  const smbs = await rest('/smbs');
  const bad = smbs.find((s) => s.name === BAD_PROVIDER);
  check('dishonest provider stake slashed to zero', bad && bad.stake_cents === 0, bad && `stake $${bad.stake_cents / 100}`);
  check('dishonest provider lost its vetted badge', bad && bad.vetted === false);

  const after = await rest('/agents/1');
  const paid = completed.reduce((sum, e) => sum + e.price_cents, 0);
  const slashCompensation = resolved[0] ? Math.round(resolved[0].price_cents * 0.2) : 0;
  check('buyer paid exactly the three completed prices minus slash compensation',
    before.balance_cents - after.balance_cents === paid - slashCompensation,
    `spent $${(before.balance_cents - after.balance_cents) / 100} (services $${paid / 100}, slash credit $${slashCompensation / 100})`);

  const inv = await rest('/ledger/invariant');
  check('ledger invariant holds', inv.ok, `Σ balances = Σ minted = $${inv.total_minted_cents / 100}`);

  const ok = checks.every(Boolean);
  console.log('─'.repeat(72));
  console.log(ok
    ? '  ✅ ROUNDTRIP VERIFIED: discovery, contracts, escrow, a caught fraud,\n     slashing, re-hire and full settlement - all via the protocol\'s MCP surface.'
    : '  ❌ ROUNDTRIP FAILED - see FAIL lines above.');
  process.exitCode = ok ? 0 : 1;
}

main().catch((err) => {
  console.error(`[roundtrip] ${err.message}`);
  process.exitCode = 1;
}).finally(() => setTimeout(() => process.exit(process.exitCode ?? 0), 300));
