// FitApp: weight, workouts, food, body, sleep, water -> timestamped records -> data/records.json in the private data repo.
const VERSION = '2026-11-04 04:41 UTC'; // auto-stamped by .git/hooks/pre-commit
const REPO = 'samcbarth/fitapp-data'; // private; the app itself is served from public samcbarth/fitapp
const PATH = 'data/records.json';
const KEY = 'fitapp.v2';
// Presets: one tap logs a 'set' record. value = weight x reps (lifting volume); walks have weight 0.
const DEFAULT_PRESETS = [
  { id: 'kb-press', name: 'KB overhead/chest press', weight: 25, reps: 30, unit: 'reps' },
  { id: 'walk-block', name: 'Walk around block', weight: 0, reps: 1, unit: 'lap' },
];
const DEFAULT_PROFILE = { sex: 'male', age: 35, heightIn: 70, activity: 1.375, deficit: 750, goal: 200, protein: 200, water: 100, bed: '22:00', wake: '06:00' };
// Web push: the remind workflow in the private repo signs pushes with the matching private key (repo secret VAPID_PRIVATE)
const VAPID_PUBLIC = 'BDJBvsujB4sHc0Cou0F-vXKVtnIGygMA_lC0E1hJq5GVuzM_c6o5Xxjj1V0k2AYzrAXABv-zQdE5xNpJ0SP-Fxg';
const PARTS =['Waist', 'Chest', 'Hips', 'Neck', 'Arm', 'Thigh'];
const $ = (s) => document.querySelector(s);
const ld = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const sv = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

// records: {id, ts, metric, value, synced, ...extra}
// metrics: weight, volume (legacy), set, food {name,qty,cal,p,c,f}, water (oz), sleep {bed,wake}, measure {part}, photo {path}, del {ref} (tombstone)
let records = ld(KEY, []);
let presets = ld('fitapp.presets', DEFAULT_PRESETS);
let meals = ld('fitapp.meals', []); // saved foods: {id,name,qty,cal,p,c,f}
let profile = { ...DEFAULT_PROFILE, ...ld('fitapp.profile', {}) };
let token = ld('fitapp.token', '');
let tab = 'today';
let status = '';
let editing = null; // preset id open in the Settings editor
let found = null; // food search/scan result being portioned: {name, per100: {cal,p,c,f}, serving}
let results = []; // food search results
let qmul = 1; // quick-add serving multiplier
const foodOf = ([name, qty, cal, p, c, f]) => ({ name, qty, cal, p, c, f });

const localDay = (ts) => new Date(ts).toLocaleDateString('en-CA');
const todayKey = () => new Date().toLocaleDateString('en-CA');
const dayAdd = (d, n) => { const x = new Date(d + 'T12:00'); x.setDate(x.getDate() + n); return x.toLocaleDateString('en-CA'); };
const rkey = (r) => r.id || r.ts + r.metric; // legacy records have no id
const live = () => { const dead = new Set(records.filter((r) => r.metric === 'del').map((r) => r.ref)); return records.filter((r) => r.metric !== 'del' && !dead.has(rkey(r))); };
const of = (metric, day) => live().filter((r) => r.metric === metric && (!day || localDay(r.ts) === day));
const sum = (a, f) => a.reduce((s, x) => s + (+f(x) || 0), 0);
const r0 = (n) => Math.round(n);

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
const weightByDay = () => { const o = {}; of('weight').forEach((r) => (o[localDay(r.ts)] = r.value)); return o; };
const foodByDay = (k) => { const o = {}; of('food').forEach((r) => { const d = localDay(r.ts); o[d] = (o[d] || 0) + (+r[k] || 0); }); return o; };

// weight trend: 7-day average, lb/week slope over the last 28 days, ETA to goal
function trend() {
  const w = weightByDay(), t = todayKey();
  const days = Object.keys(w).filter((d) => d > dayAdd(t, -28)).sort();
  if (!days.length) return null;
  const last7 = days.filter((d) => d > dayAdd(t, -7));
  const avg = last7.length ? sum(last7, (d) => w[d]) / last7.length : w[days.at(-1)];
  let perWeek = null;
  if (days.length >= 3) {
    const xs = days.map((d) => (new Date(d) - new Date(days[0])) / 864e5), ys = days.map((d) => w[d]);
    const mx = sum(xs, (x) => x) / xs.length, my = sum(ys, (y) => y) / ys.length;
    const den = sum(xs, (x) => (x - mx) ** 2);
    if (den > 0) perWeek = (xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0) / den) * 7;
  }
  const toGo = avg - profile.goal;
  const eta = perWeek < 0 && toGo > 0 ? dayAdd(t, r0((toGo / -perWeek) * 7)) : null;
  return { avg: +avg.toFixed(1), perWeek: perWeek == null ? null : +perWeek.toFixed(1), toGo: +toGo.toFixed(1), eta };
}

