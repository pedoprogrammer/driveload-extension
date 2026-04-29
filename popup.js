// DriveLoad Popup — Professional UI

// ── State ─────────────────────────────────────────────────────────────────────
let currentTab = null;
let fileId     = null;
let fileType   = null;
let polling    = null;
let lastError  = null; // for retry

// ── DOM refs ──────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const viewEmpty       = $('view-empty');
const viewMain        = $('view-main');
const statusDot       = $('status-dot');
const fileCardIcon    = $('file-card-icon');
const fileCardName    = $('file-card-name');
const fileCardType    = $('file-card-type');
const fileCardBadge   = $('file-card-badge');
const btnDownload     = $('btn-download');
const btnDownloadLabel= $('btn-download-label');
const btnSpinner      = $('btn-spinner');
const btnPdfCapture   = $('btn-pdf-capture');
const progressSection = $('progress-section');
const progressFill    = $('progress-fill');
const progressLabel   = $('progress-label');
const progressPct     = $('progress-pct');
const resultSuccess   = $('result-success');
const resultSuccessSub= $('result-success-sub');
const resultError     = $('result-error');
const resultErrorSub  = $('result-error-sub');
const btnRetry        = $('btn-retry');
const pdfHint         = $('pdf-hint');
const historySection  = $('history-section');
const historyList     = $('history-list');
const btnClearHistory = $('btn-clear-history');

// ── Button listeners ──────────────────────────────────────────────────────────
btnDownload.addEventListener('click', startDownload);
btnPdfCapture.addEventListener('click', startPdfCapture);
btnRetry.addEventListener('click', startDownload);
btnClearHistory.addEventListener('click', clearHistory);

// ── Init ──────────────────────────────────────────────────────────────────────
(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) { show(viewEmpty); return; }
  currentTab = tab;

  fileId   = extractFileId(tab.url || '');
  fileType = detectFileType(tab.url || '');

  checkLoginStatus();
  loadHistory();

  if (!fileId || !fileType) { show(viewEmpty); return; }

  // Populate file card
  show(viewMain);
  const meta = fileMeta(fileType, tab.url || '');
  fileCardIcon.textContent  = meta.icon;
  fileCardType.textContent  = meta.typeLabel;
  fileCardBadge.textContent = meta.badge;
  btnDownloadLabel.textContent = meta.btnText;
  fileCardName.textContent  = (tab.title || '')
    .replace(/\s*-\s*Google\s*(Drive|Docs|Sheets|Slides|Forms).*$/i, '').trim() || fileId;

  if (fileType === 'file') { show(btnPdfCapture); show(pdfHint); }
})();

