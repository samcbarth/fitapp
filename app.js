// FitApp: weight, workouts, food, body, sleep, water -> timestamped records -> data/records.json in the private data repo.
const VERSION = '2026-11-16 23:30 UTC'; // auto-stamped by .git/hooks/pre-commit
const REPO = 'samcbarth/fitapp-data'; // private; the app itself is served from public samcbarth/fitapp
const PATH = 'data/records.json';
const KEY = 'fitapp.v2';
// Presets: one tap logs a 'set' record. value = weight x reps (lifting volume); walks have weight 0.
// kind + min drive the calories-burned estimate; cal (optional) overrides it.
const DEFAULT_PRESETS = [
  { id: 'kb-press', name: 'KB overhead/chest press', weight: 25, reps: 30, unit: 'reps', kind: 'lift', min: 3, cal: null },
  { id: 'walk-block', name: 'Walk around block', weight: 0, reps: 1, unit: 'lap', kind: 'walk', min: 5, cal: null },
];
// deficitPct: food target is this percent below maintenance. floor: food target never goes below this.
const DEFAULT_PROFILE = { sex: 'male', age: 35, heightIn: 70, activity: 1.375, deficitPct: 15, floor: 1000, goal: 200, protein: 200, water: 100, bed: '22:00', wake: '06:00' };
// Day check-off started on this date. Earlier days with food logged count as complete so old history is kept.
const CHECKOFF_START = '2026-11-16';
// Exercise intensity (METs). Burn = (MET - 1) x kg x hours: the resting 1 MET is already inside maintenance.
const KINDS = { lift: ['Lifting', 5], walk: ['Walking', 3.5], cardio: ['Hard cardio', 7] };
// Web push: the remind workflow in the private repo signs pushes with the matching private key (repo secret VAPID_PRIVATE)
const VAPID_PUBLIC = 'BDJBvsujB4sHc0Cou0F-vXKVtnIGygMA_lC0E1hJq5GVuzM_c6o5Xxjj1V0k2AYzrAXABv-zQdE5xNpJ0SP-Fxg';
const PARTS =['Waist', 'Chest', 'Hips', 'Neck', 'Arm', 'Thigh'];
const $ = (s) => document.querySelector(s);
const ld = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const sv = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

// records: {id, ts, metric, value, synced, ...extra}
// metrics: weight, volume (legacy), set, food {name,qty,cal,p,c,f}, water (oz), sleep {bed,wake}, measure {part}, photo {path}, del {ref} (tombstone)
let records = ld(KEY, []);
// older saved presets have no kind/min: walks get 5 minute laps, everything else 3 minutes of lifting
let presets = ld('fitapp.presets', DEFAULT_PRESETS).map((p) => ({ kind: /walk/i.test(p.name) || p.weight === 0 ? 'walk' : 'lift', min: /walk/i.test(p.name) || p.weight === 0 ? 5 : 3, cal: null, ...p }));
let meals = ld('fitapp.meals', []); // saved foods: {id,name,qty,cal,p,c,f}
let profile = { ...DEFAULT_PROFILE, ...ld('fitapp.profile', {}) };
let token = ld('fitapp.token', '');
let tab = 'today';
let status = '';
let editing = null; // preset id open in the Settings editor
let found = null; // food search/scan result being portioned: {name, per100: {cal,p,c,f}, serving}
let results = []; // food search results
let localHits = []; // built-in foods / My meals matching the last search
let qmul = 1; // quick-add serving multiplier
let showSum = false; // day summary popup after check-off
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

// ---------- calories burned from workout presets ----------
const bodyKg = () => (trend()?.avg || of('weight').at(-1)?.value || 200) * 0.4536;
const estBurn = (kind, min) => r0(((KINDS[kind] || KINDS.lift)[1] - 1) * bodyKg() * ((+min || 0) / 60));
const presetBurn = (p) => (p.cal != null && p.cal !== '' ? +p.cal : estBurn(p.kind, p.min));
// burn stored on each set when logged; older sets without one are estimated from their preset now
const burnOf = (r) => r.burn ?? (() => { const p = presets.find((x) => x.id === r.preset) || presets.find((x) => x.name === r.name); return p ? presetBurn(p) : 0; })();
const burnByDay = () => { const o = {}; of('set').forEach((r) => { const d = localDay(r.ts); o[d] = (o[d] || 0) + burnOf(r); }); return o; };

// ---------- day check-off ----------
// complete = checked off, or (before check-off existed) any food logged that day. No backfill: check-off is for today only.
const doneDays = () => new Set(of('done').map((r) => r.day || localDay(r.ts)));
function completeDays() {
  const s = doneDays();
  Object.keys(foodByDay('cal')).forEach((d) => { if (d < CHECKOFF_START) s.add(d); });
  return s;
}
const isDone = (d = todayKey()) => doneDays().has(d);
function streak() {
  const s = completeDays(), t = todayKey();
  let n = 0;
  for (let d = s.has(t) ? t : dayAdd(t, -1); s.has(d); d = dayAdd(d, -1)) n++;
  return n;
}

// maintenance calories: Mifflin-St Jeor, blended toward an adaptive estimate as complete days accumulate.
// Adaptive = food eaten - exercise burned + weight change, so maintenance means "before logged workouts" and burn is never counted twice.
function tdee() {
  const p = profile, kg = (trend()?.avg || 0) * 0.4536, cm = p.heightIn * 2.54;
  const formula = r0((10 * kg + 6.25 * cm - 5 * p.age + (p.sex === 'male' ? 5 : -161)) * p.activity);
  const cal = foodByDay('cal'), burn = burnByDay(), w = weightByDay(), t = todayKey(), done = completeDays();
  const logged = Object.keys(cal).filter((d) => d > dayAdd(t, -28) && d < t && done.has(d));
  const wd = Object.keys(w).filter((d) => d > dayAdd(t, -28)).sort();
  if (logged.length < 14 || wd.length < 6) return { value: formula, formula, adaptive: null, logged: logged.length };
  const avgIn = sum(logged, (d) => cal[d] - (burn[d] || 0)) / logged.length;
  const head = wd.slice(0, 3), tail = wd.slice(-3), span = (new Date(tail[1]) - new Date(head[1])) / 864e5 || 1; // between window midpoints
  const lost = sum(head, (d) => w[d]) / 3 - sum(tail, (d) => w[d]) / 3;
  const adaptive = r0(avgIn + (lost * 3500) / span);
  const k = Math.min(1, logged.length / 28);
  return { value: r0(formula * (1 - k) + adaptive * k), formula, adaptive, logged: logged.length };
}
// food target: deficitPct below maintenance, never under the floor. Exercise does not raise it.
const calTarget = () => Math.max(+profile.floor || 0, r0(tdee().value * (1 - (+profile.deficitPct || 0) / 100)));
const deficitGoal = () => tdee().value - calTarget();
// what you can eat on a day: base target plus every calorie burned in logged workouts that day (100% eaten back)
const foodTarget = (d = todayKey()) => calTarget() + r0(burnByDay()[d] || 0);

