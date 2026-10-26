// Sends game frames to the local recorder (python recorder.py). Frames are sent in order and
// held briefly if the recorder isn't running yet; the badge shows whether they're getting through.
const ENDPOINT = "http://127.0.0.1:8765/api/frames";
const MAX_QUEUE = 2000;

let queue = [];
let sending = false;
let idleTimer = 0;

// "rec" while frames are reaching the recorder, "off" when it can't be reached, blank when idle.
// The idle reset stays under 30s so it fires before the browser suspends this worker.
function badge(ok) {
  clearTimeout(idleTimer);
  chrome.action.setBadgeText({ text: ok ? "rec" : "off" });
  chrome.action.setBadgeBackgroundColor({ color: ok ? "#256abf" : "#898781" });
  chrome.action.setTitle({ title: ok ? "Puffer Party Recorder: recording" : "Puffer Party Recorder: recorder not running" });
  if (ok) {
    idleTimer = setTimeout(() => {
      chrome.action.setBadgeText({ text: "" });
      chrome.action.setTitle({ title: "Puffer Party Recorder: waiting for a game" });
    }, 25000);
  }
}

async function flush() {
  if (sending || !queue.length) return;
  sending = true;
  try {
    while (queue.length) {
      const batch = queue.slice(0, 50);
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(batch),
      });
      if (!res.ok) throw new Error(String(res.status));
      queue = queue.slice(batch.length);
      badge(true);
    }
  } catch {
    badge(false);
    setTimeout(flush, 3000);
  } finally {
    sending = false;
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== "frame") return;
  queue.push({ url: msg.url, data: msg.data });
  if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE);
  flush();
});
