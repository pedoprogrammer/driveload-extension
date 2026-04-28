// DriveLoad Background Service Worker
// Extension service workers bypass CORS and include Chrome's cookie jar
// automatically for any URL in host_permissions.

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'downloadVideo') { handleVideo(msg, sendResponse); return true; }
  if (msg.action === 'downloadFile')  { handleFile(msg, sendResponse);  return true; }
  if (msg.action === 'injectPDF')     { handlePDFCapture(msg.tabId).then(sendResponse).catch(e => sendResponse({ ok: false, error: e.message })); return true; }
  if (msg.action === 'pollPDF')       { pollPDF(msg.tabId).then(sendResponse).catch(e => sendResponse({ ok: false, error: e.message })); return true; }
  if (msg.action === 'pollDownload')  { pollDownload(msg.tabId).then(sendResponse).catch(e => sendResponse({ ok: false, error: e.message })); return true; }
});

// ── Status helpers ─────────────────────────────────────────────────────────────
async function setPageStatus(tabId, msg, pct, err) {
  await chrome.scripting.executeScript({
    target: { tabId }, world: 'MAIN',
    func: (m, p, e) => {
      if (!window.__dl_status) return;
      if (m  !== undefined) window.__dl_status.message  = m;
      if (p  !== undefined) window.__dl_status.progress = Math.round(p);
      if (e  !== undefined) window.__dl_status.error    = e;
    },
    args: [msg, pct, err]
  }).catch(() => {});
}

