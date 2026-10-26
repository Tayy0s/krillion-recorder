"use strict";
// Dashboard views. Shared helpers (esc, api, tiers, …) come from common.js.

const view = document.getElementById("view");
const tip = document.getElementById("tip");
let onNewQuestion = null;  // set by views that refresh when the recorder sees a new question

// ---- helpers ----------------------------------------------------------------------------------

const qLink = (q) => `#q/${encodeURIComponent(q)}`;

function answersLink(filters) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) if (v != null && v !== "") p.set(k, Array.isArray(v) ? v.join(",") : v);
  const s = p.toString();
  return `#answers${s ? `?${s}` : ""}`;
}

async function getName() {
  try { return (await api("/api/settings")).name || ""; } catch { return ""; }
}

async function setName(name) {
  await api("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
}

function statRow(items) {
  return `<div class="stats">${items.map(([k, v]) => `<div class="stat"><div class="v">${v}</div><div class="k">${esc(k)}</div></div>`).join("")}</div>`;
}

function table(cols, rows, { link, empty = "Nothing yet.", sort } = {}) {
  if (!rows.length) return `<div class="empty">${esc(empty)}</div>`;
  const head = cols.map((c, i) => {
    const sortable = sort && c.sortKey ? ` class="sort ${c.num ? "n" : ""} ${c.cls || ""}" data-col="${i}" tabindex="0"` : ` class="${c.num ? "n" : ""} ${c.cls || ""}"`;
    const aria = sort && c.sortKey === sort.key ? ` aria-sort="${sort.dir > 0 ? "ascending" : "descending"}"` : "";
    return `<th${sortable}${aria}>${esc(c.label)}</th>`;
  }).join("");
  const body = rows.map((r) => {
    const href = link ? link(r) : null;
    const attrs = href ? ` class="link" data-href="${esc(href)}" tabindex="0"` : "";
    const cell = (c) => (c.html ? c.html(r) : r[c.key] == null ? `<span class="muted">–</span>` : esc(r[c.key]));
    return `<tr${attrs}>${cols.map((c) => `<td class="${c.num ? "n" : ""} ${c.cls || ""}">${cell(c)}</td>`).join("")}</tr>`;
  }).join("");
  return `<div class="scroll"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

/** Wire up sortable headers rendered by table(..., {sort}). */
function bindSort(el, cols, state, redraw) {
  el.querySelectorAll("th[data-col]").forEach((th) => {
    const c = cols[Number(th.dataset.col)];
    const go = () => {
      state.dir = state.key === c.sortKey ? -state.dir : (c.num || c.sortKey === "time" ? -1 : 1);
      state.key = c.sortKey;
      redraw();
    };
    th.addEventListener("click", go);
    th.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
  });
}

function compare(a, b, key, dir) {
  const x = a[key] ?? (dir > 0 ? Infinity : -Infinity), y = b[key] ?? (dir > 0 ? Infinity : -Infinity);
  if (typeof x === "string" && typeof y === "string") return x.localeCompare(y) * dir;
  return (x > y ? 1 : x < y ? -1 : 0) * dir;
}

// ---- charts -----------------------------------------------------------------------------------

function niceMax(v) {
  if (v <= 4) return Math.max(v, 1);
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= v);
}

// SVG charts are drawn at their real pixel width so text and bars keep a fixed size;
// views insert a placeholder, then drawCharts() fills it in (and again on resize).
const chartSpecs = new Map();
let chartId = 0;

function columnChart(items, options = {}) {
  if (!items.length) return `<div class="empty">Nothing yet.</div>`;
  const id = String(++chartId);
  chartSpecs.set(id, { items, options });
  return `<div class="chart-slot" data-chart="${id}" style="height:${options.height || 180}px"></div>`;
}

function drawCharts() {
  document.querySelectorAll("[data-chart]").forEach((slot) => {
    const spec = chartSpecs.get(slot.dataset.chart);
    if (spec) slot.innerHTML = columnSvg(spec.items, { ...spec.options, width: slot.clientWidth });
  });
}

/** Vertical bars. items: [{label, value, color?, tip}] */
function columnSvg(items, { width = 640, height = 180, color = "var(--accent)" } = {}) {
  const W = Math.max(200, width), H = height, L = 32, B = 22, T = 8;
  const max = niceMax(Math.max(...items.map((d) => d.value)));
  const ticks = max <= 4 ? Array.from({ length: max + 1 }, (_, i) => i) : [0, max / 2, max];
  const step = (W - L) / items.length;
  const bw = Math.max(2, Math.min(40, step - 2));
  const y = (v) => T + (H - T - B) * (1 - v / max);
  const every = Math.ceil(items.length / Math.max(1, Math.floor((W - L) / 64)));
  let s = `<svg class="chart" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img">`;
  for (const t of ticks) s += `<line class="grid" x1="${L}" x2="${W}" y1="${y(t)}" y2="${y(t)}"/><text x="${L - 6}" y="${y(t) + 4}" text-anchor="end">${num(t)}</text>`;
  items.forEach((d, i) => {
    const x = L + i * step + (step - bw) / 2, top = y(d.value), base = y(0), r = Math.min(4, bw / 2, base - top);
    const path = d.value > 0
      ? `M${x},${base}V${top + r}Q${x},${top} ${x + r},${top}H${x + bw - r}Q${x + bw},${top} ${x + bw},${top + r}V${base}Z`
      : "";
    s += `<rect class="hit" x="${L + i * step}" y="${T}" width="${step}" height="${H - T - B}" data-tip="${esc(d.tip)}"/>`;
    if (path) s += `<path class="mark" d="${path}" fill="${d.color || color}" pointer-events="none"/>`;
    if (i % every === 0) s += `<text x="${x + bw / 2}" y="${H - 6}" text-anchor="middle">${esc(d.label)}</text>`;
  });
  s += `<line class="base" x1="${L}" x2="${W}" y1="${y(0)}" y2="${y(0)}"/></svg>`;
  return s;
}

/** Horizontal bars as HTML rows, labels left and values right. Rows with href are links. */
function barList(items) {
  if (!items.length) return `<div class="empty">Nothing yet.</div>`;
  const max = Math.max(...items.map((d) => d.value), 1);
  return `<div class="bars">${items.map((d) => {
    const tag = d.href ? "a" : "div";
    return `<${tag} class="brow"${d.href ? ` href="${esc(d.href)}"` : ""} data-tip="${esc(d.tip || `<b>${esc(d.label)}</b> ${num(d.value)}`)}">
      <span class="blabel">${esc(d.label)}</span>
      <span class="btrack"><span class="bfill" style="width:${(100 * d.value) / max}%;background:${d.color || "var(--accent)"}"></span></span>
      <span class="bval">${num(d.value)}</span>
    </${tag}>`;
  }).join("")}</div>`;
}

/** One stacked bar for a tier breakdown, with a legend. tiers: [{tier, count}] */
function tierStack(tiers) {
  const total = tiers.reduce((a, t) => a + t.count, 0);
  if (!total) return `<div class="empty">No accepted answers.</div>`;
  const segs = tiers.map((t) => `<span style="--c:${tierColor(t.tier)};flex:${t.count}" data-tip="<b>${esc(tierName(t.tier))}</b> ${t.count} · ${pct(t.count / total)}"></span>`).join("");
  const legend = tiers.map((t) => `<span class="tag" style="--c:${tierColor(t.tier)}">${esc(tierName(t.tier))} ${t.count}</span>`).join("");
  return `<div class="stack">${segs}</div><div class="legend">${legend}</div>`;
}

const tierBars = (tiers, href) => barList(tiers.map((t) => ({
  label: tierName(t.tier), value: t.count, color: tierColor(t.tier), href: href ? href(t.tier) : null,
})));

// ---- overview ---------------------------------------------------------------------------------

async function overview() {
  const o = await api("/api/overview");
  const days = o.per_day.map((d) => ({
    label: new Date(d.date + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" }),
    value: d.count,
    tip: `<b>${esc(d.date)}</b> ${d.count} questions`,
  }));
  view.innerHTML = `
    <h1>Overview</h1>
    <p class="meta">${o.first ? `${esc(when(o.first))} – ${esc(when(o.last))}` : "No games recorded yet."}</p>
    ${statRow([["Rounds", num(o.rounds)], ["Unique questions", num(o.unique)], ["Games", num(o.games)],
      ["Rooms", num(o.rooms)], ["Accepted answers", num(o.accepted)], ["Rejected", num(o.rejected)]])}
    <section class="panel"><h2>Questions per day</h2>${columnChart(days)}</section>
    <div class="cols">
      <section class="panel"><h2>Most frequent</h2>
        ${table([{ label: "Question", key: "question" }, { label: "Seen", key: "seen", num: true }], o.top, { link: (r) => qLink(r.question) })}
      </section>
      <section class="panel"><h2>Newest</h2>
        ${table([{ label: "Question", key: "question" }, { label: "First seen", html: (r) => esc(when(r.first_seen)), cls: "t" }], o.newest, { link: (r) => qLink(r.question) })}
      </section>
    </div>`;
}

// ---- questions --------------------------------------------------------------------------------

const questionState = { key: "seen", dir: -1, filter: "" };

async function questions() {
  const rows = await api("/api/questions");
  const cols = [
    { label: "Question", key: "question", sortKey: "question" },
    { label: "Seen", key: "seen", num: true, sortKey: "seen" },
    { label: "Games", key: "games", num: true, sortKey: "games", cls: "hide-sm" },
    { label: "Threshold", html: (r) => num(r.threshold), num: true, sortKey: "threshold", cls: "hide-sm" },
    { label: "Answers", key: "answers", num: true, sortKey: "answers" },
    { label: "Rare+", key: "rare", num: true, sortKey: "rare", cls: "hide-sm" },
    { label: "Rejected", key: "rejected", num: true, sortKey: "rejected", cls: "hide-sm" },
    { label: "Last seen", html: (r) => esc(when(r.last_seen)), sortKey: "last_seen", cls: "t hide-sm" },
  ];
  view.innerHTML = `
    <h1>Questions</h1>
    <p class="meta">${num(rows.length)} unique</p>
    <div class="toolbar"><input type="search" id="qfilter" placeholder="Search" aria-label="Search questions" value="${esc(questionState.filter)}"></div>
    <section class="panel" id="qtable"></section>`;

  const draw = () => {
    const f = norm(questionState.filter);
    const shown = rows.filter((r) => !f || norm(r.question).includes(f))
      .sort((a, b) => compare(a, b, questionState.key, questionState.dir) || a.question.localeCompare(b.question));
    const el = document.getElementById("qtable");
    el.innerHTML = table(cols, shown, { link: (r) => qLink(r.question), sort: questionState, empty: f ? "No matches." : "No questions recorded yet." });
    bindSort(el, cols, questionState, draw);
  };
  document.getElementById("qfilter").addEventListener("input", (e) => { questionState.filter = e.target.value; draw(); });
  draw();
}

async function questionDetail(q) {
  const d = await api(`/api/question?q=${encodeURIComponent(q)}`);
  const meta = [`Seen ${num(d.seen)}×`];
  if (d.threshold != null) meta.push(`threshold ${num(d.threshold)}`);
  if (d.last_seen) meta.push(`last ${when(d.last_seen)}`);
  view.innerHTML = `
    <p><a href="#questions">← Questions</a></p>
    <h1>${esc(d.question)}</h1>
    <p class="meta">${esc(meta.join(" · "))} · <a href="${esc(answersLink({ question: d.question }))}">Every attempt</a></p>
    <section class="panel"><h2>Tiers</h2>${tierStack(d.tiers)}</section>
    <div class="cols">
      <section class="panel"><h2>Accepted answers <span class="muted">${num(d.answers.length)}</span></h2>
        ${table([{ label: "Answer", key: "answer" }, { label: "Tier", html: (r) => tierTag(r.tier) }, { label: "Used", key: "count", num: true }], d.answers)}
      </section>
      <section class="panel"><h2>Rejected <span class="muted">${num(d.rejected.length)}</span></h2>
        ${table([{ label: "Attempt", key: "text" }, { label: "Reason", key: "why", cls: "t" }, { label: "Count", key: "count", num: true }], d.rejected)}
      </section>
    </div>
    <section class="panel"><h2>Seen in</h2>
      ${table([{ label: "Time", html: (r) => esc(when(r.time)), cls: "t" }, { label: "Room", key: "room" },
        { label: "Game", key: "game", num: true }, { label: "Round", key: "round", num: true }], d.sightings)}
    </section>`;
}

// ---- answers ----------------------------------------------------------------------------------

const PERIODS = { all: "All time", "1": "Today", "7": "7 days", "30": "30 days" };
const ANSWERS_LIMIT = 300;
let answersCache = null;

function answerFilters() {
  const p = new URLSearchParams(location.hash.split("?")[1] || "");
  return {
    q: p.get("q") || "",
    outcome: p.get("outcome") || "all",
    tier: (p.get("tier") || "").split(",").filter(Boolean),
    player: p.get("player") || "",
    question: p.get("question") || "",
    period: p.get("period") || "all",
    view: p.get("view") || "every",
  };
}

async function answers() {
  answersCache = await api("/api/answers");
  const me = await getName();
  const f = answerFilters();
  const sortState = { key: "time", dir: -1 };
  let limit = ANSWERS_LIMIT;

  const players = [...new Set(answersCache.map((r) => r.player).filter(Boolean))]
    .sort((a, b) => (norm(a) === norm(me) ? -1 : norm(b) === norm(me) ? 1 : a.localeCompare(b)));
  const questionsList = [...new Set(answersCache.map((r) => r.question).filter(Boolean))].sort();

  const seg = (name, options, value) => `<div class="seg" role="group" aria-label="${esc(name)}">${Object.entries(options)
    .map(([v, label]) => `<button type="button" data-${name}="${esc(v)}" aria-pressed="${v === value}">${esc(label)}</button>`).join("")}</div>`;

  view.innerHTML = `
    <h1>Answers</h1>
    <div class="filters">
      <div class="toolbar">
        <input type="search" id="af-q" placeholder="Search answers" aria-label="Search answers" value="${esc(f.q)}">
        ${seg("outcome", { all: "All", accepted: "Accepted", rejected: "Rejected" }, f.outcome)}
        ${seg("view", { every: "Every attempt", unique: "Unique" }, f.view)}
      </div>
      <div class="toolbar tiers-filter" role="group" aria-label="Rarity">
        ${TIER_IDS.map((t) => `<button type="button" class="tierbtn" data-tier="${t}" style="--c:${tierColor(t)}" aria-pressed="${f.tier.includes(t)}">${esc(tierName(t))}</button>`).join("")}
      </div>
      <div class="toolbar">
        <select id="af-player" aria-label="Player">
          <option value="">All players</option>
          ${players.map((p) => `<option value="${esc(p)}"${norm(p) === norm(f.player) ? " selected" : ""}>${esc(p)}${norm(p) === norm(me) ? " (me)" : ""}</option>`).join("")}
        </select>
        <input type="search" id="af-question" list="af-questions" placeholder="Question" aria-label="Question" value="${esc(f.question)}">
        <datalist id="af-questions">${questionsList.map((q) => `<option value="${esc(q)}">`).join("")}</datalist>
        <select id="af-period" aria-label="Period">
          ${Object.entries(PERIODS).map(([v, l]) => `<option value="${v}"${v === f.period ? " selected" : ""}>${l}</option>`).join("")}
        </select>
        <button type="button" id="af-clear">Clear</button>
      </div>
    </div>
    <section class="panel" id="asummary"></section>
    <section class="panel" id="atable"></section>`;

  const syncUrl = () => {
    const link = answersLink({
      q: f.q, outcome: f.outcome === "all" ? "" : f.outcome, tier: f.tier, player: f.player,
      question: f.question, period: f.period === "all" ? "" : f.period, view: f.view === "every" ? "" : f.view,
    });
    history.replaceState(null, "", link);
  };

  const filtered = () => {
    const q = norm(f.q), question = norm(f.question), player = norm(f.player);
    const since = f.period === "all" ? null : Date.now() - (f.period === "1" ? msSinceMidnight() : Number(f.period) * 864e5);
    return answersCache.filter((r) =>
      (f.outcome === "all" || r.outcome === f.outcome)
      && (!f.tier.length || f.tier.includes(r.tier))
      && (!player || norm(r.player) === player)
      && (!question || norm(r.question).includes(question))
      && (!q || norm(r.answer).includes(q))
      && (!since || new Date(r.time).getTime() >= since));
  };

  const everyCols = [
    { label: "Time", html: (r) => esc(when(r.time)), sortKey: "time", cls: "t hide-sm" },
    { label: "Answer", key: "answer", sortKey: "answer" },
    { label: "Result", html: resultCell, sortKey: "rank" },
    { label: "Player", key: "player", sortKey: "player" },
    { label: "Question", html: questionCell, sortKey: "question", cls: "hide-sm" },
  ];
  const uniqueCols = [
    { label: "Answer", key: "answer", sortKey: "answer" },
    { label: "Result", html: resultCell, sortKey: "rank" },
    { label: "Used", key: "count", num: true, sortKey: "count" },
    { label: "Players", html: (r) => esc(r.players.join(", ")), sortKey: "playerCount", cls: "hide-sm" },
    { label: "Question", html: questionCell, sortKey: "question", cls: "hide-sm" },
  ];

  const draw = () => {
    syncUrl();
    let rows = filtered();
    const accepted = rows.filter((r) => r.outcome === "accepted");
    const tierCounts = TIER_IDS.map((t) => ({ tier: t, count: accepted.filter((r) => r.tier === t).length })).filter((t) => t.count);
    document.getElementById("asummary").innerHTML = `
      <p class="count"><b>${num(rows.length)}</b> attempts · ${num(accepted.length)} accepted · ${num(rows.length - accepted.length)} rejected</p>
      ${tierStack(tierCounts)}`;

    const unique = f.view === "unique";
    if (unique) rows = groupAnswers(rows);
    else rows = rows.map((r) => ({ ...r, rank: resultRank(r) }));
    if (unique && sortState.key === "time") { sortState.key = "count"; sortState.dir = -1; }
    if (!unique && (sortState.key === "count" || sortState.key === "playerCount")) { sortState.key = "time"; sortState.dir = -1; }
    rows.sort((a, b) => compare(a, b, sortState.key, sortState.dir) || compare(a, b, "time", -1));

    const cols = unique ? uniqueCols : everyCols;
    const el = document.getElementById("atable");
    el.innerHTML = table(cols, rows.slice(0, limit), { sort: sortState, empty: "No answers match." })
      + (rows.length > limit ? `<div class="more"><button type="button" id="amore">Show more <span class="muted">${num(rows.length - limit)} left</span></button></div>` : "");
    bindSort(el, cols, sortState, draw);
    document.getElementById("amore")?.addEventListener("click", () => { limit += ANSWERS_LIMIT; draw(); });
  };

  const reset = () => { limit = ANSWERS_LIMIT; draw(); };
  document.getElementById("af-q").addEventListener("input", (e) => { f.q = e.target.value; reset(); });
  document.getElementById("af-question").addEventListener("input", (e) => { f.question = e.target.value; reset(); });
  document.getElementById("af-player").addEventListener("change", (e) => { f.player = e.target.value; reset(); });
  document.getElementById("af-period").addEventListener("change", (e) => { f.period = e.target.value; reset(); });
  view.querySelectorAll("[data-outcome], [data-view]").forEach((b) => b.addEventListener("click", () => {
    const key = b.dataset.outcome ? "outcome" : "view";
    f[key] = b.dataset[key];
    b.parentElement.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    reset();
  }));
  view.querySelectorAll("[data-tier]").forEach((b) => b.addEventListener("click", () => {
    const t = b.dataset.tier;
    f.tier = f.tier.includes(t) ? f.tier.filter((x) => x !== t) : [...f.tier, t];
    b.setAttribute("aria-pressed", String(f.tier.includes(t)));
    reset();
  }));
  document.getElementById("af-clear").addEventListener("click", () => { location.hash = "#answers"; });
  draw();
}

function msSinceMidnight() {
  const d = new Date();
  return d - new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Accepted sort by rarity; rejected after all tiers. */
const resultRank = (r) => (r.outcome === "accepted" ? tierRank(r.tier) : TIER_IDS.length + 1);

function resultCell(r) {
  if (r.outcome === "accepted") return tierTag(r.tier);
  return `<span class="rejected">rejected${r.why ? ` · ${esc(r.why)}` : ""}</span>`;
}

function questionCell(r) {
  return r.question ? `<a href="${esc(qLink(r.question))}">${esc(r.question)}</a>` : `<span class="muted">–</span>`;
}

/** Unique view: one row per answer + question + outcome. */
function groupAnswers(rows) {
  const groups = new Map();
  for (const r of rows) {
    const k = `${norm(r.answer)}\u0000${norm(r.question)}\u0000${r.outcome}`;
    let g = groups.get(k);
    if (!g) {
      g = { answer: r.answer, question: r.question, outcome: r.outcome, tier: r.tier, why: r.why, count: 0, players: [], time: r.time };
      groups.set(k, g);
    }
    g.count += 1;
    if (r.player && !g.players.includes(r.player)) g.players.push(r.player);
    if (r.time > g.time) { g.time = r.time; g.tier = r.tier ?? g.tier; }
  }
  return [...groups.values()].map((g) => ({ ...g, rank: resultRank(g), playerCount: g.players.length }));
}

// ---- tiers ------------------------------------------------------------------------------------

async function tiers() {
  const t = await api("/api/tiers");
  view.innerHTML = `
    <h1>Tiers</h1>
    <p class="meta">${num(t.total.reduce((a, x) => a + x.count, 0))} accepted answers</p>
    <section class="panel"><h2>All accepted answers</h2>${tierBars(t.total, (tier) => answersLink({ tier, outcome: "accepted" }))}</section>
    <div class="cols">
      <section class="panel"><h2>Rarest answers</h2>
        ${table([{ label: "Answer", key: "answer" }, { label: "Tier", html: (r) => tierTag(r.tier) },
          { label: "Question", html: questionCell }], t.rarest)}
      </section>
      <section class="panel"><h2>Most rare answers by question</h2>
        ${table([{ label: "Question", key: "question" }, { label: "Rare+", key: "rare", num: true }], t.by_question,
          { link: (r) => answersLink({ question: r.question, tier: ["rare", "deepcut", "krillion"] }) })}
      </section>
    </div>`;
}

// ---- me ---------------------------------------------------------------------------------------

async function me() {
  const name = await getName();
  view.innerHTML = `
    <h1>Me</h1>
    <form class="toolbar" id="nameform">
      <input type="text" id="name" placeholder="In-game name" aria-label="In-game name" value="${esc(name)}" autocomplete="off">
      <button type="submit">Save</button>
    </form>
    <div id="mebody"></div>`;
  document.getElementById("nameform").addEventListener("submit", async (e) => {
    e.preventDefault();
    await setName(document.getElementById("name").value.trim());
    me();
  });
  const body = document.getElementById("mebody");
  if (!name) return;
  const m = await api(`/api/me?name=${encodeURIComponent(name)}`);
  if (!m || !m.games) {
    body.innerHTML = `<div class="empty">No games found for “${esc(name)}”.</div>`;
    return;
  }
  const rejected = Object.values(m.rejected).reduce((a, b) => a + b, 0);
  const places = m.places.map((p) => ({ label: `#${p.place}`, value: p.count, tip: `<b>Place ${p.place}</b> ${p.count} games` }));
  body.innerHTML = `
    ${statRow([["Games", num(m.games)], ["Average place", m.avg_place ?? "–"], ["Wins", num(m.wins)],
      ["Accepted", num(m.accepted)], ["Rejected", num(rejected)], ["Accuracy", pct(m.accuracy)],
      ["Avg answer score", m.avg_score ?? "–"], ["Pops", num(m.pops)]])}
    <div class="cols">
      <section class="panel"><h2>Placements</h2>${columnChart(places, { height: 160 })}</section>
      <section class="panel"><h2>Your answers by tier</h2>${tierBars(m.tiers, (tier) => answersLink({ tier, player: name, outcome: "accepted" }))}</section>
    </div>
    <div class="cols">
      <section class="panel"><h2>Popped on</h2>
        ${table([{ label: "Question", key: "question" }, { label: "Pops", key: "pops", num: true }], m.weak, { link: (r) => qLink(r.question), empty: "No pops." })}
      </section>
      <section class="panel"><h2>Recent answers <a class="h-link" href="${esc(answersLink({ player: name }))}">All</a></h2>
        ${table([{ label: "Answer", key: "answer" }, { label: "Tier", html: (r) => tierTag(r.tier) },
          { label: "Question", key: "question", cls: "hide-sm" }], m.recent_answers)}
      </section>
    </div>`;
  drawCharts();
}

// ---- recent -----------------------------------------------------------------------------------

async function recent() {
  const draw = async () => {
    const rows = await api("/api/recent");
    if (location.hash !== "#recent") return;
    view.innerHTML = `
      <h1>Recent</h1>
      <section class="panel">
        ${table([{ label: "Time", html: (r) => esc(when(r.time, false)), cls: "t" }, { label: "Question", key: "question" },
          { label: "Room", key: "room", cls: "hide-sm" }, { label: "Game", key: "game", num: true, cls: "hide-sm" },
          { label: "Round", key: "round", num: true }], rows, { link: (r) => qLink(r.question) })}
      </section>`;
  };
  await draw();
  onNewQuestion = () => draw().catch(() => {});
}

// ---- routing & shared events ------------------------------------------------------------------

const VIEWS = { "#overview": overview, "#questions": questions, "#answers": answers, "#tiers": tiers, "#me": me, "#recent": recent };

async function route() {
  onNewQuestion = null;
  hideTip();
  chartSpecs.clear();
  const hash = location.hash || "#overview";
  const base = hash.split("?")[0];
  const tab = base.startsWith("#q/") ? "#questions" : base;
  document.querySelectorAll("#tabs a").forEach((a) => {
    if (a.getAttribute("href") === tab) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  try {
    if (base.startsWith("#q/")) await questionDetail(decodeURIComponent(base.slice(3)));
    else await (VIEWS[base] || overview)();
  } catch (err) {
    view.innerHTML = `<h1>Couldn't load</h1><p class="meta">${esc(err.message)}</p>`;
  }
  drawCharts();
  window.scrollTo(0, 0);
}

function hideTip() { tip.hidden = true; }

document.addEventListener("mouseover", (e) => {
  const el = e.target.closest?.("[data-tip]");
  if (!el || !el.dataset.tip) return hideTip();
  tip.innerHTML = el.dataset.tip;
  tip.hidden = false;
  placeTip(e);
});
document.addEventListener("mousemove", (e) => { if (!tip.hidden) placeTip(e); });

function placeTip(e) {
  const x = Math.min(e.clientX + 12, window.innerWidth - tip.offsetWidth - 8);
  const y = e.clientY + 16 + tip.offsetHeight > window.innerHeight ? e.clientY - tip.offsetHeight - 8 : e.clientY + 16;
  tip.style.left = `${x}px`;
  tip.style.top = `${y}px`;
}
document.addEventListener("click", (e) => {
  const row = e.target.closest("tr[data-href]");
  if (row && !e.target.closest("a")) location.hash = row.dataset.href;
});
document.addEventListener("keydown", (e) => {
  const row = e.target.closest?.("tr[data-href]");
  if (row && e.key === "Enter") location.hash = row.dataset.href;
});

// Header indicator and new-question refreshes, pushed by the recorder as frames arrive.
const statusEl = document.getElementById("status");
let lastQuestion = null;

function showStatus(text, live) {
  statusEl.hidden = false;
  statusEl.classList.toggle("live", live);
  statusEl.textContent = text;
}

function connectLive() {
  const source = new EventSource("/api/live/stream");
  source.addEventListener("live", (e) => {
    const s = JSON.parse(e.data);
    const live = s.active && s.detected_at && Date.now() / 1000 - s.detected_at < 30;
    showStatus(live ? `Live · ${s.room}` : "Waiting for a game", Boolean(live));
    if (s.question && s.question !== lastQuestion) {
      lastQuestion = s.question;
      onNewQuestion?.();
    }
  });
  source.onerror = async () => {
    try {
      if (!(await api("/api/status")).recording) {  // dashboard.py on its own: nothing to stream
        source.close();
        statusEl.hidden = true;
        return;
      }
    } catch { /* recorder not reachable */ }
    showStatus("Recorder stopped", false);
  };
}
connectLive();

let resizeFrame = 0;
window.addEventListener("resize", () => {
  cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(drawCharts);
});
window.addEventListener("hashchange", route);
route();
