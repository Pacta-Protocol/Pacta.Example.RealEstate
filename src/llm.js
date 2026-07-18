'use strict';
// LLM providers for the copilot. Two implementations of one interface:
//   createLlmLoop({ system, mcp }) → { runTurn(userText, emit), reset() }
//
//   - anthropic: the Claude Messages API (adaptive thinking, pause_turn).
//   - openai:    ANY OpenAI-compatible /chat/completions endpoint - a local
//                Ollama, vLLM, OpenRouter, or a hosted provider. Implemented
//                with fetch + SSE, no SDK, so the example stays dependency-light.
//
// Each provider keeps its own native message history: Anthropic multi-turn
// tool use must replay signed thinking blocks verbatim, so a provider-neutral
// history would be lossy. The shared surface is the emit protocol:
//   {type:'text', text} {type:'tool_use', name, input}
//   {type:'tool_result', name, is_error, preview} {type:'done'} {type:'error', message}
const Anthropic = require('@anthropic-ai/sdk');
const { config } = require('./config');

const MAX_ITERATIONS = 80;

// ── Tool descriptor converters (pure; unit-tested) ──────────────────────
// MCP tool descriptor → Claude API tool definition.
function toAnthropicTool(mcpTool) {
  return {
    name: mcpTool.name,
    description: mcpTool.description || '',
    input_schema: mcpTool.inputSchema || { type: 'object', properties: {} },
  };
}

// MCP tool descriptor → OpenAI function-calling tool definition.
function toOpenAiTool(mcpTool) {
  return {
    type: 'function',
    function: {
      name: mcpTool.name,
      description: mcpTool.description || '',
      parameters: mcpTool.inputSchema || { type: 'object', properties: {} },
    },
  };
}

// ── Shared: execute one batch of tool calls against the MCP bridge ──────
async function execToolCalls(mcp, toolCalls, emit) {
  const results = [];
  for (const tc of toolCalls) {
    emit({ type: 'tool_use', name: tc.name, input: tc.input });
    let result;
    try {
      result = await mcp.call(tc.name, tc.input);
    } catch (err) {
      result = { text: `Tool failed: ${err.message}`, isError: true };
    }
    emit({
      type: 'tool_result', name: tc.name, is_error: result.isError,
      preview: result.text.length > 400 ? `${result.text.slice(0, 400)}…` : result.text,
    });
    results.push({ id: tc.id, text: result.text, isError: result.isError });
  }
  return results;
}

// ── Anthropic (Claude Messages API) ─────────────────────────────────────
function createAnthropicLoop({ system, mcp }) {
  const anthropic = new Anthropic.Anthropic();
  const tools = mcp.tools.map(toAnthropicTool);
  const messages = []; // full multi-turn history, tool + thinking blocks included

  async function runTurn(userText, emit) {
    messages.push({ role: 'user', content: userText });

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const stream = anthropic.messages.stream({
        model: config.LLM.model,
        max_tokens: 16000,
        thinking: { type: 'adaptive' },
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        tools,
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

      const toolCalls = message.content
        .filter((b) => b.type === 'tool_use')
        .map((b) => ({ id: b.id, name: b.name, input: b.input }));
      const results = await execToolCalls(mcp, toolCalls, emit);
      messages.push({
        role: 'user',
        content: results.map((r) => ({
          type: 'tool_result', tool_use_id: r.id,
          content: r.text, ...(r.isError ? { is_error: true } : {}),
        })),
      });
    }
    emit({ type: 'error', message: `Stopped after ${MAX_ITERATIONS} iterations without finishing.` });
  }

  return { runTurn, reset: () => { messages.length = 0; } };
}

// ── OpenAI-compatible (/chat/completions over SSE) ──────────────────────
// Accumulates streamed deltas into { text, toolCalls, finishReason }.
// Exported for unit tests; tolerates providers (e.g. some Ollama builds)
// that deliver tool_calls in a single chunk instead of fragments.
function accumulateSseData(acc, data) {
  const choice = data.choices?.[0];
  if (!choice) return null;
  const delta = choice.delta || {};
  if (delta.content) acc.text += delta.content;
  for (const frag of delta.tool_calls || []) {
    const i = frag.index ?? 0;
    if (!acc.toolCalls[i]) acc.toolCalls[i] = { id: '', name: '', args: '' };
    if (frag.id) acc.toolCalls[i].id = frag.id;
    if (frag.function?.name) acc.toolCalls[i].name += frag.function.name;
    if (frag.function?.arguments) acc.toolCalls[i].args += frag.function.arguments;
  }
  if (choice.finish_reason) acc.finishReason = choice.finish_reason;
  return delta.content || null;
}

async function streamChatCompletion({ baseUrl, apiKey, body, onText }) {
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({ ...body, stream: true }),
  });
  if (!res.ok) {
    throw new Error(`LLM endpoint returned ${res.status}: ${(await res.text()).slice(0, 500)}`);
  }

  const acc = { text: '', toolCalls: [], finishReason: null };
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      let data;
      try { data = JSON.parse(payload); } catch { continue; }
      if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
      const textDelta = accumulateSseData(acc, data);
      if (textDelta) onText(textDelta);
    }
  }
  acc.toolCalls = acc.toolCalls.filter(Boolean);
  return acc;
}

function createOpenAiLoop({ system, mcp }) {
  const { baseUrl, apiKey, model } = config.LLM;
  const tools = mcp.tools.map(toOpenAiTool);
  const messages = [{ role: 'system', content: system }];

  async function runTurn(userText, emit) {
    messages.push({ role: 'user', content: userText });

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const turn = await streamChatCompletion({
        baseUrl, apiKey,
        body: { model, messages, tools },
        onText: (delta) => emit({ type: 'text', text: delta }),
      });

      const toolCalls = turn.toolCalls.map((tc, n) => {
        let input = {};
        try { input = tc.args ? JSON.parse(tc.args) : {}; } catch { /* model emitted bad JSON; send empty */ }
        return { id: tc.id || `call_${i}_${n}`, name: tc.name, input, args: tc.args };
      });

      messages.push({
        role: 'assistant',
        content: turn.text || null,
        ...(toolCalls.length ? {
          tool_calls: toolCalls.map((tc) => ({
            id: tc.id, type: 'function',
            function: { name: tc.name, arguments: tc.args || '{}' },
          })),
        } : {}),
      });

      if (!toolCalls.length) {
        emit({ type: 'done', stop_reason: turn.finishReason || 'stop' });
        return;
      }

      const results = await execToolCalls(mcp, toolCalls, emit);
      for (const r of results) {
        // No is_error flag in the OpenAI schema - prefix so the model notices.
        messages.push({ role: 'tool', tool_call_id: r.id, content: r.isError ? `ERROR: ${r.text}` : r.text });
      }
    }
    emit({ type: 'error', message: `Stopped after ${MAX_ITERATIONS} iterations without finishing.` });
  }

  return { runTurn, reset: () => { messages.length = 1; } }; // keep the system message
}

function createLlmLoop(opts) {
  return config.LLM.provider === 'openai' ? createOpenAiLoop(opts) : createAnthropicLoop(opts);
}

module.exports = { createLlmLoop, toAnthropicTool, toOpenAiTool, accumulateSseData, streamChatCompletion };
