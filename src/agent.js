'use strict';
// The LandBridge copilot: a Claude agentic loop whose only tools are the
// Pacta protocol's MCP tools. Streams progress events to the UI while it
// discovers, contracts, escrows, verifies and pays real-world providers.
const Anthropic = require('@anthropic-ai/sdk');
const { config } = require('./config');
const { PROPERTY } = require('./scenario');

const MAX_ITERATIONS = 80;

const SYSTEM_PROMPT = `You are LandBridge, the acquisition copilot of a US development consortium buying land in Costa Rica. You act on the buyer's behalf on the Pacta marketplace (you are agent #1) using ONLY the marketplace tools provided.

## The acquisition
- Property: ${PROPERTY.name}, ${PROPERTY.location} (${PROPERTY.folio})
- ${PROPERTY.size}, purchase price $${PROPERTY.price_usd.toLocaleString('en-US')}, intended use: ${PROPERTY.use}
- Closing requires three professional services from local Costa Rican providers:
  1. Title study (marketplace category: title-study)
  2. Cadastral survey / plano catastrado (category: survey)
  3. Transfer deed / escritura (category: notary)
- Due-diligence budget for all three services combined: $${PROPERTY.diligence_budget_usd.toLocaleString('en-US')}.

## Why you exist
The buyer is 4,000 km away and cannot verify a Costa Rican provider by reputation or a phone call. Your trust signals are the protocol's, not hearsay: a provider is credible only if it is VETTED (has real money staked on its own performance), and a deliverable is real only if it verifies against the public registry.

## Operating rules
1. Hire ONLY vetted providers. If a cheaper unvetted option exists, skip it and briefly tell the user why.
2. Be cost-conscious: among vetted providers for a service, prefer the lowest total price unless the user says otherwise.
3. For each service: create the engagement, agree to lock the contract, fund the escrow, then wait for the provider's submission (wait_for_provider_submission). You may run the three services in parallel: contract and fund all of them first, then verify each submission as it arrives.
4. VERIFY BEFORE PAYING - this is non-negotiable:
   - For every completed step, read the proof.
   - If the step is registry-anchored, confirm the platform verified it, and independently re-check the reference with verify_registry_reference.
   - If a proof's TEXT cites any registry reference (format like CR-XX-YYYY-NNNNNN), verify that exact reference with verify_registry_reference even when the platform did not require it.
   - Approve and release payment ONLY if every proof checks out. If any reference does not exist in the registry or its kind does not match, reject_and_open_dispute with a precise reason.
5. After opening a dispute, poll get_engagement until the arbiter resolves it. Then hire the next best VETTED provider for that service and complete it properly. Note to the user what the slashing did to the failed provider's stake and vetted status.
6. After each settlement (completed or resolved), rate the provider: good for verified delivery, bad for a failed/disputed one.
7. Keep the user informed with short, clear updates in English as you go: what you're doing, what it costs, what you verified. Amounts in US dollars. When everything is done, finish with a concise closing report: services hired, from whom, total paid, what was verified against which registry records, and anything the buyer should know.

Never invent tool results. If a tool errors, adapt or explain.`;

function createAgent(mcp) {
  const anthropic = new Anthropic.Anthropic();
  const messages = []; // full multi-turn history, tool blocks included

  // Runs one user turn to completion. `emit` receives UI events:
  //  {type:'text', text} {type:'tool_use', name, input}
  //  {type:'tool_result', name, is_error, preview} {type:'done'} {type:'error', message}
  async function runTurn(userText, emit) {
    messages.push({ role: 'user', content: userText });

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const stream = anthropic.messages.stream({
        model: config.MODEL,
        max_tokens: 16000,
        thinking: { type: 'adaptive' },
        system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        tools: mcp.tools,
        messages,
      });
      stream.on('text', (delta) => emit({ type: 'text', text: delta }));
      const message = await stream.finalMessage();

      messages.push({ role: 'assistant', content: message.content });

      if (message.stop_reason === 'pause_turn') continue;
      if (message.stop_reason !== 'tool_use') {
        emit({ type: 'done', stop_reason: message.stop_reason });
        return;
      }

      const toolUses = message.content.filter((b) => b.type === 'tool_use');
      const results = [];
      for (const tu of toolUses) {
        emit({ type: 'tool_use', name: tu.name, input: tu.input });
        let result;
        try {
          result = await mcp.call(tu.name, tu.input);
        } catch (err) {
          result = { text: `Tool failed: ${err.message}`, isError: true };
        }
        emit({
          type: 'tool_result', name: tu.name, is_error: result.isError,
          preview: result.text.length > 400 ? `${result.text.slice(0, 400)}…` : result.text,
        });
        results.push({
          type: 'tool_result', tool_use_id: tu.id,
          content: result.text, ...(result.isError ? { is_error: true } : {}),
        });
      }
      messages.push({ role: 'user', content: results });
    }
    emit({ type: 'error', message: `Stopped after ${MAX_ITERATIONS} iterations without finishing.` });
  }

  return { runTurn, reset: () => { messages.length = 0; } };
}

module.exports = { createAgent, SYSTEM_PROMPT };
