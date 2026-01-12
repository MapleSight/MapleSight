import React, { useEffect, useRef, useState } from 'react';
import Tesseract from 'tesseract.js';
import './App.css';

// 기준 해상도: 1366 x 768
const ROI_PCT = {
  /*ATTR: { x: 530 / 1366, y: 600 / 768, w: 280 / 1366, h: 100 / 768 }*/
  ATTR: { x: 590 / 1366, y: 600 / 768, w: 200 / 1366, h: 110 / 768 }
};

export default function App() {
  const [isReady, setIsReady] = useState(false);
  const [showDebug, setShowDebug] = useState(false);
  const [gameRect, setGameRect] = useState(null); // { x,y,width,height } in canvas pixels
  const [myImagePresent, setMyImagePresent] = useState(null);
  const [workerReady, setWorkerReady] = useState(false);
  const [templateOCRText, setTemplateOCRText] = useState(null);
  const [templateLoadStatus, setTemplateLoadStatus] = useState('idle');
  const [templateCandidates, setTemplateCandidates] = useState([]);
  const [lastScreenOCR, setLastScreenOCR] = useState('');
  const [streamInfo, setStreamInfo] = useState(null);
  const [detectionEnabled, setDetectionEnabled] = useState(true);
  const [nextCheckMs, setNextCheckMs] = useState(null);
  const publicBase = (window && window.location && window.location.origin) ? window.location.origin : '';
  // Inline dawn.png as a data URI so the icon always loads reliably
  const dawnDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAIISURBVFhH1ZeBcYMwDEWzAit0Ba+QFbwCK3gFVugKrMAKrMAKXYH42/xGyBLkcldy1d2/QGTpPxvTuDcV60UyY53m5RLBq1o+oyS6/Nl13ZpSWvu+L9dQCPEtsR690LPcZ49hnHcQjXkIwTSOMa5ngTG6rvYKLkQF2My77qsxl8ZjLowxmUKOoUGKce5NiAbAmrlnnPrR1BlI7V1XogHgM9fmlvGQbHkgGgJe5iPwzNl4mX+KeK+l80cQJgACAxDVPO/e3AizQ2MGrqcxv1JCOs8VQQ9CsLcJgOQ4oqAOkub41Ab4TsrKSwgEesMDXiYACbU5ZkgTNo/3YSedZ42GoI8J4M2ezUqjzfAe0k4SRNZYq+ACIFCAwZ556qfGnELOg2BPxCHA2exhNKT515BA/O6VVXgZQD9zGFA01NcQIVj/FgAKGbiWAHLWcjWYx1hd//8APv4IWHT5Jvwe8quUB3oAcqm1kPMA0BO9ES7Ax/8QcRU8AL0npHTeA6CPC+CtAhozaCJl5b3ZmwD653ialh2ENsAMpXRemqMXgr3d8wB/KrkKFQKb6zlLiPdaOo9amnP28DABvCMZISQIZmdJGlvmEDzMI9nZobS+nnsQLeb5uiG0uXsoRbIemY+P5RJEyzOG0PPwWP7Jf0wQDQT3hAXyqliPXkfmjJK4QvCqlm0w+dfa4nZ7ABlHWuAqaGEaAAAAAElFTkSuQmCC';
  const [matchInfo, setMatchInfo] = useState(null);
  const matchInfoRef = useRef(null);

  const updateMatchInfo = (updater) => {
    try {
      if (typeof updater === 'function') {
        setMatchInfo(prev => { const next = updater(prev); matchInfoRef.current = next; return next; });
      } else {
        setMatchInfo(updater); matchInfoRef.current = updater;
      }
    } catch (e) {}
  };

  // Safe helpers to read Mat dimensions without throwing if the Mat was deleted
  const matCols = (m) => { try { return m && typeof m.cols === 'number' ? m.cols : 0; } catch (e) { return 0; } };
  const matRows = (m) => { try { return m && typeof m.rows === 'number' ? m.rows : 0; } catch (e) { return 0; } };

  // Trim transparent alpha borders from a canvas. Returns the same canvas if no trimming needed.
  const trimCanvasToAlpha = (srcCanvas) => {
    try {
      const w = srcCanvas.width, h = srcCanvas.height;
      const ctx = srcCanvas.getContext('2d');
      const imgd = ctx.getImageData(0, 0, w, h);
      const data = imgd.data;
      let minX = w, minY = h, maxX = 0, maxY = 0; let found = false;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          const a = data[i + 3];
          if (a > 8) { // non-trivial alpha
            found = true;
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
          }
        }
      }
      if (!found) return srcCanvas;
      // add a 1px padding to be safe
      minX = Math.max(0, minX - 1); minY = Math.max(0, minY - 1);
      maxX = Math.min(w - 1, maxX + 1); maxY = Math.min(h - 1, maxY + 1);
      const sw = maxX - minX + 1; const sh = maxY - minY + 1;
      if (sw === w && sh === h) return srcCanvas;
      const out = document.createElement('canvas'); out.width = sw; out.height = sh;
      const octx = out.getContext('2d');
      octx.drawImage(srcCanvas, minX, minY, sw, sh, 0, 0, sw, sh);
      return out;
    } catch (e) { return srcCanvas; }
  };

  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const workerRef = useRef(null);
  const templateMatRef = useRef(null);
  const templateEdgeRef = useRef(null);
  const previewAnimRef = useRef(null);
  const isAnalyzingRef = useRef(false);
  const analysisTimerRef = useRef(null);
  const nextCheckRef = useRef(null);
  const audioCtxRef = useRef(null);
  const prevDetectedRef = useRef(null);
  const beepIntervalRef = useRef(null);
  

  const ensureAudioContext = () => {
    try {
      if (!audioCtxRef.current) {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (Ctx) audioCtxRef.current = new Ctx();
      }
      if (audioCtxRef.current && audioCtxRef.current.state === 'suspended') {
        audioCtxRef.current.resume().catch(() => {});
      }
      return audioCtxRef.current;
    } catch (e) {
      return null;
    }
  };

  // Auto-detect and manual-selection features removed.

  const playBeep = () => {
    const ctx = ensureAudioContext();
    if (!ctx) return;
    try {
      const now = ctx.currentTime;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.0001, now);
      g.gain.exponentialRampToValueAtTime(0.12, now + 0.02);
      o.connect(g); g.connect(ctx.destination);
      o.start(now);
      g.gain.exponentialRampToValueAtTime(0.0001, now + 0.25);
      o.stop(now + 0.26);
    } catch (e) {
      // ignore audio errors
    }
  };

  const startBeeping = () => {
    try {
      // ensure audio context is resumed
      ensureAudioContext();
      if (beepIntervalRef.current) return;
      // play immediately then repeat every second
      playBeep();
      const id = setInterval(() => {
        playBeep();
      }, 1000);
      beepIntervalRef.current = id;
    } catch (e) {
      // ignore
    }
  };

  const stopBeeping = () => {
    try {
      if (beepIntervalRef.current) {
        clearInterval(beepIntervalRef.current);
        beepIntervalRef.current = null;
      }
    } catch (e) {}
  };

  // Initialize Tesseract worker
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const worker = await Tesseract.createWorker();
        await worker.setParameters({
          tessedit_char_whitelist:
            'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789:,.+- ',
          tessedit_pageseg_mode: '6'
        });
        workerRef.current = worker;
        if (mounted) setWorkerReady(true);
      } catch (e) {
        console.error('Tesseract init failed', e);
      }
    })();
    return () => {
      mounted = false;
      if (workerRef.current) workerRef.current.terminate();
      // cleanup any beeping interval
      try { if (beepIntervalRef.current) clearInterval(beepIntervalRef.current); } catch(e){}
      try { if (audioCtxRef.current && audioCtxRef.current.close) audioCtxRef.current.close().catch(()=>{}); } catch(e){}
    };
  }, []);

  // Load template OCR text from the single provided path
  useEffect(() => {
    if (!workerReady) return;
    let cancelled = false;
    // try multiple candidate paths and also absolute origin-prefixed path
    const base = window.location.origin || '';
    const candidates = [
      '/templates/dawn.png',
      base + '/templates/dawn.png'
    ];
    setTemplateCandidates(candidates);
    const loadAndOcr = async (src) => {
      try {
        // first try fetch to detect accessibility and avoid cross-origin tainting
        let response = null;
        try {
          response = await fetch(src, { method: 'GET', cache: 'no-cache' });
        } catch (e) {
          // fetch failed (possibly CORS/NETWORK), we'll try loading the Image directly as fallback
          response = null;
        }

        let imgSrc = src;
        let blobUrl = null;
        if (response && response.ok) {
          const blob = await response.blob();
          blobUrl = URL.createObjectURL(blob);
          imgSrc = blobUrl;
        }

        const img = new Image();
        img.crossOrigin = 'Anonymous';
        img.src = imgSrc;
        await new Promise((res, rej) => { img.onload = res; img.onerror = rej; });

        const c = document.createElement('canvas');
        c.width = img.width; c.height = img.height;
        const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0);
        if (cancelled) {
          if (blobUrl) URL.revokeObjectURL(blobUrl);
          return null;
        }
        const ocrRes = await workerRef.current.recognize(c);
        if (blobUrl) URL.revokeObjectURL(blobUrl);
        return (ocrRes.data.text || '').trim();
      } catch (e) {
        return null;
      }
    };

    (async () => {
      setTemplateLoadStatus('loading');
      for (const p of candidates) {
        if (cancelled) break;
        try {
          const t = await loadAndOcr(p);
          if (t) {
            setTemplateOCRText(t);
            setTemplateLoadStatus('loaded');
            return;
          }
        } catch (e) {
          // continue
        }
      }
      setTemplateOCRText('');
      setTemplateLoadStatus('not-found');
    })();

    return () => {
      cancelled = true;
    };
  }, [workerReady]);

  // Load OpenCV template mat when cv is available
  useEffect(() => {
    const checkCV = setInterval(async () => {
      if (window.cv && window.cv.Mat) {
        clearInterval(checkCV);
        try {
          const cv = window.cv;
          const base = window.location.origin || '';
          const candidates = [
            '/templates/dawn.png',
            '/dice/dawn.png',
            base + '/templates/dawn.png'
          ];

          let loaded = false;
          for (const p of candidates) {
            try {
              // try fetch first
              let response = null;
              try { response = await fetch(p, { method: 'GET', cache: 'no-cache' }); } catch (e) { response = null; }
              let imgSrc = p;
              let blobUrl = null;
              if (response && response.ok) {
                const blob = await response.blob();
                blobUrl = URL.createObjectURL(blob);
                imgSrc = blobUrl;
              }

              const img = new Image(); img.crossOrigin = 'Anonymous'; img.src = imgSrc;
              await new Promise((res, rej) => { img.onload = res; img.onerror = rej; });
              const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
              const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0);
              // trim transparent borders from template image to improve matching
              const trimmed = trimCanvasToAlpha(c);
              const raw = cv.imread(trimmed); const gray = new cv.Mat(); cv.cvtColor(raw, gray, cv.COLOR_RGBA2GRAY); raw.delete();
              if (templateMatRef.current) try { templateMatRef.current.delete(); } catch (e) {}
              templateMatRef.current = gray;
              // also compute and store an edge template for faster/robust matching
              try { if (templateEdgeRef.current) try { templateEdgeRef.current.delete(); } catch(e){}; const edge = new cv.Mat(); cv.Canny(gray, edge, 50, 150); templateEdgeRef.current = edge; } catch(e) {}
              if (blobUrl) URL.revokeObjectURL(blobUrl);
              loaded = true; break;
            } catch (e) {
              // try next candidate
            }
          }
          if (!loaded) {
            // nothing found - as a last resort try the inlined dawnDataUrl (ensures template always available)
            try {
              const img = new Image(); img.crossOrigin = 'Anonymous'; img.src = dawnDataUrl;
              await new Promise((res, rej) => { img.onload = res; img.onerror = rej; });
              const c2 = document.createElement('canvas'); c2.width = img.width; c2.height = img.height;
              const ctx2 = c2.getContext('2d'); ctx2.drawImage(img, 0, 0);
              const trimmed2 = trimCanvasToAlpha(c2);
              const raw2 = cv.imread(trimmed2); const gray2 = new cv.Mat(); cv.cvtColor(raw2, gray2, cv.COLOR_RGBA2GRAY); raw2.delete();
              if (templateMatRef.current) try { templateMatRef.current.delete(); } catch (e) {}
              templateMatRef.current = gray2;
              try { if (templateEdgeRef.current) try { templateEdgeRef.current.delete(); } catch(e){}; const edge2 = new cv.Mat(); cv.Canny(gray2, edge2, 50, 150); templateEdgeRef.current = edge2; } catch(e) {}
              loaded = true; setTemplateLoadStatus('loaded');
            } catch (e) {
              // still nothing
            }
          }
        } catch (e) {
          // ignore
        }
        setIsReady(true);
      }
    }, 100);
    return () => clearInterval(checkCV);
  }, []);

  const startScreenCapture = async () => {
    try {
      // create/resume audio context on user gesture so we can play sound later
      ensureAudioContext();
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      try {
        const track = stream.getVideoTracks()[0];
        if (track && typeof track.getSettings === 'function') {
          const settings = track.getSettings();
          setStreamInfo({ settings });
        }
      } catch (e) {}
      videoRef.current.srcObject = stream;
      videoRef.current.play();
      // Ensure canvas uses the video's intrinsic aspect ratio to avoid stretching.
      // When the captured video metadata is available, set canvas width/height to the video's size
      // (scaled down if too large) so drawImage uses matching dimensions.
      videoRef.current.onloadedmetadata = () => {
        try {
          const vw = videoRef.current.videoWidth || 1280;
          const vh = videoRef.current.videoHeight || 720;
          const maxW = 1280; // cap width to avoid huge canvases
          const scale = vw > maxW ? (maxW / vw) : 1;
          const cw = Math.max(1, Math.round(vw * scale));
          const ch = Math.max(1, Math.round(vh * scale));
          const canvas = canvasRef.current;
          if (canvas) {
            canvas.width = cw;
            canvas.height = ch;
          }
          // store reported/actual sizes in debug state
          try {
            setStreamInfo(prev => ({ ...(prev||{}), videoWidth: vw, videoHeight: vh, canvasWidth: cw, canvasHeight: ch, screenWidth: window.screen.width, screenHeight: window.screen.height, dpr: window.devicePixelRatio }));
          } catch (e) {}
        } catch (e) {
          // ignore
        }
      
      };
      if (analysisTimerRef.current) clearTimeout(analysisTimerRef.current);
      analysisTimerRef.current = setTimeout(analyzeFrame, 300);
    } catch (e) {
      console.error('Error accessing screen', e);
    }
  };

  // Continuous lightweight preview draw loop to keep canvas updated even when analysis is busy
  useEffect(() => {
    const startPreview = () => {
      try {
        if (previewAnimRef.current) cancelAnimationFrame(previewAnimRef.current);
      } catch (e) {}
      const draw = () => {
        try {
          const canvas = canvasRef.current; const video = videoRef.current;
          if (canvas && video && video.readyState >= 2) {
            const ctx = canvas.getContext('2d');
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            if (showDebug || gameRect) drawROIs(ctx, canvas.width, canvas.height);
            // draw detection overlay from latest matchInfo
            try {
              const mi = matchInfoRef.current;
              // draw overlay whenever we have a recent matchInfo (don't rely on state captured by the closure)
              if (mi && mi.roi) {
                const r = mi.roi;
                const lx = (typeof r.locX === 'number') ? r.locX : 0;
                const ly = (typeof r.locY === 'number') ? r.locY : 0;
                const ox = (typeof r.ax === 'number') ? r.ax : 0;
                const oy = (typeof r.ay === 'number') ? r.ay : 0;
                const w = r.tplW || r.tplw || 0; const h = r.tplH || r.tplh || 0;
                const cx = Math.round(ox + lx + w/2);
                const cy = Math.round(oy + ly + h/2);
                const radius = Math.round(Math.max(w, h)/2) + 6;
                ctx.lineWidth = 2; ctx.strokeStyle = 'lime'; ctx.strokeRect(ox + lx, oy + ly, w, h);
                ctx.beginPath(); ctx.lineWidth = 3; ctx.strokeStyle = 'lime'; ctx.arc(cx, cy, radius, 0, Math.PI*2); ctx.stroke();
              }
            } catch (e) {}
          }
        } catch (e) {}
        previewAnimRef.current = requestAnimationFrame(draw);
      };
      previewAnimRef.current = requestAnimationFrame(draw);
    };

    // Start preview when we have a stream attached to the video element
    let stop = false;
    const tryStart = () => {
      try {
        const v = videoRef.current;
        if (v && v.srcObject) startPreview();
        else if (!stop) setTimeout(tryStart, 200);
      } catch (e) {}
    };
    tryStart();
    return () => {
      stop = true;
      try { if (previewAnimRef.current) cancelAnimationFrame(previewAnimRef.current); } catch (e) {}
    };
  }, [showDebug, gameRect]);

  

  const drawROIs = (ctx, cw, ch) => {
    const roi = ROI_PCT.ATTR; if (!roi) return;
    ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(255,0,0,0.8)'; ctx.font = 'bold 14px Arial'; ctx.fillStyle = 'yellow';
    // If a gameRect is detected, draw ROIs relative to that rect. Otherwise draw relative to whole canvas.
    if (gameRect) {
      const gx = gameRect.x, gy = gameRect.y, gw = gameRect.width, gh = gameRect.height;
      const x = Math.floor(gx + roi.x * gw), y = Math.floor(gy + roi.y * gh), w = Math.floor(roi.w * gw), h = Math.floor(roi.h * gh);
      ctx.strokeRect(x, y, w, h); ctx.fillText('ATTR', x, y - 6);
      // draw detected game rect
      ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(0,200,255,0.8)'; ctx.strokeRect(gx, gy, gw, gh);
    } else {
      const x = Math.floor(roi.x * cw), y = Math.floor(roi.y * ch), w = Math.floor(roi.w * cw), h = Math.floor(roi.h * ch);
      ctx.strokeRect(x, y, w, h); ctx.fillText('ATTR', x, y - 6);
    }
  };

  const analyzeFrame = async () => {
    if (!videoRef.current || !isReady) return;
    if (isAnalyzingRef.current) return;
    isAnalyzingRef.current = true;
    const cv = window.cv;
    const mats = [];
    const track = (m) => { if (m) mats.push(m); return m; };
    try {
      const canvas = canvasRef.current;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(videoRef.current, 0, 0, canvas.width, canvas.height);
      const cw = canvas.width, ch = canvas.height;
      const src = track(cv.imread(canvas));
      
      if (showDebug) drawROIs(ctx, cw, ch);

      // HP bar detection: auto-sample the top area to find the dominant hue, then threshold.
      try {
        const hsv = track(new cv.Mat());
        cv.cvtColor(src, hsv, cv.COLOR_RGBA2HSV);

        // sample a small band at the top of the frame where HP bars usually appear
        const sampleH = Math.max(8, Math.min(ch, Math.round(ch * 0.12)));
        const sampleRect = track(hsv.roi(new cv.Rect(0, 0, cw, sampleH)));
        if (showDebug) {
          try {
            ctx.save(); ctx.lineWidth = 2; ctx.strokeStyle = 'yellow';
            ctx.strokeRect(0, 0, cw, sampleH);
            ctx.restore();
          } catch (e) {}
        }
        const data = sampleRect.data; // HSV interleaved
        // build hue histogram (0..179)
        const hist = new Array(180).fill(0);
        for (let i = 0; i + 2 < data.length; i += 3) {
          const h = data[i]; const s = data[i+1]; const v = data[i+2];
          // ignore very desaturated/dark pixels
          if (s < 30 || v < 30) continue;
          hist[h]++;
        }
        // find peak hue
        let huePeak = 0; let hueCount = 0;
        for (let h = 0; h < hist.length; h++) { if (hist[h] > hueCount) { hueCount = hist[h]; huePeak = h; } }

        // compute average S/V for pixels near the peak hue
        let sumS = 0, sumV = 0, sumCnt = 0;
        for (let i = 0; i + 2 < data.length; i += 3) {
          const h = data[i]; const s = data[i+1]; const v = data[i+2];
          const dh = Math.abs(((h - huePeak + 180) % 180));
          if (dh <= 6 && s >= 10) { sumS += s; sumV += v; sumCnt++; }
        }
        const meanS = sumCnt ? Math.round(sumS / sumCnt) : 120;
        const meanV = sumCnt ? Math.round(sumV / sumCnt) : 120;

        // choose hue span and SV tolerances
        const hueSpan = 18;
        const sTol = 50; const vTol = 50;

        // create low/high mats (handle wrap around if necessary)
        const lowHue = (huePeak - hueSpan + 180) % 180;
        const highHue = (huePeak + hueSpan) % 180;

        const mask = track(new cv.Mat());
        if (lowHue <= highHue) {
          const low = new cv.Mat(matRows(hsv), matCols(hsv), hsv.type(), [lowHue, Math.max(10, meanS - sTol), Math.max(10, meanV - vTol), 0]);
          const high = new cv.Mat(matRows(hsv), matCols(hsv), hsv.type(), [highHue, Math.min(255, meanS + sTol), Math.min(255, meanV + vTol), 255]);
          const tmp = track(new cv.Mat());
          cv.inRange(hsv, low, high, tmp);
          cv.copyTo(tmp, mask);
          try { low.delete(); high.delete(); } catch (e) {}
        } else {
          // wrap: combine two ranges
          const low1 = new cv.Mat(matRows(hsv), matCols(hsv), hsv.type(), [0, Math.max(10, meanS - sTol), Math.max(10, meanV - vTol), 0]);
          const high1 = new cv.Mat(matRows(hsv), matCols(hsv), hsv.type(), [highHue, Math.min(255, meanS + sTol), Math.min(255, meanV + vTol), 255]);
          const low2 = new cv.Mat(matRows(hsv), matCols(hsv), hsv.type(), [lowHue, Math.max(10, meanS - sTol), Math.max(10, meanV - vTol), 0]);
          const high2 = new cv.Mat(matRows(hsv), matCols(hsv), hsv.type(), [179, Math.min(255, meanS + sTol), Math.min(255, meanV + vTol), 255]);
          const m1 = track(new cv.Mat()); const m2 = track(new cv.Mat());
          cv.inRange(hsv, low1, high1, m1); cv.inRange(hsv, low2, high2, m2);
          cv.add(m1, m2, mask);
          try { low1.delete(); high1.delete(); low2.delete(); high2.delete(); } catch (e) {}
        }

        // morphological cleanup
        const kernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(5, 5));
        cv.morphologyEx(mask, mask, cv.MORPH_OPEN, kernel);
        cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, kernel);

        // find contours and prefer long horizontal bars
        const contours = new cv.MatVector();
        const hierarchy = new cv.Mat();
        cv.findContours(mask, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
        let best = null; let bestArea = 0;
        for (let i = 0; i < contours.size(); i++) {
          const cnt = contours.get(i);
          const rect = cv.boundingRect(cnt);
          const area = rect.width * rect.height;
          if (area < 300) { cnt.delete(); continue; }
          const aspect = rect.width / (rect.height || 1);
          if (aspect < 3) { cnt.delete(); continue; }
          if (area > bestArea) { bestArea = area; best = rect; }
          cnt.delete();
        }

        if (best) {
          const cx = Math.round(best.x + best.width / 2);
          const cy = Math.round(best.y + best.height / 2);
          const radius = Math.round(Math.max(best.width, best.height) / 2) + 8;
          try { ctx.lineWidth = 3; ctx.strokeStyle = 'red'; ctx.beginPath(); ctx.arc(cx, cy, radius, 0, Math.PI * 2); ctx.stroke(); } catch (e) {}
          if (showDebug) {
            try { ctx.lineWidth = 2; ctx.strokeStyle = 'lime'; ctx.strokeRect(best.x, best.y, best.width, best.height); } catch (e) {}
          }
        } else if (showDebug) {
          try {
            const maskCanvas = document.createElement('canvas'); maskCanvas.width = matCols(mask); maskCanvas.height = matRows(mask);
            cv.imshow(maskCanvas, mask);
            ctx.save(); ctx.globalAlpha = 0.18; ctx.drawImage(maskCanvas, 0, 0, canvas.width, canvas.height); ctx.restore();
          } catch (e) {}
        }

        try { contours.delete(); hierarchy.delete(); kernel.delete(); } catch (e) {}
        // tracked mats (hsv, sampleRect, mask) will be cleaned up in finally via mats
      } catch (e) {
        // ignore
      }
      const gray = track(new cv.Mat()); cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY, 0);

      // Compute ROI rectangle in canvas pixels. If gameRect detected, compute relative to it.
      let rect;
      if (gameRect) {
        rect = {
          x: Math.floor(gameRect.x + ROI_PCT.ATTR.x * gameRect.width),
          y: Math.floor(gameRect.y + ROI_PCT.ATTR.y * gameRect.height),
          w: Math.floor(ROI_PCT.ATTR.w * gameRect.width),
          h: Math.floor(ROI_PCT.ATTR.h * gameRect.height)
        };
      } else {
        rect = {
          x: Math.floor(ROI_PCT.ATTR.x * cw), y: Math.floor(ROI_PCT.ATTR.y * ch),
          w: Math.floor(ROI_PCT.ATTR.w * cw), h: Math.floor(ROI_PCT.ATTR.h * ch)
        };
      }
  const ax = Math.max(0, rect.x), ay = Math.max(0, rect.y);
  const aw = Math.min(rect.w, Math.max(0, matCols(src) - ax)), ah = Math.min(rect.h, Math.max(0, matRows(src) - ay));
  let detected = false;
  if (aw > 0 && ah > 0 && detectionEnabled) {
        const roi = track(gray.roi(new cv.Rect(ax, ay, aw, ah)));
        // OCR
        if (workerRef.current) {
          try {
            const tmp = document.createElement('canvas'); tmp.width = matCols(roi); tmp.height = matRows(roi); cv.imshow(tmp, roi);
            const res = await workerRef.current.recognize(tmp);
            const screenText = (res.data.text || '').toLowerCase(); setLastScreenOCR(screenText);
            if (templateOCRText) {
              const tt = (templateOCRText || '').toLowerCase(); const chunk = tt.slice(0, Math.min(12, tt.length));
              if (chunk.length >= 3 && (screenText.includes(chunk) || tt.includes(screenText.slice(0, Math.min(12, screenText.length))))) { detected = true; setMyImagePresent(true); }
            }
          } catch (e) { /* ignore */ }
        }
        // visual fallback: multi-scale ROI template matching (handles templates at different displayed sizes)
        if (!detected && templateMatRef.current) {
          try {
            const tpl = templateMatRef.current;
            let tplCols = 0, tplRows = 0;
            try { tplCols = matCols(tpl); tplRows = matRows(tpl); } catch (e) { tplCols = 0; tplRows = 0; }

            // Choose scales to try. Prefer a persisted calibration or the stream->canvas base scale
            const persisted = (() => { try { return parseFloat(localStorage.getItem('dawn_match_scale') || 'NaN'); } catch (e) { return NaN; } })();
            let scales = [];
            if (!Number.isNaN(persisted) && persisted > 0) {
              scales = [persisted];
            } else if (streamInfo && streamInfo.videoWidth) {
              // compute approximate scale from source video -> canvas mapping and try fine offsets
              const baseScale = (canvas.width / streamInfo.videoWidth) || 1.0;
              scales = [baseScale * 0.9, baseScale * 0.95, baseScale, baseScale * 1.05, baseScale * 1.1];
            } else {
              // fallback wide range
              scales = [0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 2.0];
            }

            // compute an edge map of the ROI once (edges are more invariant to brightness)
            const roiEdge = track(new cv.Mat());
            try { cv.Canny(roi, roiEdge, 50, 150); } catch (e) { /* ignore */ }

            let best = { val: 0, loc: { x: 0, y: 0 }, w: 0, h: 0, scale: 1.0, mode: 'intensity' };
            let bestEdge = { val: 0, loc: { x: 0, y: 0 }, w: 0, h: 0, scale: 1.0 };

            for (let i = 0; i < scales.length; i++) {
              const sc = scales[i];
              const sw = Math.max(1, Math.round((tplCols || 1) * sc));
              const sh = Math.max(1, Math.round((tplRows || 1) * sc));
              if (sw >= matCols(roi) || sh >= matRows(roi)) continue; // skip too-large templates
              let tmpTpl = null;
              let res = null;
              try {
                tmpTpl = new cv.Mat(); cv.resize(tpl, tmpTpl, new cv.Size(sw, sh)); track(tmpTpl);

                // intensity matching (whole template)
                res = new cv.Mat(); track(res);
                try { cv.matchTemplate(roi, tmpTpl, res, cv.TM_CCOEFF_NORMED); } catch (e) { /* ignore */ }
                const mm = cv.minMaxLoc(res);
                const val = (mm && mm.maxVal) ? mm.maxVal : 0;
                if (val > best.val) {
                  best = { val, loc: mm.maxLoc, w: sw, h: sh, scale: sc, mode: 'intensity' };
                }
                try { res.delete(); } catch (e) {}

                // tile-based matching (helps when part of the icon is occluded by cooldown numbers)
                try {
                  const tw = matCols(tmpTpl), th = matRows(tmpTpl);
                  const halfW = Math.floor(tw/2), halfH = Math.floor(th/2);
                  const tileRects = [ [0,0,halfW,halfH], [halfW,0,tw-halfW,halfH], [0,halfH,halfW,th-halfH], [halfW,halfH,tw-halfW,th-halfH] ];
                  let bestTileVal = 0; let bestTileLoc = null; let bestTileW = 0, bestTileH = 0;
                  for (let ti = 0; ti < tileRects.length; ti++) {
                    const r = tileRects[ti];
                    if (r[2] < 8 || r[3] < 8) continue;
                    let tile = null; let tres = null;
                    try {
                      tile = tmpTpl.roi(new cv.Rect(r[0], r[1], r[2], r[3])); track(tile);
                      tres = new cv.Mat(); track(tres);
                      cv.matchTemplate(roi, tile, tres, cv.TM_CCOEFF_NORMED);
                      const mmT = cv.minMaxLoc(tres);
                      const tv = (mmT && mmT.maxVal) ? mmT.maxVal : 0;
                      if (tv > bestTileVal) { bestTileVal = tv; bestTileLoc = mmT.maxLoc; bestTileW = r[2]; bestTileH = r[3]; }
                    } catch (e) {
                      // ignore
                    } finally {
                      try { if (tres) tres.delete(); } catch (e) {}
                    }
                  }
                  // if any tile matches strongly, promote it as a candidate
                  if (bestTileVal > 0.62 && bestTileVal > best.val) {
                    best = { val: bestTileVal, loc: bestTileLoc, w: bestTileW, h: bestTileH, scale: sc, mode: 'tile' };
                  }
                } catch (e) { /* ignore tile errors */ }

                // edge matching (more robust when icon darkens)
                let tplEdge = new cv.Mat(); track(tplEdge);
                try { cv.Canny(tmpTpl, tplEdge, 50, 150); } catch (e) { /* ignore */ }
                const resE = new cv.Mat(); track(resE);
                try { cv.matchTemplate(roiEdge, tplEdge, resE, cv.TM_CCOEFF_NORMED); } catch (e) { /* ignore */ }
                const mmE = cv.minMaxLoc(resE);
                const valE = (mmE && mmE.maxVal) ? mmE.maxVal : 0;
                if (valE > bestEdge.val) {
                  bestEdge = { val: valE, loc: mmE.maxLoc, w: sw, h: sh, scale: sc };
                }
                try { resE.delete(); } catch (e) {}
                // tplEdge will be deleted with mats cleanup
              } catch (e) {
                // ignore per-scale errors
              } finally {
                // tmpTpl will be deleted later by mats cleanup
              }
            }

            // choose edge match if it's confident; otherwise use intensity match
            const EDGE_THRESHOLD = 0.42;
            const INT_THRESHOLD = 0.55;
            let chosen = null;
            if (bestEdge.val > EDGE_THRESHOLD && bestEdge.val >= best.val) {
              chosen = { val: bestEdge.val, loc: bestEdge.loc, w: bestEdge.w, h: bestEdge.h, scale: bestEdge.scale, mode: 'edge' };
            } else {
              chosen = { val: best.val, loc: best.loc, w: best.w, h: best.h, scale: best.scale, mode: 'intensity' };
            }

            try { updateMatchInfo(prev => ({ ...(prev||{}), roi: { maxVal: chosen.val, roiW: matCols(roi), roiH: matRows(roi), tplW: chosen.w, tplH: chosen.h, scale: chosen.scale, mode: chosen.mode, locX: (chosen.loc && typeof chosen.loc.x === 'number') ? chosen.loc.x : 0, locY: (chosen.loc && typeof chosen.loc.y === 'number') ? chosen.loc.y : 0, ax, ay } })); } catch(e){}
            // persist a reliable scale so future frames are faster/accurate
            try {
              if (chosen.val > 0.75) {
                localStorage.setItem('dawn_match_scale', String(chosen.scale));
              }
            } catch (e) {}
            if (chosen.val > INT_THRESHOLD || (chosen.mode === 'edge' && chosen.val > EDGE_THRESHOLD)) {
              detected = true; setMyImagePresent(true);
              try {
                ctx.lineWidth = 2; ctx.strokeStyle = 'lime'; ctx.strokeRect(ax + chosen.loc.x, ay + chosen.loc.y, chosen.w, chosen.h);
                // draw a circle centered on the matched area
                const cx = Math.round(ax + chosen.loc.x + chosen.w / 2);
                const cy = Math.round(ay + chosen.loc.y + chosen.h / 2);
                const radius = Math.round(Math.max(chosen.w, chosen.h) / 2) + 6;
                ctx.beginPath(); ctx.lineWidth = 3; ctx.strokeStyle = 'lime'; ctx.arc(cx, cy, radius, 0, Math.PI * 2); ctx.stroke();
              } catch(e){}
            }
          } catch (e) { /* ignore */ }
        }
      } else if (!detectionEnabled) {
        // detection disabled: show unknown state and stop any beeps
        try { stopBeeping(); prevDetectedRef.current = false; setMyImagePresent(null); } catch (e) {}
      }

      // play beep when image was present then lost — start repeating until found again
      try {
        const prev = prevDetectedRef.current;
        if (prev === true && detected === false) {
          startBeeping();
        } else if (detected === true) {
          // stop any ongoing beeping once found again
          stopBeeping();
        }
        prevDetectedRef.current = detected;
      } catch (e) {}

      if (!detected) {
        if (detectionEnabled) setMyImagePresent(false);
        else setMyImagePresent(null);
      }
    } catch (e) { console.error('Frame analysis error', e); }
    finally {
      mats.forEach(m => { try { if (m && typeof m.delete === 'function') m.delete(); } catch (e) {} });
      isAnalyzingRef.current = false;
  // If the image is currently detected, poll less frequently (once per 5s).
  const delay = (prevDetectedRef.current === true) ? 5000 : 500;
      // schedule next analysis and expose countdown for debug UI
      nextCheckRef.current = Date.now() + delay;
      try { setNextCheckMs(delay); } catch (e) {}
      analysisTimerRef.current = setTimeout(analyzeFrame, delay);
    }
  };

  // redraw canvas once when gameRect or debug toggles change so user sees updated overlay
  useEffect(() => {
    try {
      const canvas = canvasRef.current; const video = videoRef.current;
      if (!canvas || !video) return;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      if (showDebug || gameRect) drawROIs(ctx, canvas.width, canvas.height);
    } catch (e) {}
  }, [gameRect, showDebug]);

  // keep a small interval to update the countdown to next check for debug UI
  useEffect(() => {
    let iv = null;
    try {
      iv = setInterval(() => {
        try {
          if (nextCheckRef.current) {
            const remaining = Math.max(0, nextCheckRef.current - Date.now());
            setNextCheckMs(remaining);
          } else {
            setNextCheckMs(null);
          }
        } catch (e) {}
      }, 200);
    } catch (e) {}
    return () => { try { if (iv) clearInterval(iv); } catch (e) {} };
  }, []);

  return (
    <div className="app-container">
      <header className="header">
          <div className="brand">
          <div className="logo">MS</div>
          <div>
              <h1 className="title">MapleSight</h1>
              <div className="tagline">A lightweight MapleStory companion</div>
          </div>
        </div>
          <div className="header-actions">
          <label className="debug-toggle">
            <input type="checkbox" checked={showDebug} onChange={(e) => setShowDebug(e.target.checked)} /> Show Debug
          </label>
          <button className="btn-capture" onClick={startScreenCapture} disabled={!isReady}>
            {isReady ? 'Select Screen' : 'Loading OpenCV...'}
          </button>
        </div>
      </header>

      <div className="content-grid">
        <div className="video-section">
          <div style={{ position: 'relative', width: '100%' }}>
            <canvas
              ref={canvasRef}
              width={1280}
              height={720}
              className="canvas-display"
            />
            <video ref={videoRef} style={{ display: 'none' }} muted />
          </div>
        </div>

        <div className="results-panel">
          <div>
            <h4 style={{ margin: 0, fontSize: '1.4rem', fontWeight: 700, color: 'var(--text-main)' }}>Detect</h4>
            <div style={{ fontSize: 14, color: '#666', display: 'flex', alignItems: 'center', gap: 12 }}>
              <div
                onClick={() => {
                  try {
                    const newVal = !detectionEnabled; setDetectionEnabled(newVal);
                    if (!newVal) { // turned off
                      setMyImagePresent(null); stopBeeping(); prevDetectedRef.current = false;
                    } else {
                      // re-run analysis soon
                      if (analysisTimerRef.current) clearTimeout(analysisTimerRef.current);
                      analysisTimerRef.current = setTimeout(analyzeFrame, 120);
                    }
                  } catch (e) {}
                }}
                title={detectionEnabled ? 'Click to disable detection' : 'Click to enable detection'}
                style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 54, height: 54, borderRadius: 999, padding: 7, cursor: 'pointer', boxShadow: '0 5px 16px rgba(0,0,0,0.44)', background: '#111' }}
              >
                <div style={{ width: 46, height: 46, borderRadius: 999, overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center', border: `3px solid ${myImagePresent === true ? '#0f9d58' : (myImagePresent === false ? '#e74c3c' : (detectionEnabled ? '#6c757d' : '#444'))}` }}>
                  <img src={dawnDataUrl} alt="dawn" style={{ width: 28, height: 28, display: 'block', opacity: detectionEnabled ? 1 : 0.45 }} />
                </div>
              </div>
            </div>
          </div>

          {showDebug && (
            <div style={{ marginTop: 12, padding: 8, background: '#111', color: '#eee', fontSize: 12, borderRadius: 6 }}>
              <div><strong>OCR Debug</strong></div>
              <div>workerReady: {workerReady ? 'yes' : 'no'}</div>
              <div>myImagePresent: {String(myImagePresent)}</div>
              <div>templateOCRText: {templateOCRText ? templateOCRText.slice(0, 160) : '[none]'}</div>
              <div>lastScreenOCR: {lastScreenOCR ? lastScreenOCR.slice(0, 160) : '[none]'}</div>
              <div>templateLoadStatus: {templateLoadStatus}</div>
              <div>templateCandidates: {templateCandidates.join(', ')}</div>
              <div>gameRect: {gameRect ? `${gameRect.x}x${gameRect.y} ${gameRect.width}x${gameRect.height}` : '[none]'}</div>
              <div>next check: {nextCheckMs === null ? '[n/a]' : (nextCheckMs >= 1000 ? `${(nextCheckMs/1000).toFixed(1)}s` : `${Math.round(nextCheckMs)}ms`)}</div>
              {streamInfo && (
                <div style={{ marginTop: 8 }}>
                  <div><strong>Stream</strong></div>
                  <div>Reported settings: {streamInfo.settings ? JSON.stringify({ width: streamInfo.settings.width, height: streamInfo.settings.height, frameRate: streamInfo.settings.frameRate }, null, 0) : '[none]'}</div>
                  <div>Decoded video: {streamInfo.videoWidth ? `${streamInfo.videoWidth}x${streamInfo.videoHeight}` : '[unknown]'}</div>
                  <div>Canvas size: {streamInfo.canvasWidth ? `${streamInfo.canvasWidth}x${streamInfo.canvasHeight}` : '[unknown]'}</div>
                  <div>Screen: {streamInfo.screenWidth}x{streamInfo.screenHeight} DPR: {streamInfo.dpr}</div>
                </div>
              )}
              {showDebug && matchInfo && (
                <div style={{ marginTop: 8 }}>
                  <div><strong>Match Debug</strong></div>
                  <div>ROI max: {matchInfo.roi ? matchInfo.roi.maxVal.toFixed(3) : '[n/a]'}</div>
                </div>
              )}
              
            </div>
          )}
        </div>
      </div>
    </div>
  );
}