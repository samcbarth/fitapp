// FitApp: weight counter + one-tap workout presets -> timestamped records -> data/records.json in the private data repo.
const VERSION = '2026-11-03 18:35 UTC'; // auto-stamped by .git/hooks/pre-commit
const REPO = 'samcbarth/fitapp-data'; // private; the app itself is served from public samcbarth/fitapp
const PATH = 'data/records.json';
const KEY = 'fitapp.v2';
const METRICS = [
  { id: 'weight', label: 'Weight today', unit: 'lb', step: 1, dec: 1 },
];
// Presets: one tap logs a 'set' record. value = weight x reps (lifting volume); walks have weight 0.
const DEFAULT_PRESETS = [
  { id: 'kb-press', name: 'KB overhead/chest press', weight: 25, reps: 30, unit: 'reps' },
  { id: 'walk-block', name: 'Walk around block', weight: 0, reps: 1, unit: 'lap' },
];
const $ = (s) => document.querySelector(s);
const ld = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const sv = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

let records = ld(KEY, []); // {ts, metric, value, synced, ...extra}; metric 'del' is a tombstone {ref}
let presets = ld('fitapp.presets', DEFAULT_PRESETS);
let token = ld('fitapp.token', '');
let tab = 'today';
let status = '';
let editing = null; // preset id open in the Settings editor
const cur = {}; // working counter values

const localDay = (ts) => new Date(ts).toLocaleDateString('en-CA');
const todayKey = () => new Date().toLocaleDateString('en-CA');
const rkey = (r) => r.id || r.ts + r.metric; // legacy records have no id
const live = () => { const dead = new Set(records.filter((r) => r.metric === 'del').map((r) => r.ref)); return records.filter((r) => r.metric !== 'del' && !dead.has(rkey(r))); };
// daily lifting volume: logged sets plus any legacy manual 'volume' total (last per day)
function volumeByDay() {
  const out = {}, manual = {};
  live().forEach((r) => {
    const d = localDay(r.ts);
    if (r.metric === 'set') out[d] = (out[d] || 0) + r.value;
    if (r.metric === 'volume') manual[d] = r.value;
  });
  Object.entries(manual).forEach(([d, v]) => (out[d] = (out[d] || 0) + v));
  return out;
}
function lastFor(m) {
  const r = live().filter((x) => x.metric === m.id);
  return r.length ? r.at(-1).value : 0;
}
METRICS.forEach((m) => (cur[m.id] = lastFor(m)));

const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const presetLine = (p) => (p.weight ? p.weight + ' lb x ' : '') + p.reps + ' ' + p.unit;

function counter(m) {
  const saved = live().filter((x) => x.metric === m.id && localDay(x.ts) === todayKey()).at(-1);
  return `<div class="card"><h2>${m.label}</h2>
    <div class="ctr">
      <button class="pm" data-dec="${m.id}" aria-label="minus">-</button>
      <input id="in-${m.id}" type="number" inputmode="decimal" step="${m.step}" value="${cur[m.id]}" data-in="${m.id}">
      <button class="pm" data-inc="${m.id}" aria-label="plus">+</button>
    </div>
    <div class="row"><button class="btn" data-save="${m.id}">Save ${m.unit}</button></div>
    <div class="mute">${saved ? 'Last saved ' + fmtTime(saved.ts) + ': ' + saved.value : 'Not saved today'}</div></div>`;
}

function presetsCard() {
  return `<div class="card"><h2>Workout presets <span class="mute">tap to log</span></h2>
    <div class="grid">${presets.map((p) => `<button class="preset" data-log="${p.id}"><b>${esc(p.name)}</b><span>${esc(presetLine(p))}</span></button>`).join('')}</div></div>`;
}

function todayLog() {
  const t = live().filter((r) => localDay(r.ts) === todayKey()).reverse();
  const vol = volumeByDay()[todayKey()] || 0;
  const line = (r) => r.metric === 'set' ? `${esc(r.name)}: ${esc(presetLine(r))}` : r.metric === 'weight' ? `Weight ${r.value} lb` : `Volume ${r.value} lb`;
  return `<div class="card"><h2>Today's log <span class="mute">volume ${vol} lb</span></h2>
    ${t.length ? t.map((r) => `<div class="item"><span>${fmtTime(r.ts)} · ${line(r)}</span><button class="x" data-del="${esc(rkey(r))}" aria-label="delete">✕</button></div>`).join('') : '<div class="mute">Nothing logged yet.</div>'}</div>`;
}

