# Krillion Puffer Party Recorder

A game logger and a real-time helper for [Krillion Puffer Party](https://krillion.io/party). A small browser extension sends game data to the logger, which saves it for viewing in a local web dashboard.

Use it to look through questions and answers from everyone in your games, see how often questions repeat, and review past rounds. The real-time window shows the fuse timer, player lives, and heart meter, and keeps track of answers other players have typed during the current round.

## Setup (once)

1. Install Python 3.
2. In Chrome, open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and pick the `extension` folder.

## Recording

```bash
python recorder.py
```

This starts the recorder and opens both the dashboard (http://127.0.0.1:8765/) and krillion.io/party in your default browser (`--no-open` skips both). Play there with the extension on. New questions print in the console as they come up. Stop with Ctrl+C.

Two places show whether it's working:
- **Extension badge:** `rec` while game messages are reaching the recorder, `off` if the recorder can't be reached, and blank when no game is going on.
- **Dashboard header:** "Live · ROOM" during a game, "Waiting for a game" otherwise.

If the recorder isn't running, the extension holds recent messages for a while and sends them once it starts.

After installing, updating or reloading the extension, **refresh any open krillion.io tab**. Tabs opened before the reload aren't connected to the extension, and the console shows "Extension context invalidated".

Works in Chrome and Edge (`edge://extensions`, then Developer mode and Load unpacked).

The extension always sends to port 8765. If you use `--port`, also change `ENDPOINT` in `extension/background.js` and reload the extension.

## Live window

Double-click **`run.bat`**, or run:

```bash
python recorder.py --live
```

This also opens a small always-on-top window to keep beside the game. The recorder pushes every change to it the moment it reads a game message, so a new question appears within a few milliseconds of the console line. It needs `pip install pywebview` once, and uses the Edge WebView2 built into Windows. To open it on its own while the recorder is already running, use `python live.py`. Enter your in-game name in it once; the dashboard's Me tab uses the same name. The window shows:

- The question, with accepted answers against the threshold, how many times you've seen it, and your best tier on it.
- Who is holding the puffer, and the fuse. The fuse goes off at a random point 10–30 s after the round starts or the last pop; passing doesn't reset it. Every new holder is safe for their first 8 s. "Safe for X s" turns into "Can pop now" once both have run out.
- Players: lives, meter toward 600 (each accepted answer adds its tier score), rating, and pops per game and average answer score from your recorded games.
- **Used this round**, so you don't get rejected for a repeat.
- **Your past answers**: only answers *you* typed and had accepted for this question before. Any already used this round are crossed out.
- This session: games, average place and rating change.

### Without the extension

```bash
python recorder.py --browser
```

This opens its own Playwright-controlled Chromium window instead. It needs `pip install -r requirements.txt` and `playwright install chromium`. Google sign-in doesn't work in that window, but your rating is kept in `profile/`.

Files in `data/`:

- `questions.jsonl`: one line per question asked (`timestamp_utc`, `room_code`, `game`, `round`, `question`, `threshold`)
- `events.jsonl`: game events tagged with their round and question: accepted answers (`pass`, with `answer` and `tier`), rejected answers (`reject`), `pop`, `out`, `win`, and so on
- `unique_questions.json`: de-duplicated questions with `times_seen`, `first_seen` and `last_seen`
- `settings.json`: your in-game name

Options: `--out DIR`, `--port N`, `--no-open`, `--live`, `--dump`, and for `--browser` mode also `--profile DIR` and `--headless`. `--dump` also writes every raw frame to `data/raw_frames.jsonl`. Use it if questions stop showing up after a site update, then adjust `KNOWN_CATEGORY_PATHS` in `recorder.py`.

## Dashboard only

```bash
python dashboard.py
```

Tabs:
- **Overview**
- **Questions:** click a question for its answer bank, tiers and rejected attempts.
- **Answers:** every attempt, filtered by text, accepted/rejected, rarity, player, question and period. It can show every attempt or unique answers, and the filters stay in the URL so links keep them.
- **Tiers**
- **Me:** your in-game name and stats.
- **Recent**

Tier colors and names match the game: Plankton, Too Clever, Schooler, Rare, Deep Cut and One in a Krillion.

## Rebuilding events from raw frames

```bash
python backfill.py
```

This replays `data/raw_frames.jsonl` (recorded with `--dump`) into `events.jsonl`. Events already saved are skipped, so it's safe to re-run.
