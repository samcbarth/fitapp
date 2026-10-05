// FitApp: daily counters (weight, lifting volume) -> timestamped records -> data/records.json in the GitHub repo.
const REPO = 'samcbarth/fitapp';
const PATH = 'data/records.json';
const KEY = 'fitapp.v2';
const METRICS = [
  { id: 'weight', label: 'Weight today', unit: 'lb', step: 1, dec: 1 },
  { id: 'volume', label: 'Weight volume', unit: 'lb', step: 5, dec: 0 },
];
const $ = (s) => document.querySelector(s);
const ld = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const sv = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

let records = ld(KEY, []); // {ts, metric, value, synced}
let token = ld('fitapp.token', '');
let tab = 'today';
let status = '';
const cur = {}; // working counter values

const dayOf = (ts) => ts.slice(0, 10);
const localDay = (ts) => new Date(ts).toLocaleDateString('en-CA');
const todayKey = () => new Date().toLocaleDateString('en-CA');
function lastFor(m) {
  const r = records.filter((x) => x.metric === m.id);
  if (m.id === 'weight') return r.length ? r.at(-1).value : 0;
  const t = r.filter((x) => localDay(x.ts) === todayKey());
  return t.length ? t.at(-1).value : 0;
}
METRICS.forEach((m) => (cur[m.id] = lastFor(m)));

function counter(m) {
  const saved = records.filter((x) => x.metric === m.id && localDay(x.ts) === todayKey()).at(-1);
  return `<div class="card"><h2>${m.label}</h2>
    <div class="ctr">
      <button class="pm" data-dec="${m.id}" aria-label="minus">-</button>
      <input id="in-${m.id}" type="number" inputmode="decimal" step="${m.step}" value="${cur[m.id]}" data-in="${m.id}">
      <button class="pm" data-inc="${m.id}" aria-label="plus">+</button>
    </div>
    <div class="row"><button class="btn" data-save="${m.id}">Save ${m.unit}</button></div>
    <div class="mute">${saved ? 'Last saved ' + new Date(saved.ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) + ': ' + saved.value : 'Not saved today'}</div></div>`;
}

function chart(m) {
  const byDay = {};
  records.filter((x) => x.metric === m.id).forEach((x) => (byDay[localDay(x.ts)] = x.value)); // last value per day
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

const views = {
  today: () => METRICS.map(counter).join(''),
  charts: () => METRICS.map(chart).join(''),
  settings: () => `<div class="card"><h2>GitHub sync</h2>
      <p class="mute">Saved records are written to ${PATH} in ${REPO}. Paste a fine-grained token (this repo only, Contents: read and write). It stays on this device.</p>
      <div class="row"><input id="tok" type="password" placeholder="github_pat_..." value="${token}"></div>
      <div class="row"><button class="btn" data-act="tok">Save token</button><button class="btn" data-act="sync">Sync now</button></div>
      <div class="mute">Unsynced records: ${records.filter((r) => !r.synced).length}</div></div>`,
};

function render() {
  if (document.activeElement && document.activeElement.tagName === 'INPUT' && tab === 'today') return;
  $('#view').innerHTML = views[tab]();
  document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  $('#status').textContent = status;
}

const b64 = (s) => btoa(unescape(encodeURIComponent(s)));
const unb64 = (s) => decodeURIComponent(escape(atob(s.replace(/\n/g, ''))));

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
      else if (g.status !== 404) throw new Error('GitHub ' + g.status);
      const seen = new Set(remote.map((r) => r.ts + r.metric));
      const merged = remote.concat(pending.filter((r) => !seen.has(r.ts + r.metric)).map(({ ts, metric, value }) => ({ ts, metric, value })));
      const p = await fetch(api, { method: 'PUT', headers, body: JSON.stringify({ message: `log ${pending.length} record(s)`, content: b64(JSON.stringify(merged, null, 1) + '\n'), sha }) });
      if (p.status === 409 || p.status === 422) continue; // stale sha, retry
      if (!p.ok) throw new Error('GitHub ' + p.status);
      pending.forEach((r) => (r.synced = true));
      sv(KEY, records);
      status = 'Synced to GitHub.';
      return;
    } catch (e) { status = 'Sync failed (' + e.message + '). Will retry.'; return; }
  }
  status = 'Sync conflict. Will retry.';
}

function save(id) {
  const m = METRICS.find((x) => x.id === id);
  const v = parseFloat($('#in-' + id).value);
  if (isNaN(v)) return;
  cur[id] = v;
  records.push({ ts: new Date().toISOString(), metric: id, value: v, synced: false });
  sv(KEY, records);
  status = 'Saved.';
  render();
  sync().then(render);
}

document.addEventListener('click', (e) => {
  const t = e.target.closest('button');
  if (!t) return;
  const d = t.dataset;
  const step = (id, dir) => { const m = METRICS.find((x) => x.id === id); const v = parseFloat($('#in-' + id).value) || 0; cur[id] = Math.max(0, +(v + dir * m.step).toFixed(m.dec + 1)); $('#in-' + id).value = cur[id]; };
  if (d.inc) return step(d.inc, 1);
  if (d.dec) return step(d.dec, -1);
  if (d.save) { document.activeElement.blur(); return save(d.save); }
  if (d.tab) { tab = d.tab; status = ''; document.activeElement.blur(); return render(); }
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
render();
sync().then(render);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