function chart(m) {
  let byDay = {};
  if (m.id === 'volume') byDay = volumeByDay();
  else live().filter((x) => x.metric === m.id).forEach((x) => (byDay[localDay(x.ts)] = x.value)); // last value per day
  const days = Object.keys(byDay).sort().slice(-30);
  if (days.length < 2) return `<div class="card"><h2>${m.label}</h2><div class="mute">Need 2+ days of data.</div></div>`;
  const vals = days.map((d) => byDay[d]);
  const lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo || 1;
  const W = 320, H = 120, P = 8;
  const pts = vals.map((v, i) => [P + (i * (W - 2 * P)) / (vals.length - 1), H - P - ((v - lo) / span) * (H - 2 * P)]);
  return `<div class="card"><h2>${m.label} <span class="mute">${days[0]} to ${days.at(-1)}</span></h2>
    <svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${m.label} chart"><polyline fill="none" stroke="#ff7a1a" stroke-width="2" points="${pts.map((p) => p.join(',')).join(' ')}"/>${pts.map((p) => `<circle cx="${p[0]}" cy="${p[1]}" r="3" fill="#ff7a1a"/>`).join('')}</svg>
    <div class="mute">min ${lo} · max ${hi} · latest ${vals.at(-1)}</div></div>`;
}

function presetEditor() {
  const row = (p) => editing === p.id
    ? `<div class="edit" data-pid="${p.id}">
        <input data-f="name" value="${esc(p.name)}" placeholder="Name">
        <div class="row"><input data-f="weight" type="number" inputmode="decimal" value="${p.weight}" placeholder="lb"><input data-f="reps" type="number" inputmode="decimal" value="${p.reps}" placeholder="reps"><input data-f="unit" value="${esc(p.unit)}" placeholder="unit"></div>
        <div class="row"><button class="btn" data-act="psave">Save</button><button class="btn ghost" data-act="pdel">Delete</button></div></div>`
    : `<div class="item"><span>${esc(p.name)} · <span class="mute">${esc(presetLine(p))}</span></span><button class="x" data-pedit="${p.id}">Edit</button></div>`;
  return `<div class="card"><h2>Presets</h2>${presets.map(row).join('')}
    <div class="row" style="margin-top:12px"><button class="btn" data-act="padd">Add preset</button></div></div>`;
}

const views = {
  today: () => METRICS.map(counter).join('') + presetsCard() + todayLog(),
  charts: () => METRICS.concat([{ id: 'volume', label: 'Lifting volume' }]).map(chart).join(''),
  settings: () => `<div class="card"><h2>GitHub sync</h2>
      <p class="mute">Saved records are written to ${PATH} in the private repo ${REPO}. Paste a fine-grained token (that repo, Contents: read and write). It stays on this device.</p>
      <div class="row"><input id="tok" type="password" placeholder="github_pat_..." value="${token}"></div>
      <div class="row"><button class="btn" data-act="tok">Save token</button><button class="btn" data-act="sync">Sync now</button></div>
      <div class="mute">Unsynced records: ${records.filter((r) => !r.synced).length}</div></div>` + presetEditor(),
};

function render() {
  $('#status').textContent = status;
  if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
  $('#view').innerHTML = views[tab]();
  document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
}

const b64 = (s) => btoa(unescape(encodeURIComponent(s)));
const unb64 = (s) => decodeURIComponent(escape(atob(s.replace(/\n/g, ''))));


// data/today.json: tiny summary for home-screen widgets (KWGT etc.)
async function putSummary(headers) {
  const day = todayKey();
  const w = live().filter((r) => r.metric === 'weight').at(-1);
  const body = { date: day, weight: w ? w.value : null, weight_ts: w ? w.ts : null, volume: volumeByDay()[day] || 0, updated: new Date().toISOString() };
  const api = `https://api.github.com/repos/${REPO}/contents/data/today.json`;
  const g = await fetch(api, { headers });
  const sha = g.ok ? (await g.json()).sha : undefined;
  const p = await fetch(api, { method: 'PUT', headers, body: JSON.stringify({ message: 'update today summary', content: b64(JSON.stringify(body, null, 1) + '\n'), sha }) });
  if (!p.ok) throw new Error('summary ' + p.status);
}