// maintenance calories: Mifflin-St Jeor, blended toward an adaptive estimate as food logs accumulate
function tdee() {
  const p = profile, kg = (trend()?.avg || 0) * 0.4536, cm = p.heightIn * 2.54;
  const formula = r0((10 * kg + 6.25 * cm - 5 * p.age + (p.sex === 'male' ? 5 : -161)) * p.activity);
  const cal = foodByDay('cal'), w = weightByDay(), t = todayKey();
  const logged = Object.keys(cal).filter((d) => d > dayAdd(t, -28) && d < t);
  const wd = Object.keys(w).filter((d) => d > dayAdd(t, -28)).sort();
  if (logged.length < 14 || wd.length < 6) return { value: formula, formula, adaptive: null, logged: logged.length };
  const avgIn = sum(logged, (d) => cal[d]) / logged.length;
  const head = wd.slice(0, 3), tail = wd.slice(-3), span = (new Date(tail[1]) - new Date(head[1])) / 864e5 || 1; // between window midpoints
  const lost = sum(head, (d) => w[d]) / 3 - sum(tail, (d) => w[d]) / 3;
  const adaptive = r0(avgIn + (lost * 3500) / span);
  const k = Math.min(1, logged.length / 28);
  return { value: r0(formula * (1 - k) + adaptive * k), formula, adaptive, logged: logged.length };
}
const calTarget = () => tdee().value - profile.deficit;

const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const presetLine = (p) => (p.weight ? p.weight + ' lb x ' : '') + p.reps + ' ' + p.unit;
const macroLine = (f) => `${r0(f.cal)} cal · ${r0(f.p)}P ${r0(f.c)}C ${r0(f.f)}F`;
const bar = (label, v, target, unit, over = false) => {
  const pct = target ? Math.min(100, (v / target) * 100) : 0;
  return `<div class="meter"><div class="mrow"><span>${label}</span><b>${r0(v)} / ${r0(target)} ${unit}</b></div><div class="bar"><div style="width:${pct}%;${over && v > target ? 'background:#e5484d' : ''}"></div></div></div>`;
};
const card = (title, body, sub = '') => `<div class="card"><h2>${title}${sub ? ` <span class="mute">${sub}</span>` : ''}</h2>${body}</div>`;
const delBtn = (r) => `<button class="x" data-del="${esc(rkey(r))}" aria-label="delete">✕</button>`;

// sleep: the record logged today describes last night
const lastSleep = () => of('sleep', todayKey()).at(-1);
const hoursOf = (s) => { const [bh, bm] = s.bed.split(':').map(Number), [wh, wm] = s.wake.split(':').map(Number); let h = wh + wm / 60 - (bh + bm / 60); if (h <= 0) h += 24; return +h.toFixed(1); };
const sleepOk = (s) => { const b = s.bed < '12:00' ? '24' + s.bed : s.bed; return b <= profile.bed && s.wake <= profile.wake; };

// ---------- views ----------
function dashboard() {
  const t = todayKey(), food = of('food', t), left = calTarget() - sum(food, (f) => f.cal);
  const tile = (label, v, sub, over) => `<div class="tile${over ? ' over' : ''}"><b>${r0(v)}</b><span>${label}</span><small>${sub}</small></div>`;
  return `<div class="tiles">${tile('cal left', Math.abs(left), left < 0 ? 'over target' : `of ${calTarget()}`, left < 0)}${tile('protein g', sum(food, (f) => f.p), `of ${profile.protein}`)}${tile('water oz', sum(of('water', t), (r) => r.value), `of ${profile.water}`)}</div>`;
}

// weight: carries the last value forward. volume: today's manual lifting total (preset sets add on top).
const COUNTERS = {
  weight: { label: 'Weight today', unit: 'lb', step: 1, start: () => of('weight').at(-1)?.value || 0 },
  volume: { label: 'Weight volume', unit: 'lb', step: 25, start: () => of('volume', todayKey()).at(-1)?.value || 0 },
};
const cIn = {}; // working counter values
function counterCard(id) {
  const c = COUNTERS[id], saved = of(id, todayKey()).at(-1);
  if (cIn[id] == null) cIn[id] = c.start();
  return card(c.label, `<div class="ctr">
      <button class="pm" data-cstep="${id}:-1" aria-label="minus">-</button>
      <input id="in-${id}" type="number" inputmode="decimal" value="${cIn[id]}">
      <button class="pm" data-cstep="${id}:1" aria-label="plus">+</button></div>
    <div class="row"><button class="btn" data-csave="${id}">Save ${c.unit}</button></div>
    <div class="mute">${saved ? 'Last saved ' + fmtTime(saved.ts) + ': ' + saved.value : 'Not saved today'}</div>`);
}

function waterCard() {
  return card('Water', `<div class="grid3">${[8, 16, 24].map((n) => `<button class="chip" data-water="${n}">+${n} oz</button>`).join('')}</div>`, `${sum(of('water', todayKey()), (r) => r.value)} / ${profile.water} oz`);
}

