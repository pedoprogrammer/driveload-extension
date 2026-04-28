// DriveLoad Popup

let currentTab  = null;
let fileId      = null;
let fileType    = null; // 'video'|'pdf'|'doc'|'sheet'|'slide'|'file'
let polling     = null;

const viewNone       = document.getElementById('view-none');
const viewMain       = document.getElementById('view-main');
const filePill       = document.getElementById('file-pill');
const fileIcon       = document.getElementById('file-icon');
const fileName       = document.getElementById('file-name');
const fileTypeEl     = document.getElementById('file-type');
const btnDownload    = document.getElementById('btn-download');
const btnLabel       = document.getElementById('btn-label');
const btnPDFCapture  = document.getElementById('btn-pdf-capture');
const progressSec    = document.getElementById('progress-section');
const progressFill   = document.getElementById('progress-fill');
const progressLabel  = document.getElementById('progress-label');
const successCard    = document.getElementById('success-card');
const successSub     = document.getElementById('success-sub');
const errorCard      = document.getElementById('error-card');
const errorSub       = document.getElementById('error-sub');
const pdfHint        = document.getElementById('pdf-hint');

// ── Init ──────────────────────────────────────────────────────────────────────
(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) { show(viewNone); return; }
  currentTab = tab;
  const url  = tab.url || '';

  fileId   = extractFileId(url);
  fileType = detectFileType(url);

  if (!fileId || !fileType) { show(viewNone); return; }

  // Populate UI
  show(viewMain);
  const meta = typeLabel(fileType);
  fileIcon.textContent = meta.icon;
  fileTypeEl.textContent = meta.label;
  btnLabel.textContent   = meta.btnText;

  // Show PDF viewer fallback button for Drive files (might be PDF)
  if (fileType === 'pdf' || fileType === 'file') {
    show(btnPDFCapture);
    show(pdfHint);
  }

  // Try to get file name from tab title
  const rawTitle = (tab.title || '')
    .replace(/\s*-\s*Google\s*(Drive|Docs|Sheets|Slides|Forms).*$/i, '')
    .trim();
  fileName.textContent = rawTitle || fileId;
})();

// ── Detect file ID from URL ───────────────────────────────────────────────────
function extractFileId(url) {
  const m = url.match(/\/(?:file|document|spreadsheets|presentation|forms)\/d\/([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  const qs = new URL(url).searchParams;
  return qs.get('id') || null;
}

// ── Detect file type from URL ─────────────────────────────────────────────────
function detectFileType(url) {
  if (!url.includes('google.com')) return null;
  if (url.includes('/document/d/'))     return 'doc';
  if (url.includes('/spreadsheets/d/')) return 'sheet';
  if (url.includes('/presentation/d/')) return 'slide';
  if (url.includes('/file/d/'))         return 'file'; // video or PDF — we'll try video first
  return null;
}

function typeLabel(type) {
  const map = {
    file:  { icon: '📁', label: 'Google Drive File (video / PDF / image)',     btnText: '⬇ Download File' },
    doc:   { icon: '📝', label: 'Google Doc — will download as .docx',         btnText: '⬇ Download as Word (.docx)' },
    sheet: { icon: '📊', label: 'Google Sheet — will download as .xlsx',       btnText: '⬇ Download as Excel (.xlsx)' },
    slide: { icon: '📽', label: 'Google Slides — will download as .pptx',      btnText: '⬇ Download as PowerPoint (.pptx)' },
    pdf:   { icon: '📄', label: 'PDF file',                                    btnText: '⬇ Download PDF' },
    video: { icon: '🎬', label: 'Video file',                                  btnText: '⬇ Download Video' },
  };
  return map[type] || map['file'];
}

// ── Primary download (authenticated, original quality) ────────────────────────
async function startDownload() {
  resetResult();
  setWorking(true);
  showProgress('Connecting to Google Drive…', 5);

  let response;

  if (fileType === 'file') {
    // Try video first
    response = await chrome.runtime.sendMessage({
      action: 'downloadVideo', fileId, tabId: currentTab.id
    });

    // If video stream found → done
    if (response?.ok) {
      hideProgress();
      showSuccess(`Video download started! Check your Downloads folder.`);
      setWorking(false);
      return;
    }

    // Video failed → treat as generic file download
    response = await chrome.runtime.sendMessage({
      action: 'downloadFile', fileId, fileType, tabId: currentTab.id
    });
  } else {
    response = await chrome.runtime.sendMessage({
      action: 'downloadFile', fileId, fileType, tabId: currentTab.id
    });
  }

  if (!response?.ok) {
    hideProgress();
    showError(response?.error || 'Could not start download.');
    setWorking(false);
    return;
  }

  // Poll for in-page download progress
  startPolling('file');
}

// ── PDF viewer capture (fallback for download-disabled files) ─────────────────
async function startPDFCapture() {
  resetResult();
  setWorking(true);
  showProgress('Injecting PDF viewer…', 3);

  const response = await chrome.runtime.sendMessage({
    action: 'injectPDF', tabId: currentTab.id
  });

  if (!response?.ok) {
    hideProgress();
    showError(response?.error || 'Could not inject PDF capture.');
    setWorking(false);
    return;
  }

  startPolling('pdf');
}

// ── Polling ───────────────────────────────────────────────────────────────────
function startPolling(mode) {
  clearInterval(polling);
  polling = setInterval(async () => {
    const result = await chrome.runtime.sendMessage({
      action: 'pollStatus', tabId: currentTab.id
    }).catch(() => null);

    if (!result) return;

    const st = mode === 'pdf' ? result.pdf : result.file;
    if (!st) return;

    if (st.error) {
      clearInterval(polling);
      hideProgress();
      showError(st.error);
      setWorking(false);
      return;
    }

    if (st.message) showProgress(st.message, st.progress || 0);

    if (st.done) {
      clearInterval(polling);
      hideProgress();
      showSuccess(st.filename ? `Saved: ${st.filename}` : 'Download complete! Check your Downloads folder.');
      setWorking(false);
    }
  }, 600);
}

// ── UI helpers ────────────────────────────────────────────────────────────────
function show(el)    { el.classList.remove('hidden'); }
function hide(el)    { el.classList.add('hidden'); }
function setWorking(on) {
  btnDownload.disabled   = on;
  btnPDFCapture.disabled = on;
}

function showProgress(msg, pct) {
  show(progressSec);
  progressFill.style.width = Math.min(100, Math.max(0, pct)) + '%';
  progressLabel.textContent = msg;
}
function hideProgress() { hide(progressSec); }

function showSuccess(msg) {
  hide(errorCard);
  successSub.textContent = msg;
  show(successCard);
}
function showError(msg) {
  hide(successCard);
  errorSub.textContent = msg;
  show(errorCard);
}
function resetResult() {
  hide(successCard);
  hide(errorCard);
  hideProgress();
}
