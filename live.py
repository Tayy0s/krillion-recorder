"""Small always-on-top window with live info for the game you're in. Needs the recorder running."""

import argparse

import webview


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8765, help="recorder port (default: 8765)")
    args = parser.parse_args()
    webview.create_window("Puffer Party Live", f"http://127.0.0.1:{args.port}/live.html",
                          width=360, height=620, min_size=(300, 360), on_top=True)
    webview.start()


if __name__ == "__main__":
    main()