// per-day numbers: maintenance + burned - eaten = deficit (positive is good)
function dayStats(d, maint = tdee().value, cal = foodByDay('cal'), burn = burnByDay()) {
  const eaten = r0(cal[d] || 0), burned = r0(burn[d] || 0);
  return { eaten, burned, maint, deficit: maint + burned - eaten };
}
const deficitByDay = () => {
  const m = tdee().value, cal = foodByDay('cal'), burn = burnByDay(), o = {};
  completeDays().forEach((d) => (o[d] = dayStats(d, m, cal, burn).deficit));
  return o;
};
// this week (Monday start): complete days plus today in progress
function weekStats() {
  const t = todayKey(), mon = dayAdd(t, -((new Date(t + 'T12:00').getDay() + 6) % 7));
  const m = tdee().value, cal = foodByDay('cal'), burn = burnByDay(), done = completeDays(), goal = deficitGoal();
  let total = 0, counted = 0, skipped = 0;
  for (let d = mon; d <= t; d = dayAdd(d, 1)) {
    if (done.has(d) || d === t) { total += dayStats(d, m, cal, burn).deficit; counted++; } else skipped++;
  }
  return { total, counted, skipped, goal: goal * 7, pace: goal * counted, start: mon };
}
// projected vs actual loss over the last 28 days: logged deficit / 3500 vs the scale
function projected() {
  const t = todayKey(), from = dayAdd(t, -28), def = deficitByDay(), w = weightByDay();
  const days = Object.keys(def).filter((d) => d > from && d < t);
  if (!days.length) return null;
  const wd = Object.keys(w).filter((d) => d > from).sort();
  const actual = wd.length >= 2 ? +(w[wd.at(-1)] - w[wd[0]]).toFixed(1) : null;
  return { days: days.length, total: r0(sum(days, (d) => def[d])), lb: +(-sum(days, (d) => def[d]) / 3500).toFixed(1), actual };
}

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
  const t = todayKey(), food = of('food', t), target = foodTarget(t), left = target - sum(food, (f) => f.cal), st = dayStats(t), dg = deficitGoal();
  const tile = (label, v, sub, over) => `<div class="tile${over ? ' over' : ''}"><b>${r0(v)}</b><span>${label}</span><small>${sub}</small></div>`;
  return `<div class="tiles">${tile('cal left', Math.abs(left), left < 0 ? 'over target' : `of ${target}${st.burned ? ` (+${st.burned} earned)` : ''}`, left < 0)}${tile(st.deficit < 0 ? 'cal surplus' : 'deficit', Math.abs(st.deficit), `goal ${dg}${st.burned ? ` · +${st.burned} burned` : ''}`, st.deficit < 0)}${tile('protein g', sum(food, (f) => f.p), `of ${profile.protein}`)}${tile('water oz', sum(of('water', t), (r) => r.value), `of ${profile.water}`)}</div>`
    + (showSum ? summaryCard() : '') + checkoffCard();
}
const signed = (n) => (n > 0 ? '+' : '') + r0(n);
function checkoffCard() {
  const done = isDone(), wk = weekStats(), s = streak(), food = of('food', todayKey()).length;
  const btn = done
    ? `<div class="row"><button class="btn ghost" data-act="uncheck">Undo check-off</button><button class="btn ghost" data-act="sumopen">Day summary</button></div><div class="mute">Today is checked off. Anything you log now still counts.</div>`
    : `<div class="row"><button class="btn" data-act="checkoff">Check off today</button></div><div class="mute">${food ? `${food} food entr${food === 1 ? 'y' : 'ies'} so far.` : 'No food logged yet.'} Check off tonight once everything you ate is in. Unchecked days don't count, and the day locks at midnight.</div>`;
  return card('Daily log', `<div class="acts"><div><b>${s}</b><span>day streak</span></div><div><b class="${wk.total < 0 ? 'neg' : ''}">${signed(wk.total)}</b><span>week deficit</span></div><div><b>${r0(wk.goal)}</b><span>week goal</span></div></div>
    ${bar('Week so far', Math.max(0, wk.total), wk.goal, 'cal')}
    <div class="mute">On pace: ${r0(wk.pace)} by today (${wk.counted} day${wk.counted === 1 ? '' : 's'}).${wk.skipped ? ` ${wk.skipped} missed day${wk.skipped === 1 ? '' : 's'} left out.` : ''}</div>${btn}`, done ? 'checked off' : 'not checked off');
}
function summaryCard() {
  const st = dayStats(todayKey()), wk = weekStats(), dg = deficitGoal();
  const row = (l, v) => `<div class="item"><span>${l}</span><b>${v}</b></div>`;
  return `<div class="card sum"><h2>Day checked off</h2>
    ${row('Maintenance', st.maint + ' cal')}${row('Burned in workouts', '+' + st.burned + ' cal')}${row('Eaten', '-' + st.eaten + ' cal')}
    ${row(st.deficit >= 0 ? 'Deficit' : 'Surplus', `<span class="${st.deficit >= dg ? 'okc' : st.deficit < 0 ? 'neg' : ''}">${Math.abs(st.deficit)} cal</span>`)}
    ${row('Food target today', `${foodTarget()} cal (${calTarget()} + ${st.burned} earned)`)}${row('Daily goal', dg + ' cal')}${row('Week total', `${signed(wk.total)} of ${r0(wk.goal)} cal`)}
    <div class="mute">${st.deficit >= dg ? 'Goal hit.' : st.deficit >= 0 ? `${dg - st.deficit} cal short of the goal, still a deficit.` : 'Over maintenance today.'} About ${(st.deficit / 3500).toFixed(2)} lb.</div>
    <div class="row"><button class="btn" data-act="sumclose">Done</button></div></div>`;
}

