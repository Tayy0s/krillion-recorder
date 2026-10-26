// Isolated content script: passes frames from page.js on to the background worker.
function onMessage(event) {
  const msg = event.data;
  if (event.source !== window || !msg || msg.source !== "puffer-recorder") return;
  try {
    chrome.runtime.sendMessage({ type: "frame", url: msg.url, data: msg.data }).catch(() => {});
  } catch {
    // The extension was reloaded or updated after this tab opened, so this copy of the script
    // can't reach it any more. A refreshed tab gets a working copy.
    window.removeEventListener("message", onMessage);
    console.warn("Puffer Party Recorder was reloaded. Refresh this tab to keep recording.");
  }
}

window.addEventListener("message", onMessage);