const presetsCard = () => card('Workout presets', `<div class="grid">${presets.map((p) => `<button class="preset" data-log="${p.id}"><b>${esc(p.name)}</b><span>${esc(presetLine(p))}</span></button>`).join('')}</div>`, 'tap to log');

function lineFor(r) {
  if (r.metric === 'set') return `${esc(r.name)}: ${esc(presetLine(r))}`;
  if (r.metric === 'food') return `${esc(r.name)} · ${macroLine(r)}`;
  if (r.metric === 'water') return `Water ${r.value} oz`;
  if (r.metric === 'sleep') return `Sleep ${r.bed} to ${r.wake}`;
  if (r.metric === 'measure') return `${esc(r.part)} ${r.value} in`;
  if (r.metric === 'photo') return 'Progress photo';
  if (r.metric === 'weight') return `Weight ${r.value} lb`;
  return `Volume ${r.value} lb`;
}
function logList(filter, title, sub) {
  const t = live().filter((r) => localDay(r.ts) === todayKey() && filter(r)).reverse();
  return card(title, t.length ? t.map((r) => `<div class="item"><span>${fmtTime(r.ts)} · ${lineFor(r)}</span>${delBtn(r)}</div>`).join('') : '<div class="mute">Nothing logged yet.</div>', sub);
}

function foodView() {
  const t = todayKey(), food = of('food', t);
  const totals = card('Food today', bar('Calories', sum(food, (f) => f.cal), calTarget(), 'cal', true) + bar('Protein', sum(food, (f) => f.p), profile.protein, 'g')
    + `<div class="mute">Carbs ${r0(sum(food, (f) => f.c))} g · Fat ${r0(sum(food, (f) => f.f))} g</div>`);
  const row = (key, name, sub, f, extra = '') => `<div class="qrow" data-q="${esc((name + ' ' + sub).toLowerCase())}"><button class="qbtn" data-quick="${esc(key)}"><b>${esc(name)}</b><span>${f.qty ? esc(f.qty) + ' · ' : ''}${macroLine(f)}</span></button>${extra}</div>`;
  const groups = (meals.length ? [['My meals', meals.map((m) => row('m:' + m.id, m.name, 'my meals', m, `<button class="x" data-unmeal="${m.id}" aria-label="remove">✕</button>`))]] : [])
    .concat(FOOD_GROUPS.map(([g, items]) => [g, items.map((it, i) => row(`f:${g}:${i}`, it[0], g, foodOf(it)))]));
  const saved = card('Quick add', `<div class="qcount"><span class="mute">How many</span><button class="pm sm" data-qstep="-1" aria-label="fewer">-</button><b id="qn">${qmul}</b><button class="pm sm" data-qstep="1" aria-label="more">+</button></div>
      <div class="grid4">${[0.5, 5, 10, 15].map((m) => `<button class="chip${qmul === m ? ' on' : ''}" data-mul="${m}">${m === 0.5 ? '½' : m}</button>`).join('')}</div>
      <input id="qf" placeholder="Filter: popeyes, chips, tea..." autocomplete="off">
      <div class="qlist">${groups.map(([g, rows]) => `<div class="qgroup" data-g><h3>${esc(g)}</h3>${rows.join('')}</div>`).join('')}</div>
      <div class="mute">Each food is one piece. Set how many, then tap the food. Count resets to 1 after logging. Macros are estimates.</div>`, 'from your orders');
  const find = card('Find food', `<div class="row"><button class="btn" data-act="scan">Scan barcode</button></div>
      <input id="scanfile" type="file" accept="image/*" capture="environment" hidden>
      <div class="row"><input id="q" placeholder="Search foods or type a barcode"><button class="btn half" data-act="search">Go</button></div>
      ${results.map((x, i) => `<div class="item"><span>${esc(x.name)} <span class="mute">${r0(x.per100.cal)} cal/100g</span></span><button class="x" data-pick="${i}">Pick</button></div>`).join('')}
      ${found ? portion() : ''}`);
  const manual = card('Add manually', `<input id="fm-name" placeholder="Food name">
      ${[['cal', 'p'], ['c', 'f']].map((ks) => `<div class="row">${ks.map((k) => `<input id="fm-${k}" type="number" inputmode="decimal" placeholder="${{ cal: 'calories', p: 'protein g', c: 'carbs g', f: 'fat g' }[k]}">`).join('')}</div>`).join('')}
      <label class="chk"><input type="checkbox" id="fm-save"> Save to My meals</label>
      <div class="row"><button class="btn" data-act="fmadd">Log food</button></div>`);
  return totals + saved + find + manual + logList((r) => r.metric === 'food', "Today's food");
}