async function sync() {
  const pending = records.filter((r) => !r.synced);
  if (!token) { status = pending.length ? 'Saved locally. Add a token in Settings to sync.' : ''; return; }
  if (!pending.length) return;
  const api = `https://api.github.com/repos/${REPO}/contents/${PATH}`;
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      let sha, remote = [];
      const g = await fetch(api, { headers });
      if (g.ok) { const j = await g.json(); sha = j.sha; remote = JSON.parse(unb64(j.content)); }
      else if (g.status === 404 || g.status === 403) throw new Error('token cannot access ' + REPO + ', update it in Settings');
      else throw new Error('GitHub ' + g.status);
      const seen = new Set(remote.map(rkey));
      const merged = remote.concat(pending.filter((r) => !seen.has(rkey(r))).map(({ synced, ...r }) => r));
      const p = await fetch(api, { method: 'PUT', headers, body: JSON.stringify({ message: `log ${pending.length} record(s)`, content: b64(JSON.stringify(merged, null, 1) + '\n'), sha }) });
      if (p.status === 409 || p.status === 422) continue; // stale sha, retry
      if (!p.ok) throw new Error('GitHub ' + p.status);
      pending.forEach((r) => (r.synced = true));
      sv(KEY, records);
      status = 'Synced to GitHub.';
      await putSummary(headers).catch((e) => (status = 'Synced; widget summary failed (' + e.message + ').'));
      return;
    } catch (e) { status = 'Sync failed (' + e.message + '). Will retry.'; return; }
  }
  status = 'Sync conflict. Will retry.';
}

function add(rec, msg) {
  records.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), ts: new Date().toISOString(), ...rec, synced: false });
  sv(KEY, records);
  status = msg;
  render();
  sync().then(render);
}

function save(id) {
  const v = parseFloat($('#in-' + id).value);
  if (isNaN(v)) return;
  cur[id] = v;
  add({ metric: id, value: v }, 'Saved.');
}

function logPreset(id) {
  const p = presets.find((x) => x.id === id);
  if (!p) return;
  add({ metric: 'set', preset: p.id, name: p.name, weight: p.weight, reps: p.reps, unit: p.unit, value: +(p.weight * p.reps).toFixed(1) }, 'Logged ' + p.name + '.');
}

const savePresets = () => sv('fitapp.presets', presets);

document.addEventListener('click', (e) => {
  const t = e.target.closest('button');
  if (!t) return;
  const d = t.dataset;
  const step = (id, dir) => { const m = METRICS.find((x) => x.id === id); const v = parseFloat($('#in-' + id).value) || 0; cur[id] = Math.max(0, +(v + dir * m.step).toFixed(m.dec + 1)); $('#in-' + id).value = cur[id]; };
  if (d.inc) return step(d.inc, 1);
  if (d.dec) return step(d.dec, -1);
  if (d.save) { document.activeElement.blur(); return save(d.save); }
  if (d.log) return logPreset(d.log);
  if (d.del) { if (confirm('Delete this entry?')) add({ metric: 'del', ref: d.del }, 'Deleted.'); return; }
  if (d.tab) { tab = d.tab; status = ''; editing = null; document.activeElement.blur(); return render(); }
  if (d.pedit) { editing = d.pedit; return render(); }
  if (d.act === 'padd') { const p = { id: 'p' + Date.now(), name: 'New preset', weight: 0, reps: 10, unit: 'reps' }; presets.push(p); savePresets(); editing = p.id; return render(); }
  if (d.act === 'psave' || d.act === 'pdel') {
    const box = t.closest('.edit'), id = box.dataset.pid;
    if (d.act === 'pdel') { if (!confirm('Delete preset?')) return; presets = presets.filter((p) => p.id !== id); }
    else {
      const f = (k) => box.querySelector(`[data-f="${k}"]`).value.trim();
      Object.assign(presets.find((x) => x.id === id), { name: f('name') || 'Preset', weight: parseFloat(f('weight')) || 0, reps: parseFloat(f('reps')) || 0, unit: f('unit') || 'reps' });
    }
    savePresets(); editing = null; document.activeElement.blur(); status = 'Presets saved.'; return render();
  }
  if (d.act === 'tok') { token = $('#tok').value.trim(); sv('fitapp.token', token); status = 'Token saved.'; document.activeElement.blur(); sync().then(render); return render(); }
  if (d.act === 'sync') { sync().then(render); }
});
document.addEventListener('change', (e) => { const id = e.target.dataset.in; if (id) cur[id] = parseFloat(e.target.value) || 0; });
let installEv;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEv = e; const b = $('#install'); if (b) b.hidden = false; });
window.addEventListener('appinstalled', () => { installEv = null; const b = $('#install'); if (b) b.hidden = true; });
document.addEventListener('click', (e) => { if (e.target.id === 'install' && installEv) { installEv.prompt(); installEv = null; e.target.hidden = true; } });
window.addEventListener('online', () => sync().then(render));

$('#date').textContent = new Date().toDateString();
$('#ver').textContent = 'Version ' + VERSION;
render();
sync().then(render);
{
  const m = new URLSearchParams(location.search).get('m');
  const el = m && $('#in-' + m);
  if (el) { el.scrollIntoView({ block: 'center' }); el.focus(); el.select(); }
}
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