// ── 1. Video — service worker 8-thread parallel download ──────────────────────
// googlevideo.com is in host_permissions → service worker bypasses CORS.
// Video URLs have auth in URL params → no cookies needed (credentials:'omit').
async function handleVideo({ fileId, tabId }, sendResponse) {
  // Step 1: get best-quality streaming URL from page (needs page cookies)
  let info;
  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId }, world: 'MAIN',
      func: async (fid) => {
        try {
          const r    = await fetch(`https://drive.google.com/u/0/get_video_info?docid=${fid}&drive_originator_app=303`, { credentials: 'include' });
          const text = await r.text();
          let title = null;
          for (const part of text.split('&')) {
            if (part.startsWith('title=')) { title = decodeURIComponent(part.slice(6)).replace(/\+/g, ' '); break; }
          }
          const urlMap = {};
          for (const part of text.split('&')) {
            if (part.includes('videoplayback')) {
              const url = decodeURIComponent(part.replace(/\+/g, ' ')).split('|').pop();
              const m   = url.match(/[?&]itag=(\d+)/);
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
    info = res[0]?.result;
  } catch (e) {
    sendResponse({ ok: false, error: e.message });
    return;
  }

  if (!info?.videoUrl) { sendResponse({ ok: false, error: 'No video stream found. Make sure you are logged into Google.' }); return; }

  const filename = (info.title || fileId).replace(/[\\/*?:"<>|]/g, '_') + '.mp4';

  // Step 2: init status and tell popup to start polling
  await chrome.scripting.executeScript({
    target: { tabId }, world: 'MAIN',
    func: () => { window.__dl_status = { running: true, progress: 0, message: 'Starting…', error: null, done: false }; }
  });
  sendResponse({ ok: true });

  // Step 3: parallel download in service worker (googlevideo.com in host_permissions)
  try {
    await setPageStatus(tabId, 'Getting video size…', 3);
    const headR = await fetch(info.videoUrl, { credentials: 'omit', method: 'HEAD' });
    const size  = parseInt(headR.headers.get('content-length') || '0');

    if (!size) {
      await setPageStatus(tabId, 'Downloading…', 5);
      const r   = await fetch(info.videoUrl, { credentials: 'omit' });
      const buf = await r.arrayBuffer();
      await triggerDownload(tabId, buf, filename);
      return;
    }

    const THREADS   = 8;
    const chunkSize = Math.ceil(size / THREADS);
    const chunks    = new Array(THREADS);
    let received    = 0;

    await setPageStatus(tabId, 'Downloading… 0%', 5);
    await Promise.all(Array.from({ length: THREADS }, async (_, i) => {
      const start = i * chunkSize;
      const end   = Math.min(start + chunkSize - 1, size - 1);
      const r     = await fetch(info.videoUrl, { credentials: 'omit', headers: { Range: `bytes=${start}-${end}` } });
      const buf   = await r.arrayBuffer();
      chunks[i]   = buf;
      received   += buf.byteLength;
      await setPageStatus(tabId, `Downloading… ${Math.round(received / size * 100)}%`, 5 + (received / size * 90));
    }));

    await setPageStatus(tabId, 'Saving…', 97);
    const combined = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { combined.set(new Uint8Array(chunk), offset); offset += chunk.byteLength; }
    await triggerDownload(tabId, combined.buffer, filename);
  } catch (e) {
    await setPageStatus(tabId, undefined, undefined, 'Video download failed: ' + e.message);
  }
}

// ── 2. Files / Docs / PDFs — 8-thread parallel download in service worker ─────
// Service workers in extensions have no CORS restrictions for host_permissions
// URLs, and fetch() with credentials:'include' sends Chrome's full cookie jar.
async function handleFile({ fileId, fileType, tabId }, sendResponse) {
  // Step 1: resolve confirmed URL quickly via page injection
  let baseUrl, defaultExt;
  if      (fileType === 'doc')   { baseUrl = `https://docs.google.com/document/d/${fileId}/export/docx`;       defaultExt = 'docx'; }
  else if (fileType === 'sheet') { baseUrl = `https://docs.google.com/spreadsheets/d/${fileId}/export/xlsx`;   defaultExt = 'xlsx'; }
  else if (fileType === 'slide') { baseUrl = `https://docs.google.com/presentation/d/${fileId}/export/pptx`;  defaultExt = 'pptx'; }
  else                           { baseUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;       defaultExt = '';     }

  let urlInfo;
  try {
    const res = await chrome.scripting.executeScript({
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
    urlInfo = res[0]?.result;
  } catch (e) {
    sendResponse({ ok: false, error: 'Script injection failed.' });
    return;
  }

  if (!urlInfo)            { sendResponse({ ok: false, error: 'Script injection failed. Make sure you are on a Google Drive page.' }); return; }
  if (urlInfo.error)       { sendResponse({ ok: false, error: urlInfo.error }); return; }
  if (!urlInfo.downloadUrl){ sendResponse({ ok: false, error: 'Could not resolve download URL.' }); return; }

  const confirmedUrl = urlInfo.downloadUrl;
  let   filename     = (urlInfo.filename || (fileId + (defaultExt ? '.' + defaultExt : ''))).replace(/[\\/*?:"<>|]/g, '_');

  // Init status in page
  await chrome.scripting.executeScript({
    target: { tabId }, world: 'MAIN',
    func: () => { window.__dl_status = { running: true, progress: 0, message: 'Starting…', error: null, done: false }; }
  });

  // Tell popup download has started — it will poll __dl_status for progress
  sendResponse({ ok: true });

  // Step 2: Parallel download entirely in service worker (no CORS, cookies included)
  // Active fetch requests keep the service worker alive throughout.
  try {
    await setPageStatus(tabId, 'Getting file info…', 3);

    // HEAD to resolve final CDN URL + content-length (SW follows redirect, no CORS)
    const headR   = await fetch(confirmedUrl, { credentials: 'include', redirect: 'follow', method: 'HEAD' });
    const size    = parseInt(headR.headers.get('content-length') || '0');
    const cdnUrl  = headR.url || confirmedUrl;

    // Try to get better filename from CDN headers
    const cdHead  = headR.headers.get('content-disposition') || '';
    const fnMatch = cdHead.match(/filename\*?=(?:UTF-8'')?["']?([^"';\r\n]+)/i);
    if (fnMatch) filename = decodeURIComponent(fnMatch[1].trim().replace(/["']/g, ''));

    if (!size) {
      // No content-length — single connection fallback
      await setPageStatus(tabId, 'Downloading…', 10);
      const r   = await fetch(cdnUrl, { credentials: 'include' });
      const buf = await r.arrayBuffer();
      await triggerDownload(tabId, buf, filename);
      return;
    }

    // 8-thread parallel chunk download — same as DriveLoad server
    const THREADS   = 8;
    const chunkSize = Math.ceil(size / THREADS);
    await setPageStatus(tabId, 'Downloading… 0%', 5);

    const chunks  = new Array(THREADS);
    let received  = 0;

    await Promise.all(Array.from({ length: THREADS }, async (_, i) => {
      const start = i * chunkSize;
      const end   = Math.min(start + chunkSize - 1, size - 1);
      const r     = await fetch(cdnUrl, {
        credentials: 'include',
        headers: { Range: `bytes=${start}-${end}` }
      });
      const buf   = await r.arrayBuffer();
      chunks[i]   = buf;
      received   += buf.byteLength;
      await setPageStatus(tabId, `Downloading… ${Math.round(received / size * 100)}%`, 5 + (received / size * 90));
    }));

    // Combine chunks in order
    await setPageStatus(tabId, 'Saving file…', 97);
    const combined = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { combined.set(new Uint8Array(chunk), offset); offset += chunk.byteLength; }

    await triggerDownload(tabId, combined.buffer, filename);

  } catch (e) {
    await setPageStatus(tabId, undefined, undefined, e.message);
  }
}

// Inject the assembled ArrayBuffer into the page to create a blob download
async function triggerDownload(tabId, buffer, filename) {
  await chrome.scripting.executeScript({
    target: { tabId }, world: 'MAIN',
    func: (buf, fname) => {
      const blob = new Blob([buf]);
      const url  = URL.createObjectURL(blob);
      const a    = Object.assign(document.createElement('a'), { href: url, download: fname });
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 120_000);
      window.__dl_status = { done: true, progress: 100, message: `Saved: ${fname}`, filename: fname };
    },
    args: [buffer, filename]
  });
}

// ── 3. PDF canvas capture ─────────────────────────────────────────────────────
async function handlePDFCapture(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', files: ['vendor/jspdf.min.js'] });
  await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: () => { window.__driveload_status = null; } });
  await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', files: ['pdf_capture.js'] });
  return { ok: true };
}

// ── 4. Polls ───────────────────────────────────────────────────────────────────
async function pollDownload(tabId) {
  const r = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: () => window.__dl_status || null });
  return { status: r[0]?.result || null };
}

async function pollPDF(tabId) {
  const r = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: () => window.__driveload_status || null });
  return { status: r[0]?.result || null };
}