function portion() {
  const g = found.serving || 100;
  return `<div class="edit"><b>${esc(found.name)}</b>
    <div class="mute">Per 100 g: ${macroLine(found.per100)}</div>
    <div class="row"><input id="grams" type="number" inputmode="decimal" value="${g}"><span class="mute">grams</span></div>
    <label class="chk"><input type="checkbox" id="fd-save"> Save to My meals</label>
    <div class="row"><button class="btn" data-act="fdadd">Log it</button><button class="btn ghost" data-act="fdclose">Cancel</button></div></div>`;
}

function bodyView() {
  const tr = trend(), sl = lastSleep();
  const wt = card('Weight trend', tr ? `<div class="big">${tr.avg} lb</div><div class="mute">7-day average · goal ${profile.goal} lb · ${tr.toGo} lb to go</div>
      <div class="mute">${tr.perWeek == null ? 'Rate needs 3+ weigh-ins in 28 days.' : `${tr.perWeek > 0 ? '+' : ''}${tr.perWeek} lb/week`}${tr.eta ? ` · goal around ${tr.eta}` : ''}</div>` : '<div class="mute">Log your weight on Today.</div>');
  const sleep = card('Sleep last night', `<div class="row"><label class="mute">Bed<input id="sl-bed" type="time" value="${sl?.bed || profile.bed}"></label><label class="mute">Up<input id="sl-wake" type="time" value="${sl?.wake || profile.wake}"></label></div>
      <div class="row"><button class="btn" data-act="sleep">Save sleep</button></div>
      <div class="mute">Target: bed by ${profile.bed}, up by ${profile.wake}.${sl ? ` Logged ${hoursOf(sl)} h ${sleepOk(sl) ? 'on target' : 'off target'}.` : ''}</div>`);
  const last = {}; of('measure').forEach((r) => (last[r.part] = r));
  const meas = card('Measurements', `<div class="row"><select id="ms-part">${PARTS.map((p) => `<option>${p}</option>`).join('')}</select><input id="ms-val" type="number" inputmode="decimal" placeholder="inches"></div>
      <div class="row"><button class="btn" data-act="measure">Save measurement</button></div>
      ${PARTS.filter((p) => last[p]).map((p) => `<div class="item"><span>${p}</span><span>${last[p].value} in <span class="mute">${localDay(last[p].ts)}</span></span></div>`).join('')}`, 'inches');
  const photos = of('photo').reverse();
  const pics = card('Progress photos', `<div class="row"><button class="btn" data-act="photo">Take / add photo</button></div><input id="photofile" type="file" accept="image/*" capture="user" hidden>
      <div class="mute">Uploads to the private repo. Needs the token.</div>
      ${photos.map((r) => `<div class="item"><span>${localDay(r.ts)}</span><button class="x" data-view="${esc(r.path)}">View</button>${delBtn(r)}</div><img class="pic" data-img="${esc(r.path)}" hidden>`).join('')}`);
  return wt + sleep + waterCard() + meas + pics;
}

function chart(label, byDay, unit, target) {
  const days = Object.keys(byDay).sort().slice(-30);
  if (days.length < 2) return card(label, '<div class="mute">Need 2+ days of data.</div>');
  const vals = days.map((d) => byDay[d]);
  const all = target ? vals.concat(target) : vals;
  const lo = Math.min(...all), hi = Math.max(...all), span = hi - lo || 1;
  const W = 320, H = 120, P = 8, y = (v) => H - P - ((v - lo) / span) * (H - 2 * P);
  const pts = vals.map((v, i) => [P + (i * (W - 2 * P)) / (vals.length - 1), y(v)]);
  const tl = target ? `<line x1="${P}" x2="${W - P}" y1="${y(target)}" y2="${y(target)}" stroke="#8b91a1" stroke-dasharray="4 4"/>` : '';
  return card(label, `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${label} chart">${tl}<polyline fill="none" stroke="#ff7a1a" stroke-width="2" points="${pts.map((p) => p.join(',')).join(' ')}"/>${pts.map((p) => `<circle cx="${p[0]}" cy="${p[1]}" r="3" fill="#ff7a1a"/>`).join('')}</svg>
    <div class="mute">min ${r0(lo)} · max ${r0(hi)} · latest ${r0(vals.at(-1))} ${unit}${target ? ` · dashed = target ${r0(target)}` : ''}</div>`, `${days[0]} to ${days.at(-1)}`);
}

function presetEditor() {
  const row = (p) => editing === p.id
    ? `<div class="edit" data-pid="${p.id}">
        <input data-f="name" value="${esc(p.name)}" placeholder="Name">
        <div class="row"><input data-f="weight" type="number" inputmode="decimal" value="${p.weight}" placeholder="lb"><input data-f="reps" type="number" inputmode="decimal" value="${p.reps}" placeholder="reps"><input data-f="unit" value="${esc(p.unit)}" placeholder="unit"></div>
        <div class="row"><button class="btn" data-act="psave">Save</button><button class="btn ghost" data-act="pdel">Delete</button></div></div>`
    : `<div class="item"><span>${esc(p.name)} · <span class="mute">${esc(presetLine(p))}</span></span><button class="x" data-pedit="${p.id}">Edit</button></div>`;
  return card('Workout presets', presets.map(row).join('') + '<div class="row" style="margin-top:12px"><button class="btn" data-act="padd">Add preset</button></div>');
}

