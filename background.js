// DriveLoad Background Service Worker
// Mirrors the same download logic as the DriveLoad Flask server.

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'downloadVideo')  { handleVideo(msg.fileId, msg.tabId).then(sendResponse).catch(e => sendResponse({ok:false,error:e.message})); return true; }
  if (msg.action === 'downloadFile')   { handleFile(msg.fileId, msg.fileType, msg.tabId).then(sendResponse).catch(e => sendResponse({ok:false,error:e.message})); return true; }
  if (msg.action === 'injectPDF')      { handlePDFCapture(msg.tabId).then(sendResponse).catch(e => sendResponse({ok:false,error:e.message})); return true; }
  if (msg.action === 'pollStatus')     { pollStatus(msg.tabId).then(sendResponse).catch(e => sendResponse({ok:false,error:e.message})); return true; }
});

// ── Video download (get_video_info → signed streaming URL → chrome.downloads) ─
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
  if (!info?.videoUrl) return { ok: false, error: 'Could not get video stream. Check that you are logged into Google and the file is accessible.' };

  const filename = (info.title || fileId).replace(/[\\/*?:"<>|]/g, '_') + '.mp4';
  return new Promise(resolve => {
    chrome.downloads.download({ url: info.videoUrl, filename }, id => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
      else resolve({ ok: true, filename });
    });
  });
}

// ── File / PDF / GDoc download (uc?export=download or export endpoint, blob in page) ─
async function handleFile(fileId, fileType, tabId) {
  // Determine the export URL (mirrors server logic)
  let exportUrl, defaultExt;
  if (fileType === 'doc')   { exportUrl = `https://docs.google.com/document/d/${fileId}/export/docx`;       defaultExt = 'docx'; }
  else if (fileType === 'sheet') { exportUrl = `https://docs.google.com/spreadsheets/d/${fileId}/export/xlsx`; defaultExt = 'xlsx'; }
  else if (fileType === 'slide') { exportUrl = `https://docs.google.com/presentation/d/${fileId}/export/pptx`; defaultExt = 'pptx'; }
  else                           { exportUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;      defaultExt = ''; }

  // Reset status then inject downloader into page context
  await chrome.scripting.executeScript({
    target: { tabId }, world: 'MAIN',
    func: () => { window.__dl_status = { running: true, progress: 0, message: 'Starting…', error: null, done: false, filename: null }; }
  });

  await chrome.scripting.executeScript({
    target: { tabId }, world: 'MAIN',
    func: async (url, ext) => {
      const setS = (msg, pct) => { window.__dl_status.message = msg; window.__dl_status.progress = pct; };

      function getFilename(headers, fallbackExt) {
        const cd = headers.get('content-disposition') || '';
        const m  = cd.match(/filename\*?=(?:UTF-8'')?["']?([^"';\r\n]+)/i);
        if (m) return decodeURIComponent(m[1].trim().replace(/["']/g, ''));
        return null;
      }

      try {
        setS('Connecting to Google Drive…', 5);
        let r1 = await fetch(url, { credentials: 'include' });
        let downloadUrl = url;
        let filename    = null;

        const ct1 = r1.headers.get('content-type') || '';
        filename  = getFilename(r1.headers, ext);

        if (ct1.includes('text/html')) {
          // Large file — extract confirmation token (mirrors server code)
          const html   = await r1.text();
          const cMatch = html.match(/confirm=([^&"'>\s]+)/);
          const uMatch = html.match(/uuid=([^&"'>\s]+)/);
          if (!cMatch) { window.__dl_status.error = 'Google is blocking the download. The file may be restricted by the owner.'; return; }
          downloadUrl  = `${url}&confirm=${cMatch[1]}${uMatch ? '&uuid=' + uMatch[1] : ''}`;
          setS('Confirmed — downloading…', 10);
          r1 = await fetch(downloadUrl, { credentials: 'include' });
          filename = getFilename(r1.headers, ext) || filename;
        }

        if (!filename) filename = (document.title.replace(/\s*-\s*Google.*$/i, '').trim() || 'download') + (ext ? `.${ext}` : '');
        filename = filename.replace(/[\\/*?:"<>|]/g, '_');

        const total  = parseInt(r1.headers.get('content-length') || '0');
        const reader = r1.body.getReader();
        const chunks = [];
        let received = 0;

        setS('Downloading…', 12);
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          received += value.length;
          const pct = total ? 12 + (received / total * 83) : 50;
          setS(`Downloading… ${total ? Math.round(received/total*100)+'%' : (received/1048576).toFixed(1)+' MB'}`, pct);
        }

        setS('Saving…', 97);
        const blob = new Blob(chunks);
        const burl = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href = burl; a.download = filename;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(burl), 60000);

        window.__dl_status.done     = true;
        window.__dl_status.progress = 100;
        window.__dl_status.message  = `Saved: ${filename}`;
        window.__dl_status.filename = filename;
      } catch (e) {
        window.__dl_status.error   = e.message;
        window.__dl_status.running = false;
      }
    },
    args: [exportUrl, defaultExt]
  });

  return { ok: true };
}

// ── PDF canvas capture fallback (view-only PDFs with download disabled) ────────
async function handlePDFCapture(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', files: ['vendor/jspdf.min.js'] });
  await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: () => { window.__driveload_status = null; } });
  await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', files: ['pdf_capture.js'] });
  return { ok: true };
}

// ── Poll both status globals ───────────────────────────────────────────────────
async function pollStatus(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId }, world: 'MAIN',
    func: () => ({ file: window.__dl_status || null, pdf: window.__driveload_status || null })
  });
  return results[0]?.result || {};
}
