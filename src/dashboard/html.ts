/**
 * Single-page dashboard. SECURITY: tweets and news are untrusted, so the
 * script only ever uses textContent / value (never innerHTML) for data.
 */
export function dashboardHtml(nonce: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>crypto-x-agent</title>
<style nonce="${nonce}">
:root{--bg:#0f1115;--card:#171a21;--line:#262b36;--fg:#e6e8ee;--mut:#8b93a7;--ok:#3ecf8e;--warn:#f5a524;--bad:#f0616d;--acc:#6ea8fe}
@media (prefers-color-scheme:light){:root{--bg:#f6f7f9;--card:#fff;--line:#dde1e8;--fg:#14171f;--mut:#5b6478}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif}
header{display:flex;gap:12px;align-items:center;padding:12px 16px;border-bottom:1px solid var(--line);flex-wrap:wrap}
h1{font-size:16px;margin:0}nav{display:flex;gap:4px;flex-wrap:wrap;padding:8px 16px}
button{background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:6px 12px;cursor:pointer;font:inherit}
button:hover{border-color:var(--acc)}button.on{background:var(--acc);color:#fff;border-color:var(--acc)}
button.ok{border-color:var(--ok)}button.bad{border-color:var(--bad)}
main{padding:0 16px 40px;max-width:1100px}.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px;margin:10px 0}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.grow{flex:1}
.pill{display:inline-block;padding:1px 8px;border-radius:99px;border:1px solid var(--line);font-size:12px}
.RUNNING,.PUBLISHED{color:var(--ok)}.PAUSED,.UNCERTAIN,.MEDIUM,.PENDING_APPROVAL{color:var(--warn)}.FAILED,.REJECTED,.HIGH,.ERROR{color:var(--bad)}
.mut{color:var(--mut)}.bar{height:8px;background:var(--line);border-radius:4px;overflow:hidden;min-width:140px}.bar>i{display:block;height:100%;background:var(--acc)}
textarea,input{width:100%;background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:8px;font:inherit}
table{width:100%;border-collapse:collapse}td,th{padding:6px 8px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
pre{white-space:pre-wrap;word-break:break-word;margin:0;font-size:12px}#msg{position:fixed;bottom:12px;right:12px;max-width:80vw}
</style></head><body>
<header><h1>crypto-x-agent</h1><span id="state" class="pill">…</span><span id="flags" class="mut"></span>
<span class="grow"></span><button id="pause" class="bad">Pause</button><button id="resume" class="ok">Resume</button><button id="tick">Run tick now</button></header>
<nav id="tabs"></nav><main id="view"></main><div id="msg" class="card" hidden></div>
<script nonce="${nonce}">
const base = location.pathname;
const $ = (s) => document.querySelector(s);
const el = (tag, props, ...kids) => { const e = document.createElement(tag); Object.assign(e, props || {}); for (const k of kids.flat()) e.append(k instanceof Node ? k : document.createTextNode(String(k ?? ''))); return e; };
async function api(route, body, extra) {
  const q = new URLSearchParams({ r: route, ...(extra || {}) });
  const res = await fetch(base + '?' + q, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json', 'x-dashboard': '1' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
  return data;
}
function toast(t, bad) { const m = $('#msg'); m.hidden = false; m.textContent = t; m.style.borderColor = bad ? 'var(--bad)' : 'var(--ok)'; setTimeout(() => m.hidden = true, 5000); }
const act = (fn) => async () => { try { await fn(); await show(tab); } catch (e) { toast(e.message, true); } };
const bar = (n, max) => el('div', { className: 'bar' }, el('i', { style: 'width:' + Math.min(100, max ? n / max * 100 : 0) + '%' }));
const fmt = (d) => d ? new Date(d).toLocaleString() : '';
const TABS = ['Overview', 'Approvals', 'Activity', 'News', 'Posts', 'Replies', 'Settings'];
let tab = 'Overview';
TABS.forEach((t) => $('#tabs').append(el('button', { textContent: t, onclick: () => show(t) })));

async function header() {
  const s = await api('status');
  $('#state').textContent = s.botStatus; $('#state').className = 'pill ' + s.botStatus;
  $('#flags').textContent = (s.flags.dryRun ? 'DRY_RUN ' : 'LIVE ') + (s.flags.autonomous ? '· autonomous' : '· approval required') + ' · @' + s.handle;
  return s;
}
$('#pause').onclick = act(() => api('pause', {}));
$('#resume').onclick = act(() => api('resume', {}));
$('#tick').onclick = act(async () => { const r = await api('tick', {}); toast('tick: ' + (r.skipped || r.jobs.map((j) => j.job + (j.ok ? '' : ' FAILED')).join(', ') || 'nothing due')); });

const views = {
  async Overview(s) {
    const u = s.usage, l = s.limits;
    const meter = (label, n, max) => el('div', { className: 'row' }, el('div', { style: 'width:110px' }, label), bar(n, max), el('span', {}, n + ' / ' + max));
    const spend = (label, n, max) => el('div', { className: 'row' }, el('div', { style: 'width:110px' }, label), bar(n, max), el('span', {}, '$' + n.toFixed(2) + ' / $' + max));
    return [
      el('div', { className: 'card' }, el('b', {}, 'Today (' + s.timezone + ')'), meter('Posts', u.postsToday, l.posts), meter('Replies', u.repliesToday, l.replies), meter('Total', u.postsToday + u.repliesToday, l.total),
        spend('X spend', u.estimatedXCost, s.budget.maxXDailySpend), spend('LLM spend', u.estimatedLlmCost, s.budget.maxLlmDailySpend)),
      el('div', { className: 'card' }, el('b', {}, 'Health'),
        el('div', {}, 'X: ', s.x.connected ? (s.x.needsReauth ? 'NEEDS RE-AUTH (npm run x:auth)' : 'connected') : 'not connected (npm run x:auth)'),
        el('div', {}, 'LLM: ', s.llm.configured ? 'configured' : 'not configured'),
        el('div', {}, 'Waiting for approval: ', s.queue.pendingPosts + s.queue.pendingReplies, ' · UNCERTAIN: ', s.queue.uncertain, ' · eligible news: ', s.queue.eligibleNews)),
      el('div', { className: 'card' }, el('b', {}, 'Scheduled jobs'), el('table', {}, s.jobs.map((j) => el('tr', {}, el('td', {}, j.job_type), el('td', {}, j.status), el('td', { className: 'mut' }, fmt(j.run_at)), el('td', { className: 'mut' }, j.last_error || ''))))),
    ];
  },
  async Approvals() {
    const { items } = await api('queue');
    if (!items.length) return [el('div', { className: 'card mut' }, 'Nothing waiting for approval.')];
    return items.map((it) => {
      const ta = el('textarea', { rows: 3, value: it.content, maxLength: 280 });
      const checks = (it.safety_report && it.safety_report.checks || []).map((c) => (c.ok ? '✓ ' : '✗ ') + c.name + ': ' + c.detail).join('\\n');
      return el('div', { className: 'card' },
        el('div', { className: 'row' }, el('span', { className: 'pill' }, it.kind), el('span', { className: 'pill ' + it.risk_level }, 'risk ' + it.risk_level), el('span', { className: 'mut' }, fmt(it.created_at))),
        it.parent_text ? el('div', { className: 'mut' }, 'Replying to: ', it.parent_text) : '',
        ta, el('pre', { className: 'mut' }, (it.safety_report && it.safety_report.reason || '') + '\\n' + checks),
        el('div', { className: 'row' },
          el('button', { className: 'ok', textContent: 'Approve & publish', onclick: act(async () => { const r = await api('approve', { kind: it.kind, id: it.id, text: ta.value }); toast('approve: ' + (r.publish ? r.publish.status : '')); }) }),
          el('button', { className: 'bad', textContent: 'Reject', onclick: act(() => api('reject', { kind: it.kind, id: it.id })) })));
    });
  },
  async Activity() {
    const { events } = await api('events', undefined, { limit: 100 });
    return [el('div', { className: 'card' }, el('table', {}, events.map((e) => el('tr', {}, el('td', { className: 'mut' }, fmt(e.ts)), el('td', { className: e.action === 'ERROR' ? 'ERROR' : '' }, e.action), el('td', {}, e.decision || ''), el('td', {}, e.reason || e.result || '')))))];
  },
  async News() {
    const { items } = await api('news', undefined, { limit: 80 });
    return [el('div', { className: 'card' }, el('table', {}, items.map((n) => el('tr', {}, el('td', {}, n.source || ''), el('td', {}, n.title), el('td', {}, n.decision), el('td', { className: 'mut' }, n.confidence ?? ''), el('td', { className: 'mut' }, n.decision_reason || '')))))];
  },
  async Posts() {
    const { items } = await api('posts', undefined, { limit: 60 });
    return [el('div', { className: 'card' }, el('table', {}, items.map((p) => el('tr', {}, el('td', { className: p.status }, p.status), el('td', {}, p.content), el('td', { className: 'mut' }, p.rejection_reason || p.publish_error || '')))))];
  },
  async Replies() {
    const { items } = await api('replies', undefined, { limit: 60 });
    return [el('div', { className: 'card' }, el('table', {}, items.map((p) => el('tr', {}, el('td', { className: p.status }, p.status), el('td', { className: 'mut' }, p.parent_text || ''), el('td', {}, p.content), el('td', { className: 'mut' }, p.rejection_reason || p.publish_error || '')))))];
  },
  async Settings() {
    const { settings, keys } = await api('settings');
    const camel = (k) => k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    return [el('div', { className: 'card mut' }, 'Daily limits can only be LOWERED (hard caps 6 / 10 / 16 are enforced in the database). DRY_RUN and AUTONOMOUS_MODE are environment variables and cannot be changed here.'),
      ...keys.filter((k) => k !== 'bot_status').map((k) => {
        const cur = settings[camel(k)];
        const input = el('input', { value: typeof cur === 'string' ? cur : JSON.stringify(cur) });
        return el('div', { className: 'card row' }, el('div', { style: 'width:260px' }, k), el('div', { className: 'grow' }, input),
          el('button', { textContent: 'Save', onclick: act(async () => { let v = input.value; try { v = JSON.parse(v); } catch (_) {} await api('settings', { key: k, value: v }); toast('saved ' + k); }) }));
      })];
  },
};
async function show(t) {
  tab = t;
  [...$('#tabs').children].forEach((b) => b.className = b.textContent === t ? 'on' : '');
  try { const s = await header(); const nodes = await views[t](s); const v = $('#view'); v.replaceChildren(...nodes); }
  catch (e) { toast(e.message, true); }
}
show(tab);
</script></body></html>`;
}
