// Safara: automatic reminder calls for transport companies.
// Bus companies' websites send bookings to the API; this service phones the passengers,
// retries when they don't pick up, and shows each company its own calls in a portal.
// No npm packages. Needs Node 22.13 or newer (uses the built-in SQLite).
// Run: node server.js

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (_) {
  console.error(`\nSafara needs Node 22.13 or newer (this is ${process.version}).\n` +
    'On Render: Environment > add NODE_VERSION = 22  (then redeploy). Locally: install Node 22 or newer.\n');
  process.exit(1);
}
process.removeAllListeners('warning'); // hide the "SQLite is experimental" notice

// ---------- config (.env) ----------
try {
  fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n').forEach((l) => {
    const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && !l.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  });
} catch (_) {}

const E = process.env;
const CFG = {
  product: E.PRODUCT_NAME || 'Safara', // the product name shown on the portal and admin pages
  port: +E.PORT || 3000,
  dbPath: E.DB_PATH || path.join(__dirname, 'data', 'app.db'),
  dashUser: E.DASHBOARD_USER || 'admin',
  dashPass: E.DASHBOARD_PASSWORD || 'changeme',
  atUser: E.AT_USERNAME || '',
  atKey: E.AT_API_KEY || '',
  atFrom: E.AT_FROM_NUMBER || '',
  atSandbox: E.AT_SANDBOX === 'true',
  maxConcurrent: +E.MAX_CONCURRENT_CALLS || 10, // calls in progress at the same time
  minListenSec: +E.MIN_LISTEN_SECONDS || 5,     // "reached" only if they stayed on this long
  ringTimeoutSec: 150,                          // provider never reported back -> no answer
  // defaults for a new company (each company can then change its own)
  defLead: +E.DEFAULT_LEAD_MINUTES || 90,
  defAttempts: +E.DEFAULT_MAX_ATTEMPTS || 7,
  defRetrySec: +E.DEFAULT_RETRY_SECONDS || 60,
};
CFG.mock = E.MOCK_CALLS === 'true' || !(CFG.atUser && CFG.atKey && CFG.atFrom);