// ── File detection helpers ────────────────────────────────────────────────────
function extractFileId(url) {
  const m = url.match(/\/(?:file|document|spreadsheets|presentation|forms)\/d\/([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  try { return new URL(url).searchParams.get('id') || null; } catch { return null; }
}

function detectFileType(url) {
  if (!url.includes('google.com')) return null;
  if (url.includes('/document/d/'))     return 'doc';
  if (url.includes('/spreadsheets/d/')) return 'sheet';
  if (url.includes('/presentation/d/')) return 'slide';
  if (url.includes('/file/d/'))         return 'file';
  return null;
}

function fileMeta(type, url) {
  const isVideo = url.includes('.mp4') || url.includes('.mov') || url.includes('.webm');
  const map = {
    file:  { icon: isVideo ? '🎬' : '📁', typeLabel: 'Google Drive File',        badge: 'FILE',   btnText: 'Download File' },
    doc:   { icon: '📝',                   typeLabel: 'Google Doc → .docx',        badge: 'DOC',    btnText: 'Download as Word (.docx)' },
    sheet: { icon: '📊',                   typeLabel: 'Google Sheet → .xlsx',      badge: 'SHEET',  btnText: 'Download as Excel (.xlsx)' },
    slide: { icon: '📽',                   typeLabel: 'Google Slides → .pptx',    badge: 'SLIDES', btnText: 'Download as PowerPoint (.pptx)' },
  };
  return map[type] || map['file'];
}

// ── Google login status indicator ─────────────────────────────────────────────
async function checkLoginStatus() {
  try {
    const cookies = await chrome.cookies.getAll({ domain: '.google.com' });
    const loggedIn = cookies.some(c => c.name === 'SID' || c.name === 'SAPISID' || c.name === '__Secure-1PSID');
    statusDot.className = 'status-dot ' + (loggedIn ? 'online' : 'offline');
    statusDot.title = loggedIn ? 'Logged into Google ✓' : 'Not logged into Google';
  } catch {
    statusDot.className = 'status-dot';
  }
}

// ── Primary download ──────────────────────────────────────────────────────────
async function startDownload() {
  resetResult();
  setWorking(true);
  lastError = null;

  // For Drive files: check video first
  if (fileType === 'file') {
    setProgress('Checking for video stream…', 10);
    const vRes = await chrome.runtime.sendMessage({ action: 'downloadVideo', fileId, tabId: currentTab.id });
    if (vRes?.ok) {
      onSuccess(vRes.filename || null, 'Check the browser download bar.');
      return;
    }
  }

  // File / Doc / Sheet / Slide — parallel SW download with live progress
  setProgress('Connecting…', 5);
  startProgressPolling();

  chrome.runtime.sendMessage({ action: 'downloadFile', fileId, fileType, tabId: currentTab.id }, (res) => {
    clearInterval(polling);
    if (chrome.runtime.lastError || !res?.ok) {
      const msg = res?.error || 'Download failed. Make sure you are logged into Google.';
      onError(msg);
    } else {
      onSuccess(res.filename || null);
    }
  });
}

// ── PDF canvas capture ────────────────────────────────────────────────────────
async function startPdfCapture() {
  resetResult();
  setWorking(true);
  setProgress('Injecting PDF capture…', 5);

  const res = await chrome.runtime.sendMessage({ action: 'injectPDF', tabId: currentTab.id });
  if (!res?.ok) {
    onError(res?.error || 'Could not inject PDF capture. Make sure the PDF is open in the Google Drive viewer.');
    return;
  }

  clearInterval(polling);
  polling = setInterval(async () => {
    const r  = await chrome.runtime.sendMessage({ action: 'pollPDF', tabId: currentTab.id }).catch(() => null);
    const st = r?.status;
    if (!st) return;
    setProgress(st.message || 'Processing…', st.progress || 0);
    if (st.error)    { clearInterval(polling); onError(st.error); }
    else if (st.done){ clearInterval(polling); onSuccess(st.filename || null, 'PDF saved — check your Downloads folder.'); }
  }, 700);
}

// ── Progress polling ──────────────────────────────────────────────────────────
function startProgressPolling() {
  clearInterval(polling);
  polling = setInterval(async () => {
    const r  = await chrome.runtime.sendMessage({ action: 'pollDownload', tabId: currentTab.id }).catch(() => null);
    const st = r?.status;
    if (!st || !st.message) return;
    setProgress(st.message, st.progress || 0);
  }, 500);
}

// ── Result handlers ───────────────────────────────────────────────────────────
function onSuccess(filename, customMsg) {
  setWorking(false);
  hideProgress();
  const name = filename || fileCardName.textContent || 'file';
  resultSuccessSub.textContent = customMsg || `Saved: ${name}`;
  show(resultSuccess);
  saveToHistory({ filename: name, status: 'success' });
  sendNotification('Download complete', name);
}

function onError(msg) {
  setWorking(false);
  hideProgress();
  lastError = msg;
  resultErrorSub.textContent = msg;
  show(resultError);
  saveToHistory({ filename: fileCardName.textContent || fileId, status: 'error' });
}

// ── Notifications ─────────────────────────────────────────────────────────────
function sendNotification(title, message) {
  try {
    chrome.notifications.create(`dl_${Date.now()}`, {
      type:     'basic',
      iconUrl:  'icons/icon128.png',
      title,
      message:  message || '',
      silent:   false,
    });
  } catch (_) {}
}

// ── History ───────────────────────────────────────────────────────────────────
async function saveToHistory(entry) {
  try {
    const { dlHistory = [] } = await chrome.storage.local.get('dlHistory');
    dlHistory.unshift({ ...entry, id: Date.now(), ts: Date.now() });
    if (dlHistory.length > 10) dlHistory.length = 10;
    await chrome.storage.local.set({ dlHistory });
    renderHistory(dlHistory);
  } catch (_) {}
}

async function loadHistory() {
  try {
    const { dlHistory = [] } = await chrome.storage.local.get('dlHistory');
    renderHistory(dlHistory);
  } catch (_) {}
}

async function clearHistory() {
  await chrome.storage.local.set({ dlHistory: [] }).catch(() => {});
  renderHistory([]);
}

function renderHistory(items) {
  if (!items || items.length === 0) { hide(historySection); return; }
  show(historySection);
  historyList.innerHTML = '';
  items.slice(0, 7).forEach(item => {
    const el = document.createElement('div');
    el.className = 'history-item';
    el.innerHTML = `
      <span class="history-icon">${item.status === 'success' ? '✓' : '✕'}</span>
      <div class="history-body">
        <div class="history-name">${escapeHtml(item.filename || 'Unknown file')}</div>
        <div class="history-time">${timeAgo(item.ts)}</div>
      </div>
      <div class="history-status ${item.status === 'success' ? 'status-ok' : 'status-err'}"></div>
    `;
    historyList.appendChild(el);
  });
}

function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60)     return 'Just now';
  if (s < 3600)   return `${Math.floor(s / 60)} min ago`;
  if (s < 86400)  return `${Math.floor(s / 3600)} hr ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function escapeHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── UI state helpers ──────────────────────────────────────────────────────────
function show(el) { el.classList.remove('hidden'); }
function hide(el) { el.classList.add('hidden'); }

function setWorking(on) {
  btnDownload.disabled     = on;
  btnPdfCapture.disabled   = on;
  btnSpinner.classList.toggle('hidden', !on);
  btnDownload.classList.toggle('is-loading', on);
}

function setProgress(msg, pct) {
  show(progressSection);
  progressFill.style.width  = Math.min(100, Math.max(0, pct)) + '%';
  progressLabel.textContent = msg;
  progressPct.textContent   = Math.round(pct) + '%';
}

function hideProgress() { hide(progressSection); }

function resetResult() {
  hide(resultSuccess);
  hide(resultError);
  hideProgress();
}