// weight: carries the last value forward. volume: today's TOTAL lifting volume (preset sets + manual).
// The saved 'volume' record holds only the manual part (total minus preset sets), so nothing double counts.
const setsToday = () => sum(of('set', todayKey()), (r) => r.value);
const COUNTERS = {
  weight: { label: 'Weight today', unit: 'lb', step: 1, start: () => of('weight').at(-1)?.value || 0 },
  volume: { label: 'Weight volume', unit: 'lb', step: 25, start: () => volumeByDay()[todayKey()] || 0 },
};
const cIn = {}; // working counter values
function counterCard(id) {
  const c = COUNTERS[id], saved = of(id, todayKey()).at(-1);
  if (cIn[id] == null) cIn[id] = c.start();
  const note = id === 'volume'
    ? `Presets today: ${r0(setsToday())} lb${saved ? ' · saved ' + fmtTime(saved.ts) : ''}`
    : saved ? 'Last saved ' + fmtTime(saved.ts) + ': ' + saved.value : 'Not saved today';
  return card(c.label, `<div class="ctr">
      <button class="pm" data-cstep="${id}:-1" aria-label="minus">-</button>
      <input id="in-${id}" type="number" inputmode="decimal" value="${cIn[id]}">
      <button class="pm" data-cstep="${id}:1" aria-label="plus">+</button></div>
    <div class="row"><button class="btn" data-csave="${id}">Save ${c.unit}</button></div>
    <div class="mute">${note}</div>`);
}

function waterCard() {
  return card('Water', `<div class="grid3">${[8, 16, 24].map((n) => `<button class="chip" data-water="${n}">+${n} oz</button>`).join('')}</div>`, `${sum(of('water', todayKey()), (r) => r.value)} / ${profile.water} oz`);
}

const presetsCard = () => card('Workout presets', `<div class="grid">${presets.map((p) => `<button class="preset" data-log="${p.id}"><b>${esc(p.name)}</b><span>${esc(presetLine(p))} · ${presetBurn(p)} cal</span></button>`).join('')}</div>`, `tap to log · ${r0(burnByDay()[todayKey()] || 0)} cal earned today`);

