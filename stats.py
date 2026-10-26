"""Aggregate stats over the recorder's data files."""

import json
import os
import threading
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

# The game's own tiers (from krillion.io), most common first: id -> (display name, score).
# The score is also what each accepted answer adds to a player's meter.
TIERS = {
    "plankton": ("Plankton", 10),
    "tooclever": ("Too Clever", 15),
    "schooler": ("Schooler", 30),
    "rare": ("Rare", 60),
    "deepcut": ("Deep Cut", 85),
    "krillion": ("One in a Krillion", 100),
}
TIER_ORDER = list(TIERS)
RARE_TIERS = {"rare", "deepcut", "krillion"}


def tier_score(tier):
    return TIERS[tier][1] if tier in TIERS else None


def avg_score(tiers):
    scores = [tier_score(t) for t in tiers if tier_score(t) is not None]
    return round(sum(scores) / len(scores), 1) if scores else None


def norm(text):
    return " ".join(str(text or "").split()).casefold()


def tier_rank(tier):
    return TIER_ORDER.index(tier) if tier in TIER_ORDER else len(TIER_ORDER)


def read_jsonl(path):
    if not path.exists():
        return []
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            try:
                rows.append(json.loads(line))
            except ValueError:
                pass  # a line mid-write; it will be complete next read
    return rows


def at_iso(ms):
    return datetime.fromtimestamp(ms / 1000, timezone.utc).isoformat(timespec="seconds") if ms else None


def local_date(iso):
    """Calendar day in this computer's timezone, so a late-night game lands on the right day."""
    return datetime.fromisoformat(iso).astimezone().date().isoformat()


def display_name(counter):
    """Most common original spelling among variants that normalise the same."""
    return counter.most_common(1)[0][0]


def load_settings(data_dir):
    path = Path(data_dir) / "settings.json"
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def save_settings(data_dir, settings):
    path = Path(data_dir) / "settings.json"
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(settings, indent=2, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, path)


_cache = {}


def cached_stats(data_dir):
    """A Stats object reused until the data files change; the live window asks twice a second."""
    d = Path(data_dir)
    key = []
    for name in ("questions.jsonl", "events.jsonl"):
        try:
            st = (d / name).stat()
            key.append((st.st_mtime_ns, st.st_size))
        except OSError:
            key.append(None)
    hit = _cache.get(str(d))
    if hit and hit[0] == key:
        return hit[1]
    stats = Stats(d)
    _cache[str(d)] = (key, stats)
    return stats


