/**
 * DriveLoad PDF Capture
 * Runs in MAIN world of Google Drive PDF viewer.
 * Scrolls all pages, captures blob images at full resolution, rebuilds as PDF.
 */
(async function driveloadCapture() {
  window.__driveload_status = { running: true, progress: 0, message: 'Starting…', error: null, done: false };

  const setS  = (msg, pct) => { window.__driveload_status.message = msg; window.__driveload_status.progress = pct || 0; };
  const setErr = msg => { window.__driveload_status.error = msg; window.__driveload_status.running = false; };
  const setDone = () => { window.__driveload_status.done = true; window.__driveload_status.running = false; window.__driveload_status.progress = 100; };
  const sleep  = ms => new Promise(r => setTimeout(r, ms));

  try {
    // ── 1. Scroll through all pages so Drive renders them ────────────────────
    setS('Scrolling to render all pages…', 2);

    const scrollEl = document.querySelector("[role='main']") ||
                     document.querySelector('.ndfHFb-c4YZDc') ||
                     document.documentElement;

    const totalH = () => Math.max(
      scrollEl.scrollHeight, document.body.scrollHeight,
      document.documentElement.scrollHeight
    );

    const step = Math.max(window.innerHeight * 0.6, 400);

    // Scroll down slowly to force rendering of every page
    for (let pos = 0; pos < totalH(); pos += step) {
      scrollEl.scrollTop = pos;
      window.scrollTo(0, pos);
      await sleep(350);
    }

    // Scroll back to top so position calculations are correct
    scrollEl.scrollTop = 0;
    window.scrollTo(0, 0);
    await sleep(900);

    // ── 2. Collect rendered blob images ──────────────────────────────────────
    setS('Collecting pages…', 15);

    let imgs = Array.from(document.images).filter(
      img => img.src.startsWith('blob:') && img.naturalWidth > 50 && img.naturalHeight > 50
    );

    // If pages not found, do a second slower pass
    if (imgs.length === 0) {
      for (let pos = 0; pos < totalH(); pos += step) {
        scrollEl.scrollTop = pos;
        window.scrollTo(0, pos);
        await sleep(600);
      }
      scrollEl.scrollTop = 0;
      window.scrollTo(0, 0);
      await sleep(1200);
      imgs = Array.from(document.images).filter(
        img => img.src.startsWith('blob:') && img.naturalWidth > 50 && img.naturalHeight > 50
      );
    }

    if (imgs.length === 0) {
      setErr('No PDF pages found. Scroll through the entire PDF first, then try again.');
      return;
    }

    // Sort by absolute vertical position (top of page in document)
    imgs.sort((a, b) => {
      const topA = a.getBoundingClientRect().top + window.scrollY;
      const topB = b.getBoundingClientRect().top + window.scrollY;
      return topA - topB || a.getBoundingClientRect().left - b.getBoundingClientRect().left;
    });

    // Deduplicate by src
    const seen = new Set();
    imgs = imgs.filter(img => { if (seen.has(img.src)) return false; seen.add(img.src); return true; });

    setS(`Found ${imgs.length} pages — building PDF…`, 20);

    // ── 3. Build PDF with jsPDF at full resolution ────────────────────────────
    if (!window.jspdf) { setErr('jsPDF library not loaded. Please try again.'); return; }
    const { jsPDF } = window.jspdf;

    const first = imgs[0];
    const pdf   = new jsPDF({
      orientation: first.naturalWidth > first.naturalHeight ? 'landscape' : 'portrait',
      unit:   'px',
      format: [first.naturalWidth, first.naturalHeight],
      hotfixes: ['px_scaling'],
    });

    for (let i = 0; i < imgs.length; i++) {
      const img = imgs[i];
      setS(`Processing page ${i + 1} of ${imgs.length}…`, 20 + (i / imgs.length) * 72);

      if (i > 0) {
        const orient = img.naturalWidth > img.naturalHeight ? 'landscape' : 'portrait';
        pdf.addPage([img.naturalWidth, img.naturalHeight], orient);
      }

      const canvas = document.createElement('canvas');
      canvas.width  = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d', { alpha: false });
      ctx.imageSmoothingEnabled = false;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      try { ctx.drawImage(img, 0, 0); }
      catch { continue; } // tainted canvas — skip page

      // PNG for lossless quality (matches DriveLoad's "high resolution" goal)
      const dataUrl = canvas.toDataURL('image/png');
      pdf.addImage(dataUrl, 'PNG', 0, 0, img.naturalWidth, img.naturalHeight, undefined, 'FAST');
    }

    // ── 4. Save ───────────────────────────────────────────────────────────────
    setS('Saving PDF…', 95);
    const title = document.title
      .replace(/\s*-\s*Google\s*(Drive|Docs|Slides|Sheets).*$/i, '')
      .replace(/[\\/*?:"<>|]/g, '_')
      .trim() || 'document';
    pdf.save(`${title}.pdf`);
    setDone();

  } catch (err) {
    setErr('Error: ' + err.message);
  }
})();
