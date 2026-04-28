// DriveLoad Background Service Worker — clean reliable version

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'downloadVideo') { handleVideo(msg.fileId, msg.tabId).then(sendResponse).catch(e => sendResponse({ ok: false, error: e.message })); return true; }
  if (msg.action === 'downloadFile')  { handleFile(msg.fileId, msg.fileType, msg.tabId).then(sendResponse).catch(e => sendResponse({ ok: false, error: e.message })); return true; }
  if (msg.action === 'injectPDF')     { handlePDFCapture(msg.tabId).then(sendResponse).catch(e => sendResponse({ ok: false, error: e.message })); return true; }
  if (msg.action === 'pollPDF')       { pollPDF(msg.tabId).then(sendResponse).catch(e => sendResponse({ ok: false, error: e.message })); return true; }
});

// ── 1. Video ───────────────────────────────────────────────────────────────────
async function handleVideo(fileId, tabId) {
  // Get best-quality streaming URL from the page (needs page cookies)
  const results = await chrome.scripting.executeScript({
    target: { tabId }, world: 'MAIN',
    func: async (fid) => {
      try {
        const r    = await fetch(
          `https://drive.google.com/u/0/get_video_info?docid=${fid}&drive_originator_app=303`,
          { credentials: 'include' }
        );
        const text = await r.text();

        let title = null;
        for (const part of text.split('&')) {
          if (part.startsWith('title=')) { title = decodeURIComponent(part.slice(6)).replace(/\+/g, ' '); break; }
        }

        // Collect all videoplayback URLs keyed by itag
        const urlMap = {};
        for (const part of text.split('&')) {
          if (part.includes('videoplayback')) {
            const url  = decodeURIComponent(part.replace(/\+/g, ' ')).split('|').pop();
            const m    = url.match(/[?&]itag=(\d+)/);
            urlMap[m ? parseInt(m[1]) : 999] = url;
          }
        }

        // Best quality: 37=1080p > 22=720p > 59=480p > 18=360p
        let videoUrl = null;
        for (const itag of [37, 22, 59, 18]) { if (urlMap[itag]) { videoUrl = urlMap[itag]; break; } }
        if (!videoUrl) videoUrl = Object.values(urlMap)[0] || null;

        return { videoUrl, title };
      } catch (e) { return { error: e.message }; }
    },
    args: [fileId]
  });

  const info = results[0]?.result;
  if (!info?.videoUrl) return { ok: false, error: 'No video stream found. Make sure you are logged into Google Drive.' };

  const filename = (info.title || fileId).replace(/[\\/*?:"<>|]/g, '_') + '.mp4';

  return new Promise(resolve => {
    chrome.downloads.download({ url: info.videoUrl, filename }, id => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
      else resolve({ ok: true, filename });
    });
  });
}

// ── 2. Files / Docs / PDFs ────────────────────────────────────────────────────
async function handleFile(fileId, fileType, tabId) {
  let baseUrl, defaultExt;
  if      (fileType === 'doc')   { baseUrl = `https://docs.google.com/document/d/${fileId}/export/docx`;       defaultExt = 'docx'; }
  else if (fileType === 'sheet') { baseUrl = `https://docs.google.com/spreadsheets/d/${fileId}/export/xlsx`;   defaultExt = 'xlsx'; }
  else if (fileType === 'slide') { baseUrl = `https://docs.google.com/presentation/d/${fileId}/export/pptx`;  defaultExt = 'pptx'; }
  else                           { baseUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;       defaultExt = '';     }

  // Resolve the real download URL (handles large-file confirmation page)
  const results = await chrome.scripting.executeScript({
    target: { tabId }, world: 'MAIN',
    func: async (url) => {
      try {
        // redirect:'manual' stops at the 302 so we never hit a cross-origin CORS error
        const r  = await fetch(url, { credentials: 'include', redirect: 'manual' });

        // Opaque redirect → URL is already good, chrome.downloads will follow it with cookies
        if (r.type === 'opaqueredirect' || r.status === 0) return { downloadUrl: url };

        const ct = r.headers.get('content-type') || '';
        if (!ct.includes('text/html')) {
          const cd  = r.headers.get('content-disposition') || '';
          const fnm = cd.match(/filename\*?=(?:UTF-8'')?["']?([^"';\r\n]+)/i);
          return { downloadUrl: url, filename: fnm ? decodeURIComponent(fnm[1].trim().replace(/["']/g, '')) : null };
        }

        // HTML confirmation page (large file) — extract confirm token
        const html   = await r.text();
        const cMatch = html.match(/confirm=([^&"'>\s]+)/);
        const uMatch = html.match(/uuid=([^&"'>\s]+)/);
        if (!cMatch) return { error: 'Download blocked — the file owner may have disabled downloads, or you are not logged into Google.' };

        return { downloadUrl: `${url}&confirm=${cMatch[1]}${uMatch ? '&uuid=' + uMatch[1] : ''}` };
      } catch (e) { return { error: e.message }; }
    },
    args: [baseUrl]
  });

  const info = results[0]?.result;
  if (!info)             return { ok: false, error: 'Could not run script — make sure you are on a Google Drive page.' };
  if (info.error)        return { ok: false, error: info.error };
  if (!info.downloadUrl) return { ok: false, error: 'Could not resolve download URL.' };

  // chrome.downloads uses Chrome's full cookie jar — follows CDN redirect natively
  return new Promise(resolve => {
    const opts = { url: info.downloadUrl, saveAs: false };
    if (info.filename) opts.filename = info.filename.replace(/[\\/*?:"<>|]/g, '_');
    chrome.downloads.download(opts, id => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
      else resolve({ ok: true });
    });
  });
}

// ── 3. PDF canvas capture ─────────────────────────────────────────────────────
async function handlePDFCapture(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', files: ['vendor/jspdf.min.js'] });
  await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: () => { window.__driveload_status = null; } });
  await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', files: ['pdf_capture.js'] });
  return { ok: true };
}

// ── 4. Poll PDF capture progress ──────────────────────────────────────────────
async function pollPDF(tabId) {
  const r = await chrome.scripting.executeScript({
    target: { tabId }, world: 'MAIN',
    func: () => window.__driveload_status || null
  });
  return { status: r[0]?.result || null };
}
