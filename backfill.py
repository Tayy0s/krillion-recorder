"""Rebuild data/events.jsonl from frames saved with --dump. Safe to re-run: events already saved are skipped."""

import argparse
import json
from pathlib import Path

from recorder import Recorder, Store


class EventsOnlyStore(Store):
    """Questions from these frames were already logged live; only fill in events."""

    def record(self, *args, **kwargs):
        pass


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", default="data", help="data folder (default: ./data)")
    args = parser.parse_args()

    raw_path = Path(args.out) / "raw_frames.jsonl"
    store = EventsOnlyStore(args.out, dump=False)
    before = len(store.event_keys)
    recorder = Recorder(store)
    with open(raw_path, encoding="utf-8") as f:
        for line in f:
            if line.strip():
                row = json.loads(line)
                recorder.on_frame(row["room"], row["frame"])
    store.close()
    print(f"Added {len(store.event_keys) - before} events from {raw_path}.")


if __name__ == "__main__":
    main()
