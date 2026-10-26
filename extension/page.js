// Runs in the page itself so it can see the game's WebSocket. It only adds a listener to
// incoming messages; nothing the game sends or receives is changed.
(() => {
  const NativeWebSocket = window.WebSocket;
  const ROOM_SOCKET = /party\.krillion\.io\/rooms\/[^/?#]+\/ws/;

  class RecordedWebSocket extends NativeWebSocket {
    constructor(url, protocols) {
      super(url, protocols);
      const href = String(url);
      if (!ROOM_SOCKET.test(href)) return;
      this.addEventListener("message", (event) => {
        if (typeof event.data === "string") {
          window.postMessage({ source: "puffer-recorder", url: href, data: event.data }, window.location.origin);
        }
      });
    }
  }

  window.WebSocket = RecordedWebSocket;
})();
