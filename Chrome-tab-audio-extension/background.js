// Open side panel when extension icon is clicked
chrome.action.onClicked.addListener(async (tab) => {
  try {
    await chrome.sidePanel.open({ tabId: tab.id });
  } catch (e) {
    console.warn('Failed to open side panel:', e);
  }
});
// background.js    

const OFFSCREEN_URL = chrome.runtime.getURL('offscreen.html');

async function ensureOffscreen() {
  try {
    const exists = await chrome.offscreen.hasDocument?.();
    if (!exists) {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_URL,
        reasons: ['USER_MEDIA', 'BLOBS'],
        justification: 'Capture active tab audio and stream chunks to side panel'
      });
    }
  } catch (e) {
    // If offscreen isn't supported, we proceed; side panel will use picker fallback.
    console.warn('Offscreen unavailable, will rely on picker fallback.', e);
  }
}

async function closeOffscreen() {
  try {
    const exists = await chrome.offscreen.hasDocument?.();
    if (exists) await chrome.offscreen.closeDocument();
  } catch {}
}

// Router
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Side panel commands
  if (msg?.from === 'sidepanel' && (msg.type === 'START' || msg.type === 'STOP')) {
    (async () => {
      await ensureOffscreen();
      // Ask offscreen to start/stop; if no offscreen, side panel will fallback to picker.
      chrome.runtime.sendMessage({ from: 'background', type: msg.type, payload: msg.payload });
      sendResponse({ ok: true });
    })();
    return true; // async
  }

  // Offscreen utility requests (we do tabs/windows here)
  if (msg?.from === 'offscreen-util') {
    (async () => {
      try {
        if (msg.type === 'GET_ACTIVE_TAB') {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          sendResponse({
            ok: true,
            tab: tab ? { id: tab.id, windowId: tab.windowId, title: tab.title } : null
          });
          return;
        }
        if (msg.type === 'FOCUS_AND_ACTIVATE' && msg.tab) {
          await chrome.windows.update(msg.tab.windowId, { focused: true });
          await chrome.tabs.update(msg.tab.id, { active: true });
          sendResponse({ ok: true });
          return;
        }
        sendResponse({ ok: false, error: 'Unknown util message' });
      } catch (e) {
        sendResponse({ ok: false, error: String(e?.message || e) });
      }
    })();
    return true; // async
  }

  // Offscreen → forward to side panel
  if (msg?.from === 'offscreen') {
    chrome.runtime.sendMessage({ from: 'background', type: 'FORWARD', payload: msg });
    if (msg.type === 'STATE' && msg.state === 'IDLE') {
      closeOffscreen().catch(() => {});
    }
    sendResponse({ ok: true });
    return true;
  }
});