"""Passively record every question (category) asked in Krillion.io Puffer Party games you play.

By default this runs a local server that the browser extension in extension/ sends the game's
WebSocket messages to, and serves the stats dashboard. With --browser it instead opens its own
Chromium window and listens there. Either way it only reads; it never sends anything to the game.
"""

import argparse
import json
import os
import re
import sys
import threading
import time
import webbrowser
from datetime import datetime, timezone
from pathlib import Path

from stats import Stats, norm

PARTY_URL = "https://krillion.io/party"
ROOM_WS_RE = re.compile(r"party\.krillion\.io/rooms/([^/?#]+)/ws")

# Checked first, in order. Dotted paths go into nested objects.
# Confirmed from a real game: room.category = {"index", "text", "threshold", "accepted"}.
KNOWN_CATEGORY_PATHS = ["category.text", "category", "round.category", "prompt", "question"]
KNOWN_ROUND_PATHS = ["category.index", "round.number", "round.index", "roundNumber", "round"]
CATEGORY_HINTS = ("categ", "prompt", "question")
SKIP_KEYS = {"players", "events", "chat", "seen"}


def now_utc():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def get_path(obj, path):
    for part in path.split("."):
        if not isinstance(obj, dict) or part not in obj:
            return None
        obj = obj[part]
    return obj


def as_text(value):
    """Category values may be plain strings or objects like {"id", "name"}."""
    if isinstance(value, str):
        return value.strip() or None
    if isinstance(value, dict):
        for k in ("text", "name", "label", "title", "prompt"):
            if isinstance(value.get(k), str) and value[k].strip():
                return value[k].strip()
    return None


def search_hinted(obj, depth=0):
    """Fallback: find a string under any key that looks like a category/prompt/question."""
    if not isinstance(obj, dict) or depth > 3:
        return None
    for key, value in obj.items():
        if key in SKIP_KEYS:
            continue
        if any(h in key.lower() for h in CATEGORY_HINTS):
            text = as_text(value)
            if text:
                return text
    for key, value in obj.items():
        if key not in SKIP_KEYS and isinstance(value, dict):
            found = search_hinted(value, depth + 1)
            if found:
                return found
    return None


def find_category(room):
    for path in KNOWN_CATEGORY_PATHS:
        text = as_text(get_path(room, path))
        if text:
            return text
    return search_hinted(room)


def find_round(room):
    for path in KNOWN_ROUND_PATHS:
        value = get_path(room, path)
        if isinstance(value, int):
            return value
    return None


class Store:
    def __init__(self, out_dir, dump):
        self.out_dir = Path(out_dir)
        self.out_dir.mkdir(parents=True, exist_ok=True)
        self.log = open(self.out_dir / "questions.jsonl", "a", encoding="utf-8")
        self.raw = open(self.out_dir / "raw_frames.jsonl", "a", encoding="utf-8") if dump else None
        events_path = self.out_dir / "events.jsonl"
        self.event_keys = set()  # (room, seq, at) already written, so re-runs and re-snaps don't duplicate
        if events_path.exists():
            for line in events_path.read_text(encoding="utf-8").splitlines():
                if line.strip():
                    e = json.loads(line)
                    self.event_keys.add((e["room_code"], e["seq"], e["at"]))
        self.events = open(events_path, "a", encoding="utf-8")
        # Everything recorded, kept in memory and added to as rows are written, so the dashboard
        # and live window never re-read the files mid-game.
        self.stats = Stats(self.out_dir)
        self.unique_path = self.out_dir / "unique_questions.json"
        self.unique = {}
        if self.unique_path.exists():
            for entry in json.loads(self.unique_path.read_text(encoding="utf-8")):
                self.unique[entry["question"].casefold()] = entry

    def record(self, room_code, game_no, round_no, question, threshold=None):
        ts = now_utc()
        row = {"timestamp_utc": ts, "room_code": room_code, "game": game_no,
               "round": round_no, "question": question, "threshold": threshold}
        self.log.write(json.dumps(row, ensure_ascii=False) + "\n")
        self.log.flush()
        self.stats.add_question(row)

        key = question.casefold()
        entry = self.unique.get(key)
        if entry:
            entry["times_seen"] += 1
            entry["last_seen"] = ts
        else:
            self.unique[key] = {"question": question, "times_seen": 1, "first_seen": ts, "last_seen": ts}
        entries = sorted(self.unique.values(), key=lambda e: e["question"].casefold())
        tmp = self.unique_path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(entries, indent=2, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, self.unique_path)

    def record_event(self, record):
        key = (record["room_code"], record["seq"], record["at"])
        if key in self.event_keys:
            return False
        self.event_keys.add(key)
        self.events.write(json.dumps(record, ensure_ascii=False) + "\n")
        self.events.flush()
        self.stats.add_event(record)
        return True

    def dump(self, room_code, payload):
        if self.raw:
            self.raw.write(json.dumps({"ts": now_utc(), "room": room_code, "frame": payload},
                                      ensure_ascii=False) + "\n")
            self.raw.flush()

    def close(self):
        self.log.close()
        self.events.close()
        if self.raw:
            self.raw.close()


