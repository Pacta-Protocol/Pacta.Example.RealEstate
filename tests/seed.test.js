'use strict';
// The demo only lands if the seeded economics are exactly right; these tests
// pin them down.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { config } = require('../src/config');
const scenario = require('../src/scenario');
const { seed } = require('../scripts/seed-demo');

const { openDb } = require(path.join(config.PACTA_DIR, 'src', 'db.js'));
const staking = require(path.join(config.PACTA_DIR, 'src', 'staking.js'));

const dbPath = path.join(os.tmpdir(), `landbridge-seed-test-${process.pid}.db`);
seed(dbPath);
const db = openDb(dbPath);

const smb = (name) => db.prepare('SELECT * FROM smbs WHERE name = ?').get(name);
const offerOf = (smbId) => db.prepare('SELECT * FROM offers WHERE smb_id = ?').get(smbId);

test('seeds one buyer agent with the scenario balance and one arbiter', () => {
  const agent = db.prepare('SELECT * FROM agents').all();
  assert.equal(agent.length, 1);
  assert.equal(agent[0].name, scenario.AGENT_NAME);
  const acct = db.prepare("SELECT * FROM accounts WHERE kind = 'agent'").get();
  assert.equal(Number(acct.balance_cents), scenario.AGENT_BALANCE_CENTS);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM arbiters').get().c, 1);
});

test('every scenario provider exists with its offer and steps', () => {
  for (const s of scenario.SMBS) {
    const row = smb(s.name);
    assert.ok(row, `${s.name} missing`);
    assert.equal(row.category, s.category);
    const offer = offerOf(row.id);
    assert.equal(Number(offer.price_cents), s.offer.price_cents);
    const steps = db.prepare('SELECT * FROM offer_steps WHERE offer_id = ? ORDER BY position').all(offer.id);
    assert.equal(steps.length, s.offer.steps.length);
    steps.forEach((st, i) => assert.equal(st.verification_kind, s.offer.steps[i][2]));
  }
});

test('the unvetted title competitor has no stake and no badge', () => {
  const row = smb('Despacho Título Económico');
  assert.equal(Number(row.vetted), 0);
  assert.equal(staking.stakeBalanceCents(db, row.id), 0);
});

test('dishonest surveyor economics: cap fits its price, refund-slash wipes the stake', () => {
  const bad = smb(scenario.BAD_PROVIDER);
  const offer = offerOf(bad.id);
  const stake = staking.stakeBalanceCents(db, bad.id);
  // Exposure cap (5x stake) must admit the offer, or agree() would 409.
  assert.ok(staking.exposureCapCents(db, bad.id) >= Number(offer.price_cents),
    'exposure cap must cover the offer price');
  // A refund ruling slashes 20% of price; the stake must not survive it,
  // so the vetted badge is revoked and the market visibly self-corrects.
  const slash = Math.round(Number(offer.price_cents) * (staking.SLASH_PCT.refund / 100));
  assert.ok(stake <= slash, `stake ${stake} must be <= refund slash ${slash}`);
  assert.ok(stake > 0, 'must start vetted');
});

test('dishonest surveyor steps are NOT registry-anchored (its proofs are just words)', () => {
  const bad = smb(scenario.BAD_PROVIDER);
  const steps = db.prepare(
    'SELECT * FROM offer_steps WHERE offer_id = (SELECT id FROM offers WHERE smb_id = ?)', [bad.id],
  ).all(bad.id);
  assert.ok(steps.every((s) => s.verification_kind === null));
});

test('public registry holds every honest receipt and NOT the fake reference', () => {
  const refs = db.prepare('SELECT ref FROM registry_records').all().map((r) => r.ref);
  for (const ref of Object.values(scenario.RECEIPTS)) assert.ok(refs.includes(ref), `${ref} missing`);
  assert.ok(!refs.includes(scenario.FAKE_SURVEY_REF), 'fake reference must not exist');
});

test('honest providers can cover their offers within the exposure cap', () => {
  for (const s of scenario.SMBS) {
    if (s.stake_cents === 0) continue;
    const row = smb(s.name);
    assert.ok(staking.exposureCapCents(db, row.id) >= s.offer.price_cents, `${s.name} cap too small`);
  }
});
