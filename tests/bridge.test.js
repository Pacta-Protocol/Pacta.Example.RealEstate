'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { toAnthropicTool } = require('../src/llm');

test('converts an MCP tool descriptor into a Claude tool definition', () => {
  const converted = toAnthropicTool({
    name: 'search_offers',
    description: 'Search the marketplace.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  });
  assert.deepEqual(converted, {
    name: 'search_offers',
    description: 'Search the marketplace.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  });
});

test('tolerates tools with no description or schema', () => {
  const converted = toAnthropicTool({ name: 'get_my_balance' });
  assert.equal(converted.description, '');
  assert.deepEqual(converted.input_schema, { type: 'object', properties: {} });
});
