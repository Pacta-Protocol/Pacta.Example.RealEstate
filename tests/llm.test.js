'use strict';
// The OpenAI-compatible provider is what makes the copilot run on local
// open-weights models; these tests pin the conversion, the SSE accumulator
// and the full agentic loop against a scripted mock endpoint.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { toOpenAiTool, accumulateSseData, streamChatCompletion } = require('../src/llm');

test('converts an MCP tool descriptor into an OpenAI function tool', () => {
  const converted = toOpenAiTool({
    name: 'search_offers',
    description: 'Search the marketplace.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  });
  assert.deepEqual(converted, {
    type: 'function',
    function: {
      name: 'search_offers',
      description: 'Search the marketplace.',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    },
  });
});

test('tolerates tools with no description or schema', () => {
  const converted = toOpenAiTool({ name: 'get_my_balance' });
  assert.equal(converted.function.description, '');
  assert.deepEqual(converted.function.parameters, { type: 'object', properties: {} });
});

test('accumulates fragmented streaming tool calls', () => {
  const acc = { text: '', toolCalls: [], finishReason: null };
  accumulateSseData(acc, { choices: [{ delta: { content: 'Hiring ' } }] });
  accumulateSseData(acc, { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'create_', arguments: '' } }] } }] });
  accumulateSseData(acc, { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'engagement', arguments: '{"offer' } }] } }] });
  accumulateSseData(acc, { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '_id": 3}' } }] } }] });
  accumulateSseData(acc, { choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
  assert.equal(acc.text, 'Hiring ');
  assert.equal(acc.finishReason, 'tool_calls');
  assert.deepEqual(acc.toolCalls, [{ id: 'call_1', name: 'create_engagement', args: '{"offer_id": 3}' }]);
});

test('accumulates single-chunk tool calls (Ollama-style)', () => {
  const acc = { text: '', toolCalls: [], finishReason: null };
  accumulateSseData(acc, {
    choices: [{
      delta: { tool_calls: [{ index: 0, id: 'c9', function: { name: 'fund_escrow', arguments: '{"engagement_id":12}' } }] },
      finish_reason: 'tool_calls',
    }],
  });
  assert.deepEqual(acc.toolCalls, [{ id: 'c9', name: 'fund_escrow', args: '{"engagement_id":12}' }]);
});

// Full loop against a scripted mock /chat/completions endpoint: first response
// asks for a tool call, second closes with text - the loop must execute the
// tool against the (mock) MCP bridge and finish cleanly.
test('openai loop: tool round-trip against a mock endpoint', async () => {
  const sse = (events) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n';
  const scripted = [
    sse([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', function: { name: 'get_my_balance', arguments: '{}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]),
    sse([
      { choices: [{ delta: { content: 'Balance is $50,000.' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ]),
  ];
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      requests.push(JSON.parse(body));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(scripted.shift());
    });
  });
  await new Promise((r) => server.listen(0, r));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;

  process.env.LLM_BASE_URL = baseUrl;
  process.env.LANDBRIDGE_PROVIDER = 'openai';
  delete require.cache[require.resolve('../src/config')];
  delete require.cache[require.resolve('../src/llm')];
  const { createLlmLoop } = require('../src/llm');

  const mcpCalls = [];
  const mcp = {
    tools: [{ name: 'get_my_balance', description: 'Balance.', inputSchema: { type: 'object', properties: {} } }],
    call: async (name, args) => { mcpCalls.push({ name, args }); return { text: '{"balance_cents":5000000}', isError: false }; },
  };

  const events = [];
  const loop = createLlmLoop({ system: 'You are a test agent.', mcp });
  await loop.runTurn('check my balance', (e) => events.push(e));
  server.close();

  assert.deepEqual(mcpCalls, [{ name: 'get_my_balance', args: {} }]);
  assert.ok(events.some((e) => e.type === 'tool_use' && e.name === 'get_my_balance'));
  assert.ok(events.some((e) => e.type === 'text' && e.text.includes('Balance is')));
  assert.equal(events.at(-1).type, 'done');
  // The follow-up request must carry the assistant tool_calls turn and the tool result.
  const second = requests[1];
  assert.equal(second.messages.at(-2).role, 'assistant');
  assert.equal(second.messages.at(-1).role, 'tool');
  assert.equal(second.messages.at(-1).tool_call_id, 'call_a');
});

test('streamChatCompletion surfaces endpoint errors with status and body', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":{"message":"model \'nope\' not found"}}');
  });
  await new Promise((r) => server.listen(0, r));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  await assert.rejects(
    () => streamChatCompletion({ baseUrl, apiKey: '', body: { model: 'nope', messages: [] }, onText: () => {} }),
    /404.*not found/s,
  );
  server.close();
});
