"use strict";
// Shared by the dashboard (app.js) and the live window (live.js).

// The game's tiers, most common first, with its display names and scores.
const TIERS = {
  plankton: { name: "Plankton", score: 10 },
  tooclever: { name: "Too Clever", score: 15 },
  schooler: { name: "Schooler", score: 30 },
  rare: { name: "Rare", score: 60 },
  deepcut: { name: "Deep Cut", score: 85 },
  krillion: { name: "One in a Krillion", score: 100 },
};
const TIER_IDS = Object.keys(TIERS);

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const num = (n) => (n == null ? "–" : Number(n).toLocaleString());
const pct = (n) => (n == null ? "–" : `${Math.round(n * 100)}%`);
const norm = (s) => String(s ?? "").trim().replace(/\s+/g, " ").toLowerCase();

const tierName = (t) => TIERS[t]?.name ?? t;
const tierColor = (t) => (TIERS[t] ? `var(--tier-${t})` : "var(--tier-unknown)");
const tierRank = (t) => (TIERS[t] ? TIER_IDS.indexOf(t) : TIER_IDS.length);
const tierTag = (t) => (t ? `<span class="tag" style="--c:${tierColor(t)}">${esc(tierName(t))}</span>` : `<span class="muted">–</span>`);

async function api(path, options) {
  const res = await fetch(path, options);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

function when(iso, withDate = true) {
  if (!iso) return "–";
  const d = new Date(iso);
  return withDate
    ? d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