class Recorder:
    """Mirrors each room's state from snap/patch frames, the same way the site's client does."""

    def __init__(self, store):
        self.store = store
        self.rooms = {}          # room code -> mirrored room state
        self.last_seen = {}      # room code -> (gameId, round, question) last recorded
        self.names = {}          # player id -> name; kept after players leave
        self.round_ctx = {}      # room code -> (round, question) the next events belong to
        self.lock = threading.Lock()  # frames arrive on server threads
        self.changed = threading.Condition(self.lock)  # wakes live streams after each frame
        self.version = 0              # bumped once per processed frame
        self.detected_at = None       # unix time the latest frame finished processing
        self.last_frame = None        # (unix time, room code) of the latest frame, for the dashboard
        # Live window state, in memory only.
        self.used = {}           # room code -> answers accepted so far this round
        self.fuse_start = {}     # room code -> server ms the fuse last restarted (round start or pop)
        self.received = {}       # room code -> local unix time the room state was last updated
        self.rating_start = {}   # normalised player name -> rating when first seen this session
        self.started_ms = int(time.time() * 1000)

    def status(self):
        if not self.last_frame:
            return {"recording": True, "last_frame_at": None, "room": None}
        at, room = self.last_frame
        return {"recording": True, "last_frame_at": at, "room": room}

    def ingest(self, ws_url, payload):
        """Entry point for frames forwarded by the extension: picks the room code out of the socket URL."""
        match = ROOM_WS_RE.search(ws_url)
        if not match:
            return
        code = match.group(1).upper()
        self.last_frame = (time.time(), code)
        with self.lock:
            if code not in self.rooms and code not in self.round_ctx:
                print(f"-- connected to room {code}", flush=True)
            self.on_frame(code, payload)
            self.announce()

    def announce(self):
        """Wake every live stream; call with the lock held, right after a frame is applied."""
        self.version += 1
        self.detected_at = time.time()
        self.changed.notify_all()

    def wait_for_change(self, last_version, timeout):
        """Block until a frame newer than last_version has been processed (or timeout); returns the version."""
        with self.changed:
            self.changed.wait_for(lambda: self.version != last_version, timeout)
            return self.version

    def learn_players(self, players):
        for p in players or []:
            if isinstance(p, dict) and p.get("id"):
                self.names[p["id"]] = p.get("name")

    def current_round(self, room):
        cat = room.get("category")
        return (find_round(room), find_category(room)) if cat else (None, None)

    def track_live(self, room_code, e):
        kind = e.get("kind")
        if kind == "category":
            self.used[room_code] = []
            self.fuse_start[room_code] = e.get("at")
        elif kind == "pop":
            # The fuse restarts after every pop; passing the puffer doesn't reset it.
            self.fuse_start[room_code] = e.get("at")
        elif kind == "pass" and e.get("answer"):
            self.used.setdefault(room_code, []).append(
                {"answer": e["answer"], "tier": e.get("tier"), "by": self.names.get(e.get("from"))})

    def on_events(self, room_code, room, events, live_only=False):
        """Log game events in order, tagged with the round they happened in."""
        for e in events or []:
            if not isinstance(e, dict) or "seq" not in e:
                continue
            self.track_live(room_code, e)
            if live_only:
                continue
            if e.get("kind") == "category":
                # A pass that clears a round can arrive in the same patch as the next round's
                # category, so only switch context when the category event itself comes up.
                rnd, question = self.current_round(room)
                self.round_ctx[room_code] = (e.get("index"), question if rnd == e.get("index") else None)
            rnd, question = self.round_ctx.get(room_code, (None, None))
            record = {
                "room_code": room_code, "game_id": room.get("gameId"), "game": room.get("gameNumber"),
                "round": rnd, "question": question, "kind": e.get("kind"), "seq": e["seq"], "at": e.get("at"),
            }
            for key in ("answer", "tier", "text", "why", "place", "livesLeft", "index"):
                if key in e:
                    record[key] = e[key]
            for key in ("from", "to", "playerId", "holderId"):
                if e.get(key):
                    record[key] = e[key]
                    record[key + "_name"] = self.names.get(e[key])
            self.store.record_event(record)

    def on_frame(self, room_code, payload):
        if isinstance(payload, bytes):
            payload = payload.decode("utf-8", "replace")
        self.store.dump(room_code, payload)
        try:
            msg = json.loads(payload)
        except ValueError:
            return
        if not isinstance(msg, dict):
            return

        if msg.get("t") == "snap" and isinstance(msg.get("room"), dict):
            room = msg["room"]
            rejoin = room_code in self.round_ctx
            self.rooms[room_code] = room
            self.learn_players(room.get("players"))
            if rejoin:
                # Reconnect: the backlog may hold events missed while disconnected.
                self.on_events(room_code, room, room.get("events"))
            else:
                # First join: the backlog is from before we arrived (often a previous game whose
                # questions we never saw), so don't log it. It still tells the live window which
                # answers this round already used and when the fuse last restarted.
                self.on_events(room_code, room, room.get("events"), live_only=True)
                self.round_ctx[room_code] = self.current_round(room)
            self.received[room_code] = time.time()
        elif msg.get("t") == "patch" and isinstance(msg.get("patch"), dict):
            room, patch = self.rooms.get(room_code), msg["patch"]
            if room is None or patch.get("base") != room.get("version"):
                # Out of sync; the site's client requests a fresh snap, so wait for it.
                self.rooms.pop(room_code, None)
                return
            room.update(patch.get("set") or {})
            room["version"] = patch.get("v")
            if patch.get("now"):
                room["now"] = patch["now"]
            self.received[room_code] = time.time()
            if patch.get("players") or patch.get("drop"):
                players = {p["id"]: p for p in room.get("players") or []}
                for pid in patch.get("drop") or []:
                    players.pop(pid, None)
                for p in patch.get("players") or []:
                    players[p["id"]] = p
                room["players"] = sorted(players.values(), key=lambda p: p.get("seat", 0))
                self.learn_players(patch.get("players"))
            self.on_events(room_code, room, patch.get("eventsAll") or patch.get("events"))
        else:
            return

        room = self.rooms[room_code]
        question = find_category(room)
        if not question:
            return
        round_no = find_round(room)
        # category is re-sent every time an answer is accepted; only log when the round changes.
        identity = (room.get("gameId"), round_no, question)
        if identity != self.last_seen.get(room_code):
            self.last_seen[room_code] = identity
            game_no = room.get("gameNumber")
            self.store.record(room_code, game_no, round_no, question, get_path(room, "category.threshold"))
            label = f"round {round_no}" if round_no is not None else "new round"
            print(f"[{room_code}] game {game_no} {label}: {question}", flush=True)

    def attach(self, page):
        def on_websocket(ws):
            match = ROOM_WS_RE.search(ws.url)
            if match:
                code = match.group(1).upper()
                print(f"-- connected to room {code}", flush=True)
                ws.on("framereceived", lambda payload: self.locked_frame(code, payload))

        page.on("websocket", on_websocket)

    def locked_frame(self, code, payload):
        self.last_frame = (time.time(), code)
        with self.lock:
            self.on_frame(code, payload)
            self.announce()

    def live_state(self, my_name=""):
        """Snapshot of the room with the latest activity, for the live window."""
        with self.lock:
            if not self.last_frame:
                return {"recording": True, "active": False}
            code = self.last_frame[1]
            room = self.rooms.get(code)
            since_update = time.time() - self.received.get(code, 0)
            if room is None or since_update > 120:
                return {"recording": True, "active": False}

            # Server clock now = the room's last "now" plus the time since that update arrived.
            server_now = (room.get("now") or 0) + since_update * 1000
            settings = room.get("settings") or {}
            in_round = room.get("phase") == "round"
            holder_since, fuse_start = room.get("holderSince"), self.fuse_start.get(code)
            me, rating = norm(my_name), {}
            players = []
            for p in room.get("players") or []:
                players.append({**{k: p.get(k) for k in
                                   ("name", "lives", "meter", "answers", "pops", "rating", "alive", "place",
                                    "connected", "best")},
                                "is_me": bool(me) and norm(p.get("name")) == me})
                if me and norm(p.get("name")) == me and p.get("rating") is not None:
                    start = self.rating_start.setdefault(me, p["rating"])
                    rating = {"rating": p["rating"], "rating_change": p["rating"] - start}
            return {
                "recording": True,
                "active": True,
                "detected_at": self.detected_at,
                "room": code,
                "phase": room.get("phase"),
                "rated": bool(room.get("rated")),
                "game": room.get("gameNumber"),
                "round": find_round(room) if in_round else None,
                "question": find_category(room) if in_round else None,
                "threshold": get_path(room, "category.threshold") if in_round else None,
                "accepted": get_path(room, "category.accepted") if in_round else None,
                "holder": self.names.get(room.get("holderId")) if in_round else None,
                "holding_ms": server_now - holder_since if in_round and holder_since else None,
                "fuse_ms": server_now - fuse_start if in_round and fuse_start else None,
                "fuse_min_ms": settings.get("fuseMinMs"),
                "fuse_max_ms": settings.get("fuseMaxMs"),
                "min_turn_ms": settings.get("minTurnMs"),
                "meter_target": settings.get("meterTarget"),
                "max_lives": settings.get("maxLives"),
                "countdown_ms": room["countdownEndsAt"] - server_now if room.get("countdownEndsAt") else None,
                "players": players,
                "used": list(self.used.get(code, [])) if in_round else [],
                "rating": rating,
            }


