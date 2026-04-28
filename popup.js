// DriveLoad Popup — clean reliable version

let currentTab = null;
let fileId     = null;
let fileType   = null;
let polling    = null;

const viewNone      = document.getElementById('view-none');
const viewMain      = document.getElementById('view-main');
const fileIcon      = document.getElementById('file-icon');
const fileName      = document.getElementById('file-name');
const fileTypeEl    = document.getElementById('file-type');
const btnDownload   = document.getElementById('btn-download');
const btnLabel      = document.getElementById('btn-label');
const btnPDFCapture = document.getElementById('btn-pdf-capture');
const progressSec   = document.getElementById('progress-section');
const progressFill  = document.getElementById('progress-fill');
const progressLabel = document.getElementById('progress-label');
const successCard   = document.getElementById('success-card');
const successSub    = document.getElementById('success-sub');
const errorCard     = document.getElementById('error-card');
const errorSub      = document.getElementById('error-sub');
const pdfHint       = document.getElementById('pdf-hint');

// ── Button listeners ──────────────────────────────────────────────────────────
document.getElementById('btn-download').addEventListener('click', startDownload);
document.getElementById('btn-pdf-capture').addEventListener('click', startPDFCapture);

// ── Init ──────────────────────────────────────────────────────────────────────
(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) { show(viewNone); return; }
  currentTab = tab;

  fileId   = extractFileId(tab.url || '');
  fileType = detectFileType(tab.url || '');

  if (!fileId || !fileType) { show(viewNone); return; }

  show(viewMain);
  const meta = typeLabel(fileType);
  fileIcon.textContent   = meta.icon;
  fileTypeEl.textContent = meta.label;
  btnLabel.textContent   = meta.btnText;

  if (fileType === 'file') { show(btnPDFCapture); show(pdfHint); }

  fileName.textContent = (tab.title || '')
    .replace(/\s*-\s*Google\s*(Drive|Docs|Sheets|Slides|Forms).*$/i, '').trim() || fileId;
})();

// ── Helpers ───────────────────────────────────────────────────────────────────
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

function typeLabel(type) {
  return ({
    file:  { icon: '📁', label: 'Google Drive File (video / PDF / image)', btnText: '⬇ Download File' },
    doc:   { icon: '📝', label: 'Google Doc — downloads as .docx',         btnText: '⬇ Download as Word (.docx)' },
    sheet: { icon: '📊', label: 'Google Sheet — downloads as .xlsx',       btnText: '⬇ Download as Excel (.xlsx)' },
    slide: { icon: '📽', label: 'Google Slides — downloads as .pptx',     btnText: '⬇ Download as PowerPoint (.pptx)' },
  })[type] || { icon: '📁', label: 'Google Drive File', btnText: '⬇ Download File' };
}

// ── Primary download ──────────────────────────────────────────────────────────
async function startDownload() {
  resetResult();
  setWorking(true);

  if (fileType === 'file') {
    // Try video stream first
    showProgress('Checking for video stream…', 15);
    const vRes = await chrome.runtime.sendMessage({ action: 'downloadVideo', fileId, tabId: currentTab.id });

    if (vRes?.ok) {
      hideProgress();
      showSuccess(`Video download started!\nCheck the browser download bar.`);
      setWorking(false);
      return;
    }

    // Not a video — download as generic file
    showProgress('Resolving download URL…', 40);
  } else {
    showProgress('Resolving download URL…', 40);
  }

  const res = await chrome.runtime.sendMessage({ action: 'downloadFile', fileId, fileType, tabId: currentTab.id });

  hideProgress();

  if (!res?.ok) {
    showError(res?.error || 'Download failed. Make sure you are logged into Google and on a Drive file page.');
    setWorking(false);
    return;
  }

  showSuccess('Download started!\nCheck the browser download bar.');
  setWorking(false);
}

// ── PDF canvas capture ────────────────────────────────────────────────────────
async function startPDFCapture() {
  resetResult();
  setWorking(true);
  showProgress('Injecting PDF capture…', 5);

  const res = await chrome.runtime.sendMessage({ action: 'injectPDF', tabId: currentTab.id });

  if (!res?.ok) {
    hideProgress();
    showError(res?.error || 'Could not inject PDF capture. Make sure the PDF is open in Google Drive viewer.');
    setWorking(false);
    return;
  }

  clearInterval(polling);
  polling = setInterval(async () => {
    const r  = await chrome.runtime.sendMessage({ action: 'pollPDF', tabId: currentTab.id }).catch(() => null);
    const st = r?.status;
    if (!st) return;

    showProgress(st.message || 'Processing…', st.progress || 0);

    if (st.error) {
      clearInterval(polling);
      hideProgress();
      showError(st.error);
      setWorking(false);
    } else if (st.done) {
      clearInterval(polling);
      hideProgress();
      showSuccess('PDF saved! Check your Downloads folder.');
      setWorking(false);
    }
  }, 700);
}

// ── UI helpers ────────────────────────────────────────────────────────────────
function show(el) { el.classList.remove('hidden'); }
function hide(el) { el.classList.add('hidden'); }
function setWorking(on) { btnDownload.disabled = on; btnPDFCapture.disabled = on; }

function showProgress(msg, pct) {
  show(progressSec);
  progressFill.style.width  = Math.min(100, Math.max(0, pct)) + '%';
  progressLabel.textContent = msg;
}
function hideProgress() { hide(progressSec); }

function showSuccess(msg) { hide(errorCard); successSub.textContent = msg; show(successCard); }
function showError(msg)   { hide(successCard); errorSub.textContent = msg; show(errorCard); }
function resetResult()    { hide(successCard); hide(errorCard); hideProgress(); }
