"use strict";
// Live window: the recorder pushes each change over /api/live/stream the moment it's detected.
// `live` carries the game itself and is drawn at once; `extra` (history, your past answers)
// follows right after. Timers are animated locally between updates.

const root = document.getElementById("live");
let state = null;      // latest `live` merged with the latest `extra`
let extra = {};
let receivedAt = 0;      // performance.now() when `state` last arrived
let nameFormOpen = false;

const secs = (ms) => `${Math.max(0, ms / 1000).toFixed(1)}s`;
const since = () => performance.now() - receivedAt;

function connect() {
  const source = new EventSource("/api/live/stream");
  source.addEventListener("live", (e) => {
    const next = JSON.parse(e.data);
    if (state && next.question !== state.question) {
      // New question: drop the old one's answers until its own arrive a moment later.
      extra = { ...extra, my_answers: null, familiarity: null };
    }
    state = { ...next, ...extra };
    receivedAt = performance.now();
    window.__lastLive = { detected_at: next.detected_at, received: performance.timeOrigin + performance.now() };
    render();
  });
  source.addEventListener("extra", (e) => {
    extra = JSON.parse(e.data);
    state = { ...state, ...extra };
    render();
  });
  source.onerror = () => {  // EventSource reconnects by itself
    state = { error: true };
    render();
  };
}

/** One full fetch, for when something changed that the recorder doesn't push (your name). */
async function refresh() {
  const full = await api("/api/live");
  extra = { session: full.session, history: full.history, familiarity: full.familiarity, my_answers: full.my_answers };
  state = full;
  receivedAt = performance.now();
  render();
}

function render() {
  if (!state) return;
  if (state.error) {
    root.innerHTML = `<div class="wait">Recorder stopped</div>`;
    return;
  }
  const focused = document.activeElement?.id;
  if (nameFormOpen && focused === "name") return; // don't wipe the name while it's being typed

  if (!state.active || state.phase !== "round") {
    root.innerHTML = `${headline()}${waiting()}${session()}${nameForm()}`;
  } else {
    root.innerHTML = `${headline()}${round()}${fuse()}${players()}${usedChips()}${mine()}${session()}${nameForm()}`;
  }
  bindNameForm();
  tick();
}

function headline() {
  if (!state.active) return `<div class="top"><span class="dot"></span>Waiting for a game</div>`;
  const bits = [state.room, state.game != null ? `Game ${state.game}` : null,
    state.round != null ? `Round ${state.round}` : null, state.rated ? "Rated" : "Unrated"].filter(Boolean);
  return `<div class="top"><span class="dot live"></span>${esc(bits.join(" · "))}</div>`;
}

function waiting() {
  if (!state.active) return "";
  const label = { lobby: "In the lobby", countdown: "Starting" }[state.phase] || esc(state.phase || "");
  const count = state.phase === "countdown" && state.countdown_ms != null ? ` <span data-countdown></span>` : "";
  return `<div class="wait">${label}${count}</div>`;
}

function round() {
  const total = state.threshold || 0, done = state.accepted || 0;
  const f = state.familiarity;
  const fam = [];
  if (f) {
    fam.push(f.seen > 1 ? `Seen ${f.seen}×` : "First time seen");
    if (f.my_pops) fam.push(`popped you ${f.my_pops}×`);
    if (f.my_best) fam.push(`your best ${tierName(f.my_best)}`);
  }
  return `
    <div>
      <p class="question">${esc(state.question)}</p>
      <div class="row note"><span>${num(done)} / ${num(total)} accepted</span><span>${esc(fam.join(" · "))}</span></div>
      <div class="track"><span class="fill" style="width:${total ? Math.min(100, (100 * done) / total) : 0}%"></span></div>
    </div>`;
}

function fuse() {
  if (state.fuse_ms == null || !state.fuse_max_ms) return "";
  const min = state.fuse_min_ms, max = state.fuse_max_ms;
  return `
    <div class="sec">
      <div class="row"><span>${esc(state.holder || "–")} holding</span><span class="big" data-holding></span></div>
      <div class="track fuse" data-fusebar>
        <span class="zone" style="left:${(100 * min) / max}%;right:0"></span>
        <span class="fill" data-fusefill></span>
      </div>
      <div class="note" data-fusenote></div>
    </div>`;
}

function players() {
  const target = state.meter_target || 600;
  const rows = state.players.map((p) => {
    const cls = ["player", p.is_me ? "me" : "", p.alive === false ? "out" : "", p.name === state.holder ? "holder" : ""].join(" ");
    const h = state.history?.[p.name];
    const hist = h && h.games ? `${h.pops_per_game ?? "–"} pops/g · avg ${h.avg_score ?? "–"}` : "new";
    const status = p.alive === false ? (p.place ? `#${p.place}` : "out") : "♥".repeat(Math.max(0, p.lives || 0));
    return `
      <div class="${cls}" data-tip="${esc(`<b>${esc(p.name)}</b> rating ${p.rating ?? "–"} · ${esc(hist)} · meter ${num(p.meter)}/${num(target)}`)}">
        <span class="pname">${esc(p.name)}<small>${p.rating ?? ""}</small></span>
        <span class="lives">${status}</span>
        <span class="meter" title="Meter ${num(p.meter)} / ${num(target)}"><span style="width:${Math.min(100, (100 * (p.meter || 0)) / target)}%"></span></span>
      </div>`;
  }).join("");
  return `<div class="sec"><h2><span>Players</span><span>lives · meter</span></h2><div class="players">${rows}</div></div>`;
}

