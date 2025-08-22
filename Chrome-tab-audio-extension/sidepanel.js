
/* ======== EXISTING IMPORTS / GLOBALS (unchanged) ======== */
const startBtn     = document.getElementById('start');
const stopBtn      = document.getElementById('stop');
const statusEl     = document.getElementById('status');
const audioEl      = document.getElementById('playback');
const dlEl         = document.getElementById('download');
const chunkSecsEl  = document.getElementById('chunkSecs');
const chunkList    = document.getElementById('chunkList');

const serverUrl = "http://127.0.0.1:8000"; // FastAPI server

// -------- Session state --------
let fullChunks = [];
let mimeHint = '';
let runningFB = false;
let sessionId = null;

// Keep BOTH streams so we can fully stop the share banner
let fbDisplayStream = null;  // stream returned by getDisplayMedia (video+audio)
let fbAudioStream   = null;  // audio-only stream used by MediaRecorder

let fbChunkIndex = 0;
let fbCurrentRec = null;
let fbChunkTimer = null;

// -------- Transcript state --------
let currentSource = 'Unknown source';
let transcriptionBuffer = [];
let transcriptionTimer = null;
let transcriptLog = []; // [{ts:number, source:string, text:string}]

// -------- Timer state --------
let meetingStart = null;
let meetingTimerId = null;

// -------- Network state (for graceful degradation) --------
let isOffline = !navigator.onLine;

