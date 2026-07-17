'use strict';
// Builds a fresh demo marketplace database for the LandBridge scenario using
// the protocol's own modules (db/ledger/staking) - the protocol repo is a
// dependency, never a copy. server-pacta.js later opens this DB and skips its
// default seed because the database is no longer empty.
const fs = require('node:fs');
const path = require('node:path');
const { config, assertPactaDir } = require('../src/config');
const scenario = require('../src/scenario');

assertPactaDir();
const { openDb, withTx } = require(path.join(config.PACTA_DIR, 'src', 'db.js'));
const { getOrCreateAccount, mint } = require(path.join(config.PACTA_DIR, 'src', 'ledger.js'));
const { depositStake } = require(path.join(config.PACTA_DIR, 'src', 'staking.js'));

function seed(dbPath) {
  for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) fs.rmSync(f, { force: true });
  const db = openDb(dbPath);
  const insert = (sql, params) => Number(db.prepare(sql).run(...params).lastInsertRowid);

  withTx(db, () => {
    // Buyer side: the consortium's agent, plus a neutral arbiter.
    const agentId = insert('INSERT INTO agents (name) VALUES (?)', [scenario.AGENT_NAME]);
    mint(db, getOrCreateAccount(db, 'agent', agentId).id, scenario.AGENT_BALANCE_CENTS,
      `seed balance for ${scenario.AGENT_NAME}`);
    insert('INSERT INTO arbiters (name) VALUES (?)', [scenario.ARBITER_NAME]);

    // Provider side.
    for (const s of scenario.SMBS) {
      const smbId = insert(
        'INSERT INTO smbs (name, category, location, description, capabilities, vetted) VALUES (?, ?, ?, ?, ?, ?)',
        [s.name, s.category, s.location, s.description, s.capabilities, s.stake_cents > 0 ? 1 : 0],
      );
      getOrCreateAccount(db, 'smb', smbId);
      if (s.stake_cents > 0) depositStake(db, smbId, s.stake_cents, `seed stake for ${s.name}`);

      const offerId = insert(
        'INSERT INTO offers (smb_id, title, description, price_cents, upfront_pct) VALUES (?, ?, ?, ?, ?)',
        [smbId, s.offer.title, s.offer.description, s.offer.price_cents, s.offer.upfront_pct],
      );
      s.offer.steps.forEach(([title, description, kind], i) => {
        insert('INSERT INTO offer_steps (offer_id, position, title, description, verification_kind) VALUES (?, ?, ?, ?, ?)',
          [offerId, i + 1, title, description, kind]);
      });

      for (let i = 0; i < s.rating.good; i++) {
        insert('INSERT INTO ratings (engagement_id, smb_id, agent_id, value) VALUES (NULL, ?, NULL, ?)', [smbId, 'good']);
      }
      for (let i = 0; i < s.rating.bad; i++) {
        insert('INSERT INTO ratings (engagement_id, smb_id, agent_id, value) VALUES (NULL, ?, NULL, ?)', [smbId, 'bad']);
      }
    }

    // Public registry: only the honest providers' filings exist.
    for (const [ref, kind, title, issuedTo, details] of scenario.REGISTRY_RECORDS) {
      insert('INSERT INTO registry_records (ref, kind, title, issued_to, details) VALUES (?, ?, ?, ?, ?)',
        [ref, kind, title, issuedTo, details]);
    }
  });

  db.close();
}

if (require.main === module) {
  seed(config.DB_PATH);
  console.log(`[seed] LandBridge demo marketplace written to ${config.DB_PATH}`);
}

module.exports = { seed };