function usedChips() {
  const used = state.used || [];
  if (!used.length) return `<div class="sec"><h2>Used this round</h2><div class="muted">None yet</div></div>`;
  const chips = used.map((u) => `<span class="chip" style="--c:${tierColor(u.tier)}" title="${esc(`${tierName(u.tier) || ""} · ${u.by || ""}`)}">${esc(u.answer)}</span>`).join("");
  return `<div class="sec"><h2><span>Used this round</span><span>${used.length}</span></h2><div class="chips">${chips}</div></div>`;
}

function mine() {
  if (!state.me || state.my_answers == null) return "";
  const list = state.my_answers;
  if (!list.length) return `<div class="sec"><h2>Your past answers</h2><div class="muted">None for this question</div></div>`;
  const used = new Set((state.used || []).map((u) => norm(u.answer)));
  const chips = list.map((a) => `<span class="chip${used.has(norm(a.answer)) ? " used" : ""}" style="--c:${tierColor(a.tier)}" title="${esc(tierName(a.tier) || "")}">${esc(a.answer)}${a.count > 1 ? ` <span class="n">${a.count}×</span>` : ""}</span>`).join("");
  return `<div class="sec"><h2>Your past answers</h2><div class="chips">${chips}</div></div>`;
}

function session() {
  const s = state.session;
  if (!s || (!s.games && s.rating == null)) return "";
  const bits = [`${s.games} game${s.games === 1 ? "" : "s"}`];
  if (s.avg_place != null) bits.push(`avg place ${s.avg_place}`);
  if (s.rating != null) bits.push(`rating ${s.rating}${s.rating_change ? ` (${s.rating_change > 0 ? "+" : ""}${s.rating_change})` : ""}`);
  return `<div class="sec"><h2>This session</h2><div>${esc(bits.join(" · "))}</div></div>`;
}

function nameForm() {
  if (state.me) return "";
  nameFormOpen = true;
  return `<form class="sec name" id="nameform"><input type="text" id="name" placeholder="Your in-game name" aria-label="Your in-game name" autocomplete="off"><button type="submit">Save</button></form>`;
}

function bindNameForm() {
  document.getElementById("nameform")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = document.getElementById("name").value.trim();
    if (!name) return;
    await api("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
    nameFormOpen = false;
    document.activeElement?.blur();
    refresh();
  });
}

/** Timers move every frame; the data itself refreshes every 500 ms. */
function tick() {
  if (!state || !state.active) return;
  const dt = since();
  const cd = root.querySelector("[data-countdown]");
  if (cd && state.countdown_ms != null) cd.textContent = secs(state.countdown_ms - dt);
  const holdingEl = root.querySelector("[data-holding]");
  if (!holdingEl || state.fuse_ms == null) return;

  const holding = (state.holding_ms ?? 0) + dt;
  const fuseNow = state.fuse_ms + dt;
  const { fuse_min_ms: min, fuse_max_ms: max, min_turn_ms: minTurn = 0 } = state;
  holdingEl.textContent = secs(holding);
  root.querySelector("[data-fusefill]").style.width = `${Math.min(100, (100 * fuseNow) / max)}%`;

  // The fuse goes off somewhere between min and max after the round start or last pop,
  // but a new holder always gets at least minTurn before they can pop.
  const safeFor = Math.max(min - fuseNow, minTurn - holding);
  const hot = safeFor <= 0;
  root.querySelector("[data-fusebar]").classList.toggle("hot", hot);
  root.querySelector("[data-fusenote]").innerHTML = hot
    ? `<span class="hot-text">Can pop now</span> · fuse ${secs(fuseNow)} of max ${secs(max)}`
    : `Safe for ${secs(safeFor)} · fuse ${secs(fuseNow)}`;
}

(function frame() {
  tick();
  requestAnimationFrame(frame);
})();

// Simple hover tooltips for player rows.
const tip = document.createElement("div");
tip.id = "tip";
tip.hidden = true;
document.body.append(tip);
document.addEventListener("mouseover", (e) => {
  const el = e.target.closest?.("[data-tip]");
  if (!el) { tip.hidden = true; return; }
  tip.innerHTML = el.dataset.tip;
  tip.hidden = false;
});
document.addEventListener("mousemove", (e) => {
  if (tip.hidden) return;
  tip.style.left = `${Math.min(e.clientX + 12, innerWidth - tip.offsetWidth - 8)}px`;
  tip.style.top = `${e.clientY + 16 + tip.offsetHeight > innerHeight ? e.clientY - tip.offsetHeight - 8 : e.clientY + 16}px`;
});

connect();