function lineFor(r) {
  if (r.metric === 'set') return `${esc(r.name)}: ${esc(presetLine(r))} · ${burnOf(r)} cal`;
  if (r.metric === 'done') return 'Day checked off';
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
  const totals = card('Food today', bar('Calories', sum(food, (f) => f.cal), foodTarget(t), 'cal', true) + bar('Protein', sum(food, (f) => f.p), profile.protein, 'g')
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
      ${localHits.length ? `<h3>From your list</h3>${localHits.map((x) => `<div class="item"><span>${esc(x.name)} <span class="mute">${r0(x.f.cal)} cal</span></span><button class="x" data-quick="${esc(x.key)}">Log</button></div>`).join('')}` : ''}
      ${results.length ? '<h3>Open Food Facts</h3>' : ''}${results.map((x, i) => `<div class="item"><span>${esc(x.name)} <span class="mute">${r0(x.per100.cal)} cal/100g</span></span><button class="x" data-pick="${i}">Pick</button></div>`).join('')}
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

function projectedCard() {
  const pr = projected();
  if (!pr) return card('Projected loss', '<div class="mute">Check off days to see what your deficit should be doing to the scale.</div>', 'last 28 days');
  const row = (l, v) => `<div class="item"><span>${l}</span><b>${v}</b></div>`;
  const note = pr.actual == null ? 'Weigh in at least twice to compare with the scale.'
    : pr.actual <= pr.lb ? 'The scale is keeping up with your logs.'
    : 'The scale is behind the logs. Common causes: missed snacks or drinks, portions bigger than logged, or water weight. Give it two weeks before changing anything.';
  return card('Projected loss', row('Logged deficit', `${signed(pr.total)} cal on ${pr.days} complete day${pr.days === 1 ? '' : 's'}`) + row('Projected', `${pr.lb > 0 ? '+' : ''}${pr.lb} lb`)
    + row('Actual on the scale', pr.actual == null ? 'not enough weigh-ins' : `${pr.actual > 0 ? '+' : ''}${pr.actual} lb`) + `<div class="mute">3500 cal is about 1 lb. Missed days are not in the projection. ${note}</div>`, 'last 28 days');
}

function bodyView() {
  const tr = trend(), sl = lastSleep();
  const wt = card('Weight trend', tr ? `<div class="big">${tr.avg} lb</div><div class="mute">7-day average · goal ${profile.goal} lb · ${tr.toGo} lb to go</div>
      <div class="mute">${tr.perWeek == null ? 'Rate needs 3+ weigh-ins in 28 days.' : `${tr.perWeek > 0 ? '+' : ''}${tr.perWeek} lb/week`}${tr.eta ? ` · goal around ${tr.eta}` : ''}</div>` : '<div class="mute">Log your weight on Today.</div>')
    + projectedCard();
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

// ---------- charts: shared time window (range chips + pan slider), axes, drag-to-read crosshair ----------
let range = 30, back = 0; // days shown (0 = all), days panned back from today
const RANGES = [[7, '1W'], [30, '1M'], [90, '3M'], [180, '6M'], [365, '1Y'], [0, 'All']];
const dayDiff = (a, b) => Math.round((new Date(b + 'T12:00') - new Date(a + 'T12:00')) / 864e5);
const fmtDay = (d, yr) => new Date(d + 'T12:00').toLocaleDateString([], yr ? { month: 'short', year: '2-digit' } : { month: 'short', day: 'numeric' });
const fmtLong = (d) => new Date(d + 'T12:00').toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
const firstDay = () => live().reduce((m, r) => { const d = localDay(r.ts); return d < m ? d : m; }, todayKey());
function win() {
  const t = todayKey(), f = firstDay();
  if (!range) return { start: f < t ? f : dayAdd(t, -6), end: t, maxBack: 0 };
  const maxBack = Math.max(0, dayDiff(f, t) + 1 - range);
  back = Math.min(back, maxBack);
  const end = dayAdd(t, -back);
  return { start: dayAdd(end, -range + 1), end, maxBack };
}
function niceTicks(lo, hi, n = 4) {
  const raw = (hi - lo) / n, mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const out = [];
  for (let v = Math.floor(lo / step) * step; v <= Math.ceil(hi / step) * step + step / 2; v += step) out.push(+v.toFixed(6));
  return out;
}
const fmtNum = (v) => (Math.abs(v) >= 10000 ? (v / 1000).toFixed(0) + 'k' : Math.abs(v) >= 1000 ? (v / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(+v.toFixed(1)));

const CH = []; // per-chart crosshair data, rebuilt every draw
const CW = 340, CHH = 200, CL = 46, CR = 10, CT = 12, CB = 26;
function chart(label, byDay, unit, { target, kind = 'bar', dec = 0 } = {}) {
  const { start, end } = win(), n = dayDiff(start, end) + 1, pw = CW - CL - CR, ph = CHH - CT - CB;
  const days = Object.keys(byDay).filter((d) => d >= start && d <= end).sort();
  if (!days.length) return card(label, `<div class="mute">Nothing logged ${fmtDay(start)} to ${fmtDay(end)}.</div>`);
  const vals = days.map((d) => byDay[d]), fv = (v) => (+v).toFixed(dec);
  let lo = kind === 'bar' ? Math.min(0, ...vals) : Math.min(...vals), hi = Math.max(...vals, kind === 'bar' ? target || 0 : -Infinity);
  if (hi === lo) { lo -= 1; hi += 1; }
  const ticks = niceTicks(lo, hi); lo = ticks[0]; hi = ticks.at(-1);
  const x = (d) => CL + ((dayDiff(start, d) + 0.5) * pw) / n, y = (v) => CT + ph - ((v - lo) / (hi - lo)) * ph;
  const yr = n > 200;
  let g = ticks.map((v) => `<line class="gl" x1="${CL}" x2="${CW - CR}" y1="${y(v)}" y2="${y(v)}"/><text class="ax" x="${CL - 6}" y="${y(v) + 4}" text-anchor="end">${fmtNum(v)}</text>`).join('');
  const xt = n === 1 ? [start] : [0, 1, 2, 3].map((i) => dayAdd(start, Math.round((i * (n - 1)) / 3)));
  g += [...new Set(xt)].map((d, i, a) => `<text class="ax" x="${x(d)}" y="${CHH - 8}" text-anchor="${i === 0 && a.length > 1 ? 'start' : i === a.length - 1 && a.length > 1 ? 'end' : 'middle'}">${fmtDay(d, yr)}</text>`).join('');
  if (target && target >= lo && target <= hi) g += `<line class="tg" x1="${CL}" x2="${CW - CR}" y1="${y(target)}" y2="${y(target)}"/>`;
  const pts = days.map((d, i) => ({ d, v: vals[i], px: x(d), py: y(vals[i]) }));
  if (kind === 'bar') {
    const bw = Math.max(1.5, (pw / n) * 0.7);
    const y0 = y(Math.max(lo, 0)); // bars grow from zero, up or down
    g += pts.map((p) => `<rect class="mk${p.v < 0 ? ' neg' : ''}" x="${p.px - bw / 2}" y="${Math.min(p.py, y0)}" width="${bw}" height="${Math.abs(y0 - p.py)}" rx="${Math.min(2, bw / 3)}"/>`).join('');
  } else {
    g += `<polyline class="ln" points="${pts.map((p) => p.px + ',' + p.py).join(' ')}"/>`;
    if (pts.length <= 60) g += pts.map((p) => `<circle class="dot" cx="${p.px}" cy="${p.py}" r="3"/>`).join('');
  }
  const idx = CH.length;
  const rl = (RANGES.find(([r]) => r === range) || [])[1];
  let summary;
  if (kind === 'line') {
    const ch = vals.at(-1) - vals[0], pct = vals[0] ? (ch / vals[0]) * 100 : 0;
    summary = days.length > 1 ? `<span class="${ch < 0 ? 'dn' : ch > 0 ? 'up' : ''}">${ch > 0 ? '+' : ''}${fv(ch)} ${unit} (${pct > 0 ? '+' : ''}${pct.toFixed(1)}%)</span> ${fmtDay(days[0])} to ${fmtDay(days.at(-1))}` : fmtLong(days[0]);
  } else summary = `avg ${fmtNum(sum(vals, (v) => v) / vals.length)} ${unit}/day on ${days.length} logged day${days.length === 1 ? '' : 's'}${target ? ` · target ${fmtNum(target)}` : ''}`;
  const latest = `<b data-v>${fv(vals.at(-1))}</b> <span class="mute">${unit}</span>`;
  CH.push({ pts, latest, summary, fv, unit });
  return `<div class="card"><h2>${label}${rl && back === 0 ? ` <span class="mute">${rl}</span>` : ''}</h2>
    <div class="chd" data-hd="${idx}"><div class="cv">${latest}</div><div class="mute cs">${summary}</div></div>
    <svg class="chart" data-ch="${idx}" viewBox="0 0 ${CW} ${CHH}" width="100%" role="img" aria-label="${label} chart">${g}
      <line class="xh" x1="0" x2="0" y1="${CT}" y2="${CT + ph}" visibility="hidden"/><circle class="xd" r="5" visibility="hidden"/></svg></div>`;
}
function chartsHtml() {
  CH.length = 0;
  return chart('Weight', weightByDay(), 'lb', { kind: 'line', dec: 1, target: profile.goal })
    + chart('Deficit (complete days)', deficitByDay(), 'cal', { target: deficitGoal() })
    + chart('Calories', foodByDay('cal'), 'cal', { target: calTarget() }) // line is the base target; workout days allow more
    + chart('Burned in workouts', burnByDay(), 'cal')
    + chart('Protein', foodByDay('p'), 'g', { target: profile.protein })
    + chart('Lifting volume', volumeByDay(), 'lb');
}
const winLabel = (a, b) => { const y = (d) => (d.slice(0, 4) === todayKey().slice(0, 4) ? '' : " '" + d.slice(2, 4)); return `${fmtDay(a)}${y(a)} to ${fmtDay(b)}${y(b)}`; };
function timelineCard() {
  const { start, end, maxBack } = win();
  return `<div class="card tl"><div class="grid6">${RANGES.map(([r, l]) => `<button class="chip${r === range ? ' on' : ''}" data-range="${r}">${l}</button>`).join('')}</div>
    <input id="pan" type="range" min="0" max="${maxBack}" value="${maxBack - back}" ${maxBack ? '' : 'disabled'} aria-label="slide through time">
    <div class="mute tlr"><span id="winlbl">${winLabel(start, end)}</span><span>${maxBack ? '← slide for earlier' : ''}</span></div>
    <div class="mute">Drag across a chart to read any day.</div></div>`;
}
function scrub(svg, e) {
  const c = CH[+svg.dataset.ch], hd = document.querySelector(`[data-hd="${svg.dataset.ch}"]`);
  if (!c || !hd) return;
  const b = svg.getBoundingClientRect(), mx = ((e.clientX - b.left) / b.width) * CW;
  const p = c.pts.reduce((a, q) => (Math.abs(q.px - mx) < Math.abs(a.px - mx) ? q : a));
  const xh = svg.querySelector('.xh'), xd = svg.querySelector('.xd');
  xh.setAttribute('x1', p.px); xh.setAttribute('x2', p.px); xh.setAttribute('visibility', 'visible');
  xd.setAttribute('cx', p.px); xd.setAttribute('cy', p.py); xd.setAttribute('visibility', 'visible');
  hd.querySelector('.cv').innerHTML = `<b>${c.fv(p.v)}</b> <span class="mute">${c.unit}</span>`;
  hd.querySelector('.cs').textContent = fmtLong(p.d);
}
function unscrub(svg) {
  const c = CH[+svg.dataset.ch], hd = document.querySelector(`[data-hd="${svg.dataset.ch}"]`);
  svg.querySelectorAll('.xh,.xd').forEach((el) => el.setAttribute('visibility', 'hidden'));
  if (c && hd) { hd.querySelector('.cv').innerHTML = c.latest; hd.querySelector('.cs').innerHTML = c.summary; }
}
function bindCharts() {
  document.querySelectorAll('svg.chart').forEach((svg) => {
    const on = (e) => scrub(svg, e), off = () => unscrub(svg);
    svg.addEventListener('pointerdown', on); svg.addEventListener('pointermove', on);
    ['pointerup', 'pointerleave', 'pointercancel'].forEach((k) => svg.addEventListener(k, off));
  });
}

// ---------- activity grid: one square per day, darker = more kinds of things logged ----------
const CATS = { set: 'workout', volume: 'workout', weight: 'weight', food: 'food', water: 'water', sleep: 'sleep', measure: 'body', photo: 'body' };
let actBy = {};
function activityCard() {
  actBy = {};
  live().forEach((r) => { const c = CATS[r.metric]; if (c) (actBy[localDay(r.ts)] ||= new Set()).add(c); });
  const t = todayKey(), start = dayAdd(t, -(52 * 7 + new Date(t + 'T12:00').getDay())); // Sunday, 52 weeks back
  const S = 15, G = 3, L = 30, T = 18, cols = Math.ceil((dayDiff(start, t) + 1) / 7);
  let cells = '', months = '';
  for (let i = 0, d = start; d <= t; i++, d = dayAdd(d, 1)) {
    const col = Math.floor(i / 7), row = i % 7, k = actBy[d]?.size || 0;
    cells += `<rect class="l${Math.min(4, k)}${d === t ? ' td' : ''}" x="${L + col * (S + G)}" y="${T + row * (S + G)}" width="${S}" height="${S}" rx="3" data-day="${d}"/>`;
    if (row === 0 && +d.slice(8) <= 7 && col < cols - 1) months += `<text class="ax" x="${L + col * (S + G)}" y="12">${fmtDay(d, d.slice(5, 7) === '01')}</text>`;
  }
  const wd = [[1, 'Mon'], [3, 'Wed'], [5, 'Fri']].map(([r, l]) => `<text class="ax" x="0" y="${T + r * (S + G) + 12}">${l}</text>`).join('');
  const W = L + cols * (S + G), H = T + 7 * (S + G);
  // streaks: today counts if logged, otherwise the run can still end yesterday
  let cur = 0, best = 0, run = 0;
  for (let d = actBy[t] ? t : dayAdd(t, -1); actBy[d]; d = dayAdd(d, -1)) cur++;
  for (let d = start; d <= t; d = dayAdd(d, 1)) { run = actBy[d] ? run + 1 : 0; best = Math.max(best, run); }
  const year = Object.keys(actBy).filter((d) => d >= start).length;
  return card('Activity', `<div class="acts"><div><b>${cur}</b><span>day streak</span></div><div><b>${best}</b><span>best streak</span></div><div><b>${year}</b><span>days logged</span></div></div>
    <div class="hscroll" id="actscroll"><svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="days logged over the past year">${months}${wd}${cells}</svg></div>
    <div class="legend mute"><span id="actinfo">Tap a square to see that day.</span><span class="lg">Less ${[0, 1, 2, 3, 4].map((l) => `<i class="l${l}"></i>`).join('')} More</span></div>`, 'past year');
}

// ---------- logging calendar: checked off / partly logged (food but no check-off) / missed ----------
let calBy = {};
function logCalendarCard() {
  const done = completeDays(), food = foodByDay('cal'), t = todayKey();
  const start = dayAdd(t, -(26 * 7 + new Date(t + 'T12:00').getDay())); // Sunday, 26 weeks back
  const S = 15, G = 3, L = 30, T = 18, cols = Math.ceil((dayDiff(start, t) + 1) / 7);
  let cells = '', months = '', nDone = 0, nPart = 0, nMiss = 0;
  calBy = {};
  for (let i = 0, d = start; d <= t; i++, d = dayAdd(d, 1)) {
    const col = Math.floor(i / 7), row = i % 7;
    const s = done.has(d) ? 'done' : food[d] ? 'part' : 'miss';
    calBy[d] = d === t && s !== 'done' ? 'today, not checked off yet' : { done: 'checked off', part: 'food logged but not checked off', miss: 'nothing logged' }[s];
    if (d !== t) { if (s === 'done') nDone++; else if (s === 'part') nPart++; else if (d >= firstDay()) nMiss++; }
    cells += `<rect class="cal-${s}${d === t ? ' td' : ''}" x="${L + col * (S + G)}" y="${T + row * (S + G)}" width="${S}" height="${S}" rx="3" data-cday="${d}"/>`;
    if (row === 0 && +d.slice(8) <= 7 && col < cols - 1) months += `<text class="ax" x="${L + col * (S + G)}" y="12">${fmtDay(d, d.slice(5, 7) === '01')}</text>`;
  }
  const wd = [[1, 'Mon'], [3, 'Wed'], [5, 'Fri']].map(([r, l]) => `<text class="ax" x="0" y="${T + r * (S + G) + 12}">${l}</text>`).join('');
  const W = L + cols * (S + G), H = T + 7 * (S + G);
  return card('Logging calendar', `<div class="acts"><div><b>${nDone}</b><span>complete</span></div><div><b>${nPart}</b><span>partial</span></div><div><b>${nMiss}</b><span>missed</span></div></div>
    <div class="hscroll calscroll"><svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="checked off days">${months}${wd}${cells}</svg></div>
    <div class="legend mute"><span id="calinfo">Tap a square to see that day.</span><span class="lg"><i class="cal-done"></i> done <i class="cal-part"></i> partial <i class="cal-miss"></i> missed</span></div>`, 'past 6 months');
}

function presetEditor() {
  const row = (p) => editing === p.id
    ? `<div class="edit" data-pid="${p.id}">
        <input data-f="name" value="${esc(p.name)}" placeholder="Name">
        <div class="row"><input data-f="weight" type="number" inputmode="decimal" value="${p.weight}" placeholder="lb"><input data-f="reps" type="number" inputmode="decimal" value="${p.reps}" placeholder="reps"><input data-f="unit" value="${esc(p.unit)}" placeholder="unit"></div>
        <label class="mute">Type<select data-f="kind">${Object.entries(KINDS).map(([k, [l]]) => `<option value="${k}"${p.kind === k ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
        <div class="row"><label class="mute">Minutes per tap<input data-f="min" type="number" inputmode="decimal" value="${p.min ?? ''}"></label>
          <label class="mute">Calories<input data-f="cal" type="number" inputmode="decimal" value="${p.cal ?? ''}" placeholder="auto"></label></div>
        <div class="mute">Leave Calories blank to use the estimate (${estBurn(p.kind, p.min)} cal now).</div>
        <div class="row"><button class="btn" data-act="psave">Save</button><button class="btn ghost" data-act="pdel">Delete</button></div></div>`
    : `<div class="item"><span>${esc(p.name)} · <span class="mute">${esc(presetLine(p))} · ${presetBurn(p)} cal${p.cal != null && p.cal !== '' ? ' (set)' : ' (auto)'}</span></span><button class="x" data-pedit="${p.id}">Edit</button></div>`;
  return card('Workout presets', presets.map(row).join('') + `<div class="row" style="margin-top:12px"><button class="btn" data-act="padd">Add preset</button></div>
    <div class="mute">Calories burned are estimated from your current weight, the exercise type and the minutes one tap takes. Leave Calories blank to keep the estimate updating as you lose weight.</div>`);
}

function profileCard() {
  const p = profile, td = tdee();
  const f = (k, label, type = 'number') => `<label class="mute">${label}<input data-pf="${k}" type="${type}" ${type === 'number' ? 'inputmode="decimal"' : ''} value="${esc(p[k])}"></label>`;
  return card('Targets and profile', `<div class="row"><label class="mute">Sex<select data-pf="sex"><option value="male"${p.sex === 'male' ? ' selected' : ''}>Male</option><option value="female"${p.sex === 'female' ? ' selected' : ''}>Female</option></select></label>${f('age', 'Age')}${f('heightIn', 'Height (in)')}</div>
    <label class="mute">Activity<select data-pf="activity">${[[1.2, 'Desk, little exercise'], [1.375, 'Light exercise 1-3 days'], [1.55, 'Moderate 3-5 days'], [1.725, 'Hard 6-7 days']].map(([v, l]) => `<option value="${v}"${+p.activity === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
    <div class="row">${f('goal', 'Goal lb')}${f('deficitPct', 'Deficit %')}${f('floor', 'Min cal')}</div>
    <div class="row">${f('protein', 'Protein g')}${f('water', 'Water oz')}</div>
    <div class="row">${f('bed', 'Bed by', 'time')}${f('wake', 'Up by', 'time')}</div>
    <div class="row"><button class="btn" data-act="profile">Save targets</button></div>
    <div class="mute">Maintenance ${td.value} cal (formula ${td.formula}${td.adaptive ? `, from your logs ${td.adaptive}` : `; adapts after 14 complete days, have ${td.logged}`}). Base food target ${calTarget()} cal (${p.deficitPct}% under, never below ${p.floor}). Every calorie a workout preset burns is added to that day's food target, so the daily deficit goal stays ${deficitGoal()} cal whether you work out or not. Work out more, eat more.</div>`);
}

function remindCard() {
  const on = ld('fitapp.push', false), perm = 'Notification' in window ? Notification.permission : 'unsupported';
  return card('Reminders', `<p class="mute">A Chrome notification every 3 hours, 8am to 8pm, showing what's left for water, protein, calories and your deficit. At 2pm it flags if no food is logged yet. At 9pm it nudges you to check off the day, only if you haven't.</p>
    <div class="row"><button class="btn" data-act="push">${on ? 'Re-register this phone' : 'Turn on reminders'}</button>${on ? '<button class="btn ghost" data-act="pushtest">Test</button>' : ''}</div>
    <div class="mute">${perm === 'denied' ? 'Notifications are blocked. Allow them in Chrome site settings for this app.' : ld('fitapp.pushDead', false) ? 'Not working right now. Tap Re-register this phone.' : on ? 'On for this phone. Checked and renewed automatically each time the app opens.' : 'Off.'}</div>`);
}
const vapidKey = () => Uint8Array.from(atob(VAPID_PUBLIC.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
// save this phone's subscription to data/push.json in the private repo (the reminder job reads it from there)
async function saveSub(sub, why) {
  const g = await fetch(api('data/push.json'), { headers: ghHeaders() });
  if (!g.ok && g.status !== 404) throw new Error(`could not read data/push.json (GitHub ${g.status}${g.status === 401 || g.status === 403 ? ', token expired or missing Contents access' : ''})`);
  const sha = g.ok ? (await g.json()).sha : undefined;
  const body = { subscription: sub.toJSON(), tz: Intl.DateTimeFormat().resolvedOptions().timeZone, updated: new Date().toISOString() };
  const p = await fetch(api('data/push.json'), { method: 'PUT', headers: ghHeaders(), body: JSON.stringify({ message: why, content: b64(JSON.stringify(body, null, 1) + '\n'), sha }) });
  if (!p.ok) throw new Error(`could not write data/push.json (GitHub ${p.status}${p.status === 401 || p.status === 403 ? ', token expired or missing Contents write access' : p.status === 409 ? ', file changed, tap again' : ''})`);
  sv('fitapp.pushEndpoint', sub.endpoint);
}
// throw away any old subscription and make a new one: an expired one can still be returned by getSubscription()
async function freshSub() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) throw new Error('this browser does not support push notifications');
  const reg = await navigator.serviceWorker.ready;
  const old = await reg.pushManager.getSubscription();
  if (old) await old.unsubscribe().catch(() => {});
  return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: vapidKey() });
}
async function enablePush() {
  if (!token) { status = 'Add a token first; the reminder job reads your subscription from the private repo.'; return render(); }
  if (!('Notification' in window)) { status = 'This browser does not support notifications. Open the app in Chrome.'; return render(true); }
  if (await Notification.requestPermission() !== 'granted') { status = 'Notifications not allowed. Allow them in Chrome site settings for this app, then tap again.'; return render(true); }
  status = 'Registering this phone...'; render();
  await saveSub(await freshSub(), 'register push subscription');
  sv('fitapp.push', true); sv('fitapp.pushDead', false); status = 'Reminders on. Tap Test to send one through the reminder job.'; render(true);
}
// On every app open: if the reminder job reported the subscription dead (HTTP 410), or Chrome rotated it,
// make a new one and save it, so reminders fix themselves without a trip to Settings.
async function healPush() {
  if (!token || !ld('fitapp.push', false) || !('Notification' in window) || Notification.permission !== 'granted' || !('serviceWorker' in navigator)) return;
  try {
    const g = await fetch(api('data/push.json'), { headers: { ...ghHeaders(), Accept: 'application/vnd.github.raw' }, cache: 'no-store' });
    const remote = g.ok ? await g.json() : null;
    const reg = await navigator.serviceWorker.ready;
    const cur = await reg.pushManager.getSubscription();
    const why = !remote ? 'no subscription saved in the repo' : remote.dead ? `the reminder job got "${remote.dead}"`
      : !cur ? 'Chrome dropped the subscription' : remote.subscription?.endpoint !== cur.endpoint ? 'Chrome changed the subscription' : '';
    if (!why) { sv('fitapp.pushDead', false); return; }
    await saveSub(await freshSub(), 'renew push subscription (' + why + ')');
    sv('fitapp.pushDead', false); status = `Reminders were broken (${why}). Re-registered this phone automatically.`; render();
  } catch (e) { sv('fitapp.pushDead', true); status = 'Reminders need attention: ' + e.message + '. Open Settings > Reminders.'; render(); }
}
// real test: ask GitHub to run the reminder job now with a test message (same path as the scheduled reminders)
async function testPush() {
  if (!token) { status = 'Add a token first.'; return render(); }
  status = 'Asking the reminder job to send a test...'; render();
  const r = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/remind.yml/dispatches`, { method: 'POST', headers: ghHeaders(), body: JSON.stringify({ ref: 'main', inputs: { test: 'yes' } }) });
  if (r.status === 204) { status = 'Test sent to the reminder job. A notification should arrive in about 30 to 60 seconds. If it does not, tap Re-register this phone.'; return render(true); }
  const why = r.status === 403 || r.status === 404 ? 'your token cannot start workflows. Give it Actions: Read and write on fitapp-data, or use the GitHub Actions tab > remind > Run workflow' : r.status === 401 ? 'token expired' : 'unexpected error';
  status = `Could not start the reminder job (GitHub ${r.status}: ${why}). Showing a local preview instead.`; render(true);
  (await navigator.serviceWorker.ready).showNotification('FitApp check-in', { body: 'Local preview only. This did not go through the reminder job.', icon: 'icon-192.png', tag: 'remind' });
}

const views = {
  today: () => dashboard() + counterCard('weight') + counterCard('volume') + presetsCard() + logList((r) => ['set', 'weight', 'volume', 'water'].includes(r.metric), "Today's log", `volume ${volumeByDay()[todayKey()] || 0} lb`),
  food: foodView,
  body: bodyView,
  charts: () => logCalendarCard() + activityCard() + timelineCard() + `<div id="charts">${chartsHtml()}</div>`,
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
  if (tab === 'charts') { bindCharts(); document.querySelectorAll('#actscroll,.calscroll').forEach((s) => (s.scrollLeft = s.scrollWidth)); }
}

// ---------- GitHub ----------
const b64 = (s) => btoa(unescape(encodeURIComponent(s)));
const unb64 = (s) => decodeURIComponent(escape(atob(s.replace(/\n/g, ''))));
const ghHeaders = () => ({ Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' });
const api = (p) => `https://api.github.com/repos/${REPO}/contents/${p}`;

// data/today.json: tiny summary for home-screen widgets and the reminder job
async function putSummary(headers) {
  const day = todayKey(), food = of('food', day), sl = lastSleep(), st = dayStats(day), wk = weekStats();
  const body = { date: day, weight: trend()?.avg ?? null, volume: volumeByDay()[day] || 0, cal: r0(sum(food, (f) => f.cal)), cal_target: foodTarget(day), cal_base: calTarget(), protein: r0(sum(food, (f) => f.p)), protein_target: profile.protein, water: sum(of('water', day), (r) => r.value), water_target: profile.water, sleep_ok: sl ? sleepOk(sl) : null,
    food_count: food.length, burned: st.burned, deficit: st.deficit, deficit_goal: deficitGoal(), week_deficit: r0(wk.total), week_goal: r0(wk.goal), checked_off: isDone(day), streak: streak(), updated: new Date().toISOString() };
  const g = await fetch(api('data/today.json'), { headers });
  if (!g.ok && g.status !== 404) throw new Error(`could not read data/today.json (GitHub ${g.status}${g.status === 401 || g.status === 403 ? ', token expired or missing Contents access' : ''})`);
  const sha = g.ok ? (await g.json()).sha : undefined;
  const p = await fetch(api('data/today.json'), { method: 'PUT', headers, body: JSON.stringify({ message: 'update today summary', content: b64(JSON.stringify(body, null, 1) + '\n'), sha }) });
  if (!p.ok) throw new Error(`could not write data/today.json (GitHub ${p.status}${p.status === 409 || p.status === 422 ? ', changed on another device, will retry next sync' : p.status === 401 || p.status === 403 ? ', token expired or missing Contents write access' : ''}). Reminders use this file, so they may be out of date`);
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
// fetch JSON from Open Food Facts with a timeout and one retry when the server is busy (it rate limits searches)
async function offGet(url) {
  for (let i = 0; i < 2; i++) {
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 12000);
    let r;
    try { r = await fetch(url, { signal: ctl.signal }); }
    catch (e) {
      // a busy Open Food Facts answers 503 without CORS headers, which the browser reports as a network error
      if (e.name !== 'AbortError' && navigator.onLine && i === 0) { await new Promise((ok) => setTimeout(ok, 2500)); continue; }
      throw new Error(e.name === 'AbortError' ? 'Open Food Facts took over 12 seconds to answer' : navigator.onLine ? 'could not reach Open Food Facts, it is probably busy (it limits searches to about 10 a minute). Wait a minute and try again' : 'you are offline');
    } finally { clearTimeout(t); }
    if ((r.status === 503 || r.status === 429) && i === 0) { await new Promise((ok) => setTimeout(ok, 2500)); continue; }
    if (r.status === 503 || r.status === 429) throw new Error(`Open Food Facts is busy (HTTP ${r.status}), it limits searches to about 10 a minute. Wait a minute and try again`);
    if (!r.ok) throw new Error(`Open Food Facts returned HTTP ${r.status}`);
    try { return await r.json(); } catch { throw new Error('Open Food Facts sent back something that is not JSON'); }
  }
}
// built-in foods and My meals whose name contains every word of the query
function localMatches(q) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const hit = (txt) => words.every((w) => txt.toLowerCase().includes(w));
  return meals.filter((m) => hit(m.name)).map((m) => ({ key: 'm:' + m.id, name: m.name, f: m }))
    .concat(FOOD_GROUPS.flatMap(([g, items]) => items.map((it, i) => ({ key: `f:${g}:${i}`, name: it[0], g, f: foodOf(it) })).filter((x) => hit(x.name + ' ' + x.g))));
}
async function lookupBarcode(code) {
  status = 'Looking up ' + code + '...'; render();
  try {
    const j = await offGet(`${OFF}/api/v2/product/${code}.json?fields=product_name,brands,nutriments,serving_quantity`);
    if (j.status !== 1 || !j.product) { status = `Barcode ${code} is not in Open Food Facts. Add it manually below.`; return render(); }
    found = fromOff(j.product); results = []; status = ''; render(true);
  } catch (e) { status = 'Barcode lookup failed: ' + e.message + '.'; render(); }
}
async function searchFood(q) {
  if (/^\d{8,14}$/.test(q)) return lookupBarcode(q);
  localHits = localMatches(q).slice(0, 8);
  status = 'Searching...'; results = []; found = null; render(true);
  try {
    const j = await offGet(`${OFF}/cgi/search.pl?search_terms=${encodeURIComponent(q)}&json=1&page_size=12&fields=product_name,brands,nutriments,serving_quantity`);
    results = (j.products || []).map(fromOff).filter((x) => x.per100.cal);
    status = results.length || localHits.length ? '' : `No matches for "${q}". Try fewer words or add it manually.`; render(true);
  } catch (e) { status = 'Online search failed: ' + e.message + '.' + (localHits.length ? ' Showing matches from your list.' : ''); render(true); }
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
  checkoff() {
    if (isDone()) return;
    if (!of('food', todayKey()).length && !confirm('No food is logged today. Check off anyway? The day will count as 0 calories eaten.')) return;
    showSum = true;
    add({ metric: 'done', day: todayKey(), value: 1 }, 'Day checked off.');
  },
  uncheck() {
    const recs = of('done').filter((r) => (r.day || localDay(r.ts)) === todayKey());
    if (!recs.length || !confirm('Undo today\'s check-off?')) return;
    showSum = false;
    recs.forEach((r) => records.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), ts: new Date().toISOString(), metric: 'del', ref: rkey(r), synced: false }));
    sv(KEY, records); status = 'Check-off undone.'; render(true); sync().then(() => render());
  },
  sumopen() { showSum = true; render(true); },
  sumclose() { showSum = false; render(true); },
  padd() { const p = { id: 'p' + Date.now(), name: 'New preset', weight: 0, reps: 10, unit: 'reps', kind: 'lift', min: 3, cal: null }; presets.push(p); sv('fitapp.presets', presets); editing = p.id; render(true); },
  tok() { token = val('#tok'); sv('fitapp.token', token); status = 'Token saved.'; render(true); sync().then(() => render()); },
  sync() { sync().then(() => render()); },
  push() { enablePush().catch((e) => { status = 'Reminders failed (' + e.message + ').'; render(true); }); },
  pushtest() { testPush().catch((e) => { status = 'Test failed (' + e.message + ').'; render(true); }); },
};

document.addEventListener('click', (e) => {
  const t = e.target.closest('button');
  if (!t) return;
  const d = t.dataset;
  if (d.tab) { tab = d.tab; status = ''; editing = null; return render(true); }
  if (d.cstep) { const [id, dir] = d.cstep.split(':'); cIn[id] = Math.max(0, +((parseFloat(val('#in-' + id)) || 0) + dir * COUNTERS[id].step).toFixed(1)); $('#in-' + id).value = cIn[id]; return; }
  if (d.csave) {
    const id = d.csave, v = parseFloat(val('#in-' + id)); if (isNaN(v)) return; cIn[id] = v; document.activeElement.blur();
    return add({ metric: id, value: id === 'volume' ? +(v - setsToday()).toFixed(1) : v }, 'Saved.');
  }
  if (d.log) {
    const p = presets.find((x) => x.id === d.log); if (!p) return;
    const v = +(p.weight * p.reps).toFixed(1), cur = parseFloat(val('#in-volume'));
    cIn.volume = +((isNaN(cur) ? COUNTERS.volume.start() : cur) + v).toFixed(1); // counter keeps any unsaved edit and adds the set
    const burn = presetBurn(p);
    return add({ metric: 'set', preset: p.id, name: p.name, weight: p.weight, reps: p.reps, unit: p.unit, value: v, burn }, `Logged ${p.name}${v ? ` (+${v} lb volume)` : ''}. +${burn} cal added to today's food.`);
  }
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
  if (d.del) { if (confirm('Delete this entry?')) { cIn.volume = null; add({ metric: 'del', ref: d.del }, 'Deleted.'); } return; }
  if (d.range != null) { range = +d.range; back = 0; return render(true); }
  if (d.pedit) { editing = d.pedit; return render(true); }
  if (d.act === 'psave' || d.act === 'pdel') {
    const box = t.closest('.edit'), id = box.dataset.pid;
    if (d.act === 'pdel') { if (!confirm('Delete preset?')) return; presets = presets.filter((p) => p.id !== id); }
    else {
      const f = (k) => box.querySelector(`[data-f="${k}"]`).value.trim();
      Object.assign(presets.find((x) => x.id === id), { name: f('name') || 'Preset', weight: parseFloat(f('weight')) || 0, reps: parseFloat(f('reps')) || 0, unit: f('unit') || 'reps', kind: f('kind') || 'lift', min: parseFloat(f('min')) || 0, cal: f('cal') === '' ? null : parseFloat(f('cal')) || 0 });
    }
    sv('fitapp.presets', presets); editing = null; status = 'Presets saved.'; return render(true);
  }
  if (handlers[d.act]) handlers[d.act]();
});
document.addEventListener('change', (e) => {
  if (e.target.id === 'scanfile' && e.target.files[0]) scanFile(e.target.files[0]);
  if (e.target.id === 'photofile' && e.target.files[0]) uploadPhoto(e.target.files[0]).catch((x) => { status = 'Photo failed (' + x.message + ').'; render(); });
});
// activity square tap: show that day's logged kinds without re-rendering
document.addEventListener('click', (e) => {
  const c = e.target.closest?.('rect[data-day]'), info = $('#actinfo');
  if (!c || !info) return;
  document.querySelectorAll('rect.sel').forEach((r) => r.classList.remove('sel'));
  c.classList.add('sel');
  const k = actBy[c.dataset.day];
  info.textContent = `${fmtLong(c.dataset.day)}: ${k ? [...k].join(', ') : 'nothing logged'}`;
});
// logging calendar tap: show that day's status
document.addEventListener('click', (e) => {
  const c = e.target.closest?.('rect[data-cday]'), info = $('#calinfo');
  if (!c || !info) return;
  document.querySelectorAll('rect.sel').forEach((r) => r.classList.remove('sel'));
  c.classList.add('sel');
  info.textContent = `${fmtLong(c.dataset.cday)}: ${calBy[c.dataset.cday] || 'nothing logged'}`;
});
// timeline slider pans every chart; only the chart list re-renders so the slider keeps the drag
document.addEventListener('input', (e) => {
  if (e.target.id !== 'pan') return;
  back = +e.target.max - +e.target.value;
  const { start, end } = win();
  $('#winlbl').textContent = winLabel(start, end);
  $('#charts').innerHTML = chartsHtml();
  bindCharts();
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
healPush();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