function profileCard() {
  const p = profile, td = tdee();
  const f = (k, label, type = 'number') => `<label class="mute">${label}<input data-pf="${k}" type="${type}" ${type === 'number' ? 'inputmode="decimal"' : ''} value="${esc(p[k])}"></label>`;
  return card('Targets and profile', `<div class="row"><label class="mute">Sex<select data-pf="sex"><option value="male"${p.sex === 'male' ? ' selected' : ''}>Male</option><option value="female"${p.sex === 'female' ? ' selected' : ''}>Female</option></select></label>${f('age', 'Age')}${f('heightIn', 'Height (in)')}</div>
    <label class="mute">Activity<select data-pf="activity">${[[1.2, 'Desk, little exercise'], [1.375, 'Light exercise 1-3 days'], [1.55, 'Moderate 3-5 days'], [1.725, 'Hard 6-7 days']].map(([v, l]) => `<option value="${v}"${+p.activity === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
    <div class="row">${f('goal', 'Goal lb')}${f('deficit', 'Deficit cal')}</div>
    <div class="row">${f('protein', 'Protein g')}${f('water', 'Water oz')}</div>
    <div class="row">${f('bed', 'Bed by', 'time')}${f('wake', 'Up by', 'time')}</div>
    <div class="row"><button class="btn" data-act="profile">Save targets</button></div>
    <div class="mute">Maintenance ${td.value} cal (formula ${td.formula}${td.adaptive ? `, from your logs ${td.adaptive}` : `; adapts after 14 days of food logs, have ${td.logged}`}). Daily target ${calTarget()} cal.</div>`);
}

function remindCard() {
  const on = ld('fitapp.push', false), perm = 'Notification' in window ? Notification.permission : 'unsupported';
  return card('Reminders', `<p class="mute">A Chrome notification every 3 hours, 8am to 8pm, showing what's left for water, protein, calories and lifting.</p>
    <div class="row"><button class="btn" data-act="push">${on ? 'Re-register this phone' : 'Turn on reminders'}</button>${on ? '<button class="btn ghost" data-act="pushtest">Test</button>' : ''}</div>
    <div class="mute">${perm === 'denied' ? 'Notifications are blocked. Allow them in Chrome site settings for this app.' : on ? 'On for this phone.' : 'Off.'}</div>`);
}
async function enablePush() {
  if (!token) { status = 'Add a token first; the reminder job reads your subscription from the private repo.'; return render(); }
  if (await Notification.requestPermission() !== 'granted') { status = 'Notifications not allowed.'; return render(true); }
  const reg = await navigator.serviceWorker.ready;
  const key = Uint8Array.from(atob(VAPID_PUBLIC.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  const sub = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }));
  const g = await fetch(api('data/push.json'), { headers: ghHeaders() });
  const sha = g.ok ? (await g.json()).sha : undefined;
  const body = { subscription: sub.toJSON(), tz: Intl.DateTimeFormat().resolvedOptions().timeZone, updated: new Date().toISOString() };
  const p = await fetch(api('data/push.json'), { method: 'PUT', headers: ghHeaders(), body: JSON.stringify({ message: 'register push subscription', content: b64(JSON.stringify(body, null, 1) + '\n'), sha }) });
  if (!p.ok) { status = 'Could not save subscription (' + p.status + '). Check the token.'; return render(true); }
  sv('fitapp.push', true); status = 'Reminders on.'; render(true);
}

const views = {
  today: () => dashboard() + counterCard('weight') + counterCard('volume') + presetsCard() + waterCard() + logList((r) => ['set', 'weight', 'volume', 'water'].includes(r.metric), "Today's log", `volume ${volumeByDay()[todayKey()] || 0} lb`),
  food: foodView,
  body: bodyView,
  charts: () => { const tr = weightByDay(), c = foodByDay('cal'), pr = foodByDay('p'); return chart('Weight', tr, 'lb', profile.goal) + chart('Calories', c, 'cal', calTarget()) + chart('Protein', pr, 'g', profile.protein) + chart('Lifting volume', volumeByDay(), 'lb'); },
  settings: () => profileCard() + remindCard() + presetEditor() + card('GitHub sync', `<p class="mute">Records are written to ${PATH} in the private repo ${REPO}. Paste a fine-grained token (that repo, Contents: read and write). It stays on this device.</p>
      <div class="row"><input id="tok" type="password" placeholder="github_pat_..." value="${esc(token)}"></div>
      <div class="row"><button class="btn" data-act="tok">Save token</button><button class="btn" data-act="sync">Sync now</button></div>
      <div class="mute">Unsynced records: ${records.filter((r) => !r.synced).length}</div>`),
};

function render(force) {
  $('#status').textContent = status;
  if (!force && document.activeElement && ['INPUT', 'SELECT'].includes(document.activeElement.tagName)) return;
  $('#view').innerHTML = views[tab]();
  document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
}

// ---------- GitHub ----------
const b64 = (s) => btoa(unescape(encodeURIComponent(s)));
const unb64 = (s) => decodeURIComponent(escape(atob(s.replace(/\n/g, ''))));
const ghHeaders = () => ({ Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' });
const api = (p) => `https://api.github.com/repos/${REPO}/contents/${p}`;

// data/today.json: tiny summary for home-screen widgets and the reminder job
async function putSummary(headers) {
  const day = todayKey(), food = of('food', day), sl = lastSleep();
  const body = { date: day, weight: trend()?.avg ?? null, volume: volumeByDay()[day] || 0, cal: r0(sum(food, (f) => f.cal)), cal_target: calTarget(), protein: r0(sum(food, (f) => f.p)), protein_target: profile.protein, water: sum(of('water', day), (r) => r.value), water_target: profile.water, sleep_ok: sl ? sleepOk(sl) : null, updated: new Date().toISOString() };
  const g = await fetch(api('data/today.json'), { headers });
  const sha = g.ok ? (await g.json()).sha : undefined;
  const p = await fetch(api('data/today.json'), { method: 'PUT', headers, body: JSON.stringify({ message: 'update today summary', content: b64(JSON.stringify(body, null, 1) + '\n'), sha }) });
  if (!p.ok) throw new Error('summary ' + p.status);
}

async function sync() {
  const pending = records.filter((r) => !r.synced);
  if (!token) { status = pending.length ? 'Saved locally. Add a token in Settings to sync.' : ''; return; }
  if (!pending.length) return;
  const headers = ghHeaders();
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      let sha, remote = [];
      const g = await fetch(api(PATH), { headers });
      if (g.ok) { const j = await g.json(); sha = j.sha; remote = JSON.parse(unb64(j.content)); }
      else if (g.status === 404 || g.status === 403 || g.status === 401) throw new Error('token cannot access ' + REPO + ', update it in Settings');
      else throw new Error('GitHub ' + g.status);
      const seen = new Set(remote.map(rkey));
      const merged = remote.concat(pending.filter((r) => !seen.has(rkey(r))).map(({ synced, ...r }) => r));
      const p = await fetch(api(PATH), { method: 'PUT', headers, body: JSON.stringify({ message: `log ${pending.length} record(s)`, content: b64(JSON.stringify(merged, null, 1) + '\n'), sha }) });
      if (p.status === 409 || p.status === 422) continue; // stale sha, retry
      if (!p.ok) throw new Error('GitHub ' + p.status);
      pending.forEach((r) => (r.synced = true));
      sv(KEY, records);
      status = 'Synced to GitHub.';
      await putSummary(headers).catch((e) => (status = 'Synced; summary failed (' + e.message + ').'));
      return;
    } catch (e) { status = 'Sync failed (' + e.message + '). Will retry.'; return; }
  }
  status = 'Sync conflict. Will retry.';
}

// shrink a photo to 1080px JPEG and upload it to data/photos/
async function uploadPhoto(file) {
  if (!token) { status = 'Add a token in Settings first; photos go straight to the private repo.'; return render(); }
  status = 'Uploading photo...'; render();
  const img = await createImageBitmap(file), s = Math.min(1, 1080 / Math.max(img.width, img.height));
  const c = document.createElement('canvas'); c.width = r0(img.width * s); c.height = r0(img.height * s);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  const path = `data/photos/${todayKey()}-${Date.now().toString(36)}.jpg`;
  const p = await fetch(api(path), { method: 'PUT', headers: ghHeaders(), body: JSON.stringify({ message: 'progress photo', content: c.toDataURL('image/jpeg', 0.8).split(',')[1] }) });
  if (!p.ok) { status = 'Photo upload failed (' + p.status + ').'; return render(); }
  add({ metric: 'photo', path, value: 0 }, 'Photo saved.');
}
async function viewPhoto(path) {
  const el = document.querySelector(`img[data-img="${CSS.escape(path)}"]`);
  if (!el) return;
  if (!el.hidden) { el.hidden = true; return; }
  const r = await fetch(api(path), { headers: { ...ghHeaders(), Accept: 'application/vnd.github.raw' } });
  if (!r.ok) { status = 'Could not load photo (' + r.status + ').'; return render(); }
  el.src = URL.createObjectURL(await r.blob()); el.hidden = false;
}

// ---------- Open Food Facts ----------
const OFF = 'https://world.openfoodfacts.org';
const fromOff = (p) => {
  const n = p.nutriments || {};
  return { name: [p.product_name, p.brands].filter(Boolean).join(' · ') || 'Unnamed food', per100: { cal: +n['energy-kcal_100g'] || 0, p: +n.proteins_100g || 0, c: +n.carbohydrates_100g || 0, f: +n.fat_100g || 0 }, serving: +p.serving_quantity || null };
};
async function lookupBarcode(code) {
  status = 'Looking up ' + code + '...'; render();
  try {
    const j = await fetch(`${OFF}/api/v2/product/${code}.json?fields=product_name,brands,nutriments,serving_quantity`).then((r) => r.json());
    if (j.status !== 1 || !j.product) { status = 'Barcode not found. Add it manually.'; return render(); }
    found = fromOff(j.product); results = []; status = ''; render(true);
  } catch { status = 'Lookup failed. Check connection.'; render(); }
}
async function searchFood(q) {
  if (/^\d{8,14}$/.test(q)) return lookupBarcode(q);
  status = 'Searching...'; render();
  try {
    const j = await fetch(`${OFF}/cgi/search.pl?search_terms=${encodeURIComponent(q)}&json=1&page_size=12&fields=product_name,brands,nutriments,serving_quantity`).then((r) => r.json());
    results = (j.products || []).map(fromOff).filter((x) => x.per100.cal);
    found = null; status = results.length ? '' : 'No matches.'; render(true);
  } catch { status = 'Search failed. Check connection.'; render(); }
}
async function scanFile(file) {
  if (!('BarcodeDetector' in window)) { status = 'Scanner not supported on this browser. Type the barcode number instead.'; return render(); }
  try {
    const codes = await new BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e'] }).detect(await createImageBitmap(file));
    if (!codes.length) { status = 'No barcode found in photo. Try closer, in good light.'; return render(); }
    lookupBarcode(codes[0].rawValue);
  } catch { status = 'Scan failed.'; render(); }
}

// ---------- actions ----------
function add(rec, msg) {
  records.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), ts: new Date().toISOString(), ...rec, synced: false });
  sv(KEY, records);
  status = msg;
  render(true);
  sync().then(() => render());
}
const logFood = (f, save) => {
  const item = { name: f.name, qty: f.qty || '', cal: r0(f.cal), p: +(+f.p).toFixed(1), c: +(+f.c).toFixed(1), f: +(+f.f).toFixed(1) };
  if (save) { meals.push({ id: 'm' + Date.now(), ...item }); sv('fitapp.meals', meals); }
  add({ metric: 'food', ...item, value: item.cal }, 'Logged ' + item.name + '.');
};
const val = (s) => $(s)?.value.trim() ?? '';
const num = (s) => parseFloat(val(s)) || 0;

