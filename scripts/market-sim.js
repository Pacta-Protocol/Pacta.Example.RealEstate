'use strict';
// Plays every party the buying agent transacts with, so a full roundtrip can
// run unattended:
//   - honest provider bots: work funded engagements step by step, attaching
//     real registry references where the contract demands them, then submit;
//   - one dishonest bot (AgriMensura Express): delivers proofs that cite a
//     registry reference that does not exist;
//   - the arbiter: rules 'refund' on any dispute after a short deliberation,
//     which triggers the protocol's stake slashing.
// In production each of these is an independent party's own back office.
const { config } = require('../src/config');
const { RECEIPTS, BAD_PROVIDER, FAKE_SURVEY_REF } = require('../src/scenario');

const BASE = process.env.MARKETPLACE_URL || config.PACTA_URL;
const STEP_DELAY = config.SIM_STEP_DELAY_MS;
const RULING_DELAY = config.SIM_RULING_DELAY_MS;

async function api(method, path, body) {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error((data && data.error) || `${method} ${path} → ${res.status}`);
  return data;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (tag, msg) => console.log(`[${tag}] ${msg}`);

async function workEngagement(e) {
  const dishonest = e.smb.name === BAD_PROVIDER;
  log('sim', `${e.smb.name} starts work on engagement #${e.id} "${e.title}"`);
  for (const step of e.steps) {
    if (step.status === 'done') continue;
    await sleep(STEP_DELAY);
    const body = dishonest
      ? { proof_text: `Completed: ${step.title}. Filed under official reference ${FAKE_SURVEY_REF}.` }
      : {
        proof_text: `Completed: ${step.title}.` + (step.verification_kind
          ? ` Official filing reference: ${RECEIPTS[step.verification_kind]}.`
          : ' Deliverable sent to the client.'),
        ...(step.verification_kind ? { registry_ref: RECEIPTS[step.verification_kind] } : {}),
      };
    await api('POST', `/engagements/${e.id}/steps/${step.id}/complete`, body);
    log('sim', `  ${e.smb.name}: step ${step.position}/${e.steps.length} done${body.registry_ref ? ` (registry ${body.registry_ref})` : dishonest ? ` (claims ${FAKE_SURVEY_REF})` : ''}`);
  }
  await api('POST', `/engagements/${e.id}/submit`, {});
  log('sim', `${e.smb.name} submitted engagement #${e.id} for verification`);
}

async function ruleDispute(e) {
  log('arbiter', `dispute on engagement #${e.id} (${e.smb.name}): "${e.dispute_reason}" - deliberating...`);
  await sleep(RULING_DELAY);
  await api('POST', `/engagements/${e.id}/resolve`, { ruling: 'refund' });
  log('arbiter', `ruling on #${e.id}: REFUND - escrow returned to the buyer, provider stake slashed`);
}

async function main() {
  log('sim', `watching ${BASE} (providers + arbiter)...`);
  const busy = new Set();
  for (;;) {
    try {
      const work = [
        ...await api('GET', '/engagements?state=funded'),
        ...await api('GET', '/engagements?state=in_progress'),
      ];
      for (const e of work) {
        if (busy.has(e.id)) continue;
        busy.add(e.id);
        workEngagement(e).catch((err) => { log('sim', `error on #${e.id}: ${err.message}`); busy.delete(e.id); });
      }
      for (const e of await api('GET', '/engagements?state=disputed')) {
        const key = `dispute-${e.id}`;
        if (busy.has(key)) continue;
        busy.add(key);
        ruleDispute(e).catch((err) => { log('arbiter', `error on #${e.id}: ${err.message}`); busy.delete(key); });
      }
    } catch { /* marketplace not up yet */ }
    await sleep(500);
  }
}

if (require.main === module) main();
