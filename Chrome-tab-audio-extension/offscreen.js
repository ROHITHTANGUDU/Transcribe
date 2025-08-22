// offscreen.js — continuous chunks for backend + segment recorder for playable downloads

let contRecorder = null;   // continuous recorder (timeslice) -> CHUNK (init for first)
let segRunning   = false;  // segment loop flag
let audioStream  = null;
let timesliceMs  = 10000;  // UI chunk size
let sentInit     = false;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const isProtectedErr = (s='') => /permission denied|not allowed|capture.*not.*allowed/i.test(s);

function pickMime() {
  const types = [
    'audio/webm;codecs=opus', 'audio/webm',
    'audio/ogg;codecs=opus',  'audio/mp4;codecs=mp4a.40.2'
  ];
  for (const t of types) if (MediaRecorder.isTypeSupported?.(t)) return t;
  return '';
}
function post(payload) { try { chrome.runtime.sendMessage({ from: 'offscreen', ...payload }); } catch {} }

async function getActiveTabViaBG() {
  const resp = await chrome.runtime.sendMessage({ from: 'offscreen-util', type: 'GET_ACTIVE_TAB' });
  if (!resp?.ok) throw new Error(resp?.error || 'Failed to get active tab');
  if (!resp.tab) throw new Error('No active tab in current window.');
  return resp.tab;
}
async function focusAndActivateViaBG(tab) {
  const resp = await chrome.runtime.sendMessage({ from: 'offscreen-util', type: 'FOCUS_AND_ACTIVATE', tab });
  if (!resp?.ok) throw new Error(resp?.error || 'Failed to focus/activate tab');
}

async function captureActiveTab() {
  const tab = await getActiveTabViaBG();
  await focusAndActivateViaBG(tab);
  await sleep(150);

  return new Promise((resolve, reject) => {
    chrome.tabCapture.capture({ audio: true, video: false }, (stream) => {
      if (chrome.runtime.lastError || !stream) {
        const msg = chrome.runtime.lastError?.message || 'tabCapture failed';
        reject(new Error(msg));
      } else {
        resolve({ stream, tab });
      }
    });
  });
}

// -------- segment recorder for playable downloads --------
function startSegmentLoop(stream, mimeType) {
  segRunning = true;

  const startOne = () => {
    if (!segRunning) return;
    const segRec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    let segBlob = null;

    segRec.ondataavailable = (e) => { if (e.data && e.data.size) segBlob = e.data; };
    segRec.onstop = () => {
      if (segBlob) post({ type: 'SEGMENT', blob: segBlob, mimeType: mimeType || segBlob.type || 'audio/webm' });
      if (segRunning) startOne();
    };

    segRec.start(); // no timeslice: complete, standalone chunk on stop
    setTimeout(() => { if (segRec.state !== 'inactive') segRec.stop(); }, timesliceMs);
  };

  startOne();
}

async function startRecording({ chunkSecs }) {
  timesliceMs = Math.max(2, Number(chunkSecs || 10)) * 1000;
  sentInit = false;

  try {
    const { stream, tab } = await captureActiveTab();
    audioStream = stream;

    post({ type: 'STATE', state: 'RECORDING', tabTitle: tab?.title || 'current tab' });

    const mimeType = pickMime();

    // 1) Continuous recorder for backend streaming
    contRecorder = new MediaRecorder(audioStream, mimeType ? { mimeType } : undefined);
    contRecorder.ondataavailable = (e) => {
      if (!e.data || !e.data.size) return;
      post({
        type: 'CHUNK',
        blob: e.data,
        mimeType: mimeType || e.data.type || 'audio/webm',
        init: !sentInit
      });
      sentInit = true;
    };
    contRecorder.onstop = () => {
      post({ type: 'STATE', state: 'IDLE' });
      try { audioStream?.getTracks().forEach(t => t.stop()); } catch {}
      audioStream = null; contRecorder = null; segRunning = false;
    };
    contRecorder.start(timesliceMs); // continuous chunks

    // 2) Parallel segment-loop for playable UI downloads
    startSegmentLoop(audioStream, mimeType);
  } catch (err) {
    const msg = String(err?.message || err);
    if (isProtectedErr(msg)) { post({ type: 'NEED_PICKER', reason: 'DRM or site blocks tab capture' }); return; }
    post({ type: 'ERROR', message: msg });
  }
}

function stopRecording() {
  segRunning = false;
  try {
    if (contRecorder && contRecorder.state !== 'inactive') contRecorder.stop();
    else post({ type: 'STATE', state: 'IDLE' });
  } catch (e) {
    post({ type: 'ERROR', message: String(e?.message || e) });
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.from !== 'background') return;
  if (msg.type === 'START') {
    startRecording(msg.payload || {})
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (msg.type === 'STOP') {
    stopRecording(); sendResponse({ ok: true }); return true;
  }
});