const handlers = {
  scan() { $('#scanfile').click(); },
  search() { const q = val('#q'); if (q) searchFood(q); },
  fdclose() { found = null; render(true); },
  fdadd() { const g = num('#grams') || 100, k = g / 100, p = found.per100; logFood({ name: found.name, qty: g + ' g', cal: p.cal * k, p: p.p * k, c: p.c * k, f: p.f * k }, $('#fd-save').checked); found = null; },
  fmadd() { const name = val('#fm-name'); if (!name) { status = 'Give the food a name.'; return render(); } logFood({ name, cal: num('#fm-cal'), p: num('#fm-p'), c: num('#fm-c'), f: num('#fm-f') }, $('#fm-save').checked); },
  sleep() { const bed = val('#sl-bed'), wake = val('#sl-wake'); if (!bed || !wake) return; const s = { bed, wake }; add({ metric: 'sleep', ...s, value: hoursOf(s) }, 'Sleep saved.'); },
  measure() { const v = num('#ms-val'); if (!v) return; add({ metric: 'measure', part: val('#ms-part'), value: v }, 'Measurement saved.'); },
  photo() { $('#photofile').click(); },
  profile() {
    document.querySelectorAll('[data-pf]').forEach((el) => { const k = el.dataset.pf; profile[k] = ['sex', 'bed', 'wake'].includes(k) ? el.value : parseFloat(el.value) || DEFAULT_PROFILE[k]; });
    sv('fitapp.profile', profile); status = 'Targets saved.'; render(true);
  },
  padd() { const p = { id: 'p' + Date.now(), name: 'New preset', weight: 0, reps: 10, unit: 'reps' }; presets.push(p); sv('fitapp.presets', presets); editing = p.id; render(true); },
  tok() { token = val('#tok'); sv('fitapp.token', token); status = 'Token saved.'; render(true); sync().then(() => render()); },
  sync() { sync().then(() => render()); },
  push() { enablePush().catch((e) => { status = 'Reminders failed (' + e.message + ').'; render(true); }); },
  async pushtest() { (await navigator.serviceWorker.ready).showNotification('FitApp check-in', { body: 'This is what reminders look like.', icon: 'icon-192.png', tag: 'remind' }); },
};

