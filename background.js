// DriveLoad Background Service Worker

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'downloadVideo')   { handleVideo(msg.fileId, msg.tabId).then(sendResponse).catch(e => sendResponse({ ok: false, error: e.message })); return true; }
  if (msg.action === 'downloadFile')    { handleFile(msg.fileId, msg.fileType, msg.tabId).then(sendResponse).catch(e => sendResponse({ ok: false, error: e.message })); return true; }
  if (msg.action === 'systemDownload')  { systemDownload(msg.url, msg.filename).then(sendResponse).catch(e => sendResponse({ ok: false, error: e.message })); return true; }
  if (msg.action === 'injectPDF')       { handlePDFCapture(msg.tabId).then(sendResponse).catch(e => sendResponse({ ok: false, error: e.message })); return true; }
  if (msg.action === 'pollPDF')         { pollPDF(msg.tabId).then(sendResponse).catch(e => sendResponse({ ok: false, error: e.message })); return true; }
  if (msg.action === 'pollDownload')    { pollDownload(msg.tabId).then(sendResponse).catch(e => sendResponse({ ok: false, error: e.message })); return true; }
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
        let title = null;
        for (const part of text.split('&')) {
          if (part.startsWith('title=')) { title = decodeURIComponent(part.slice(6)).replace(/\+/g, ' '); break; }
        }
        const urlMap = {};
        for (const part of text.split('&')) {
          if (part.includes('videoplayback')) {
            const url  = decodeURIComponent(part.replace(/\+/g, ' ')).split('|').pop();
            const m    = url.match(/[?&]itag=(\d+)/);
            urlMap[m ? parseInt(m[1]) : 999] = url;
          }
        }
        let videoUrl = null;
        for (const itag of [37, 22, 59, 18]) { if (urlMap[itag]) { videoUrl = urlMap[itag]; break; } }
        if (!videoUrl) videoUrl = Object.values(urlMap)[0] || null;
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
// Step 1 — fast URL resolver (gets confirmation token, avoids CORS on redirect)
// Step 2 — inject 8-thread parallel downloader into the page (fire-and-forget)
//           drive.usercontent.google.com supports CORS for Google's own origins.
//           If parallel fails → sets __dl_status.error = '__USE_SYSTEM_DL__'
//           popup picks this up and calls systemDownload via chrome.downloads.
async function handleFile(fileId, fileType, tabId) {
  let baseUrl, defaultExt;
  if      (fileType === 'doc')   { baseUrl = `https://docs.google.com/document/d/${fileId}/export/docx`;       defaultExt = 'docx'; }
  else if (fileType === 'sheet') { baseUrl = `https://docs.google.com/spreadsheets/d/${fileId}/export/xlsx`;   defaultExt = 'xlsx'; }
  else if (fileType === 'slide') { baseUrl = `https://docs.google.com/presentation/d/${fileId}/export/pptx`;  defaultExt = 'pptx'; }
  else                           { baseUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;       defaultExt = '';     }

  // Step 1: resolve confirmed URL
  const urlResult = await chrome.scripting.executeScript({
    target: { tabId }, world: 'MAIN',
    func: async (url) => {
      try {
        const r  = await fetch(url, { credentials: 'include', redirect: 'manual' });
        if (r.type === 'opaqueredirect' || r.status === 0) return { downloadUrl: url };
        const ct = r.headers.get('content-type') || '';
        if (!ct.includes('text/html')) {
          const cd  = r.headers.get('content-disposition') || '';
          const fnm = cd.match(/filename\*?=(?:UTF-8'')?["']?([^"';\r\n]+)/i);
          return { downloadUrl: url, filename: fnm ? decodeURIComponent(fnm[1].trim().replace(/["']/g, '')) : null };
        }
        const html   = await r.text();
        const cMatch = html.match(/confirm=([^&"'>\s]+)/);
        const uMatch = html.match(/uuid=([^&"'>\s]+)/);
        if (!cMatch) return { error: 'Download blocked — the file owner may have disabled downloads.' };
        return { downloadUrl: `${url}&confirm=${cMatch[1]}${uMatch ? '&uuid=' + uMatch[1] : ''}` };
      } catch (e) { return { error: e.message }; }
    },
    args: [baseUrl]
  });

  const urlInfo = urlResult[0]?.result;
  if (!urlInfo)            return { ok: false, error: 'Could not run script. Make sure you are on a Google Drive page.' };
  if (urlInfo.error)       return { ok: false, error: urlInfo.error };
  if (!urlInfo.downloadUrl) return { ok: false, error: 'Could not resolve download URL.' };

  const confirmedUrl = urlInfo.downloadUrl;
  const filename     = (urlInfo.filename || fileId + (defaultExt ? '.' + defaultExt : '')).replace(/[\\/*?:"<>|]/g, '_');

  // Step 2: inject parallel downloader — fires and returns immediately
  await chrome.scripting.executeScript({
    target: { tabId }, world: 'MAIN',
    func: (dlUrl, fname) => {
      window.__dl_status = { running: true, progress: 0, message: 'Connecting…', error: null, done: false };
      const setS = (msg, pct) => { window.__dl_status.message = msg; window.__dl_status.progress = Math.round(pct); };

      // IIFE is NOT awaited — returns immediately so executeScript doesn't block
      void (async () => {
        try {
          setS('Getting download URL…', 3);

          // Follow redirect to get final CDN URL + content-length
          // drive.usercontent.google.com allows CORS from Google's own origins
          let cdnUrl = dlUrl, size = 0;
          try {
            const h = await fetch(dlUrl, { credentials: 'include', redirect: 'follow', method: 'HEAD' });
            cdnUrl = h.url && h.url !== dlUrl ? h.url : dlUrl;
            size   = parseInt(h.headers.get('content-length') || '0');
          } catch (_) {
            // CORS blocked on redirect — fall back to chrome.downloads
            window.__dl_status.error = '__USE_SYSTEM_DL__';
            return;
          }

          if (!size) {
            // No content-length — can't do chunked; fall back
            window.__dl_status.error = '__USE_SYSTEM_DL__';
            return;
          }

          // 8-thread parallel chunk download (same as DriveLoad server)
          const THREADS   = 8;
          const chunkSize = Math.ceil(size / THREADS);
          setS('Downloading… 0%', 5);

          const chunks = new Array(THREADS);
          let received  = 0;

          await Promise.all(Array.from({ length: THREADS }, async (_, i) => {
            const start = i * chunkSize;
            const end   = Math.min(start + chunkSize - 1, size - 1);
            const r     = await fetch(cdnUrl, {
              credentials: 'include',
              headers: { Range: `bytes=${start}-${end}` }
            });
            if (!r.ok && r.status !== 206) throw new Error('Range request failed: ' + r.status);
            const buf   = await r.arrayBuffer();
            chunks[i]   = buf;
            received   += buf.byteLength;
            setS(`Downloading… ${Math.round(received / size * 100)}%`, 5 + (received / size * 90));
          }));

          setS('Saving…', 97);
          const blob = new Blob(chunks);
          const burl = URL.createObjectURL(blob);
          const a    = Object.assign(document.createElement('a'), { href: burl, download: fname });
          document.body.appendChild(a); a.click(); document.body.removeChild(a);
          setTimeout(() => URL.revokeObjectURL(burl), 120_000);

          window.__dl_status = { done: true, progress: 100, message: `Saved: ${fname}`, filename: fname };
        } catch (e) {
          // Any fetch failure → fall back to chrome.downloads
          window.__dl_status.error = '__USE_SYSTEM_DL__';
        }
      })();
    },
    args: [confirmedUrl, filename]
  });

  return { ok: true, confirmedUrl, filename };
}

// ── 3. chrome.downloads fallback (when parallel CORS fails) ───────────────────
async function systemDownload(url, filename) {
  return new Promise(resolve => {
    const opts = { url, saveAs: false };
    if (filename) opts.filename = filename;
    chrome.downloads.download(opts, id => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
      else resolve({ ok: true });
    });
  });
}

// ── 4. PDF canvas capture ─────────────────────────────────────────────────────
async function handlePDFCapture(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', files: ['vendor/jspdf.min.js'] });
  await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: () => { window.__driveload_status = null; } });
  await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', files: ['pdf_capture.js'] });
  return { ok: true };
}

// ── 5. Poll file download progress ────────────────────────────────────────────
async function pollDownload(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId }, world: 'MAIN',
    func: () => window.__dl_status || null
  });
  return { status: results[0]?.result || null };
}

// ── 6. Poll PDF capture progress ──────────────────────────────────────────────
async function pollPDF(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId }, world: 'MAIN',
    func: () => window.__driveload_status || null
  });
  return { status: results[0]?.result || null };
}
