// DriveLoad Background Service Worker

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // return true keeps the message channel open → SW stays alive until sendResponse()
  if (msg.action === 'downloadVideo') { handleVideo(msg.fileId, msg.tabId).then(sendResponse).catch(e => sendResponse({ ok: false, error: e.message })); return true; }
  if (msg.action === 'downloadFile')  { handleFile(msg.fileId, msg.fileType, msg.tabId).then(sendResponse).catch(e => sendResponse({ ok: false, error: e.message })); return true; }
  if (msg.action === 'injectPDF')     { handlePDFCapture(msg.tabId).then(sendResponse).catch(e => sendResponse({ ok: false, error: e.message })); return true; }
  if (msg.action === 'pollPDF')       { pollPDF(msg.tabId).then(sendResponse).catch(e => sendResponse({ ok: false, error: e.message })); return true; }
  if (msg.action === 'pollDownload')  { pollDownload(msg.tabId).then(sendResponse).catch(e => sendResponse({ ok: false, error: e.message })); return true; }
});

// ── Shared helpers ─────────────────────────────────────────────────────────────
async function setStatus(tabId, msg, pct) {
  await chrome.scripting.executeScript({
    target: { tabId }, world: 'MAIN',
    func: (m, p) => { if (window.__dl_status) { window.__dl_status.message = m; window.__dl_status.progress = Math.round(p); } },
    args: [msg, pct]
  }).catch(() => {});
}

async function setError(tabId, err) {
  await chrome.scripting.executeScript({
    target: { tabId }, world: 'MAIN',
    func: (e) => { if (window.__dl_status) window.__dl_status.error = e; },
    args: [err]
  }).catch(() => {});
}

async function triggerBlobDownload(tabId, buffer, filename) {
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

// ── 1. Video ───────────────────────────────────────────────────────────────────
async function handleVideo(fileId, tabId) {
  const results = await chrome.scripting.executeScript({
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
// The message channel stays open (return true in listener) which keeps the
// SW alive for the entire download — no 30-second timeout issue.
// SW fetches with credentials:'include' use Chrome's full cookie jar.
async function handleFile(fileId, fileType, tabId) {
  let baseUrl, defaultExt;
  if      (fileType === 'doc')   { baseUrl = `https://docs.google.com/document/d/${fileId}/export/docx`;       defaultExt = 'docx'; }
  else if (fileType === 'sheet') { baseUrl = `https://docs.google.com/spreadsheets/d/${fileId}/export/xlsx`;   defaultExt = 'xlsx'; }
  else if (fileType === 'slide') { baseUrl = `https://docs.google.com/presentation/d/${fileId}/export/pptx`;  defaultExt = 'pptx'; }
  else                           { baseUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;       defaultExt = '';     }

  // Step 1: resolve confirmed URL quickly via page injection
  const urlRes = await chrome.scripting.executeScript({
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
        if (!cMatch) return { error: 'Download blocked — the owner may have disabled downloads, or you are not logged into Google.' };
        return { downloadUrl: `${url}&confirm=${cMatch[1]}${uMatch ? '&uuid=' + uMatch[1] : ''}` };
      } catch (e) { return { error: e.message }; }
    },
    args: [baseUrl]
  });

  const urlInfo = urlRes[0]?.result;
  if (!urlInfo)            return { ok: false, error: 'Script injection failed — make sure you are on a Google Drive page.' };
  if (urlInfo.error)       return { ok: false, error: urlInfo.error };
  if (!urlInfo.downloadUrl) return { ok: false, error: 'Could not resolve download URL.' };

  const confirmedUrl = urlInfo.downloadUrl;
  let   filename     = (urlInfo.filename || fileId + (defaultExt ? '.' + defaultExt : '')).replace(/[\\/*?:"<>|]/g, '_');

  // Step 2: init status for popup polling
  await chrome.scripting.executeScript({
    target: { tabId }, world: 'MAIN',
    func: () => { window.__dl_status = { running: true, progress: 0, message: 'Connecting…', error: null, done: false }; }
  }).catch(() => {});

  // Step 3: SW parallel download — message channel open keeps SW alive
  try {
    await setStatus(tabId, 'Getting file info…', 3);

    // HEAD to get final CDN URL and file size (SW has no CORS restrictions for host_permissions)
    const headR  = await fetch(confirmedUrl, { credentials: 'include', redirect: 'follow', method: 'HEAD' });
    const size   = parseInt(headR.headers.get('content-length') || '0');
    const cdnUrl = headR.url || confirmedUrl;

    // Extract filename from CDN headers
    const cdHead = headR.headers.get('content-disposition') || '';
    const fnHead = cdHead.match(/filename\*?=(?:UTF-8'')?["']?([^"';\r\n]+)/i);
    if (fnHead) filename = decodeURIComponent(fnHead[1].trim().replace(/["']/g, ''));

    if (!size) {
      // No content-length — single connection stream
      await setStatus(tabId, 'Downloading…', 10);
      const r   = await fetch(cdnUrl, { credentials: 'include' });
      const buf = await r.arrayBuffer();
      await triggerBlobDownload(tabId, buf, filename);
      return { ok: true, filename };
    }

    // 8-thread parallel chunk download — same as DriveLoad server
    const THREADS   = 8;
    const chunkSize = Math.ceil(size / THREADS);
    await setStatus(tabId, 'Downloading… 0%', 5);

    const chunks  = new Array(THREADS);
    let received  = 0;

    await Promise.all(Array.from({ length: THREADS }, async (_, i) => {
      const start = i * chunkSize;
      const end   = Math.min(start + chunkSize - 1, size - 1);
      const r     = await fetch(cdnUrl, { credentials: 'include', headers: { Range: `bytes=${start}-${end}` } });
      const buf   = await r.arrayBuffer();
      chunks[i]   = buf;
      received   += buf.byteLength;
      await setStatus(tabId, `Downloading… ${Math.round(received / size * 100)}%`, 5 + (received / size * 90));
    }));

    await setStatus(tabId, 'Saving file…', 97);
    const combined = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { combined.set(new Uint8Array(chunk), offset); offset += chunk.byteLength; }

    await triggerBlobDownload(tabId, combined.buffer, filename);
    return { ok: true, filename };

  } catch (e) {
    // Any failure → fall back to chrome.downloads (single connection, always works)
    await setStatus(tabId, 'Using system download…', 80);
    return new Promise(resolve => {
      chrome.downloads.download({ url: confirmedUrl, saveAs: false }, id => {
        if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
        else resolve({ ok: true });
      });
    });
  }
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
