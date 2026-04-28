// DriveLoad Background Service Worker

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'downloadVideo') { handleVideo(msg.fileId, msg.tabId).then(sendResponse).catch(e => sendResponse({ ok: false, error: e.message })); return true; }
  if (msg.action === 'downloadFile')  { handleFile(msg.fileId, msg.fileType, msg.tabId).then(sendResponse).catch(e => sendResponse({ ok: false, error: e.message })); return true; }
  if (msg.action === 'injectPDF')     { handlePDFCapture(msg.tabId).then(sendResponse).catch(e => sendResponse({ ok: false, error: e.message })); return true; }
  if (msg.action === 'pollPDF')       { pollPDF(msg.tabId).then(sendResponse).catch(e => sendResponse({ ok: false, error: e.message })); return true; }
});

// ── 1. Video ───────────────────────────────────────────────────────────────────
async function handleVideo(fileId, tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId }, world: 'MAIN',
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
  if (!info?.videoUrl) return { ok: false, error: 'No video stream found.' };

  const filename = (info.title || fileId).replace(/[\\/*?:"<>|]/g, '_') + '.mp4';
  return new Promise(resolve => {
    chrome.downloads.download({ url: info.videoUrl, filename }, id => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
      else resolve({ ok: true, filename });
    });
  });
}

// ── 2. Files / PDFs / Docs ────────────────────────────────────────────────────
// Key fix: use redirect:'manual' so the injected fetch never hits a cross-origin
// redirect. If Google redirects to drive.usercontent.google.com we return the
// original URL and let chrome.downloads follow it — it uses Chrome's own cookie
// jar with no CORS restrictions.
async function handleFile(fileId, fileType, tabId) {
  let baseUrl, defaultExt;
  if      (fileType === 'doc')   { baseUrl = `https://docs.google.com/document/d/${fileId}/export/docx`;       defaultExt = 'docx'; }
  else if (fileType === 'sheet') { baseUrl = `https://docs.google.com/spreadsheets/d/${fileId}/export/xlsx`;   defaultExt = 'xlsx'; }
  else if (fileType === 'slide') { baseUrl = `https://docs.google.com/presentation/d/${fileId}/export/pptx`;  defaultExt = 'pptx'; }
  else                           { baseUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;       defaultExt = '';     }

  const results = await chrome.scripting.executeScript({
    target: { tabId }, world: 'MAIN',
    func: async (url) => {
      try {
        // redirect:'manual' → we never follow a cross-origin redirect ourselves,
        // so we never hit a CORS error on drive.usercontent.google.com
        const r  = await fetch(url, { credentials: 'include', redirect: 'manual' });

        // opaqueredirect means Google sent a 302/301/307 to the CDN.
        // Return the original URL — chrome.downloads will follow the redirect
        // with Chrome's cookies (no CORS restriction on chrome.downloads).
        if (r.type === 'opaqueredirect' || r.status === 0) {
          return { downloadUrl: url };
        }

        const ct = r.headers.get('content-type') || '';

        // Direct binary (unlikely without redirect, but handle it)
        if (!ct.includes('text/html')) {
          const cd  = r.headers.get('content-disposition') || '';
          const fnm = cd.match(/filename\*?=(?:UTF-8'')?["']?([^"';\r\n]+)/i);
          return { downloadUrl: url, filename: fnm ? decodeURIComponent(fnm[1].trim().replace(/["']/g, '')) : null };
        }

        // Google returned an HTML confirmation page (large-file antivirus warning)
        const html   = await r.text();
        const cMatch = html.match(/confirm=([^&"'>\s]+)/);
        const uMatch = html.match(/uuid=([^&"'>\s]+)/);

        if (!cMatch) {
          return { error: 'Download blocked. The file owner may have disabled downloads, or you are not logged into Google.' };
        }

        const confirmedUrl = `${url}&confirm=${cMatch[1]}${uMatch ? '&uuid=' + uMatch[1] : ''}`;
        return { downloadUrl: confirmedUrl };
      } catch (e) {
        return { error: e.message };
      }
    },
    args: [baseUrl]
  });

  const info = results[0]?.result;
  if (!info)             return { ok: false, error: 'Could not run script. Make sure you are on a Google Drive page.' };
  if (info.error)        return { ok: false, error: info.error };
  if (!info.downloadUrl) return { ok: false, error: 'Could not resolve download URL.' };

  // chrome.downloads uses Chrome's cookie jar — handles the CDN redirect with cookies
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

// ── 4. Poll PDF progress ──────────────────────────────────────────────────────
async function pollPDF(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId }, world: 'MAIN',
    func: () => window.__driveload_status || null
  });
  return { status: results[0]?.result || null };
}
