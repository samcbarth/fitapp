// FitApp: workouts + nutrition + body metrics. No build, state in localStorage.
const KEY = 'fitapp.v1';
const today = () => new Date().toISOString().slice(0, 10);
const defaults = { workouts: [], food: [], body: [], goals: { kcal: 2400, protein: 160 } };
let S;
try { S = { ...defaults, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { S = { ...defaults }; }
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch {} };
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const num = (id) => parseFloat($('#' + id).value);
let tab = 'today';

function bar(v, max) { return `<div class="bar"><div style="width:${Math.min(100, (v / max) * 100 || 0)}%"></div></div>`; }

const views = {
  today() {
    const f = S.food.filter((x) => x.date === today());
    const kcal = f.reduce((a, x) => a + x.kcal, 0);
    const pro = f.reduce((a, x) => a + x.protein, 0);
    const w = S.workouts.filter((x) => x.date === today());
    const last = S.body.at(-1);
    return `
      <div class="card"><h2>Calories</h2><div class="big">${kcal} <span class="mute">/ ${S.goals.kcal}</span></div>${bar(kcal, S.goals.kcal)}</div>
      <div class="card"><h2>Protein (g)</h2><div class="big">${pro} <span class="mute">/ ${S.goals.protein}</span></div>${bar(pro, S.goals.protein)}</div>
      <div class="card"><h2>Sets logged today</h2><div class="big">${w.length}</div></div>
      <div class="card"><h2>Latest weight</h2><div class="big">${last ? last.weight + ' lb' : '-'}</div></div>
      <div class="card"><h2>Goals</h2>
        <div class="row"><input id="gk" type="number" value="${S.goals.kcal}" aria-label="kcal goal"><input id="gp" type="number" value="${S.goals.protein}" aria-label="protein goal"><button class="btn" data-act="goals">Save</button></div></div>`;
  },
  workouts() {
    const list = S.workouts.slice().reverse().slice(0, 30);
    const prs = {};
    S.workouts.forEach((x) => { prs[x.exercise] = Math.max(prs[x.exercise] || 0, x.weight); });
    return `
      <div class="card"><h2>Log a set</h2>
        <div class="row"><input id="ex" placeholder="Exercise" list="exs"></div>
        <datalist id="exs">${Object.keys(prs).map((e) => `<option value="${esc(e)}">`).join('')}</datalist>
        <div class="row"><input id="wt" type="number" placeholder="Weight"><input id="rp" type="number" placeholder="Reps"><button class="btn" data-act="addset">Add</button></div></div>
      <div class="card"><h2>Recent sets</h2>${list.map((x) => `<div class="item"><span>${esc(x.exercise)} <span class="mute">${x.weight} x ${x.reps} · ${x.date}${x.weight === prs[x.exercise] ? ' · PR' : ''}</span></span><button class="x" data-act="delset" data-id="${x.id}">x</button></div>`).join('') || '<div class="mute">Nothing yet.</div>'}</div>`;
  },
  food() {
    const f = S.food.filter((x) => x.date === today());
    return `
      <div class="card"><h2>Log food</h2>
        <div class="row"><input id="fn" placeholder="Food"></div>
        <div class="row"><input id="fk" type="number" placeholder="kcal"><input id="fp" type="number" placeholder="protein g"><button class="btn" data-act="addfood">Add</button></div></div>
      <div class="card"><h2>Today</h2>${f.map((x) => `<div class="item"><span>${esc(x.name)} <span class="mute">${x.kcal} kcal · ${x.protein}g</span></span><button class="x" data-act="delfood" data-id="${x.id}">x</button></div>`).join('') || '<div class="mute">Nothing yet.</div>'}</div>`;
  },
  body() {
    const list = S.body.slice().reverse().slice(0, 30);
    return `
      <div class="card"><h2>Log weight</h2>
        <div class="row"><input id="bw" type="number" step="0.1" placeholder="Weight (lb)"><button class="btn" data-act="addbody">Add</button></div></div>
      <div class="card"><h2>History</h2>${list.map((x) => `<div class="item"><span>${x.weight} lb <span class="mute">${x.date}</span></span><button class="x" data-act="delbody" data-id="${x.id}">x</button></div>`).join('') || '<div class="mute">Nothing yet.</div>'}</div>`;
  },
};

const id = () => Date.now() + Math.random();
const actions = {
  goals() { S.goals = { kcal: num('gk') || 2400, protein: num('gp') || 160 }; },
  addset() { const e = $('#ex').value.trim(); if (!e || isNaN(num('wt')) || isNaN(num('rp'))) return false; S.workouts.push({ id: id(), date: today(), exercise: e, weight: num('wt'), reps: num('rp') }); },
  addfood() { const n = $('#fn').value.trim(); if (!n || isNaN(num('fk'))) return false; S.food.push({ id: id(), date: today(), name: n, kcal: num('fk'), protein: num('fp') || 0 }); },
  addbody() { if (isNaN(num('bw'))) return false; S.body.push({ id: id(), date: today(), weight: num('bw') }); },
  delset(d) { S.workouts = S.workouts.filter((x) => x.id !== +d); },
  delfood(d) { S.food = S.food.filter((x) => x.id !== +d); },
  delbody(d) { S.body = S.body.filter((x) => x.id !== +d); },
};

function render() {
  $('#view').innerHTML = views[tab]();
  document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
}
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-tab],[data-act]');
  if (!t) return;
  if (t.dataset.tab) tab = t.dataset.tab;
  else if (actions[t.dataset.act](t.dataset.id) === false) return;
  else save();
  render();
});
$('#date').textContent = new Date().toDateString();
render();
