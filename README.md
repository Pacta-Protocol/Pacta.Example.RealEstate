# LandBridge - cross-border real estate on Pacta

An example **vertical agentic app** built on the [Pacta protocol](https://github.com/Pacta-Protocol/Pacta.Protocol): a US development consortium is buying coastal land in Guanacaste, Costa Rica, and an LLM copilot runs the entire closing due diligence - it discovers local providers, contracts them, funds escrow, **verifies every deliverable against the public registry**, and releases payment. All through Pacta's MCP surface, without modifying a line of the protocol.

## Why this scenario

Cross-border is where trust breaks hardest. The buyer is 4,000 km away: they can't call a colleague about a Costa Rican surveyor, can't read the local reputation network, can't drop by the Registro Nacional. Pacta replaces that missing local knowledge with two mechanical signals:

- **Vetting by stake** - a provider is credible because it has its own money bet on its performance, not because someone vouched for it.
- **Registry-verified proofs** - a deliverable is real because the public registry says so, not because the provider says so.

The demo's climax makes the point: the cheapest surveyor has a *spotless rating* and a vetted badge, but delivers a "plano" citing a filing reference the Catastro has never seen. The copilot checks the reference, catches the fraud, opens a dispute - and the protocol refunds the escrow, **slashes the provider's stake to zero, revokes its badge**, and the copilot re-hires a verified competitor. Reputation missed it; verification caught it.

## The three-tier picture

| Tier | What | Where |
|---|---|---|
| Protocol | discover → contract → escrow → verify → pay, staking/vetting, MCP | [`Pacta.Protocol`](https://github.com/Pacta-Protocol/Pacta.Protocol) |
| Reference explorer | horizontal marketplace UI | inside the protocol repo |
| **Example apps (this)** | vertical, opinionated products consuming the protocol | separate repos |

LandBridge is deliberately skinned as a consumer product (its own brand, warm editorial UI) with the protocol timeline as a dark "ledger" panel beside the chat - what you see on the right is what the **protocol** recorded, never what the model claims.

## Quick start

Requirements: Node ≥ 22.5, a local clone of the protocol, and an LLM - a **local open-weights model** (via Ollama or any OpenAI-compatible endpoint) or a Claude API key. Or no model at all: see the deterministic roundtrip below.

```bash
# 1. The protocol (sibling folder; or point PACTA_DIR anywhere)
git clone https://github.com/Pacta-Protocol/Pacta.Protocol.git protocol
cd protocol && npm install && cd ..

# 2. This example
git clone https://github.com/Pacta-Protocol/Pacta.Example.RealEstate.git
cd Pacta.Example.RealEstate
npm install

# 3. Pick your model in .env (see "Choose your model" below)
cp .env.example .env

# 4. Everything up: seeded marketplace + provider bots + arbiter + web app
npm run demo                  # → http://localhost:3300
```

Click the suggested prompt ("Run the full due diligence…") and watch both panels: the copilot reports milestones on the left; contracts, escrow movements, the dispute, the slash and the payouts appear on the right as raw ledger events.

Two viewing modes, one run: by default the copilot talks like a colleague (milestones only, tool activity folded away). Flip **Technical view** in the header to expose every MCP tool call and the full ledger memos - same session, different audience.

### Choose your model

The copilot is model-agnostic: the agentic loop speaks two wire protocols (`src/llm.js`) and picks one from `.env`. Whatever you choose, keys live only in the Node backend (`.env`, gitignored) - the browser never talks to a model API.

**Fully local - open weights, no key, no cloud:**

```bash
ollama pull qwen3             # or any tool-capable open model
# .env:
#   LLM_BASE_URL=http://localhost:11434/v1
#   LANDBRIDGE_MODEL=qwen3
```

Everything - marketplace, providers, arbiter, copilot and model - now runs on your machine. Nothing leaves it.

**Any OpenAI-compatible endpoint** (vLLM, OpenRouter, a hosted provider): set `LLM_BASE_URL`, `LLM_API_KEY` and `LANDBRIDGE_MODEL`.

**The Claude API:** set `ANTHROPIC_API_KEY` (get one at [console.anthropic.com](https://console.anthropic.com)); model defaults to `claude-opus-4-8`, override with `LANDBRIDGE_MODEL`. A full demo run costs roughly a few tens of cents.

## No model? The protocol is verifiable without one

The same end-to-end flow - including the fraud, the dispute and the re-hire - driven by a **scripted buyer over the identical MCP tools**, then **audited independently through the REST API**. No LLM, no key, fully deterministic:

```bash
npm run roundtrip     # exits 0 only if every audit check passes
npm test              # unit tests (seed economics, MCP + LLM tool bridges)
```

This is also what CI runs: an LLM makes the demo alive, but every protocol guarantee - escrow, verification, slashing, the ledger invariant - holds and is checkable without one.

## How it works

```
┌────────────── LandBridge (this repo) ──────────────┐   ┌── Pacta.Protocol ──┐
│ browser UI ── SSE ── Express ── LLM (local/API)    │   │                    │
│                         │ tool_use                 │   │                    │
│                         └── MCP client ── stdio ───┼──▶│ mcp/server.js      │
│ scripts/market-sim.js  (providers + arbiter) ──────┼──▶│ REST API + ledger  │
│ scripts/seed-demo.js   (scenario data) ────────────┼──▶│ SQLite (fresh DB)  │
└────────────────────────────────────────────────────┘   └────────────────────┘
```

- **The copilot's tool surface *is* the protocol's MCP surface** (`src/llm.js` converts MCP tool descriptors to each model API's tool format mechanically). Add a tool to the protocol's MCP server and the copilot gains it on restart - whichever model is driving.
- **`scripts/market-sim.js`** plays the counterparties: honest provider bots that file real registry references, the dishonest surveyor that doesn't, and the arbiter that rules `refund` on disputes (which triggers the protocol's stake slashing).
- **The demo runs against a fresh, seeded local marketplace** (`server-pacta.js` on port 3240 with its own DB) - never against a live deployment.

## Scenario data

Property: *Finca Vista Pacífico*, Playa Potrero, Guanacaste - 4.2 ha for an eco-resort. Three services close the deal:

| Service | Providers seeded | The catch |
|---|---|---|
| Title study | Registral Firme S.A. ($1,450, staked) · Despacho Título Económico ($1,100, **unvetted**) | cheaper option has no stake - copilot must skip it |
| Cadastral survey | AgriMensura Express ($680, staked, rating 5/0) · Geodesia Guanacaste ($1,480, staked) | the cheap one's proof cites `CR-CN-2026-999999` - a reference that doesn't exist |
| Transfer deed | Notaría Chaves & Mora ($2,200, staked) | - |

All amounts are simulated USD on the protocol's double-entry ledger; the audit checks the ledger invariant (Σ balances = Σ minted) after the whole story has played out.

## License

MIT - see [LICENSE](LICENSE).