/* ===================== Utils ===================== */
function extFor() { return 'webm'; }
function formatHMS(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = String(Math.floor(s / 3600)).padStart(2, '0');
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${h}:${m}:${ss}`;
}
function startTimer() {
  if (meetingTimerId) return;
  meetingStart = new Date();
  const el = document.getElementById('meeting-timer');
  const tick = () => { if (el && meetingStart) el.textContent = formatHMS(Date.now() - meetingStart.getTime()); };
  tick();
  meetingTimerId = setInterval(tick, 500);
}
function stopTimer() { clearInterval(meetingTimerId); meetingTimerId = null; }

function resetUI() {
  fullChunks = [];
  mimeHint = '';
  chunkList.innerHTML = '';
  audioEl.src = '';
  dlEl.style.display = 'none';
  dlEl.removeAttribute('href'); dlEl.removeAttribute('download');
  transcriptLog = [];
  clearTranscriptionDisplay();
  stopTimer();
  const t = document.getElementById('meeting-timer'); 
  if (t) t.textContent = '00:00:00';
  statusEl.textContent = 'Ready';

  // 🔄 Reset counters for new recording session
  fbChunkIndex = 0;     // fallback recorder/Download list index
  txNextIndex  = 1;     // FIFO transcription index
  txQueue = [];         // clear queue
  sessionId = new Date().toISOString().replace(/[:.]/g, '-'); // new session prefix

  // reset health LED (safe if not defined yet)
  if (typeof setHealthLight === 'function') setHealthLight('off');
}

function clearTranscriptionDisplay() {
  const existing = document.getElementById('transcription-container');
  if (existing) existing.remove();
}

/* ================== Transcript UI (toolbar + list) ================== */
function setupTranscriptionDisplay() {
  if (document.getElementById('transcription-container')) return;

  if (!document.getElementById('transcription-styles')) {
    const style = document.createElement('style');
    style.id = 'transcription-styles';
    style.textContent = `
      #transcription-container { margin-top: 1rem; max-height: 260px; overflow-y: auto;
        border: 1px solid #e5e7eb; padding: 10px; border-radius: 8px; background: #fff; }
      .tx-toolbar { display:flex; align-items:center; gap:8px; margin-bottom:8px; flex-wrap: wrap; }
      .tx-toolbar .label { font-size:12px; color:#374151; }
      .tx-toolbar .pill { font-variant-numeric: tabular-nums; font-size:12px; padding:4px 8px; border:1px solid #e5e7eb; border-radius:999px; background:#f9fafb; }
      .tx-btn { font-size:12px; padding:6px 10px; border:1px solid #e5e7eb; background:#f9fafb; border-radius:6px; cursor:pointer; }
      .tx-btn:hover { background:#f3f4f6; }
      .tx-entry { padding: 8px 10px; border-radius: 6px; margin-bottom: 8px; background:#fafafa; }
      .tx-header { font-size: 12px; color:#6b7280; font-weight:600; margin-bottom:4px; }
      .tx-text { font-size: 14px; color:#111827; white-space: pre-wrap; line-height: 1.45; }
    `;
    document.head.appendChild(style);
  }

  const container = document.createElement("div");
  container.id = "transcription-container";

  const heading = document.createElement("h3");
  heading.textContent = "Live Transcription";
  heading.style.margin = "0 0 8px 0";
  heading.style.fontSize = "16px";
  container.appendChild(heading);

  const bar = document.createElement('div');
  bar.className = 'tx-toolbar';

  const timerLabel = document.createElement('span');
  timerLabel.className = 'label';
  timerLabel.textContent = 'Meeting Timer:';
  const timerVal = document.createElement('span');
  timerVal.id = 'meeting-timer';
  timerVal.className = 'pill';
  timerVal.textContent = '00:00:00';

  const btnCopy = document.createElement('button');
  btnCopy.className = 'tx-btn';
  btnCopy.textContent = 'Copy transcript';
  btnCopy.onclick = async () => {
    try { await navigator.clipboard.writeText(buildTranscriptText()); btnCopy.textContent = 'Copied!'; setTimeout(() => (btnCopy.textContent = 'Copy transcript'), 1200); }
    catch { alert('Clipboard write failed'); }
  };
  const btnTxt = document.createElement('button');
  btnTxt.className = 'tx-btn';
  btnTxt.textContent = 'Download .txt';
  btnTxt.onclick = () => downloadBlob(new Blob([buildTranscriptText()], { type: 'text/plain' }), filename('transcript', 'txt'));
  const btnJson = document.createElement('button');
  btnJson.className = 'tx-btn';
  btnJson.textContent = 'Download .json';
  btnJson.onclick = () => downloadBlob(new Blob([JSON.stringify(buildTranscriptJSON(), null, 2)], { type: 'application/json' }), filename('transcript', 'json'));

  bar.append(timerLabel, timerVal, btnCopy, btnTxt, btnJson);
  container.appendChild(bar);

  const transcriptionDiv = document.createElement("div");
  transcriptionDiv.id = "transcription";
  container.appendChild(transcriptionDiv);

  dlEl.insertAdjacentElement('afterend', container);
}

function filename(base, ext) { const dt = new Date().toISOString().replace(/[:.]/g, '-'); return `${base}-${dt}.${ext}`; }
function downloadBlob(blob, name) { const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }

function buildTranscriptText() {
  return transcriptLog.map(e => `[${new Date(e.ts).toLocaleTimeString()}] • ${e.source}\n${e.text}`).join('\n\n');
}
function buildTranscriptJSON() {
  return transcriptLog.map(e => ({ timestamp: new Date(e.ts).toISOString(), localTime: new Date(e.ts).toLocaleTimeString(), source: e.source, text: e.text }));
}

function renderTranscriptEntry({ text, source }) {
  if (!text || !text.trim()) return;
  setupTranscriptionDisplay();
  const wrap = document.getElementById('transcription');

  const entry = document.createElement('div'); entry.className = 'tx-entry';
  const hdr = document.createElement('div'); hdr.className = 'tx-header';
  const tsStr = new Date().toLocaleTimeString();
  hdr.textContent = `[${tsStr}] • ${source || currentSource || 'Unknown'}`;
  const body = document.createElement('div'); body.className = 'tx-text'; body.textContent = text.trim();

  entry.appendChild(hdr); entry.appendChild(body); wrap.appendChild(entry);
  wrap.scrollTop = wrap.scrollHeight;
  transcriptLog.push({ ts: Date.now(), source: source || currentSource || 'Unknown', text: text.trim() });
}

/* ================== Download + Playback ================== */
function addDownloadItem(blob, type) {
  const url = URL.createObjectURL(blob);
  const ext = extFor(type || blob.type || 'audio/webm');
  fbChunkIndex += 1; // index used for filenames + list label
  const filename = `session-${sessionId}_chunk-${fbChunkIndex}.${ext}`;

  const li = document.createElement('li');
  li.insertAdjacentHTML('beforeend', `<code>[${fbChunkIndex}]</code> `);
  const a = document.createElement('a'); 
  a.href = url; 
  a.download = filename;
  a.textContent = `Download ${filename} (${(blob.size/1024).toFixed(0)} KB)`; 
  li.appendChild(a);
  chunkList.appendChild(li);
}

function buildAndShowFull() {
  if (!fullChunks.length) return;
  const type = mimeHint || 'audio/webm';
  const blob = new Blob(fullChunks, { type });
  const url = URL.createObjectURL(blob);
  audioEl.src = url;
  const dt = new Date().toISOString().replace(/[:.]/g, '-');
  dlEl.href = url; dlEl.download = `session-${dt}.${extFor(type)}`; dlEl.style.display = 'inline-block';
}

/* ================== Transcription UI helpers ================== */
function addTranscriptionText(text) {
  if (!text.trim()) return;
  transcriptionBuffer.push(text.trim());
  clearTimeout(transcriptionTimer);
  transcriptionTimer = setTimeout(() => {
    const combined = transcriptionBuffer.join(" ");
    transcriptionBuffer = [];
    renderTranscriptEntry({ text: combined, source: currentSource });
  }, 300);
}

/* ================== Friendly error helpers (graceful degradation) ================== */
function toastUserError(title, tips = []) {
  console.warn(title, tips);
  statusEl.textContent = title;
  // Also log into transcript pane so user sees it later
  renderTranscriptEntry({
    source: currentSource,
    text: `❌ ${title}${tips.length ? '\n' + tips.map(t => `• ${t}`).join('\n') : ''}`
  });
}

function showSoftFailForChunk(index, httpOrMsg) {
  statusEl.textContent = `Transcription unavailable for chunk ${index}. Audio saved.`;
  renderTranscriptEntry({
    source: currentSource,
    text: `⚠️ Transcription temporarily unavailable for chunk ${index}.
You can keep recording, download the audio, or retry later.
Error: ${httpOrMsg}`
  });
}

/* ================== Online/Offline handling ================== */
window.addEventListener('offline', () => {
  isOffline = true;
  statusEl.textContent = 'You are offline. Recording continues; queued transcription will resume when online.';
});
window.addEventListener('online', () => {
  isOffline = false;
  statusEl.textContent = 'Back online. Resuming queued transcriptions…';
  runTxProcessor(); // pick up where we left off
});

/* ================== NEW: FIFO transcription queue (strict order) ================== */
let txQueue = [];         // [{index, blob}]
let txProcessing = false;
let txNextIndex = 1;

function addFullChunk(blob) {
  // Archive every chunk for final stitching (original behavior)
  fullChunks.push(blob);
  // Also enqueue for in-order transcription
  enqueueForTranscription(blob);
}

function enqueueForTranscription(blob) {
  const idx = txNextIndex++;
  // Create a named File for consistent server-side handling & logging
  const named = new File([blob], `session-${sessionId}_chunk-${idx}.webm`, { type: blob.type || 'audio/webm' });
  txQueue.push({ index: idx, blob: named });
  runTxProcessor();
}

async function runTxProcessor() {
  if (txProcessing) return;
  txProcessing = true;
  try {
    while (txQueue.length > 0) {
      const item = txQueue[0]; // process head only
      // Exactly 4 retries (500 → 1000 → 2000 → 4000 ms)
      await transcribeChunkWithRetryFIFO(item);
      // move to next regardless of success/fail after retries
      txQueue.shift();
    }
  } finally {
    txProcessing = false;
  }
}

// Exactly 4 retries per chunk (500 → 1000 → 2000 → 4000ms). Logs retry # and HTTP code.
async function transcribeChunkWithRetryFIFO(item) {
  const RETRIES = 4;     // 4 retries per chunk
  const BASE = 500;      // ms
  const MAX = 4000;      // cap

  // If offline, degrade gracefully: keep audio, inform user, skip to next
  if (isOffline) {
    console.log(`[Chunk ${item.index}] Offline: deferring transcription (soft-fail).`);
    showSoftFailForChunk(item.index, 'offline');
    return false;
  }

  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    const label = attempt === 0 ? `Attempt 1 (initial)` : `Retry ${attempt}/${RETRIES}`;
    try {
      console.log(`[Chunk ${item.index}] ${label} — sending to server…`);

      const formData = new FormData();
      formData.append("file", item.blob, item.blob.name);

      // show ORANGE when sending to Python
      if (typeof setHealthLight === 'function') setHealthLight('orange');

      const resp = await fetch(`${serverUrl}/transcribe_chunk`, { method: "POST", body: formData });
      if (!resp.ok) {
        console.error(`[Chunk ${item.index}] HTTP ${resp.status}`);
        throw new Error(`HTTP_${resp.status}`);
      }

      const result = await resp.json();

      // server OK but LLM failed → keep ORANGE
      if (result && result.status === 'error') {
        if (typeof setHealthLight === 'function') setHealthLight('orange');
        const msg = (result.error || result.details || 'LLM error');
        console.warn(`[Chunk ${item.index}] LLM error: ${msg}`);
        throw new Error('EMPTY_OR_ERROR');
      }

      if (result && result.text && result.text.trim()) {
        addTranscriptionText(result.text);
        // success → GREEN
        if (typeof setHealthLight === 'function') setHealthLight('green');
        console.log(`[Chunk ${item.index}] ✅ Success`);
        return true;
      } else {
        const msg = (result && (result.error || result.details || result.user_message)) || 'Empty transcription';
        console.warn(`[Chunk ${item.index}] Unexpected payload: ${msg}`);
        throw new Error('EMPTY_OR_ERROR');
      }
    } catch (err) {
      if (attempt === RETRIES) {
        console.error(`[Chunk ${item.index}] ❌ Failed after ${RETRIES} retries. Skipping this chunk.`);
        showSoftFailForChunk(item.index, err?.message || 'Unknown error');

        const tips = [];
        if ((err?.message || '').includes('HTTP_401')) tips.push('Check API key on the server.');
        if ((err?.message || '').includes('HTTP_429')) tips.push('Too many requests. Try lowering chunk seconds or wait briefly.');
        if ((err?.message || '').includes('HTTP_413')) tips.push('Chunk too large. Reduce chunk seconds and retry.');
        if (!tips.length) tips.push('You can download audio now and retry later.');
        toastUserError('Transcription temporarily unavailable.', tips);

        // terminal failure → RED
        if (typeof setHealthLight === 'function') setHealthLight('red');

        return false;
      }
      const delay = Math.min(MAX, BASE * Math.pow(2, attempt)); // 500, 1000, 2000, 4000
      console.log(`[Chunk ${item.index}] ${label} failed (${err?.message || err}). Retrying in ${delay}ms…`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  return false;
}

/* ================== Offscreen path (may emit fragments) ================== */
async function startOffscreenFlow() {
  const chunkSecs = Math.max(2, Number(chunkSecsEl.value || 10));
  statusEl.textContent = 'Capturing current active tab… (no picker on non-DRM sites)';
  try {
    await chrome.runtime.sendMessage({ from: 'sidepanel', type: 'START', payload: { chunkSecs } });
    startBtn.disabled = true; 
    stopBtn.disabled = false;
    setupTranscriptionDisplay();
    startTimer();
  } catch {
    startPickerFallback();
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.from !== 'background' || msg.type !== 'FORWARD') return;
  const p = msg.payload;
  if (p?.from !== 'offscreen') return;

  if (p.type === 'STATE') {
    if (p.state === 'RECORDING') {
      currentSource = p.tabTitle || 'Current tab';
      statusEl.textContent = `Recording from: ${currentSource} (no picker)`;
    }
    if (p.state === 'IDLE') {
      buildAndShowFull();
      startBtn.disabled = false; 
      stopBtn.disabled = true;
      stopTimer();
    }
  }

  if (p.type === 'CHUNK') {
    mimeHint = p.mimeType || mimeHint || p.blob?.type || 'audio/webm';
    addFullChunk(p.blob);
  }

  if (p.type === 'SEGMENT') {
    addDownloadItem(p.blob, p.mimeType || p.blob?.type || 'audio/webm');
  }

  if (p.type === 'NEED_PICKER') startPickerFallback();
  if (p.type === 'ERROR') { 
    statusEl.textContent = 'Auto-capture not available; switching to picker…'; 
    startPickerFallback(); 
  }
});

/* ================== Stop helpers ================== */
function stopRecordingOnly() {
  runningFB = false;
  clearTimeout(fbChunkTimer); fbChunkTimer = null;
  try { if (fbCurrentRec && fbCurrentRec.state !== 'inactive') fbCurrentRec.stop(); } catch {}
  fbCurrentRec = null;
}
function stopScreenShare() {
  // IMPORTANT: stop BOTH the display stream (banner) and the audio-only stream
  try { fbDisplayStream?.getTracks().forEach(t => t.stop()); } catch {}
  try { fbAudioStream?.getTracks().forEach(t => t.stop()); } catch {}
  fbDisplayStream = null;
  fbAudioStream   = null;
}
function stopRecordingAndShare() { stopRecordingOnly(); stopScreenShare(); }
async function stopOffscreenIfAny() { try { await chrome.runtime.sendMessage({ from: 'sidepanel', type: 'STOP' }); } catch {} }

/* ================== Picker fallback (standalone WebM per chunk) ================== */
async function startPickerFallback() {
  try {
    statusEl.textContent = 'Site blocks auto-capture. Select the tab and tick "Share tab audio."';
    // Keep FULL display stream so we can stop the banner later
    const ds = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    fbDisplayStream = ds;

    const audioTracks = ds.getAudioTracks();
    if (!audioTracks.length) {
      statusEl.textContent = 'No audio track. Ensure "Share tab audio" is checked and you selected a TAB.';
      try { ds.getTracks().forEach(t => t.stop()); } catch {}
      startBtn.disabled = false; stopBtn.disabled = true; return;
    }

    // Recorder uses audio-only stream, but we keep ds to stop banner
    fbAudioStream = new MediaStream(audioTracks);

    runningFB = true;
    fbChunkIndex = 0;
    mimeHint = 'audio/webm';
    currentSource = 'Shared tab';
    setupTranscriptionDisplay();
    startTimer();

    const pickWebmMime = () => {
      const types = ['audio/webm;codecs=opus', 'audio/webm'];
      for (const t of types) if (MediaRecorder.isTypeSupported?.(t)) return t;
      return ''; // let browser decide (Chrome => webm)
    };
    const mimeType = pickWebmMime();

    const startOneChunk = (secs) => {
      if (!runningFB) return;

      if (fbCurrentRec && fbCurrentRec.state !== 'inactive') {
        try { fbCurrentRec.stop(); } catch {}
      }

      fbCurrentRec = new MediaRecorder(fbAudioStream, mimeType ? { mimeType } : undefined);

      let chunkBlob = null;
      fbCurrentRec.ondataavailable = (e) => { if (e.data && e.data.size) chunkBlob = e.data; };

      fbCurrentRec.onstop = () => {
        if (chunkBlob) {
          addDownloadItem(chunkBlob, chunkBlob.type || 'audio/webm');
          addFullChunk(chunkBlob);
        }
        if (runningFB) setTimeout(() => startOneChunk(secs), 0);
      };

      fbCurrentRec.start(); // no timeslice => full EBML header per blob
      fbChunkTimer = setTimeout(() => {
        if (fbCurrentRec && fbCurrentRec.state !== 'inactive') fbCurrentRec.stop();
      }, Math.max(2, Number(chunkSecsEl.value || secs)) * 1000);
    };

    startOneChunk(Number(chunkSecsEl.value || 10));

    statusEl.textContent = 'Recording (picker fallback, WebM per-chunk)…';
    startBtn.disabled = true; 
    stopBtn.disabled = false;

    // Stop button in fallback: stop recording AND fully end screen share (banner disappears)
    stopBtn.onclick = async () => {
      if (!runningFB && !fbDisplayStream) return;
      stopRecordingAndShare();
      await stopOffscreenIfAny();
      statusEl.textContent = 'Stopped.';
      startBtn.disabled = false; 
      stopBtn.disabled = true;
      buildAndShowFull();
      stopTimer();
    };

  } catch (e) {
    toastUserError(
      'Could not start screen share.',
      [
        'Select a *tab* (not a window) and tick “Share tab audio”.',
        'Some DRM sites block capture; try another tab.'
      ]
    );
    startBtn.disabled = false; 
    stopBtn.disabled = true;
    stopTimer();
  }
}

/* ================== Health Light + Refresh (beside heading) ================== */
let healthLedEl = null;
function setHealthLight(color /* 'green' | 'orange' | 'red' | 'off' */) {
  if (!healthLedEl) return;
  const colors = {
    green:  '#10b981',
    orange: '#fb923c',
    red:    '#ef4444',
    off:    '#e5e7eb'
  };
  healthLedEl.style.background = colors[color] || colors.off;
}

function ensureHealthControls() {
  // Use existing HTML if present; otherwise create minimally
  let refreshBtn = document.getElementById('healthRefresh');
  let dot = document.getElementById('healthDot');

  if (!refreshBtn || !dot) {
    const heading = document.getElementById('appHeading') || document.querySelector('h1');
    const wrap = document.createElement('span');
    wrap.id = 'health-controls';
    wrap.className = 'health-wrap';

    refreshBtn = document.createElement('button');
    refreshBtn.id = 'healthRefresh';
    refreshBtn.className = 'health-btn';
    refreshBtn.textContent = 'Refresh';
    refreshBtn.title = 'Refresh health';

    dot = document.createElement('span');
    dot.id = 'healthDot';
    dot.className = 'health-led';
    dot.title = 'Health status';

    wrap.appendChild(refreshBtn);
    wrap.appendChild(dot);
    heading.appendChild(wrap);
  }

  healthLedEl = dot;
  refreshBtn.onclick = () => runHealthCheck();
}

function makeSilentWav1KB() {
  // 1024B WAV: 44B header + 980B data -> 490 samples (16-bit mono)
  const total = 1024, header = 44, samples = (total - header) >> 1, sr = 16000;
  const buf = new ArrayBuffer(header + samples * 2), v = new DataView(buf);
  // RIFF/WAVE header
  writeStr(v, 0, "RIFF"); v.setUint32(4, 36 + samples*2, true);
  writeStr(v, 8, "WAVE"); writeStr(v,12, "fmt "); v.setUint32(16,16,true);
  v.setUint16(20,1,true); v.setUint16(22,1,true); v.setUint32(24,sr,true);
  v.setUint32(28,sr*2,true); v.setUint16(32,2,true); v.setUint16(34,16,true);
  writeStr(v,36,"data"); v.setUint32(40,samples*2,true);
  return new Blob([buf], { type: 'audio/wav' });
}
function writeStr(v, off, s){ for(let i=0;i<s.length;i++) v.setUint8(off+i, s.charCodeAt(i)); }

async function runHealthCheck() {
  try {
    setHealthLight('orange'); // in-flight to Python
    const fd = new FormData();
    fd.append('file', makeSilentWav1KB(), 'health.wav');
    const r = await fetch(`${serverUrl}/health_ping`, { method: 'POST', body: fd });
    if (!r.ok) { setHealthLight('red'); statusEl.textContent = `Health: server ${r.status}`; return; }
    const j = await r.json();
    if (j.python_ok && j.llm_ok) { setHealthLight('green');  statusEl.textContent = 'Health: OK (Backend Server+ LLM Server)'; }
    else if (j.python_ok && !j.llm_ok) { setHealthLight('orange'); statusEl.textContent = 'Health: Python OK, LLM failed'; }
    else { setHealthLight('red'); statusEl.textContent = 'Health: Python failed'; }
  } catch(e) {
    setHealthLight('red'); statusEl.textContent = `Health: ${e?.message||e}`;
  }
}

/* ================== Main controls ================== */
startBtn.addEventListener('click', async () => { resetUI(); await startOffscreenFlow(); });
stopBtn.addEventListener('click', async () => {
  // Global Stop: cover both paths
  if (runningFB || fbDisplayStream) {
    stopRecordingAndShare();         // <- kills recorder AND the Chrome share banner
    await stopOffscreenIfAny();
    statusEl.textContent = 'Recording & screen share stopped.';
    startBtn.disabled = false; 
    stopBtn.disabled = true;
    buildAndShowFull();
    stopTimer();
  } else {
    await stopOffscreenIfAny();
    stopScreenShare(); // safe no-op if already null
    stopTimer();
  }
});

// Ensure the refresh UI appears on load
ensureHealthControls();
