// DriveLoad Background Service Worker

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'downloadVideo') { handleVideo(msg.fileId, msg.tabId).then(sendResponse).catch(e => sendResponse({ ok: false, error: e.message })); return true; }
  if (msg.action === 'downloadFile')  { handleFile(msg.fileId, msg.fileType, msg.tabId).then(sendResponse).catch(e => sendResponse({ ok: false, error: e.message })); return true; }
  if (msg.action === 'injectPDF')     { handlePDFCapture(msg.tabId).then(sendResponse).catch(e => sendResponse({ ok: false, error: e.message })); return true; }
  if (msg.action === 'pollPDF')       { pollPDF(msg.tabId).then(sendResponse).catch(e => sendResponse({ ok: false, error: e.message })); return true; }
  if (msg.action === 'pollDownload')  { pollDownload(msg.tabId).then(sendResponse).catch(e => sendResponse({ ok: false, error: e.message })); return true; }
});

// ── 1. Video — best quality + 6-thread parallel download ─────────────────────
// Video URLs from get_video_info (googlevideo.com) support range requests and
// have auth embedded in the URL — no cookies needed, no CORS issues.
async function handleVideo(fileId, tabId) {
  // Step 1: resolve best quality URL from get_video_info
  const results = await chrome.scripting.executeScript({
    target: { tabId }, world: 'MAIN',
    func: async (fid) => {
      try {
        const r    = await fetch(
          `https://drive.google.com/u/0/get_video_info?docid=${fid}&drive_originator_app=303`,
          { credentials: 'include' }
        );
        const text = await r.text();

        // Extract title
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
            const itag = m ? parseInt(m[1]) : 999;
            urlMap[itag] = url;
          }
        }

        // Pick highest quality: 37=1080p > 22=720p > 59=480p > 18=360p > any
        let videoUrl = null;
        for (const itag of [37, 22, 59, 18]) {
          if (urlMap[itag]) { videoUrl = urlMap[itag]; break; }
        }
        if (!videoUrl) videoUrl = Object.values(urlMap)[0] || null;

        return { videoUrl, title };
      } catch (e) { return { error: e.message }; }
    },
    args: [fileId]
  });

  const info = results[0]?.result;
  if (!info?.videoUrl) return { ok: false, error: 'No video stream found. Make sure you are logged into Google.' };

  const filename = (info.title || fileId).replace(/[\\/*?:"<>|]/g, '_') + '.mp4';

  // Step 2: inject 6-thread parallel downloader into the page
  // googlevideo.com has CORS open (needed for embedded players), range requests supported.
  await chrome.scripting.executeScript({
    target: { tabId }, world: 'MAIN',
    func: (videoUrl, filename) => {
      window.__dl_status = { running: true, progress: 0, message: 'Starting…', error: null, done: false };
      const setS = (msg, pct) => { window.__dl_status.message = msg; window.__dl_status.progress = Math.round(pct); };

      void (async () => {
        try {
          setS('Checking file size…', 1);

          // HEAD to get size (no credentials — auth is in URL params)
          let size = 0;
          try {
            const h = await fetch(videoUrl, { method: 'HEAD', credentials: 'omit' });
            size = parseInt(h.headers.get('content-length') || '0');
          } catch (_) { size = 0; }

          if (!size) {
            // No size info — single connection fallback
            setS('Downloading…', 5);
            const r    = await fetch(videoUrl, { credentials: 'omit' });
            const blob = await r.blob();
            setS('Saving…', 98);
            const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: filename });
            document.body.appendChild(a); a.click(); document.body.removeChild(a);
            window.__dl_status = { done: true, progress: 100, message: `Saved: ${filename}` };
            return;
          }

          // 6-thread parallel chunk download (mirrors DriveLoad server logic)
          const THREADS   = 6;
          const chunkSize = Math.ceil(size / THREADS);
          setS(`Downloading with ${THREADS} parallel connections…`, 2);

          const chunks   = new Array(THREADS);
          let received   = 0;

          await Promise.all(Array.from({ length: THREADS }, async (_, i) => {
            const start = i * chunkSize;
            const end   = Math.min(start + chunkSize - 1, size - 1);
            const r     = await fetch(videoUrl, {
              credentials: 'omit',
              headers: { Range: `bytes=${start}-${end}` }
            });
            const buf   = await r.arrayBuffer();
            chunks[i]   = buf;
            received   += buf.byteLength;
            setS(`Downloading… ${Math.round(received / size * 100)}%`, received / size * 95);
          }));

          setS('Saving file…', 97);
          const blob = new Blob(chunks, { type: 'video/mp4' });
          const burl = URL.createObjectURL(blob);
          const a    = Object.assign(document.createElement('a'), { href: burl, download: filename });
          document.body.appendChild(a); a.click(); document.body.removeChild(a);
          setTimeout(() => URL.revokeObjectURL(burl), 120_000);

          window.__dl_status = { done: true, progress: 100, message: `Saved: ${filename}`, filename };
        } catch (e) {
          window.__dl_status = { done: false, running: false, error: e.message };
        }
      })();
    },
    args: [info.videoUrl, filename]
  });

  return { ok: true, mode: 'download', filename };
}

// ── 2. Files / Docs / PDFs ────────────────────────────────────────────────────
async function handleFile(fileId, fileType, tabId) {
  let baseUrl;
  if      (fileType === 'doc')   baseUrl = `https://docs.google.com/document/d/${fileId}/export/docx`;
  else if (fileType === 'sheet') baseUrl = `https://docs.google.com/spreadsheets/d/${fileId}/export/xlsx`;
  else if (fileType === 'slide') baseUrl = `https://docs.google.com/presentation/d/${fileId}/export/pptx`;
  else                           baseUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;

  // Fast URL resolver — only reads headers / small HTML, never downloads the file body
  const results = await chrome.scripting.executeScript({
    target: { tabId }, world: 'MAIN',
    func: async (url) => {
      try {
        // redirect:'manual' → stops at the 302 instead of crossing into drive.usercontent.google.com
        const r  = await fetch(url, { credentials: 'include', redirect: 'manual' });

        if (r.type === 'opaqueredirect' || r.status === 0) {
          return { downloadUrl: url }; // let chrome.downloads follow the redirect with its cookies
        }

        const ct = r.headers.get('content-type') || '';
        if (!ct.includes('text/html')) {
          const cd  = r.headers.get('content-disposition') || '';
          const fnm = cd.match(/filename\*?=(?:UTF-8'')?["']?([^"';\r\n]+)/i);
          return { downloadUrl: url, filename: fnm ? decodeURIComponent(fnm[1].trim().replace(/["']/g, '')) : null };
        }

        // Large-file confirmation page — extract token
        const html   = await r.text();
        const cMatch = html.match(/confirm=([^&"'>\s]+)/);
        const uMatch = html.match(/uuid=([^&"'>\s]+)/);
        if (!cMatch) return { error: 'Download blocked. The file owner may have disabled downloads, or you are not logged into Google.' };

        return { downloadUrl: `${url}&confirm=${cMatch[1]}${uMatch ? '&uuid=' + uMatch[1] : ''}` };
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

  // chrome.downloads uses Chrome's own cookie jar — handles CDN redirect natively
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

// ── 4. Poll video/file download progress ─────────────────────────────────────
async function pollDownload(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId }, world: 'MAIN',
    func: () => window.__dl_status || null
  });
  return { status: results[0]?.result || null };
}

// ── 5. Poll PDF capture progress ──────────────────────────────────────────────
async function pollPDF(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId }, world: 'MAIN',
    func: () => window.__driveload_status || null
  });
  return { status: results[0]?.result || null };
}