document.addEventListener('click', (e) => {
  const t = e.target.closest('button');
  if (!t) return;
  const d = t.dataset;
  if (d.tab) { tab = d.tab; status = ''; editing = null; return render(true); }
  if (d.cstep) { const [id, dir] = d.cstep.split(':'); cIn[id] = Math.max(0, +((parseFloat(val('#in-' + id)) || 0) + dir * COUNTERS[id].step).toFixed(1)); $('#in-' + id).value = cIn[id]; return; }
  if (d.csave) { const id = d.csave, v = parseFloat(val('#in-' + id)); if (isNaN(v)) return; cIn[id] = v; document.activeElement.blur(); return add({ metric: id, value: v }, 'Saved.'); }
  if (d.log) { const p = presets.find((x) => x.id === d.log); return p && add({ metric: 'set', preset: p.id, name: p.name, weight: p.weight, reps: p.reps, unit: p.unit, value: +(p.weight * p.reps).toFixed(1) }, 'Logged ' + p.name + '.'); }
  if (d.water) return add({ metric: 'water', value: +d.water }, `+${d.water} oz water.`);
  // count changes update in place so the list keeps its scroll position
  const setCount = (n) => { qmul = Math.max(0.5, n); $('#qn').textContent = qmul; document.querySelectorAll('[data-mul]').forEach((b) => b.classList.toggle('on', +b.dataset.mul === qmul)); };
  if (d.mul) return setCount(+d.mul);
  if (d.qstep) return setCount(qmul < 1 && +d.qstep > 0 ? 1 : Math.floor(qmul) + +d.qstep);
  if (d.quick) {
    const [kind, a, b] = d.quick.split(':');
    const f = kind === 'm' ? meals.find((x) => x.id === a) : foodOf(FOOD_GROUPS.find(([g]) => g === a)[1][+b]);
    if (!f) return;
    const k = qmul;
    qmul = 1;
    return logFood({ ...f, name: k === 1 ? f.name : `${k} × ${f.name}`, qty: k === 1 ? f.qty : `${k} × ${f.qty}`, cal: f.cal * k, p: f.p * k, c: f.c * k, f: f.f * k });
  }
  if (d.unmeal) { if (confirm('Remove from My meals?')) { meals = meals.filter((m) => m.id !== d.unmeal); sv('fitapp.meals', meals); render(true); } return; }
  if (d.pick) { found = results[+d.pick]; results = []; return render(true); }
  if (d.view) return viewPhoto(d.view);
  if (d.del) { if (confirm('Delete this entry?')) add({ metric: 'del', ref: d.del }, 'Deleted.'); return; }
  if (d.pedit) { editing = d.pedit; return render(true); }
  if (d.act === 'psave' || d.act === 'pdel') {
    const box = t.closest('.edit'), id = box.dataset.pid;
    if (d.act === 'pdel') { if (!confirm('Delete preset?')) return; presets = presets.filter((p) => p.id !== id); }
    else {
      const f = (k) => box.querySelector(`[data-f="${k}"]`).value.trim();
      Object.assign(presets.find((x) => x.id === id), { name: f('name') || 'Preset', weight: parseFloat(f('weight')) || 0, reps: parseFloat(f('reps')) || 0, unit: f('unit') || 'reps' });
    }
    sv('fitapp.presets', presets); editing = null; status = 'Presets saved.'; return render(true);
  }
  if (handlers[d.act]) handlers[d.act]();
});
document.addEventListener('change', (e) => {
  if (e.target.id === 'scanfile' && e.target.files[0]) scanFile(e.target.files[0]);
  if (e.target.id === 'photofile' && e.target.files[0]) uploadPhoto(e.target.files[0]).catch((x) => { status = 'Photo failed (' + x.message + ').'; render(); });
});
// filter the quick-add list in place (re-rendering would steal focus from the input)
document.addEventListener('input', (e) => {
  if (e.target.id !== 'qf') return;
  const q = e.target.value.trim().toLowerCase();
  document.querySelectorAll('.qrow').forEach((r) => (r.hidden = q && !r.dataset.q.includes(q)));
  document.querySelectorAll('.qgroup').forEach((g) => (g.hidden = !g.querySelector('.qrow:not([hidden])')));
});
document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.id === 'q') handlers.search(); });
let installEv;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEv = e; const b = $('#install'); if (b) b.hidden = false; });
window.addEventListener('appinstalled', () => { installEv = null; const b = $('#install'); if (b) b.hidden = true; });
document.addEventListener('click', (e) => { if (e.target.id === 'install' && installEv) { installEv.prompt(); installEv = null; e.target.hidden = true; } });
window.addEventListener('online', () => sync().then(() => render()));

$('#date').textContent = new Date().toDateString();
$('#ver').textContent = 'Version ' + VERSION;
{
  const m = new URLSearchParams(location.search).get('m');
  if (['food', 'body'].includes(m)) tab = m;
  render(true);
  const el = COUNTERS[m] && $('#in-' + m);
  if (el) { el.scrollIntoView({ block: 'center' }); el.focus(); el.select(); }
}
sync().then(() => render());
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