// ---------- pages (built into this file) ----------
const PAGES = { portal: "<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<title>{{PRODUCT}}: company portal</title>\n<link href=\"https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,800&family=Figtree:wght@400;500;600&display=swap\" rel=\"stylesheet\">\n<style>\n  :root{--ink:#16231f;--bg:#eef1ee;--card:#fff;--line:#d3dcd6;--muted:#62706a;--go:#1f7a4d;--err:#b3261e;--blue:#2457a6;--amber:#f0b429}\n  *{box-sizing:border-box}\n  body{margin:0;background:var(--bg);font:15px/1.45 Figtree,system-ui,sans-serif;color:var(--ink)}\n  header{background:var(--ink);color:#fff;padding:16px clamp(16px,4vw,40px);display:flex;gap:16px;align-items:center;flex-wrap:wrap}\n  header h1{font:800 20px 'Bricolage Grotesque',sans-serif;margin:0;flex:1}\n  header span{color:#b9c6c0;font-size:14px}\n  main{max-width:980px;margin:0 auto;padding:22px 16px 60px}\n  button{font:inherit;font-size:13px;font-weight:600;padding:7px 13px;border-radius:8px;border:1.5px solid var(--ink);background:#fff;color:var(--ink);cursor:pointer}\n  button:hover{background:var(--ink);color:#fff} button:focus-visible,input:focus-visible,select:focus-visible{outline:3px solid var(--amber)}\n  button.ghost{border-color:var(--line);color:var(--muted)} header button{background:transparent;color:#fff;border-color:#4b5b55}\n  input,select{font:inherit;padding:9px 11px;border:1.5px solid var(--line);border-radius:8px;background:#fff;color:var(--ink)}\n  /* login */\n  .login{max-width:380px;margin:9vh auto 0;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:26px;display:grid;gap:14px}\n  .login h2{font:800 24px 'Bricolage Grotesque',sans-serif;margin:0}\n  .login label{display:grid;gap:6px;font-weight:600;font-size:14px} .login input{width:100%;padding:12px}\n  .login .go{background:var(--ink);color:#fff;padding:13px;font-size:15px}\n  .err{color:var(--err);font-weight:600;font-size:14px;margin:0;min-height:20px}\n  /* app */\n  .stats{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:16px}\n  .stat{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 16px;min-width:110px}\n  .stat b{font:800 26px 'Bricolage Grotesque',sans-serif;display:block;line-height:1.1} .stat span{font-size:13px;color:var(--muted)}\n  .policy{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin-bottom:16px;display:flex;gap:10px 14px;align-items:center;flex-wrap:wrap}\n  .policy input{width:84px} .policy .note{color:var(--muted);font-size:13px;flex-basis:100%}\n  .filters{display:flex;gap:10px;margin-bottom:14px;flex-wrap:wrap} .filters input{flex:1;min-width:180px}\n  .empty{background:var(--card);border:1px dashed var(--line);border-radius:12px;padding:36px;text-align:center;color:var(--muted)}\n  .job{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin-bottom:12px}\n  .head{display:flex;gap:12px;align-items:flex-start;justify-content:space-between;flex-wrap:wrap}\n  .who{font-weight:600;font-size:16px} .meta{color:var(--muted);font-size:13px}\n  .pill{font-size:13px;font-weight:600;padding:4px 11px;border-radius:99px;white-space:nowrap}\n  .pill.pending{background:#e6ebe8} .pill.calling{background:#dbe6f7;color:var(--blue)}\n  .pill.answered{background:#d6efe1;color:var(--go)} .pill.failed{background:#f6d9d6;color:var(--err)} .pill.cancelled{background:#e6ebe8;color:var(--muted)}\n  .dots{display:flex;gap:5px;margin:10px 0 4px;flex-wrap:wrap}\n  .dot{width:16px;height:16px;border-radius:50%;border:2px solid var(--line);background:#fff}\n  .dot.answered{background:var(--go);border-color:var(--go)} .dot.bad{background:var(--err);border-color:var(--err)}\n  .dot.live{border-color:var(--blue);animation:pulse 1s infinite}\n  @keyframes pulse{50%{background:#dbe6f7}} @media(prefers-reduced-motion:reduce){.dot.live{animation:none;background:#dbe6f7}}\n  details{margin-top:6px} summary{cursor:pointer;font-size:13px;color:var(--muted)}\n  .log{margin:6px 0 0;padding:0;list-style:none;font-size:13px;color:#3d4a45} .log li{padding:2px 0}\n  .acts{margin-top:10px}\n  [hidden]{display:none!important}\n</style>\n</head>\n<body>\n<header>\n  <h1>{{PRODUCT}}</h1>\n  <span id=\"co\"></span>\n  <button id=\"logout\" hidden>Log out</button>\n</header>\n\n<main>\n  <form class=\"login\" id=\"loginForm\" hidden>\n    <h2>Log in</h2>\n    <label>Login <input id=\"login\" autocomplete=\"username\" autocapitalize=\"none\" required></label>\n    <label>Password <input id=\"pw\" type=\"password\" autocomplete=\"current-password\" required></label>\n    <p class=\"err\" id=\"loginErr\" role=\"alert\"></p>\n    <button class=\"go\" type=\"submit\">Log in</button>\n  </form>\n\n  <div id=\"app\" hidden>\n    <div class=\"stats\" id=\"stats\"></div>\n    <div class=\"policy\">\n      <label for=\"lead\"><b>Call passengers</b></label>\n      <input id=\"lead\" type=\"number\" min=\"10\" max=\"1440\" step=\"5\">\n      <span>minutes before departure</span>\n      <button id=\"saveLead\">Save</button>\n      <span class=\"err\" id=\"leadMsg\" style=\"min-height:0\"></span>\n      <span class=\"note\" id=\"policyNote\"></span>\n    </div>\n    <div class=\"filters\">\n      <select id=\"status\" aria-label=\"Filter by status\">\n        <option value=\"\">All bookings</option><option value=\"waiting\">Waiting</option><option value=\"answered\">Reached</option>\n        <option value=\"failed\">Not reached</option><option value=\"cancelled\">Cancelled</option>\n      </select>\n      <input id=\"q\" type=\"search\" placeholder=\"Search name, phone or booking ref\" aria-label=\"Search\">\n    </div>\n    <div id=\"list\"></div>\n  </div>\n</main>\n\n<script>\nconst $ = (id) => document.getElementById(id);\nconst esc = (s) => String(s == null ? '' : s).replace(/[<>&\"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '\"': '&quot;' }[c]));\nconst t = (v) => new Date(v).toLocaleTimeString('en-NG', { timeZone: 'Africa/Lagos', hour: 'numeric', minute: '2-digit', second: '2-digit' });\nconst dt = (v) => new Date(v).toLocaleString('en-NG', { timeZone: 'Africa/Lagos', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });\nconst LABEL = { pending: 'Waiting', calling: 'Calling now', answered: 'Reached', failed: 'Not reached', cancelled: 'Cancelled' };\nconst OUT = { answered: 'Picked up', 'no-answer': 'No answer', busy: 'Busy', 'switched-off': 'Phone off', 'hung-up': 'Hung up early', failed: 'Call failed', stopped: 'Stopped' };\nlet timer, me;\n\nfunction show(loggedIn) {\n  $('loginForm').hidden = loggedIn; $('app').hidden = !loggedIn; $('logout').hidden = !loggedIn;\n  if (!loggedIn) { $('co').textContent = ''; clearInterval(timer); }\n}\nasync function api(path, opts) {\n  const r = await fetch('/portal/api/' + path, opts);\n  if (r.status === 401 && path !== 'login') { show(false); throw new Error('login'); }\n  return r;\n}\nasync function loadMe() {\n  const r = await api('me'); const d = await r.json(); me = d.company;\n  $('co').textContent = me.name;\n  if (document.activeElement !== $('lead')) $('lead').value = me.lead_minutes;\n  const s = d.stats;\n  $('stats').innerHTML = [['Bookings', s.total], ['Waiting', s.pending + s.calling], ['Reached', s.answered], ['Not reached', s.failed]]\n    .map(([l, n]) => `<div class=\"stat\"><b>${n}</b><span>${l}</span></div>`).join('');\n  const m = Math.round(me.retry_seconds / 60 * 10) / 10;\n  $('policyNote').textContent = `If a passenger doesn't pick up, we try again every ${m === 1 ? 'minute' : m + ' minutes'}, up to ${me.max_attempts} calls, and stop at departure time.`;\n}\nasync function loadList() {\n  const r = await api('reminders?status=' + encodeURIComponent($('status').value) + '&q=' + encodeURIComponent($('q').value));\n  const { reminders: jobs, now } = await r.json();\n  if (!jobs.length) { $('list').innerHTML = '<div class=\"empty\">No bookings to show. When your website sends a booking, it appears here.</div>'; return; }\n  const open = new Set([...document.querySelectorAll('details[open]')].map((d) => d.dataset.id));\n  $('list').innerHTML = jobs.map((j) => {\n    const dots = Array.from({ length: j.max_attempts }, (_, i) => {\n      const l = j.history.find((x) => x.attempt === i + 1 && x.outcome !== 'stopped');\n      if (l) return `<span class=\"dot ${l.outcome === 'answered' ? 'answered' : 'bad'}\" title=\"Attempt ${i + 1}: ${esc(OUT[l.outcome] || l.outcome)}\"></span>`;\n      if (j.status === 'calling' && j.attempts === i + 1) return '<span class=\"dot live\" title=\"Calling now\"></span>';\n      return `<span class=\"dot\" title=\"Attempt ${i + 1}\"></span>`;\n    }).join('');\n    let when = '';\n    if (j.status === 'pending') { const n = new Date(j.next_attempt_at).getTime(); when = n <= now ? 'Calling any second\u2026' : `${j.attempts ? 'Next try' : 'First call'} at ${t(n)}`; }\n    const log = j.history.map((l) => `<li>${t(l.at)} \u00b7 attempt ${l.attempt}: <b>${esc(OUT[l.outcome] || l.outcome)}</b>: ${esc(l.detail)}</li>`).join('');\n    const route = j.from && j.to ? `${esc(j.from)} \u2192 ${esc(j.to)} \u00b7 ` : '';\n    return `<article class=\"job\">\n      <div class=\"head\"><div><div class=\"who\">${esc(j.passenger_name)} \u00b7 ${esc(j.phone)}</div>\n        <div class=\"meta\">${route}departs ${dt(j.departure_time)}${j.reference ? ' \u00b7 ref ' + esc(j.reference) : ''}</div></div>\n        <span class=\"pill ${esc(j.status)}\">${esc(LABEL[j.status] || j.status)}</span></div>\n      <div class=\"dots\" aria-label=\"Call attempts\">${dots}</div>\n      <div class=\"meta\">${when}</div>\n      ${log ? `<details data-id=\"${esc(j.id)}\" ${open.has(j.id) ? 'open' : ''}><summary>Call history (${j.history.filter((h) => h.outcome !== 'stopped').length})</summary><ul class=\"log\">${log}</ul></details>` : ''}\n      ${j.status === 'pending' ? `<div class=\"acts\"><button class=\"ghost\" data-cancel=\"${esc(j.id)}\">Cancel reminder</button></div>` : ''}\n    </article>`;\n  }).join('');\n}\nasync function refresh() { try { await Promise.all([loadMe(), loadList()]); } catch (_) {} }\nfunction start() { show(true); refresh(); clearInterval(timer); timer = setInterval(refresh, 3000); }\n\n$('loginForm').addEventListener('submit', async (e) => {\n  e.preventDefault(); $('loginErr').textContent = '';\n  const r = await api('login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login: $('login').value, password: $('pw').value }) });\n  const d = await r.json();\n  if (!r.ok) { $('loginErr').textContent = d.error; return; }\n  $('pw').value = ''; start();\n});\n$('logout').addEventListener('click', async () => { await api('logout', { method: 'POST' }).catch(() => {}); show(false); });\n$('saveLead').addEventListener('click', async () => {\n  const r = await api('policy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lead_minutes: $('lead').value }) });\n  const d = await r.json();\n  $('leadMsg').style.color = r.ok ? 'var(--go)' : 'var(--err)';\n  $('leadMsg').textContent = r.ok ? 'Saved. Applies to new bookings.' : d.error;\n  setTimeout(() => ($('leadMsg').textContent = ''), 4000);\n});\n$('status').addEventListener('change', loadList);\nlet qt; $('q').addEventListener('input', () => { clearTimeout(qt); qt = setTimeout(loadList, 250); });\n$('list').addEventListener('click', async (e) => {\n  const b = e.target.closest('button[data-cancel]'); if (!b) return;\n  if (!confirm('Cancel this reminder call?')) return;\n  await api('reminders/' + b.dataset.cancel + '/cancel', { method: 'POST' }); refresh();\n});\nfetch('/portal/api/me').then((r) => (r.ok ? start() : show(false)));\n</script>\n</body>\n</html>\n", admin: "<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<title>{{PRODUCT}}: admin</title>\n<link href=\"https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,800&family=Figtree:wght@400;500;600&display=swap\" rel=\"stylesheet\">\n<style>\n  :root{--ink:#16231f;--bg:#eef1ee;--card:#fff;--line:#d3dcd6;--muted:#62706a;--go:#1f7a4d;--err:#b3261e;--blue:#2457a6;--amber:#f0b429}\n  *{box-sizing:border-box}\n  body{margin:0;background:var(--bg);font:15px/1.45 Figtree,system-ui,sans-serif;color:var(--ink)}\n  header{background:var(--ink);color:#fff;padding:16px clamp(16px,4vw,40px);display:flex;gap:16px;align-items:center;flex-wrap:wrap}\n  header h1{font:800 20px 'Bricolage Grotesque',sans-serif;margin:0;flex:1}\n  .mode{font-size:13px;padding:5px 10px;border-radius:99px;font-weight:600}\n  .mode.mock{background:var(--amber);color:var(--ink)} .mode.live{background:var(--go);color:#fff}\n  main{max-width:1000px;margin:0 auto;padding:22px 16px 60px}\n  h2{font:800 18px 'Bricolage Grotesque',sans-serif;margin:26px 0 10px}\n  .stats{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:6px}\n  .stat{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 16px;min-width:110px}\n  .stat b{font:800 26px 'Bricolage Grotesque',sans-serif;display:block;line-height:1.1} .stat span{font-size:13px;color:var(--muted)}\n  button{font:inherit;font-size:13px;font-weight:600;padding:6px 12px;border-radius:8px;border:1.5px solid var(--ink);background:#fff;color:var(--ink);cursor:pointer}\n  button:hover{background:var(--ink);color:#fff} button:focus-visible,input:focus-visible{outline:3px solid var(--amber)}\n  button.ghost{border-color:var(--line);color:var(--muted)}\n  input{font:inherit;padding:8px 10px;border:1.5px solid var(--line);border-radius:8px;background:#fff;color:var(--ink)}\n  .card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin-bottom:12px}\n  .add{display:flex;gap:10px;flex-wrap:wrap;align-items:end} .add label{display:grid;gap:4px;font-size:13px;font-weight:600}\n  .creds{background:#fff8e1;border:1.5px solid var(--amber);border-radius:12px;padding:14px 16px;margin-bottom:14px}\n  .creds code{background:#fff;border:1px solid var(--line);padding:2px 6px;border-radius:6px;user-select:all;word-break:break-all}\n  .creds p{margin:5px 0}\n  .co{display:flex;gap:10px 16px;flex-wrap:wrap;align-items:center}\n  .co .name{font-weight:600;flex:1 1 200px} .co .meta{flex-basis:100%}\n  .co input{width:70px} .co label{font-size:13px;color:var(--muted)}\n  .empty{background:var(--card);border:1px dashed var(--line);border-radius:12px;padding:30px;text-align:center;color:var(--muted)}\n  .head{display:flex;gap:12px;align-items:flex-start;justify-content:space-between;flex-wrap:wrap}\n  .who{font-weight:600;font-size:16px} .meta{color:var(--muted);font-size:13px}\n  .pill{font-size:13px;font-weight:600;padding:4px 11px;border-radius:99px;white-space:nowrap}\n  .pill.pending{background:#e6ebe8} .pill.calling{background:#dbe6f7;color:var(--blue)}\n  .pill.answered{background:#d6efe1;color:var(--go)} .pill.failed{background:#f6d9d6;color:var(--err)} .pill.cancelled{background:#e6ebe8;color:var(--muted)}\n  .dots{display:flex;gap:5px;margin:10px 0 4px;flex-wrap:wrap}\n  .dot{width:16px;height:16px;border-radius:50%;border:2px solid var(--line);background:#fff}\n  .dot.answered{background:var(--go);border-color:var(--go)} .dot.bad{background:var(--err);border-color:var(--err)}\n  .dot.live{border-color:var(--blue);animation:pulse 1s infinite}\n  @keyframes pulse{50%{background:#dbe6f7}} @media(prefers-reduced-motion:reduce){.dot.live{animation:none;background:#dbe6f7}}\n  .log{margin:8px 0 0;padding:0;list-style:none;font-size:13px;color:#3d4a45} .log li{padding:2px 0}\n  .acts{display:flex;gap:8px;margin-top:10px}\n  .tools{margin-top:24px;text-align:right}\n</style>\n</head>\n<body>\n<header>\n  <h1>{{PRODUCT}}: admin</h1>\n  <span class=\"mode\" id=\"mode\"></span>\n</header>\n<main>\n  <div class=\"stats\" id=\"stats\"></div>\n\n  <h2>Companies</h2>\n  <div id=\"creds\"></div>\n  <form class=\"card add\" id=\"addForm\">\n    <label>Company name <input id=\"cname\" required placeholder=\"Chisco Transport\"></label>\n    <label>Call before departure (min) <input id=\"clead\" type=\"number\" value=\"90\" min=\"10\" max=\"1440\" style=\"width:110px\"></label>\n    <button type=\"submit\">Add company</button>\n  </form>\n  <div id=\"companies\"></div>\n\n  <h2>Recent reminders</h2>\n  <div id=\"list\"></div>\n  <div class=\"tools\"><button class=\"ghost\" id=\"reset\">Clear all reminders (testing)</button></div>\n</main>\n<script>\nconst $ = (id) => document.getElementById(id);\nconst esc = (s) => String(s == null ? '' : s).replace(/[<>&\"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '\"': '&quot;' }[c]));\nconst t = (v) => new Date(v).toLocaleTimeString('en-NG', { timeZone: 'Africa/Lagos', hour: 'numeric', minute: '2-digit', second: '2-digit' });\nconst dt = (v) => new Date(v).toLocaleString('en-NG', { timeZone: 'Africa/Lagos', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });\nconst LABEL = { pending: 'Waiting', calling: 'Calling now', answered: 'Reached', failed: 'Not reached', cancelled: 'Cancelled' };\nconst OUT = { answered: 'Picked up', 'no-answer': 'No answer', busy: 'Busy', 'switched-off': 'Phone off', 'hung-up': 'Hung up early', failed: 'Call failed', stopped: 'Stopped' };\nconst post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });\nlet companiesHtml = '';\n\nfunction render(s) {\n  $('mode').textContent = s.config.mock ? 'Test calls (free, simulated)' : 'Live calls';\n  $('mode').className = 'mode ' + (s.config.mock ? 'mock' : 'live');\n  const st = s.stats;\n  $('stats').innerHTML = [['Reminders', st.total], ['Waiting', st.pending + st.calling], ['On a call now', s.calling + ' / ' + s.config.maxConcurrent], ['Reached', st.answered], ['Not reached', st.failed]]\n    .map(([l, n]) => `<div class=\"stat\"><b>${n}</b><span>${l}</span></div>`).join('');\n\n  // companies: only redraw when no field is being edited\n  if (!document.activeElement || !document.activeElement.closest('#companies')) {\n    $('companies').innerHTML = s.companies.map((c) => `<div class=\"card co\" data-id=\"${esc(c.id)}\">\n      <div class=\"name\">${esc(c.name)} ${c.active ? '' : '<span class=\"meta\">(paused)</span>'}</div>\n      <label>Call <input class=\"f-lead\" type=\"number\" value=\"${c.lead_minutes}\"> min before</label>\n      <label>Max calls <input class=\"f-att\" type=\"number\" value=\"${c.max_attempts}\"></label>\n      <label>Retry every <input class=\"f-ret\" type=\"number\" value=\"${c.retry_seconds}\"> sec</label>\n      <button data-a=\"save\">Save</button>\n      <button class=\"ghost\" data-a=\"pw\">Reset password</button>\n      <button class=\"ghost\" data-a=\"toggle\" data-active=\"${c.active}\">${c.active ? 'Pause' : 'Resume'}</button>\n      <div class=\"meta\">Portal login: <b>${esc(c.login)}</b> \u00b7 ${c.stats.total} reminders, ${c.stats.answered} reached, ${c.stats.failed} not reached</div>\n    </div>`).join('') || '<div class=\"empty\">No companies yet.</div>';\n  }\n  const jobs = s.reminders;\n  if (!jobs.length) { $('list').innerHTML = '<div class=\"empty\">No reminders yet.</div>'; return; }\n  $('list').innerHTML = jobs.map((j) => {\n    const dots = Array.from({ length: j.max_attempts }, (_, i) => {\n      const l = j.history.find((x) => x.attempt === i + 1 && x.outcome !== 'stopped');\n      if (l) return `<span class=\"dot ${l.outcome === 'answered' ? 'answered' : 'bad'}\" title=\"Attempt ${i + 1}: ${esc(OUT[l.outcome] || l.outcome)}\"></span>`;\n      if (j.status === 'calling' && j.attempts === i + 1) return '<span class=\"dot live\"></span>';\n      return '<span class=\"dot\"></span>';\n    }).join('');\n    let when = '';\n    if (j.status === 'pending') { const n = new Date(j.next_attempt_at).getTime(); when = n <= s.now ? 'Waiting for a free line\u2026' : `${j.attempts ? 'Next try' : 'Call'} at ${t(n)}`; }\n    const log = j.history.map((l) => `<li>${t(l.at)} \u00b7 attempt ${l.attempt}: <b>${esc(OUT[l.outcome] || l.outcome)}</b>: ${esc(l.detail)}</li>`).join('');\n    const route = j.from && j.to ? `${esc(j.from)} \u2192 ${esc(j.to)} \u00b7 ` : '';\n    return `<article class=\"card\">\n      <div class=\"head\"><div><div class=\"who\">${esc(j.passenger_name)} \u00b7 ${esc(j.phone)}</div>\n        <div class=\"meta\">${esc(j.company)} \u00b7 ${route}departs ${dt(j.departure_time)}${j.reference ? ' \u00b7 ref ' + esc(j.reference) : ''}</div></div>\n        <span class=\"pill ${esc(j.status)}\">${esc(LABEL[j.status] || j.status)}</span></div>\n      <div class=\"dots\">${dots}</div><div class=\"meta\">${when}</div><ul class=\"log\">${log}</ul>\n      <div class=\"acts\">\n        ${j.status !== 'calling' ? `<button data-r=\"call-now\" data-id=\"${esc(j.id)}\">${j.status === 'pending' ? 'Call now' : 'Call again'}</button>` : ''}\n        ${j.status === 'pending' ? `<button class=\"ghost\" data-r=\"cancel\" data-id=\"${esc(j.id)}\">Cancel</button>` : ''}\n      </div></article>`;\n  }).join('');\n}\nasync function load() { try { render(await (await fetch('/internal/state')).json()); } catch (_) {} }\nfunction showCreds(c, extra) {\n  $('creds').innerHTML = `<div class=\"creds\"><b>${esc(c.name)}: copy these now. They are shown only once.</b>\n    <p>Portal address: <code>${esc(location.origin)}/portal</code></p>\n    <p>Portal login: <code>${esc(c.login)}</code> &nbsp; Password: <code>${esc(c.password)}</code></p>\n    ${c.api_key ? `<p>API key (for their website's server): <code>${esc(c.api_key)}</code></p>` : ''}</div>`;\n}\n$('addForm').addEventListener('submit', async (e) => {\n  e.preventDefault();\n  const r = await post('/internal/companies', { name: $('cname').value, lead_minutes: $('clead').value });\n  const d = await r.json();\n  if (!r.ok) { alert(d.error); return; }\n  showCreds(d); $('cname').value = ''; load();\n});\n$('companies').addEventListener('click', async (e) => {\n  const b = e.target.closest('button'); if (!b) return;\n  const row = b.closest('.co'), id = row.dataset.id;\n  if (b.dataset.a === 'pw') { if (!confirm('Reset this company\\'s portal password?')) return; showCreds(await (await post(`/internal/companies/${id}/reset-password`)).json()); return; }\n  const body = { lead_minutes: row.querySelector('.f-lead').value, max_attempts: row.querySelector('.f-att').value, retry_seconds: row.querySelector('.f-ret').value, active: b.dataset.a === 'toggle' ? b.dataset.active !== 'true' : !row.textContent.includes('(paused)') };\n  await post(`/internal/companies/${id}/update`, body); document.activeElement.blur(); load();\n});\n$('list').addEventListener('click', async (e) => {\n  const b = e.target.closest('button'); if (!b) return;\n  await post(`/internal/reminders/${b.dataset.id}/${b.dataset.r}`); load();\n});\n$('reset').addEventListener('click', async () => { if (confirm('Delete ALL reminders and call history?')) { await post('/internal/clear-reminders'); load(); } });\nload(); setInterval(load, 2000);\n</script>\n</body>\n</html>\n" };
const page = (name) => PAGES[name].replace(/\{\{PRODUCT\}\}/g, CFG.product.replace(/[<>&"]/g, ''));

// ---------- database (SQLite) ----------
function openDb(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return new DatabaseSync(file);
}
let db;
try {
  db = openDb(CFG.dbPath);
} catch (e) {
  // e.g. DB_PATH=/data/app.db but no disk is attached to the host
  const fallback = path.join(__dirname, 'data', 'app.db');
  console.error(`\nWARNING: cannot use DB_PATH "${CFG.dbPath}" (${e.message}).\n` +
    `Using ${fallback} instead. On most hosts that folder is WIPED on every redeploy: attach a persistent disk and set DB_PATH to it.\n`);
  CFG.dbPath = fallback;
  db = openDb(fallback);
}
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS companies (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, login TEXT NOT NULL UNIQUE,
    api_key_hash TEXT NOT NULL UNIQUE, pw_salt TEXT NOT NULL, pw_hash TEXT NOT NULL,
    lead_minutes INTEGER NOT NULL, max_attempts INTEGER NOT NULL, retry_seconds INTEGER NOT NULL,
    active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS reminders (
    id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id), reference TEXT,
    name TEXT NOT NULL, phone TEXT NOT NULL, from_city TEXT, to_city TEXT, departure TEXT NOT NULL,
    webhook_url TEXT, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
    next_run_at INTEGER NOT NULL, started_at INTEGER, session_id TEXT, picked_up INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS ux_ref ON reminders(company_id, reference) WHERE reference IS NOT NULL;
  CREATE INDEX IF NOT EXISTS ix_due ON reminders(status, next_run_at);
  CREATE INDEX IF NOT EXISTS ix_company ON reminders(company_id, created_at);
  CREATE TABLE IF NOT EXISTS attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, reminder_id TEXT NOT NULL REFERENCES reminders(id) ON DELETE CASCADE,
    attempt INTEGER NOT NULL, outcome TEXT NOT NULL, detail TEXT, at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS ix_att ON attempts(reminder_id);
`);
const get = (sql, ...p) => db.prepare(sql).get(...p);
const all = (sql, ...p) => db.prepare(sql).all(...p);
const run = (sql, ...p) => db.prepare(sql).run(...p);

// ---------- small helpers ----------
const now = () => Date.now();
const uid = (p) => p + '_' + crypto.randomBytes(5).toString('hex');
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const safeEq = (a, b) => { const x = crypto.createHash('sha256').update(String(a)).digest(), y = crypto.createHash('sha256').update(String(b)).digest(); return crypto.timingSafeEqual(x, y); };
const clamp = (n, lo, hi, dflt) => (Number.isFinite(+n) && +n > 0 ? Math.min(hi, Math.max(lo, Math.round(+n))) : dflt);
const hashPw = (pw, salt) => crypto.scryptSync(String(pw), salt, 32).toString('hex');
const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

function secret() {
  if (E.SESSION_SECRET) return E.SESSION_SECRET;
  let r = get("SELECT value FROM settings WHERE key='session_secret'");
  if (!r) { run("INSERT INTO settings VALUES ('session_secret', ?)", crypto.randomBytes(32).toString('hex')); r = get("SELECT value FROM settings WHERE key='session_secret'"); }
  return r.value;
}
const SECRET = secret();

function normalizePhone(raw) {
  let p = String(raw || '').replace(/[\s\-().]/g, '');
  if (/^0\d{10}$/.test(p)) p = '+234' + p.slice(1);
  else if (/^234\d{10}$/.test(p)) p = '+' + p;
  else if (/^\d{10}$/.test(p)) p = '+234' + p;
  return /^\+\d{10,15}$/.test(p) ? p : null;
}
const TZ = 'Africa/Lagos';
const fmtTime = (iso) => new Date(iso).toLocaleTimeString('en-NG', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true });
const dayKey = (t) => new Date(t).toLocaleDateString('en-CA', { timeZone: TZ });
function dayWord(iso) {
  const d = dayKey(iso);
  if (d === dayKey(now())) return 'today';
  if (d === dayKey(now() + 864e5)) return 'tomorrow';
  return 'on ' + new Date(iso).toLocaleDateString('en-NG', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' });
}
function reminderText(r, companyName) {
  const first = r.name.split(' ')[0];
  const route = r.from_city && r.to_city ? ` from ${r.from_city} to ${r.to_city}` : '';
  const one = `Hello ${first}. This is a reminder from ${companyName}. Your bus${route} leaves ${dayWord(r.departure)} at ${fmtTime(r.departure)}. Please be at the park at least thirty minutes before departure. Thank you, and safe journey.`;
  return one + ' ... I will repeat. ' + one;
}

// ---------- companies ----------
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'company';
const newApiKey = () => 'ck_' + crypto.randomBytes(24).toString('base64url');
const newPassword = () => { const a = 'abcdefghjkmnpqrstuvwxyz23456789'; return Array.from(crypto.randomBytes(10), (b) => a[b % a.length]).join(''); };

function createCompany(name, opts = {}) {
  let login = slug(name), n = 1;
  while (get('SELECT 1 FROM companies WHERE login=?', login)) login = slug(name) + '-' + ++n;
  const apiKey = opts.apiKey || newApiKey();
  const password = opts.password || newPassword();
  const salt = crypto.randomBytes(16).toString('hex');
  const id = uid('co');
  run('INSERT INTO companies (id,name,login,api_key_hash,pw_salt,pw_hash,lead_minutes,max_attempts,retry_seconds,active,created_at) VALUES (?,?,?,?,?,?,?,?,?,1,?)',
    id, String(name).trim().slice(0, 60), login, sha(apiKey), salt, hashPw(password, salt),
    clamp(opts.lead, 10, 1440, CFG.defLead), clamp(opts.attempts, 1, 15, CFG.defAttempts), clamp(opts.retry, 20, 3600, CFG.defRetrySec), now());
  return { id, login, apiKey, password };
}
function setPassword(id) {
  const password = newPassword(), salt = crypto.randomBytes(16).toString('hex');
  run('UPDATE companies SET pw_salt=?, pw_hash=? WHERE id=?', salt, hashPw(password, salt), id);
  return password;
}
const companyView = (c) => ({ id: c.id, name: c.name, login: c.login, lead_minutes: c.lead_minutes, max_attempts: c.max_attempts, retry_seconds: c.retry_seconds, active: !!c.active });

// first run: create one demo company so the test booking site works straight away
if (!get('SELECT COUNT(*) c FROM companies').c) {
  const demo = createCompany(E.SEED_COMPANY || 'Victoria Travels', { apiKey: E.SEED_API_KEY || undefined, password: E.SEED_PASSWORD || undefined });
  console.log(`\nFirst run: created demo company "${E.SEED_COMPANY || 'Victoria Travels'}"\n  API key: ${demo.apiKey}\n  Portal login: ${demo.login}  password: ${demo.password}   (shown once; reset it from the admin dashboard)\n`);
}

// ---------- views ----------
const SELECT_R = 'SELECT r.*, c.name AS company_name, c.max_attempts AS max_attempts FROM reminders r JOIN companies c ON c.id=r.company_id';
function view(r) {
  const hist = all('SELECT attempt,outcome,detail,at FROM attempts WHERE reminder_id=? ORDER BY id', r.id);
  return {
    id: r.id, reference: r.reference, status: r.status, passenger_name: r.name, phone: r.phone,
    from: r.from_city, to: r.to_city, departure_time: r.departure,
    attempts: r.attempts, max_attempts: r.max_attempts,
    next_attempt_at: r.status === 'pending' ? new Date(r.next_run_at).toISOString() : null,
    created_at: new Date(r.created_at).toISOString(),
    history: hist.map((h) => ({ at: new Date(h.at).toISOString(), attempt: h.attempt, outcome: h.outcome, detail: h.detail })),
  };
}
const counts = (where, ...p) => {
  const o = { total: 0, pending: 0, calling: 0, answered: 0, failed: 0, cancelled: 0 };
  for (const x of all(`SELECT status, COUNT(*) c FROM reminders ${where} GROUP BY status`, ...p)) { o[x.status] = x.c; o.total += x.c; }
  return o;
};

// ---------- calling providers ----------
// Mock: pretends to call so everything can be tested for free.
function mockCall(r) {
  setTimeout(() => {
    const x = Math.random();
    if (x < 0.35) finishAttempt(r.id, 'answered', 'Mock: picked up and listened (' + Math.round(14 + Math.random() * 8) + 's)');
    else if (x < 0.6) finishAttempt(r.id, 'no-answer', 'Mock: rang out');
    else if (x < 0.8) finishAttempt(r.id, 'switched-off', 'Mock: phone switched off or unreachable');
    else finishAttempt(r.id, 'busy', 'Mock: line busy');
  }, 3000 + Math.random() * 3000);
}

// Africa's Talking Voice API
async function atCall(r) {
  const url = CFG.atSandbox ? 'https://voice.sandbox.africastalking.com/call' : 'https://voice.africastalking.com/call';
  const body = new URLSearchParams({ username: CFG.atUser, to: r.phone, from: CFG.atFrom, clientRequestId: r.id + ':' + (r.attempts + 1) });
  try {
    const res = await fetch(url, {
      method: 'POST', signal: AbortSignal.timeout(15000),
      headers: { apiKey: CFG.atKey, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body,
    });
    const text = await res.text();
    let data = {}; try { data = JSON.parse(text); } catch (_) {}
    const entry = data.entries && data.entries[0];
    if (!entry || entry.status !== 'Queued')
      return finishAttempt(r.id, 'failed', 'Provider rejected call: ' + ((entry && entry.status) || data.errorMessage || text.slice(0, 160)));
    run('UPDATE reminders SET session_id=? WHERE id=?', entry.sessionId, r.id);
  } catch (e) {
    finishAttempt(r.id, 'failed', 'Could not reach provider: ' + e.message);
  }
}

// ---------- call engine ----------
function placeCall(r) {
  run("UPDATE reminders SET attempts=attempts+1, status='calling', started_at=?, session_id=NULL, picked_up=0 WHERE id=?", now(), r.id);
  const cur = get('SELECT * FROM reminders WHERE id=?', r.id);
  console.log(`[call] ${r.company_name} / ${r.name} ${r.phone} attempt ${cur.attempts}/${r.max_attempts}`);
  CFG.mock ? mockCall(cur) : atCall({ ...cur, attempts: cur.attempts - 1 });
}

function finishAttempt(id, outcome, detail) {
  const r = get(SELECT_R + " WHERE r.id=? AND r.status='calling'", id);
  if (!r) return; // duplicate or late callback
  run('INSERT INTO attempts (reminder_id,attempt,outcome,detail,at) VALUES (?,?,?,?,?)', id, r.attempts, outcome, detail, now());
  const co = get('SELECT retry_seconds FROM companies WHERE id=?', r.company_id);
  let status, next = r.next_run_at;
  if (outcome === 'answered') status = 'answered';
  else if (r.attempts >= r.max_attempts) status = 'failed';
  else if (now() + co.retry_seconds * 1000 > new Date(r.departure).getTime()) {
    status = 'failed';
    run('INSERT INTO attempts (reminder_id,attempt,outcome,detail,at) VALUES (?,?,?,?,?)', id, r.attempts, 'stopped', 'Departure time reached, no more retries', now());
  } else { status = 'pending'; next = now() + co.retry_seconds * 1000; }
  run('UPDATE reminders SET status=?, next_run_at=?, started_at=NULL WHERE id=?', status, next, id);
  console.log(`[result] ${id} attempt ${r.attempts}: ${outcome} -> ${status}`);
  if (status === 'answered' || status === 'failed') notify(id);
}

async function notify(id) {
  const r = get(SELECT_R + ' WHERE r.id=?', id);
  if (!r || !r.webhook_url) return;
  try {
    await fetch(r.webhook_url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(5000),
      body: JSON.stringify({ event: 'reminder.' + r.status, reminder: view(r) }),
    });
  } catch (e) { console.log('[webhook] failed for', id, e.message); }
}

function tick() {
  const t = now();
  // calls the provider never reported on
  for (const r of all("SELECT id FROM reminders WHERE status='calling' AND started_at < ?", t - CFG.ringTimeoutSec * 1000))
    finishAttempt(r.id, 'no-answer', 'No result from provider in time');
  // reminders whose bus has already left: stop
  for (const r of all("SELECT id, attempts FROM reminders WHERE status='pending' AND next_run_at <= ? AND departure < ?", t, new Date(t).toISOString())) {
    run("UPDATE reminders SET status='failed' WHERE id=?", r.id);
    run('INSERT INTO attempts (reminder_id,attempt,outcome,detail,at) VALUES (?,?,?,?,?)', r.id, r.attempts, 'stopped', 'Departure time passed before the call could be made', t);
    notify(r.id);
  }
  // start new calls, never more than the concurrency cap
  const slots = CFG.maxConcurrent - get("SELECT COUNT(*) c FROM reminders WHERE status='calling'").c;
  if (slots <= 0) return;
  for (const r of all(SELECT_R + " WHERE r.status='pending' AND r.next_run_at <= ? ORDER BY r.departure LIMIT ?", t, slots)) placeCall(r);
}
// after a restart, a call that was "in progress" has an unknown result
for (const r of all("SELECT id FROM reminders WHERE status='calling'")) finishAttempt(r.id, 'no-answer', 'Service restarted during the call');
setInterval(() => { try { tick(); } catch (e) { console.error('tick error', e); } }, 2000);

// ---------- HTTP plumbing ----------
const json = (res, code, obj, headers = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(obj)); };
const readBody = (req) => new Promise((ok, no) => {
  let d = ''; req.on('data', (c) => { d += c; if (d.length > 1e5) { no(new Error('too large')); req.destroy(); } }); req.on('end', () => ok(d));
});
const parseJson = async (req) => { try { return JSON.parse((await readBody(req)) || '{}'); } catch (_) { return null; } };

function apiAuth(req) {
  const m = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  return m ? get('SELECT * FROM companies WHERE api_key_hash=? AND active=1', sha(m[1].trim())) || null : null;
}
function adminAuth(req, res) {
  const h = (req.headers.authorization || '').replace(/^Basic\s+/i, '');
  const s = Buffer.from(h, 'base64').toString(), i = s.indexOf(':');
  if (i > -1 && safeEq(s.slice(0, i), CFG.dashUser) && safeEq(s.slice(i + 1), CFG.dashPass)) return true;
  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Admin"' }); res.end('Login required');
  return false;
}
// portal sessions: signed cookie
const sign = (s) => crypto.createHmac('sha256', SECRET).update(s).digest('hex');
function makeCookie(req, companyId) {
  const payload = companyId + '.' + (now() + 7 * 864e5);
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  return `sid=${payload}.${sign(payload)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${7 * 86400}${secure}`;
}
function portalCompany(req) {
  const m = (req.headers.cookie || '').match(/(?:^|;\s*)sid=([^;]+)/);
  if (!m) return null;
  const parts = m[1].split('.');
  if (parts.length !== 3) return null;
  const payload = parts[0] + '.' + parts[1];
  if (!safeEq(sign(payload), parts[2]) || +parts[1] < now()) return null;
  return get('SELECT * FROM companies WHERE id=? AND active=1', parts[0]) || null;
}
const tries = new Map(); // login rate limit per IP
function tooMany(ip) {
  const t = now(), list = (tries.get(ip) || []).filter((x) => t - x < 15 * 60000);
  tries.set(ip, list);
  return list.length >= 10;
}

// ---------- routes ----------
async function handle(req, res) {
  const p = new URL(req.url, 'http://x').pathname;
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  let m;

  if (p === '/health') return json(res, 200, { ok: true, mode: CFG.mock ? 'mock' : 'live' });
  if (p === '/') { res.writeHead(302, { Location: '/portal' }); return res.end(); }

  // ===== public API (used by the bus companies' websites) =====
  if (p.startsWith('/v1/')) {
    const co = apiAuth(req);
    if (!co) return json(res, 401, { error: 'Missing or wrong API key. Send header: Authorization: Bearer YOUR_KEY' });

    if (req.method === 'POST' && p === '/v1/reminders') {
      const d = await parseJson(req);
      if (!d) return json(res, 400, { error: 'Body must be valid JSON.' });
      const phone = normalizePhone(d.phone);
      const dep = new Date(d.departure_time).getTime();
      if (!d.passenger_name || String(d.passenger_name).trim().length < 2) return json(res, 400, { error: 'passenger_name is required.' });
      if (!phone) return json(res, 400, { error: 'phone is missing or not a valid number.' });
      if (!dep) return json(res, 400, { error: 'departure_time is required (ISO 8601, e.g. 2026-10-08T08:00:00+01:00).' });
      if (dep < now() + 60000) return json(res, 400, { error: 'departure_time must be in the future.' });
      if (d.consent !== true) return json(res, 400, { error: 'consent must be true: the passenger agreed to receive an automated reminder call.' });
      if (d.webhook_url && !/^https?:\/\//.test(d.webhook_url)) return json(res, 400, { error: 'webhook_url must start with http:// or https://' });
      if (d.reference) {
        const dupe = get(SELECT_R + ' WHERE r.company_id=? AND r.reference=?', co.id, String(d.reference));
        if (dupe) return json(res, 200, { reminder: view(dupe), first_call_at: new Date(dupe.next_run_at).toISOString(), duplicate: true });
      }
      let runAt = dep - co.lead_minutes * 60000;                      // the company's own policy
      if (d.call_at && new Date(d.call_at).getTime()) runAt = new Date(d.call_at).getTime();
      if (+d.call_in_seconds > 0) runAt = now() + Math.min(+d.call_in_seconds, 86400) * 1000; // for testing
      if (runAt < now() + 3000) runAt = now() + 3000;                  // already inside the window: call right away
      const id = uid('rem');
      run('INSERT INTO reminders (id,company_id,reference,name,phone,from_city,to_city,departure,webhook_url,status,attempts,next_run_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,0,?,?)',
        id, co.id, d.reference ? String(d.reference).slice(0, 80) : null, String(d.passenger_name).trim().slice(0, 60), phone,
        d.from ? String(d.from).slice(0, 40) : null, d.to ? String(d.to).slice(0, 40) : null,
        new Date(dep).toISOString(), d.webhook_url || null, 'pending', runAt, now());
      return json(res, 201, { reminder: view(get(SELECT_R + ' WHERE r.id=?', id)), first_call_at: new Date(runAt).toISOString() });
    }
    if (req.method === 'GET' && p === '/v1/reminders')
      return json(res, 200, { reminders: all(SELECT_R + ' WHERE r.company_id=? ORDER BY r.created_at DESC LIMIT 100', co.id).map(view) });
    if ((m = p.match(/^\/v1\/reminders\/([\w-]+)(\/cancel)?$/))) {
      const r = get(SELECT_R + ' WHERE r.id=? AND r.company_id=?', m[1], co.id);
      if (!r) return json(res, 404, { error: 'Reminder not found.' });
      if (req.method === 'GET' && !m[2]) return json(res, 200, { reminder: view(r) });
      if (req.method === 'POST' && m[2]) {
        if (r.status === 'pending') run("UPDATE reminders SET status='cancelled' WHERE id=?", r.id);
        return json(res, 200, { reminder: view(get(SELECT_R + ' WHERE r.id=?', r.id)) });
      }
    }
    return json(res, 404, { error: 'Unknown endpoint.' });
  }

  // ===== provider webhook (Africa's Talking) =====
  if (req.method === 'POST' && p === '/voice/callback') {
    const f = Object.fromEntries(new URLSearchParams(await readBody(req)));
    console.log('[callback]', JSON.stringify(f));
    const crid = (f.clientRequestId || '').split(':')[0];
    const r = (f.sessionId && get(SELECT_R + ' WHERE r.session_id=?', f.sessionId)) || (crid && get(SELECT_R + ' WHERE r.id=?', crid));
    res.writeHead(200, { 'Content-Type': 'application/xml' });
    if (!r) return res.end('<?xml version="1.0"?><Response></Response>');
    if (f.isActive === '1') {
      run('UPDATE reminders SET picked_up=1, session_id=COALESCE(session_id, ?) WHERE id=?', f.sessionId || null, r.id);
      return res.end(`<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="woman" playBeep="false">${esc(reminderText(r, r.company_name))}</Say></Response>`);
    }
    const dur = +f.durationInSeconds || 0;
    if (r.picked_up && dur >= CFG.minListenSec) finishAttempt(r.id, 'answered', `Picked up, listened ${dur}s`);
    else if (r.picked_up) finishAttempt(r.id, 'hung-up', `Picked up but hung up after ${dur}s`);
    else finishAttempt(r.id, 'no-answer', 'Not answered' + (f.hangupCause ? ' (' + f.hangupCause + ')' : ''));
    return res.end('<?xml version="1.0"?><Response></Response>');
  }

  // ===== company portal =====
  if (p === '/portal' && req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(page('portal')); }
  if (p === '/portal/api/login' && req.method === 'POST') {
    if (tooMany(ip)) return json(res, 429, { error: 'Too many attempts. Try again in 15 minutes.' });
    const d = await parseJson(req) || {};
    const co = get('SELECT * FROM companies WHERE login=? AND active=1', String(d.login || '').trim().toLowerCase());
    if (!co || !safeEq(hashPw(d.password || '', co.pw_salt), co.pw_hash)) { tries.get(ip).push(now()); return json(res, 401, { error: 'Wrong login or password.' }); }
    return json(res, 200, { ok: true }, { 'Set-Cookie': makeCookie(req, co.id) });
  }
  if (p === '/portal/api/logout' && req.method === 'POST') return json(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; HttpOnly; Path=/; Max-Age=0' });
  if (p.startsWith('/portal/api/')) {
    const co = portalCompany(req);
    if (!co) return json(res, 401, { error: 'Not logged in.' });
    if (req.method === 'GET' && p === '/portal/api/me')
      return json(res, 200, { company: companyView(co), stats: counts('WHERE company_id=?', co.id), now: now() });
    if (req.method === 'GET' && p === '/portal/api/reminders') {
      const u = new URL(req.url, 'http://x').searchParams;
      let sql = SELECT_R + ' WHERE r.company_id=?'; const args = [co.id];
      const st = u.get('status');
      if (st === 'waiting') sql += " AND r.status IN ('pending','calling')";
      else if (['answered', 'failed', 'cancelled'].includes(st)) { sql += ' AND r.status=?'; args.push(st); }
      const q = (u.get('q') || '').trim();
      if (q) { sql += ' AND (r.name LIKE ? OR r.phone LIKE ? OR r.reference LIKE ?)'; args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
      return json(res, 200, { reminders: all(sql + ' ORDER BY r.departure DESC LIMIT 200', ...args).map(view), now: now() });
    }
    if (req.method === 'POST' && p === '/portal/api/policy') {
      const d = await parseJson(req) || {};
      const lead = clamp(d.lead_minutes, 10, 1440, 0);
      if (!lead) return json(res, 400, { error: 'Enter a number of minutes between 10 and 1440.' });
      run('UPDATE companies SET lead_minutes=? WHERE id=?', lead, co.id);
      return json(res, 200, { ok: true, lead_minutes: lead });
    }
    if (req.method === 'POST' && (m = p.match(/^\/portal\/api\/reminders\/([\w-]+)\/cancel$/))) {
      const r = get('SELECT id FROM reminders WHERE id=? AND company_id=?', m[1], co.id);
      if (!r) return json(res, 404, { error: 'Not found' });
      run("UPDATE reminders SET status='cancelled' WHERE id=? AND status='pending'", r.id);
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: 'Unknown endpoint.' });
  }

  // ===== operator admin (you) =====
  if (p === '/dashboard' || p.startsWith('/internal/')) {
    if (!adminAuth(req, res)) return;
    if (p === '/dashboard') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(page('admin')); }
    if (req.method === 'GET' && p === '/internal/state') {
      const companies = all('SELECT * FROM companies ORDER BY created_at').map((c) => ({ ...companyView(c), stats: counts('WHERE company_id=?', c.id) }));
      return json(res, 200, {
        now: now(), config: { mock: CFG.mock, maxConcurrent: CFG.maxConcurrent, product: CFG.product },
        stats: counts(''), calling: get("SELECT COUNT(*) c FROM reminders WHERE status='calling'").c,
        companies, reminders: all(SELECT_R + ' ORDER BY r.created_at DESC LIMIT 200').map((r) => ({ ...view(r), company: r.company_name })),
      });
    }
    if (req.method === 'POST' && p === '/internal/companies') {
      const d = await parseJson(req) || {};
      if (!d.name || String(d.name).trim().length < 2) return json(res, 400, { error: 'Enter the company name.' });
      const c = createCompany(d.name, { lead: d.lead_minutes, attempts: d.max_attempts, retry: d.retry_seconds });
      return json(res, 201, { name: String(d.name).trim(), login: c.login, api_key: c.apiKey, password: c.password });
    }
    if (req.method === 'POST' && (m = p.match(/^\/internal\/companies\/([\w-]+)\/(reset-password|update)$/))) {
      const c = get('SELECT * FROM companies WHERE id=?', m[1]);
      if (!c) return json(res, 404, { error: 'Not found' });
      if (m[2] === 'reset-password') return json(res, 200, { name: c.name, login: c.login, password: setPassword(c.id) });
      const d = await parseJson(req) || {};
      run('UPDATE companies SET lead_minutes=?, max_attempts=?, retry_seconds=?, active=? WHERE id=?',
        clamp(d.lead_minutes, 10, 1440, c.lead_minutes), clamp(d.max_attempts, 1, 15, c.max_attempts), clamp(d.retry_seconds, 20, 3600, c.retry_seconds),
        d.active === false ? 0 : 1, c.id);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && (m = p.match(/^\/internal\/reminders\/([\w-]+)\/(call-now|cancel)$/))) {
      const r = get(SELECT_R + ' WHERE r.id=?', m[1]);
      if (!r) return json(res, 404, { error: 'Not found' });
      if (m[2] === 'call-now') {
        if (r.status === 'calling') return json(res, 409, { error: 'Already calling' });
        if (r.status !== 'pending') run("UPDATE reminders SET status='pending', attempts=? WHERE id=?", Math.min(r.attempts, r.max_attempts - 1), r.id);
        run('UPDATE reminders SET next_run_at=? WHERE id=?', now(), r.id);
      } else if (r.status !== 'calling') run("UPDATE reminders SET status='cancelled' WHERE id=?", r.id);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && p === '/internal/clear-reminders') { run('DELETE FROM reminders'); return json(res, 200, { ok: true }); }
  }
  res.writeHead(404); res.end('Not found');
}

http.createServer((req, res) => handle(req, res).catch((e) => { console.error(e); if (!res.headersSent) res.writeHead(500); res.end('Server error'); }))
  .listen(CFG.port, () => {
    console.log(`${CFG.product} running on port ${CFG.port}`);
    console.log(`  Database: ${CFG.dbPath}`);
    console.log(`  API:      /v1/reminders`);
    console.log(`  Portal:   /portal      (bus companies log in here)`);
    console.log(`  Admin:    /dashboard   (login: ${CFG.dashUser} / ${CFG.dashPass === 'changeme' ? 'changeme  <- change DASHBOARD_PASSWORD' : '(your password)'})`);
    console.log(`  Calls:    ${CFG.mock ? "MOCK (simulated, free). Add Africa's Talking keys for real calls." : "LIVE via Africa's Talking" + (CFG.atSandbox ? ' (sandbox)' : '')}, up to ${CFG.maxConcurrent} at once\n`);
  });
