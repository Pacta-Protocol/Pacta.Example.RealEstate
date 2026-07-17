'use strict';
// LandBridge UI. Two independent loops:
//   1. the chat: streams the copilot's turn (SSE over fetch) - the agent's voice;
//   2. the protocol panel + stepper: polls the marketplace snapshot - the
//      ledger's voice. The two never mix: progress shown on the right is what
//      the protocol recorded, not what the model said.
const $ = (sel) => document.querySelector(sel);
const usd = (cents) => '$' + (cents / 100).toLocaleString('en-US');
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Minimal markdown: bold, inline code, paragraphs.
function md(text) {
  return esc(text)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .split(/\n{2,}/).map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('');
}

// ── Property card ───────────────────────────────────────────────────────
async function loadState() {
  const state = await (await fetch('/api/state')).json();
  const p = state.property;
  $('#prop-name').textContent = p.name;
  $('#prop-loc').textContent = p.location;
  $('#prop-budget').textContent = usd(p.diligence_budget_usd * 100);
  $('#prop-facts').innerHTML = [
    ['Registry', p.folio], ['Size', p.size],
    ['Price', usd(p.price_usd * 100)], ['Use', p.use],
  ].map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(String(v))}</dd></div>`).join('');
  $('#explorer-link').href = state.marketplace_url;
  $('#pacta-badge').href = state.marketplace_url;
}

// ── Protocol panel + stepper (poll) ─────────────────────────────────────
const LANE_STATUS = {
  draft: ['working', 'contracting…'], agreed: ['working', 'contract locked'],
  funded: ['working', 'escrow funded - provider working'], in_progress: ['working', 'provider working…'],
  submitted: ['verifying', 'verifying proofs…'], completed: ['done', 'verified & paid ✓'],
  disputed: ['issue', 'dispute - arbiter reviewing'], resolved: ['issue', 'refunded - provider slashed'],
};

function renderStepper(engagements) {
  for (const lane of document.querySelectorAll('.lane')) {
    const cat = lane.dataset.cat;
    const mine = engagements.filter((e) => e.smb.category === cat);
    lane.className = 'lane';
    let status = 'pending';
    if (mine.some((e) => e.state === 'completed')) { lane.classList.add('done'); status = LANE_STATUS.completed[1]; }
    else if (mine.length) {
      // most recent engagement drives the lane
      const e = mine.reduce((a, b) => (a.id > b.id ? a : b));
      const [cls, label] = LANE_STATUS[e.state] || ['working', e.state];
      lane.classList.add(cls); status = label;
    }
    lane.querySelector('.lane-status').textContent = status;
  }
}

function renderProviders(smbs) {
  $('#providers').innerHTML = smbs.map((s) => `
    <div class="prov ${s.vetted ? '' : 'unvetted'}">
      <span class="prov-name">${esc(s.name)}</span>
      <span class="stake">${s.vetted ? `⬡ ${usd(s.stake_cents)} staked` : 'unvetted'}</span>
    </div>`).join('');
}

function renderFeed(transactions) {
  const feed = $('#feed');
  if (!transactions.length) { feed.innerHTML = '<div class="feed-empty">No protocol events yet.</div>'; return; }
  // column-reverse container: newest first in DOM order = bottom-anchored feel
  feed.innerHTML = transactions.map((t) => `
    <div class="evt ${esc(t.type)}">
      <span class="evt-amt">${usd(t.amount_cents)}</span> ${esc(t.type)}${t.engagement_id ? ` · eng #${t.engagement_id}` : ''}
      <span class="evt-memo">${esc(t.memo)}</span>
    </div>`).join('');
}

async function poll() {
  try {
    const res = await fetch('/api/market/summary');
    if (!res.ok) return;
    const m = await res.json();
    renderStepper(m.engagements);
    renderProviders(m.smbs);
    renderFeed(m.transactions);
    $('#agent-balance').textContent = usd(m.agent_balance_cents);
    $('#invariant').textContent = `ledger: ${m.invariant.ok ? 'balanced ✓' : 'BROKEN ✗'} (${usd(m.invariant.total_minted_cents)} minted)`;
  } catch { /* marketplace momentarily unreachable */ }
}

// ── Chat ────────────────────────────────────────────────────────────────
const log = $('#chat-log');
const form = $('#chat-form');
const input = $('#chat-text');
const sendBtn = $('#chat-send');

function addMsg(cls, html) {
  const div = document.createElement('div');
  div.className = `msg ${cls}`;
  div.innerHTML = html;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
  return div;
}

async function send(text) {
  addMsg('user', md(text));
  input.value = '';
  sendBtn.disabled = true;
  $('#chat-suggest').style.display = 'none';

  let bubble = null; let buffer = '';
  const flush = () => { if (bubble) bubble.innerHTML = md(buffer); log.scrollTop = log.scrollHeight; };

  try {
    const res = await fetch('/api/agent/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok || !res.body) {
      const err = await res.json().catch(() => ({}));
      addMsg('error', esc(err.error || `request failed (${res.status})`));
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = pending.indexOf('\n\n')) >= 0) {
        const frame = pending.slice(0, idx); pending = pending.slice(idx + 2);
        if (!frame.startsWith('data: ')) continue;
        const evt = JSON.parse(frame.slice(6));
        if (evt.type === 'text') {
          if (!bubble) { bubble = addMsg('assistant', ''); buffer = ''; }
          buffer += evt.text; flush();
        } else if (evt.type === 'tool_use') {
          flush(); bubble = null;
          const args = JSON.stringify(evt.input || {});
          addMsg('assistant tools', `<span class="tool-chip">→ ${esc(evt.name)}(${esc(args.length > 90 ? args.slice(0, 90) + '…' : args)})</span>`);
        } else if (evt.type === 'tool_result') {
          const last = log.lastElementChild;
          const chip = `<span class="tool-chip ${evt.is_error ? 'err' : ''}">${evt.is_error ? '✗' : '<span class="ok">✓</span>'} ${esc(evt.name)}</span>`;
          if (last && last.classList.contains('tools')) last.insertAdjacentHTML('beforeend', chip);
        } else if (evt.type === 'error') {
          addMsg('error', esc(evt.message));
        }
      }
    }
    flush();
  } catch (err) {
    addMsg('error', esc(`connection lost: ${err.message}`));
  } finally {
    sendBtn.disabled = false;
    input.focus();
  }
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (text && !sendBtn.disabled) send(text);
});
$('#suggest-btn').addEventListener('click', () => send($('#suggest-btn').textContent));

loadState();
poll();
setInterval(poll, 1500);
