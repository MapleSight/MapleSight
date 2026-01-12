import React, { useEffect, useRef, useState } from 'react';
import Tesseract from 'tesseract.js';
import './App.css';

// 기준 해상도: 1366 x 768
const ROI_PCT = {
  /*ATTR: { x: 530 / 1366, y: 600 / 768, w: 280 / 1366, h: 100 / 768 }*/
  ATTR: { x: 630 / 1366, y: 500 / 768, w: 80 / 1366, h: 200 / 768 }
};

export default function App() {
  const [isReady, setIsReady] = useState(false);
  const [showDebug, setShowDebug] = useState(false);
  const [gameRect, setGameRect] = useState(null); // { x,y,width,height } in canvas pixels
  const [isSelecting, setIsSelecting] = useState(false);
  const selectStartRef = useRef(null);
  const [detectionRunning, setDetectionRunning] = useState(false);
  const [detectionProgress, setDetectionProgress] = useState(0);
  const [myImagePresent, setMyImagePresent] = useState(null);
  const [workerReady, setWorkerReady] = useState(false);
  const [templateOCRText, setTemplateOCRText] = useState(null);
  const [templateLoadStatus, setTemplateLoadStatus] = useState('idle');
  const [templateCandidates, setTemplateCandidates] = useState([]);
  const [lastScreenOCR, setLastScreenOCR] = useState('');

  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const workerRef = useRef(null);
  const templateMatRef = useRef(null);
  const isAnalyzingRef = useRef(false);
  const analysisTimerRef = useRef(null);
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

  // Auto-detect game window in the current canvas using edge/contour method on a single frame
  const detectSingleFrame = async () => {
    try {
      if (!window.cv) return null;
      const cv = window.cv;
      const canvas = canvasRef.current;
      if (!canvas) return null;
      const src = cv.imread(canvas);
      const gray = new cv.Mat(); cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY, 0);
      const blur = new cv.Mat(); cv.GaussianBlur(gray, blur, new cv.Size(5,5), 0);
      const edges = new cv.Mat(); cv.Canny(blur, edges, 50, 150);
      const contours = new cv.MatVector(); const hierarchy = new cv.Mat();
      cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
      let bestArea = 0; let bestRect = null;
      for (let i = 0; i < contours.size(); i++) {
        const cnt = contours.get(i);
        const rect = cv.boundingRect(cnt);
        const area = rect.width * rect.height;
        // skip tiny contours
        if (area < 5000) { cnt.delete(); continue; }
        if (area > bestArea) {
          bestArea = area; bestRect = rect;
        }
        cnt.delete();
      }
      // clean up
      src.delete(); gray.delete(); blur.delete(); edges.delete(); contours.delete(); hierarchy.delete();
      if (bestRect) {
        // clamp within canvas
        const gx = Math.max(0, bestRect.x), gy = Math.max(0, bestRect.y);
        const gw = Math.min(canvas.width - gx, bestRect.width), gh = Math.min(canvas.height - gy, bestRect.height);
        const gr = { x: gx, y: gy, width: gw, height: gh };
        return gr;
      }
      return null;
    } catch (e) {
      console.error('detectSingleFrame error', e);
      return null;
    }
  };

  // Run detection across multiple frames and pick a stable rectangle (median of successful detections)
  const aggregateDetect = async (samples = 8, delayMs = 150) => {
    if (detectionRunning) return;
    setDetectionRunning(true); setDetectionProgress(0);
    const rects = [];
    try {
      for (let i = 0; i < samples; i++) {
        // draw a fresh frame to canvas
        try {
          const canvas = canvasRef.current; const video = videoRef.current;
          if (canvas && video) {
            const ctx = canvas.getContext('2d'); ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          }
        } catch (e) {}
        const r = await detectSingleFrame();
        if (r) rects.push(r);
        setDetectionProgress(Math.round(((i+1)/samples)*100));
        // small wait to allow next video frame
        await new Promise(res => setTimeout(res, delayMs));
      }
      if (rects.length === 0) {
        setDetectionRunning(false); setDetectionProgress(0); return null;
      }
      // compute median rectangle components to be robust to outliers
      const xs = rects.map(r => r.x).sort((a,b)=>a-b);
      const ys = rects.map(r => r.y).sort((a,b)=>a-b);
      const ws = rects.map(r => r.width).sort((a,b)=>a-b);
      const hs = rects.map(r => r.height).sort((a,b)=>a-b);
      const mid = Math.floor(rects.length/2);
      const medianRect = {
        x: xs[mid], y: ys[mid], width: ws[mid], height: hs[mid]
      };
      // clamp and set
      const canvas = canvasRef.current;
      medianRect.x = Math.max(0, Math.min(canvas.width-1, medianRect.x));
      medianRect.y = Math.max(0, Math.min(canvas.height-1, medianRect.y));
      medianRect.width = Math.max(1, Math.min(canvas.width-medianRect.x, medianRect.width));
      medianRect.height = Math.max(1, Math.min(canvas.height-medianRect.y, medianRect.height));
      setGameRect(medianRect);
      setDetectionRunning(false); setDetectionProgress(100);
      // brief pause before clearing progress
      setTimeout(()=>setDetectionProgress(0), 800);
      return medianRect;
    } catch (e) {
      console.error('aggregateDetect error', e);
      setDetectionRunning(false); setDetectionProgress(0);
      return null;
    }
  };

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
      '/templates/myImage.png',
      '/dice/myImage.png',
      base + '/templates/myImage.png'
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
            '/templates/myImage.png',
            '/dice/myImage.png',
            base + '/templates/myImage.png'
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
              const raw = cv.imread(c); const gray = new cv.Mat(); cv.cvtColor(raw, gray, cv.COLOR_RGBA2GRAY); raw.delete();
              if (templateMatRef.current) try { templateMatRef.current.delete(); } catch (e) {}
              templateMatRef.current = gray;
              if (blobUrl) URL.revokeObjectURL(blobUrl);
              loaded = true; break;
            } catch (e) {
              // try next candidate
            }
          }
          if (!loaded) {
            // nothing found - leave templateMatRef null
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
      const aw = Math.min(rect.w, src.cols - ax), ah = Math.min(rect.h, src.rows - ay);
      let detected = false;
      if (aw > 0 && ah > 0) {
        const roi = track(gray.roi(new cv.Rect(ax, ay, aw, ah)));
        // OCR
        if (workerRef.current) {
          try {
            const tmp = document.createElement('canvas'); tmp.width = roi.cols; tmp.height = roi.rows; cv.imshow(tmp, roi);
            const res = await workerRef.current.recognize(tmp);
            const screenText = (res.data.text || '').toLowerCase(); setLastScreenOCR(screenText);
            if (templateOCRText) {
              const tt = (templateOCRText || '').toLowerCase(); const chunk = tt.slice(0, Math.min(12, tt.length));
              if (chunk.length >= 3 && (screenText.includes(chunk) || tt.includes(screenText.slice(0, Math.min(12, screenText.length))))) { detected = true; setMyImagePresent(true); }
            }
          } catch (e) { /* ignore */ }
        }
  // visual fallback
        if (!detected && templateMatRef.current) {
          try {
            const tpl = templateMatRef.current; let tplToUse = tpl; let resized = null;
            if (tpl.cols > roi.cols || tpl.rows > roi.rows) {
              const scale = Math.min(roi.cols / tpl.cols, roi.rows / tpl.rows);
              resized = new cv.Mat(); cv.resize(tpl, resized, new cv.Size(Math.max(1, Math.round(tpl.cols * scale)), Math.max(1, Math.round(tpl.rows * scale)))); tplToUse = resized; track(resized);
            }
            const result = track(new cv.Mat()); cv.matchTemplate(roi, tplToUse, result, cv.TM_CCOEFF_NORMED);
            const mm = cv.minMaxLoc(result); if (mm.maxVal > 0.65) { detected = true; setMyImagePresent(true); }
          } catch (e) { /* ignore */ }
        }
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

      if (!detected) setMyImagePresent(false);
    } catch (e) { console.error('Frame analysis error', e); }
    finally {
      mats.forEach(m => { try { if (m && typeof m.delete === 'function') m.delete(); } catch (e) {} });
      isAnalyzingRef.current = false;
  // If the image is currently detected, poll much less frequently (once per 20s).
  const delay = (prevDetectedRef.current === true) ? 20000 : 500;
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

  return (
    <div className="app-container">
      <header className="header">
        <div className="brand">
          <div className="logo">MB</div>
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
          <button className="btn-detect" onClick={() => aggregateDetect(8, 150)} disabled={!isReady || detectionRunning} title="Auto-detect game window from the captured frame">
            {detectionRunning ? `Detecting... ${detectionProgress}%` : 'Auto-detect Game Window'}
          </button>
          <button className="btn-detect" onClick={() => setGameRect(null)} disabled={!gameRect}>Clear Detection</button>
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
              onMouseDown={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                const x = Math.round((e.clientX - rect.left) * (e.currentTarget.width / rect.width));
                const y = Math.round((e.clientY - rect.top) * (e.currentTarget.height / rect.height));
                selectStartRef.current = { x, y };
                setIsSelecting(true);
              }}
              onMouseMove={(e) => {
                if (!isSelecting || !selectStartRef.current) return;
                const rect = e.currentTarget.getBoundingClientRect();
                const x = Math.round((e.clientX - rect.left) * (e.currentTarget.width / rect.width));
                const y = Math.round((e.clientY - rect.top) * (e.currentTarget.height / rect.height));
                const sx = Math.min(selectStartRef.current.x, x), sy = Math.min(selectStartRef.current.y, y);
                const sw = Math.abs(x - selectStartRef.current.x), sh = Math.abs(y - selectStartRef.current.y);
                setGameRect({ x: sx, y: sy, width: sw, height: sh });
              }}
              onMouseUp={(e) => { setIsSelecting(false); selectStartRef.current = null; }}
            />
            <video ref={videoRef} style={{ display: 'none' }} muted />
          </div>
        </div>

        <div className="results-panel">
          <h3 style={{ marginTop: 0 }}>Analysis Results</h3>
          <div>
            <h4 className="section-title">Detect</h4>
            <div style={{ fontSize: 14, color: '#666', display: 'flex', alignItems: 'center', gap: 8 }}>
              {myImagePresent === null && <span>Checking for myImage.png...</span>}
              {myImagePresent === true && (
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ width: 22, height: 22, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: '#0f9d58', color: '#fff', borderRadius: 6 }}>✓</span>
                  <span style={{ color: '#0f9d58', fontWeight: 600 }}>Found</span>
                </div>
              )}
              {myImagePresent === false && (
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ width: 22, height: 22, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: '#e74c3c', color: '#fff', borderRadius: 6 }}>✕</span>
                  <span style={{ color: '#e74c3c', fontWeight: 600 }}>Missing</span>
                </div>
              )}
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
              <div>detection: {detectionRunning ? `running (${detectionProgress}%)` : 'idle'}</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}