'use strict';
// LandBridge UI. Two independent loops:
//   1. the chat: streams the copilot's turn (SSE over fetch) - the agent's voice;
//   2. the protocol panel + stepper: polls the marketplace snapshot - the
//      ledger's voice. The two never mix: progress shown on the right is what
//      the protocol recorded, not what the model said.
//
// Two viewing modes. Human (default): the copilot speaks in milestones and the
// raw tool activity stays folded away. Technical: every tool call and ledger
// memo is visible. The same run, two audiences.
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

// ── Technical view toggle ───────────────────────────────────────────────
const techToggle = $('#tech-toggle');
function applyTech(on) {
  document.body.classList.toggle('tech', on);
  techToggle.checked = on;
  // open existing activity groups when switching into technical view
  if (on) document.querySelectorAll('details.activity').forEach((d) => { d.open = true; });
  localStorage.setItem('landbridge-tech', on ? '1' : '0');
}
techToggle.addEventListener('change', () => applyTech(techToggle.checked));
applyTech(localStorage.getItem('landbridge-tech') === '1');

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
  funded: ['working', 'in escrow · provider working'], in_progress: ['working', 'provider working…'],
  submitted: ['verifying', 'verifying proofs…'], completed: ['done', 'verified & paid ✓'],
  disputed: ['issue', 'dispute · arbiter reviewing'], resolved: ['issue', 'refunded · provider slashed'],
};

function renderStepper(engagements) {
  for (const lane of document.querySelectorAll('.lane')) {
    const cat = lane.dataset.cat;
    const mine = engagements.filter((e) => e.smb.category === cat);
    lane.className = 'lane';
    let status = 'pending';
    let detail = '';
    const completedOne = mine.find((e) => e.state === 'completed');
    if (completedOne) {
      lane.classList.add('done');
      status = LANE_STATUS.completed[1];
      detail = `${completedOne.smb.name} · ${usd(completedOne.price_cents)}`;
    } else if (mine.length) {
      // most recent engagement drives the lane
      const e = mine.reduce((a, b) => (a.id > b.id ? a : b));
      const [cls, label] = LANE_STATUS[e.state] || ['working', e.state];
      lane.classList.add(cls);
      status = label;
      detail = `${e.smb.name} · ${usd(e.price_cents)}`;
    }
    lane.querySelector('.lane-status').textContent = status;
    lane.querySelector('.lane-detail').textContent = detail;
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

// Contiguous tool calls fold into one collapsible "activity" group. In human
// mode the group is hidden entirely; in technical view it renders expanded.
function newActivityGroup() {
  const details = document.createElement('details');
  details.className = 'activity';
  details.open = document.body.classList.contains('tech');
  details.innerHTML = '<summary><span class="act-count">0</span> protocol actions</summary><div class="act-body"></div>';
  log.appendChild(details);
  return details;
}

function addWorking() {
  const div = document.createElement('div');
  div.className = 'working';
  div.innerHTML = 'working on it<span class="dots"><i>.</i><i>.</i><i>.</i></span>';
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
  let activity = null; let actionCount = 0;
  const working = addWorking();
  const flush = () => { if (bubble) bubble.innerHTML = md(buffer); log.scrollTop = log.scrollHeight; };
  const keepWorkingLast = () => { log.appendChild(working); log.scrollTop = log.scrollHeight; };

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
          if (!bubble) { bubble = addMsg('assistant', ''); buffer = ''; activity = null; }
          buffer += evt.text; flush(); keepWorkingLast();
        } else if (evt.type === 'tool_use') {
          flush(); bubble = null;
          if (!activity) { activity = newActivityGroup(); actionCount = 0; }
          actionCount += 1;
          activity.querySelector('summary').innerHTML =
            `<span class="act-count">${actionCount}</span> protocol ${actionCount === 1 ? 'action' : 'actions'}`;
          const args = JSON.stringify(evt.input || {});
          activity.querySelector('.act-body').insertAdjacentHTML('beforeend',
            `<span class="tool-chip">→ ${esc(evt.name)}(${esc(args.length > 90 ? args.slice(0, 90) + '…' : args)})</span>`);
          keepWorkingLast();
        } else if (evt.type === 'tool_result') {
          if (activity) {
            activity.querySelector('.act-body').insertAdjacentHTML('beforeend',
              `<span class="tool-chip ${evt.is_error ? 'err' : ''}">${evt.is_error ? '✗' : '<span class="ok">✓</span>'} ${esc(evt.name)}</span>`);
          }
        } else if (evt.type === 'error') {
          addMsg('error', esc(evt.message));
        }
      }
    }
    flush();
  } catch (err) {
    addMsg('error', esc(`connection lost: ${err.message}`));
  } finally {
    working.remove();
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