class Stats:
    def __init__(self, data_dir="data"):
        self.dir = Path(data_dir)
        self.lock = threading.Lock()  # guards add_* against snapshot() while the recorder runs
        self.questions = read_jsonl(self.dir / "questions.jsonl")
        self.events = read_jsonl(self.dir / "events.jsonl")

        self.spellings = defaultdict(Counter)  # normalised question -> original spellings
        for q in self.questions:
            self.spellings[norm(q["question"])][q["question"]] += 1
        for e in self.events:
            if e.get("question"):
                self.spellings[norm(e["question"])][e["question"]] += 0

    def add_question(self, row):
        with self.lock:
            self.questions.append(row)
            self.spellings[norm(row["question"])][row["question"]] += 1

    def add_event(self, record):
        with self.lock:
            self.events.append(record)
            if record.get("question"):
                self.spellings[norm(record["question"])][record["question"]] += 0

    def snapshot(self):
        """A copy to compute on while new rows keep arriving; copying is cheap next to the stats themselves."""
        with self.lock:
            copy = Stats.__new__(Stats)
            copy.dir = self.dir
            copy.lock = threading.Lock()
            copy.questions = list(self.questions)
            copy.events = list(self.events)
            copy.spellings = defaultdict(Counter, {k: Counter(v) for k, v in self.spellings.items()})
        return copy

    def name_of(self, key):
        return display_name(self.spellings[key]) if self.spellings.get(key) else key

    def tiers_present(self):
        return sorted({e.get("tier") for e in self.events if e.get("kind") == "pass" and e.get("tier")},
                      key=lambda t: (tier_rank(t), t))

    # ---- overview -------------------------------------------------------------------------

    def overview(self):
        seen = Counter(norm(q["question"]) for q in self.questions)
        first_seen = {}
        for q in self.questions:
            first_seen.setdefault(norm(q["question"]), q["timestamp_utc"])
        per_day = Counter(local_date(q["timestamp_utc"]) for q in self.questions)
        kinds = Counter(e.get("kind") for e in self.events)
        times = [q["timestamp_utc"] for q in self.questions]
        return {
            "rounds": len(self.questions),
            "unique": len(seen),
            "games": len({(q["room_code"], q.get("game")) for q in self.questions}),
            "rooms": len({q["room_code"] for q in self.questions}),
            "accepted": kinds["pass"],
            "rejected": kinds["reject"],
            "first": min(times) if times else None,
            "last": max(times) if times else None,
            "per_day": [{"date": d, "count": per_day[d]} for d in sorted(per_day)],
            "top": [{"question": self.name_of(k), "seen": n} for k, n in seen.most_common(10)],
            "newest": [{"question": self.name_of(k), "first_seen": t}
                       for k, t in sorted(first_seen.items(), key=lambda kv: kv[1], reverse=True)[:10]],
        }

    # ---- questions --------------------------------------------------------------------------

    def questions_table(self):
        rows = {}
        for q in self.questions:
            k = norm(q["question"])
            r = rows.setdefault(k, {"question": self.name_of(k), "seen": 0, "games": set(), "thresholds": [],
                                    "first_seen": q["timestamp_utc"], "last_seen": q["timestamp_utc"]})
            r["seen"] += 1
            r["games"].add((q["room_code"], q.get("game")))
            if q.get("threshold") is not None:
                r["thresholds"].append(q["threshold"])
            r["first_seen"] = min(r["first_seen"], q["timestamp_utc"])
            r["last_seen"] = max(r["last_seen"], q["timestamp_utc"])
        answers, rare, rejected = defaultdict(set), Counter(), Counter()
        for e in self.events:
            k = norm(e.get("question"))
            if k not in rows:
                continue
            if e.get("kind") == "pass":
                answers[k].add(norm(e.get("answer")))
                rare[k] += e.get("tier") in RARE_TIERS
            elif e.get("kind") == "reject":
                rejected[k] += 1
        out = []
        for k, r in rows.items():
            ts = r.pop("thresholds")
            r["games"] = len(r["games"])
            r["threshold"] = round(sum(ts) / len(ts), 1) if ts else None
            r["answers"] = len(answers[k])
            r["rare"] = rare[k]
            r["rejected"] = rejected[k]
            out.append(r)
        out.sort(key=lambda r: (-r["seen"], r["question"].casefold()))
        return out

    def answer_bank(self, key):
        """Accepted answers for one question: [{answer, count, tier}], most used first."""
        spell, count, tiers = defaultdict(Counter), Counter(), {}
        for e in self.events:
            if e.get("kind") == "pass" and norm(e.get("question")) == key and e.get("answer"):
                a = norm(e["answer"])
                spell[a][e["answer"]] += 1
                count[a] += 1
                if e.get("tier"):
                    tiers[a] = e["tier"]
        return sorted(({"answer": display_name(spell[a]), "count": n, "tier": tiers.get(a)} for a, n in count.items()),
                      key=lambda r: (-r["count"], tier_rank(r["tier"]), r["answer"].casefold()))

    def question_detail(self, question):
        key = norm(question)
        sightings = [q for q in self.questions if norm(q["question"]) == key]
        rejected, reject_spell = Counter(), defaultdict(Counter)
        tiers = Counter()
        for e in self.events:
            if norm(e.get("question")) != key:
                continue
            if e.get("kind") == "reject" and e.get("text"):
                r = (norm(e["text"]), e.get("why"))
                rejected[r] += 1
                reject_spell[r][e["text"]] += 1
            elif e.get("kind") == "pass":
                tiers[e.get("tier") or "unknown"] += 1
        ts = [q["threshold"] for q in sightings if q.get("threshold") is not None]
        return {
            "question": self.name_of(key),
            "seen": len(sightings),
            "threshold": round(sum(ts) / len(ts), 1) if ts else None,
            "first_seen": min((q["timestamp_utc"] for q in sightings), default=None),
            "last_seen": max((q["timestamp_utc"] for q in sightings), default=None),
            "answers": self.answer_bank(key),
            "tiers": [{"tier": t, "count": tiers[t]} for t in sorted(tiers, key=lambda t: (tier_rank(t), t))],
            "rejected": [{"text": display_name(reject_spell[r]), "why": r[1], "count": n}
                         for r, n in rejected.most_common()],
            "sightings": [{"time": q["timestamp_utc"], "room": q["room_code"], "game": q.get("game"),
                           "round": q.get("round")} for q in sorted(sightings, key=lambda q: q["timestamp_utc"],
                                                                    reverse=True)],
        }

    # ---- tiers ------------------------------------------------------------------------------

    def tiers(self):
        total = Counter(e.get("tier") or "unknown" for e in self.events if e.get("kind") == "pass")
        rare_by_q = defaultdict(Counter)
        for e in self.events:
            if e.get("kind") == "pass" and e.get("tier") in RARE_TIERS and e.get("question"):
                rare_by_q[norm(e["question"])][e["tier"]] += 1
        rare_rows = [{"question": self.name_of(k), "rare": sum(c.values()),
                      "tiers": {t: c[t] for t in c}} for k, c in rare_by_q.items()]
        rare_rows.sort(key=lambda r: (-r["rare"], r["question"].casefold()))
        rarest = [e for e in self.events if e.get("kind") == "pass" and e.get("tier") in RARE_TIERS]
        rarest.sort(key=lambda e: (-tier_rank(e.get("tier")), -(e.get("at") or 0)))
        return {
            "order": self.tiers_present(),
            "total": [{"tier": t, "count": total[t]} for t in sorted(total, key=lambda t: (tier_rank(t), t))],
            "by_question": rare_rows[:20],
            "rarest": [{"answer": e["answer"], "tier": e["tier"], "question": e.get("question"),
                        "by": e.get("from_name")} for e in rarest[:20]],
        }

    # ---- me ---------------------------------------------------------------------------------

    def me(self, name):
        me = norm(name)
        if not me:
            return None
        mine = lambda e, field: norm(e.get(field + "_name")) == me
        games, places = set(), {}
        answers, tiers, pops_by_q, rejects = [], Counter(), Counter(), Counter()
        for e in self.events:
            if any(mine(e, f) for f in ("from", "to", "playerId", "holderId")):
                games.add((e["room_code"], e.get("game_id")))
            kind = e.get("kind")
            if kind == "pass" and mine(e, "from"):
                answers.append(e)
                tiers[e.get("tier") or "unknown"] += 1
            elif kind == "reject" and mine(e, "playerId"):
                rejects[e.get("why") or "miss"] += 1
            elif kind == "pop" and mine(e, "playerId") and e.get("question"):
                pops_by_q[norm(e["question"])] += 1
            elif kind == "out" and mine(e, "playerId"):
                places[(e["room_code"], e.get("game_id"))] = e.get("place")
            elif kind == "win" and mine(e, "playerId"):
                places[(e["room_code"], e.get("game_id"))] = 1
        place_list = [p for p in places.values() if p]
        attempts = len(answers) + sum(rejects.values())
        return {
            "name": name,
            "avg_score": avg_score(e.get("tier") for e in answers),
            "games": len(games),
            "finished": len(place_list),
            "wins": place_list.count(1),
            "avg_place": round(sum(place_list) / len(place_list), 2) if place_list else None,
            "places": [{"place": p, "count": n} for p, n in sorted(Counter(place_list).items())],
            "accepted": len(answers),
            "rejected": dict(rejects),
            "accuracy": round(len(answers) / attempts, 3) if attempts else None,
            "pops": sum(pops_by_q.values()),
            "tiers": [{"tier": t, "count": tiers[t]} for t in sorted(tiers, key=lambda t: (tier_rank(t), t))],
            "weak": [{"question": self.name_of(k), "pops": n} for k, n in pops_by_q.most_common(15)],
            "recent_answers": [{"answer": e["answer"], "tier": e.get("tier"), "question": e.get("question"),
                                "time": at_iso(e.get("at"))} for e in answers[-15:][::-1]],
        }

    # ---- answers ----------------------------------------------------------------------------

    def answers(self):
        """Every answer attempt, accepted or rejected, newest first."""
        rows = []
        for e in self.events:
            kind = e.get("kind")
            if kind == "pass" and e.get("answer"):
                rows.append({"time": at_iso(e.get("at")), "answer": e["answer"], "outcome": "accepted",
                             "tier": e.get("tier"), "why": None, "player": e.get("from_name"),
                             "question": e.get("question"), "room": e.get("room_code"), "game": e.get("game")})
            elif kind == "reject" and e.get("text"):
                rows.append({"time": at_iso(e.get("at")), "answer": e["text"], "outcome": "rejected",
                             "tier": None, "why": e.get("why"), "player": e.get("playerId_name"),
                             "question": e.get("question"), "room": e.get("room_code"), "game": e.get("game")})
        rows.sort(key=lambda r: r["time"] or "", reverse=True)
        return rows

    # ---- live helpers -----------------------------------------------------------------------

    def player_history(self, names):
        """Per player name: games, pops per game and average answer score across recorded games."""
        wanted = {norm(n): n for n in names if n}
        games, pops, tiers = defaultdict(set), Counter(), defaultdict(list)
        for e in self.events:
            for field in ("from", "to", "playerId", "holderId"):
                k = norm(e.get(field + "_name"))
                if k in wanted:
                    games[k].add((e.get("room_code"), e.get("game_id")))
            kind = e.get("kind")
            if kind == "pop" and norm(e.get("playerId_name")) in wanted:
                pops[norm(e["playerId_name"])] += 1
            elif kind == "pass" and norm(e.get("from_name")) in wanted:
                tiers[norm(e["from_name"])].append(e.get("tier"))
        out = {}
        for k, name in wanted.items():
            g = len(games[k])
            out[name] = {"games": g, "pops_per_game": round(pops[k] / g, 2) if g else None,
                         "avg_score": avg_score(tiers[k])}
        return out

    def my_answers_for(self, name, question):
        """Answers this player got accepted for this question before: [{answer, tier, count}]."""
        me, key = norm(name), norm(question)
        spell, count, tier = defaultdict(Counter), Counter(), {}
        for e in self.events:
            if (e.get("kind") == "pass" and e.get("answer") and norm(e.get("question")) == key
                    and norm(e.get("from_name")) == me):
                a = norm(e["answer"])
                spell[a][e["answer"]] += 1
                count[a] += 1
                if e.get("tier"):
                    tier[a] = e["tier"]  # latest rating wins if the game re-tiers an answer
        rows = [{"answer": display_name(spell[a]), "tier": tier.get(a), "count": n} for a, n in count.items()]
        # Rarest first: they're worth the most meter.
        rows.sort(key=lambda r: (-(tier_score(r["tier"]) or 0), -r["count"], r["answer"].casefold()))
        return rows

    def familiarity(self, name, question):
        me, key = norm(name), norm(question)
        seen = sum(1 for q in self.questions if norm(q["question"]) == key)
        my_pops = sum(1 for e in self.events if e.get("kind") == "pop" and norm(e.get("question")) == key
                      and me and norm(e.get("playerId_name")) == me)
        my_tiers = [e.get("tier") for e in self.events if e.get("kind") == "pass" and norm(e.get("question")) == key
                    and me and norm(e.get("from_name")) == me and e.get("tier") in TIERS]
        return {"seen": seen, "my_pops": my_pops,
                "my_best": max(my_tiers, key=tier_rank) if my_tiers else None}

    def session(self, name, since_ms):
        """Your games and placements since the recorder started."""
        me = norm(name)
        games, places = set(), {}
        for e in self.events:
            if (e.get("at") or 0) < since_ms:
                continue
            if any(norm(e.get(f + "_name")) == me for f in ("from", "to", "playerId", "holderId")):
                games.add((e.get("room_code"), e.get("game_id")))
            if e.get("kind") == "out" and norm(e.get("playerId_name")) == me:
                places[(e.get("room_code"), e.get("game_id"))] = e.get("place")
            elif e.get("kind") == "win" and norm(e.get("playerId_name")) == me:
                places[(e.get("room_code"), e.get("game_id"))] = 1
        place_list = [p for p in places.values() if p]
        return {"games": len(games), "places": place_list,
                "avg_place": round(sum(place_list) / len(place_list), 2) if place_list else None}

    # ---- recent -----------------------------------------------------------------------------

    def recent(self, limit=30):
        return [{"time": q["timestamp_utc"], "room": q["room_code"], "game": q.get("game"), "round": q.get("round"),
                 "question": q["question"], "threshold": q.get("threshold")}
                for q in sorted(self.questions, key=lambda q: q["timestamp_utc"], reverse=True)[:limit]]