def start_live_window(port):
    """The live window runs as its own process: pywebview needs the main thread."""
    import subprocess
    script = Path(__file__).resolve().parent / "live.py"
    return subprocess.Popen([sys.executable, str(script), "--port", str(port)])


def run_server(args, store, recorder):
    """Extension mode: the server receives frames from Chrome and serves the dashboard."""
    from dashboard import make_server
    try:
        server = make_server(args.out, args.port, recorder=recorder)
    except OSError as e:
        sys.exit(f"Port {args.port} is busy ({e}). Is the recorder already running? Try --port.")
    url = f"http://127.0.0.1:{args.port}/"
    print(f"Recording to {Path(args.out).resolve()}")
    print(f"Dashboard: {url}  - play at krillion.io/party in Chrome with the extension on; Ctrl+C to stop.")
    if not args.no_open:
        webbrowser.open(url)
        webbrowser.open(PARTY_URL)  # opened last so the game's tab is the one in front
    live = start_live_window(args.port) if args.live else None
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        if live:
            live.terminate()
        server.server_close()
        store.close()
    print(f"Done. {len(store.unique)} unique questions saved.")


def run_browser(args, store, recorder):
    """--browser mode: open a Playwright-controlled Chromium window and listen to its traffic."""
    from playwright.sync_api import sync_playwright
    from dashboard import start_in_background

    print(f"Recording to {Path(args.out).resolve()} - play in the browser window; Ctrl+C or close it to stop.")
    server = None
    try:
        server = start_in_background(args.out, args.port, open_browser=not (args.headless or args.no_open),
                                     recorder=recorder)
    except OSError as e:
        print(f"Dashboard not started (port {args.port} busy? {e}); recording continues.")
    live = start_live_window(args.port) if args.live and server else None

    with sync_playwright() as p:
        context = p.chromium.launch_persistent_context(args.profile, headless=args.headless,
                                                       no_viewport=True)
        context.on("page", recorder.attach)
        for page in context.pages:
            recorder.attach(page)
        page = context.pages[0] if context.pages else context.new_page()
        page.goto(PARTY_URL)
        try:
            context.wait_for_event("close", timeout=0)
        except KeyboardInterrupt:
            pass
        finally:
            if live:
                live.terminate()
            if server:
                server.shutdown()
            store.close()
            try:
                context.close()
            except Exception:
                pass
    print(f"Done. {len(store.unique)} unique questions saved.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", default="data", help="output folder (default: ./data)")
    parser.add_argument("--port", type=int, default=8765, help="server/dashboard port (default: 8765)")
    parser.add_argument("--no-open", action="store_true", help="don't open the dashboard and krillion.io/party automatically")
    parser.add_argument("--live", action="store_true", help="also open the always-on-top live window")
    parser.add_argument("--dump", action="store_true", help="also save every raw frame to raw_frames.jsonl")
    parser.add_argument("--browser", action="store_true", help="use a Playwright window instead of the extension")
    parser.add_argument("--profile", default="profile", help="--browser: profile folder (default: ./profile)")
    parser.add_argument("--headless", action="store_true", help="--browser: run without a visible window")
    parser.add_argument("--ui", action="store_true", help=argparse.SUPPRESS)  # old flag; the dashboard is always on
    args = parser.parse_args()

    store = Store(args.out, args.dump)
    recorder = Recorder(store)
    (run_browser if args.browser else run_server)(args, store, recorder)


if __name__ == "__main__":
    sys.exit(main())
