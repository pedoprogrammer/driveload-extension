// DriveLoad Background Service Worker

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'downloadVideo') { handleVideo(msg.fileId, msg.tabId).then(sendResponse).catch(e => sendResponse({ ok: false, error: e.message })); return true; }
  if (msg.action === 'downloadFile')  { handleFile(msg.fileId, msg.fileType, msg.tabId).then(sendResponse).catch(e => sendResponse({ ok: false, error: e.message })); return true; }
  if (msg.action === 'injectPDF')     { handlePDFCapture(msg.tabId).then(sendResponse).catch(e => sendResponse({ ok: false, error: e.message })); return true; }
  if (msg.action === 'pollPDF')       { pollPDF(msg.tabId).then(sendResponse).catch(e => sendResponse({ ok: false, error: e.message })); return true; }
});

// ── 1. Video: get_video_info → signed URL → chrome.downloads ──────────────────
async function handleVideo(fileId, tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world:  'MAIN',
    func: async (fid) => {
      try {
        const r    = await fetch(
          `https://drive.google.com/u/0/get_video_info?docid=${fid}&drive_originator_app=303`,
          { credentials: 'include' }
        );
        const text = await r.text();
        let videoUrl = null, title = null;
        for (const part of text.split('&')) {
          if (!title    && part.startsWith('title='))       title    = decodeURIComponent(part.slice(6)).replace(/\+/g, ' ');
          if (!videoUrl && part.includes('videoplayback'))  videoUrl = decodeURIComponent(part.replace(/\+/g, ' ')).split('|').pop();
          if (videoUrl && title) break;
        }
        return { videoUrl, title };
      } catch (e) { return { error: e.message }; }
    },
    args: [fileId]
  });

  const info = results[0]?.result;
  if (!info?.videoUrl) return { ok: false, error: 'No video stream found. Make sure you are logged into Google.' };

  const filename = (info.title || fileId).replace(/[\\/*?:"<>|]/g, '_') + '.mp4';
  return new Promise(resolve => {
    chrome.downloads.download({ url: info.videoUrl, filename }, id => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
      else resolve({ ok: true, filename });
    });
  });
}

// ── 2. Files / Docs / PDFs ────────────────────────────────────────────────────
// FIXED approach:
//   Step 1 — inject a FAST script that only resolves the real download URL
//             (handles Google's large-file confirmation page).
//             This takes < 2 seconds — service worker is NOT blocked.
//   Step 2 — pass the URL to chrome.downloads.
//             Chrome uses its own cookie jar → no CORS, no blob, no memory issues.
async function handleFile(fileId, fileType, tabId) {
  let baseUrl, defaultExt;
  if      (fileType === 'doc')   { baseUrl = `https://docs.google.com/document/d/${fileId}/export/docx`;       defaultExt = 'docx'; }
  else if (fileType === 'sheet') { baseUrl = `https://docs.google.com/spreadsheets/d/${fileId}/export/xlsx`;   defaultExt = 'xlsx'; }
  else if (fileType === 'slide') { baseUrl = `https://docs.google.com/presentation/d/${fileId}/export/pptx`;  defaultExt = 'pptx'; }
  else                           { baseUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;       defaultExt = '';     }

  // Inject a fast URL-resolver — does NOT download the file itself
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world:  'MAIN',
    func: async (url) => {
      function parseFn(headers) {
        const cd = headers.get('content-disposition') || '';
        const m  = cd.match(/filename\*?=(?:UTF-8'')?["']?([^"';\r\n]+)/i);
        return m ? decodeURIComponent(m[1].trim().replace(/["']/g, '')) : null;
      }
      try {
        const r  = await fetch(url, { credentials: 'include' });
        const ct = r.headers.get('content-type') || '';

        if (!ct.includes('text/html')) {
          // Direct binary — URL is ready
          return { downloadUrl: url, filename: parseFn(r.headers) };
        }

        // Google returned an HTML confirmation page (large file antivirus warning)
        const html   = await r.text();
        const cMatch = html.match(/confirm=([^&"'>\s]+)/);
        const uMatch = html.match(/uuid=([^&"'>\s]+)/);

        if (!cMatch) return { error: 'Download blocked — the file owner may have disabled downloads.' };

        const confirmedUrl = `${url}&confirm=${cMatch[1]}${uMatch ? '&uuid=' + uMatch[1] : ''}`;
        const r2           = await fetch(confirmedUrl, { credentials: 'include' });
        const filename     = parseFn(r2.headers);

        // Return the final URL — chrome.downloads will follow any remaining redirect
        return { downloadUrl: confirmedUrl, filename };
      } catch (e) {
        return { error: e.message };
      }
    },
    args: [baseUrl]
  });

  const info = results[0]?.result;
  if (!info)             return { ok: false, error: 'Script injection failed. Make sure you are on a Google Drive page.' };
  if (info.error)        return { ok: false, error: info.error };
  if (!info.downloadUrl) return { ok: false, error: 'Could not resolve download URL.' };

  // chrome.downloads sends the request with Chrome's own cookies — works for all Google domains
  return new Promise(resolve => {
    const opts = { url: info.downloadUrl, saveAs: false };
    if (info.filename) opts.filename = info.filename.replace(/[\\/*?:"<>|]/g, '_');
    chrome.downloads.download(opts, id => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
      else resolve({ ok: true, filename: info.filename });
    });
  });
}

// ── 3. PDF canvas capture (fallback for locked PDFs) ─────────────────────────
async function handlePDFCapture(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', files: ['vendor/jspdf.min.js'] });
  await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: () => { window.__driveload_status = null; } });
  await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', files: ['pdf_capture.js'] });
  return { ok: true };
}

// ── 4. Poll PDF capture progress ──────────────────────────────────────────────
async function pollPDF(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId }, world: 'MAIN',
    func: () => window.__driveload_status || null
  });
  return { status: results[0]?.result || null };
}
