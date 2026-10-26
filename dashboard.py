"""Local stats dashboard for the recorder's data. Serves ui/ and a small JSON API on 127.0.0.1."""

import argparse
import json
import threading
import webbrowser
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from stats import cached_stats, load_settings, save_settings

UI_DIR = Path(__file__).resolve().parent / "ui"


class Handler(SimpleHTTPRequestHandler):
    data_dir = "data"
    recorder = None  # the running Recorder; None when only viewing stats

    def log_message(self, *args):
        pass  # keep the recorder's console readable

    def origin_allowed(self, extension_only=False):
        """Block other websites from posting into this local server; local tools send no Origin."""
        origin = self.headers.get("Origin")
        if not origin:
            return True
        if origin.startswith("chrome-extension://"):
            return True
        return not extension_only and origin == f"http://{self.headers.get('Host')}"

    def read_json(self):
        return json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")

    def send_json(self, payload, status=200):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self):
        if not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-cache")  # pick up UI edits without a hard refresh
        super().end_headers()

    def do_GET(self):
        url = urlparse(self.path)
        if not url.path.startswith("/api/"):
            return super().do_GET()
        if url.path == "/api/live/stream":
            return self.stream()
        q = {k: v[0] for k, v in parse_qs(url.query).items()}
        s = self.stats()
        routes = {
            "/api/overview": lambda: s.overview(),
            "/api/questions": lambda: s.questions_table(),
            "/api/question": lambda: s.question_detail(q.get("q", "")),
            "/api/answers": lambda: s.answers(),
            "/api/tiers": lambda: s.tiers(),
            "/api/me": lambda: s.me(q.get("name") or load_settings(self.data_dir).get("name", "")),
            "/api/recent": lambda: s.recent(),
            "/api/settings": lambda: load_settings(self.data_dir),
            "/api/status": lambda: self.recorder.status() if self.recorder else {"recording": False},
            "/api/live": self.live,
        }
        route = routes.get(url.path)
        if route is None:
            return self.send_json({"error": "not found"}, 404)
        self.send_json(route())

    def stats(self):
        """While recording, the recorder's in-memory stats; otherwise read from the data files."""
        if self.recorder:
            return self.recorder.store.stats.snapshot()
        return cached_stats(self.data_dir)

    def fast_state(self, name):
        """The live game itself, straight from the recorder's memory: no disk, no stats."""
        state = self.recorder.live_state(name)
        state["me"] = name
        return state

    def extra_state(self, name, state):
        """The personal part of the live window, computed from recorded history."""
        s = self.stats()
        question = state.get("question")
        extra = {"session": {**s.session(name, self.recorder.started_ms), **state.get("rating", {})} if name else None}
        if state.get("active"):
            extra["history"] = s.player_history([p["name"] for p in state.get("players", [])])
            extra["familiarity"] = s.familiarity(name, question) if question else None
            extra["my_answers"] = s.my_answers_for(name, question) if name and question else []
        return extra

    def live(self):
        """Everything the live window shows, in one response."""
        if not self.recorder:
            return {"recording": False, "active": False}
        name = load_settings(self.data_dir).get("name", "")
        state = self.fast_state(name)
        return {**state, **self.extra_state(name, state)}

    def send_event(self, event, payload):
        data = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        self.wfile.write(f"event: {event}\ndata: {data}\n\n".encode("utf-8"))
        self.wfile.flush()

    def stream(self):
        """Server-Sent Events: pushes the live state the moment the recorder applies a frame.

        After every frame it sends `live` (the game itself) first, then `extra` (history, your past
        answers) only when the room, game, round, phase, players or your name changed. `extra` gets
        slower as recorded data grows, so it's never computed between a frame and its `live` message.
        """
        if not self.recorder:
            return self.send_json({"recording": False}, 503)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        version, extra_key = -1, None
        try:
            self.wfile.write(b"retry: 1000\n\n")  # reconnect quickly if the recorder restarts
            while True:
                # A timeout still sends the state, so "waiting for a game" shows once a game goes quiet.
                version = self.recorder.wait_for_change(version, 15)
                name = load_settings(self.data_dir).get("name", "")
                state = self.fast_state(name)
                self.send_event("live", state)
                key = (state.get("room"), state.get("game"), state.get("round"), state.get("question"),
                       state.get("phase"), state.get("active"), name,
                       tuple((p["name"], p.get("alive")) for p in state.get("players", [])))
                if key != extra_key:
                    self.send_event("extra", self.extra_state(name, state))
                    extra_key = key
        except (ConnectionError, OSError):
            pass  # the window closed or reloaded

    def do_POST(self):
        path = urlparse(self.path).path
        if path == "/api/frames":
            return self.post_frames()
        if path != "/api/settings":
            return self.send_json({"error": "not found"}, 404)
        if not self.origin_allowed():
            return self.send_json({"error": "forbidden"}, 403)
        try:
            body = self.read_json()
            settings = load_settings(self.data_dir)
            settings["name"] = " ".join(str(body["name"]).split())[:32]
            save_settings(self.data_dir, settings)
        except (KeyError, ValueError, TypeError):
            return self.send_json({"error": "bad request"}, 400)
        self.send_json(settings)

    def post_frames(self):
        """Game messages forwarded by the browser extension: [{"url": ws_url, "data": frame_text}, ...]."""
        if not self.origin_allowed(extension_only=True):
            return self.send_json({"error": "forbidden"}, 403)
        if self.recorder is None:
            return self.send_json({"error": "not recording"}, 503)
        try:
            body = self.read_json()
            frames = body if isinstance(body, list) else [body]
            for f in frames:
                self.recorder.ingest(str(f["url"]), str(f["data"]))
        except (KeyError, ValueError, TypeError):
            return self.send_json({"error": "bad request"}, 400)
        self.send_json({"ok": len(frames)})


def make_server(data_dir="data", port=8765, recorder=None):
    attrs = {"data_dir": str(data_dir), "recorder": recorder}
    handler = partial(type("BoundHandler", (Handler,), attrs), directory=str(UI_DIR))
    return ThreadingHTTPServer(("127.0.0.1", port), handler)


def start_in_background(data_dir="data", port=8765, open_browser=True, recorder=None):
    server = make_server(data_dir, port, recorder)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{port}/"
    print(f"Dashboard: {url}", flush=True)
    if open_browser:
        webbrowser.open(url)
    return server


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", default="data", help="data folder (default: ./data)")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-browser", action="store_true", help="don't open the dashboard automatically")
    args = parser.parse_args()
    server = make_server(args.data, args.port)
    url = f"http://127.0.0.1:{args.port}/"
    print(f"Dashboard: {url}  (Ctrl+C to stop)")
    if not args.no_browser:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
