const $ = (s) => document.querySelector(s);
const video = $('#video');
const stage = $('#stage');
const roi = $('#roi');
const valueEl = $('#value');
const statusEl = $('#status');
const threshold = $('#threshold');
const thresholdOut = $('#thresholdOut');
const polarity = $('#polarity');
const confirmRange = $('#confirm');
const confirmOut = $('#confirmOut');
const soundCheck = $('#sound');
const vibrateCheck = $('#vibrate');
const debug = $('#debug');
const dctx = debug.getContext('2d', { willReadFrequently: true });

const work = document.createElement('canvas');
const wctx = work.getContext('2d', { willReadFrequently: true });
let stream = null;
let timer = null;
let zeroCount = 0;
let notified = false;
let audioCtx = null;

const SEGMENTS = {
  '1111110': '0', '0110000': '1', '1101101': '2', '1111001': '3', '0110011': '4',
  '1011011': '5', '1011111': '6', '1110000': '7', '1111111': '8', '1111011': '9'
};

const segmentBoxes = [
  [0.24,0.08,0.52,0.14], // a
  [0.69,0.16,0.16,0.31], // b
  [0.69,0.55,0.16,0.31], // c
  [0.24,0.79,0.52,0.14], // d
  [0.15,0.55,0.16,0.31], // e
  [0.15,0.16,0.16,0.31], // f
  [0.24,0.44,0.52,0.14], // g
];

function saveSettings() {
  localStorage.setItem('sevenSegSettings', JSON.stringify({
    threshold: threshold.value,
    polarity: polarity.value,
    confirm: confirmRange.value,
    sound: soundCheck.checked,
    vibrate: vibrateCheck.checked,
    roi: { left: roi.style.left, top: roi.style.top, width: roi.style.width, height: roi.style.height }
  }));
}

function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem('sevenSegSettings') || '{}');
    if (s.threshold) threshold.value = s.threshold;
    if (s.polarity) polarity.value = s.polarity;
    if (s.confirm) confirmRange.value = s.confirm;
    if (typeof s.sound === 'boolean') soundCheck.checked = s.sound;
    if (typeof s.vibrate === 'boolean') vibrateCheck.checked = s.vibrate;
    if (s.roi) Object.assign(roi.style, s.roi);
  } catch {}
  thresholdOut.value = threshold.value;
  confirmOut.value = confirmRange.value;
}

async function startCamera() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false
    });
    video.srcObject = stream;
    await video.play();
    $('#start').disabled = true;
    $('#stop').disabled = false;
    statusEl.textContent = '監視中';
    timer = setInterval(analyze, 220);
  } catch (e) {
    statusEl.textContent = 'カメラを開始できません';
    alert('カメラを開始できませんでした。ブラウザのカメラ権限を確認してください。\n' + e.message);
  }
}

function stopCamera() {
  clearInterval(timer); timer = null;
  stream?.getTracks().forEach(t => t.stop());
  stream = null;
  video.srcObject = null;
  $('#start').disabled = false;
  $('#stop').disabled = true;
  statusEl.textContent = '停止中';
  valueEl.textContent = '---';
  zeroCount = 0;
}

function analyze() {
  if (!stream || !video.videoWidth) return;
  const sr = stage.getBoundingClientRect();
  const rr = roi.getBoundingClientRect();
  const sxScale = video.videoWidth / sr.width;
  const syScale = video.videoHeight / sr.height;
  const sx = Math.max(0, (rr.left - sr.left) * sxScale);
  const sy = Math.max(0, (rr.top - sr.top) * syScale);
  const sw = Math.min(video.videoWidth - sx, rr.width * sxScale);
  const sh = Math.min(video.videoHeight - sy, rr.height * syScale);
  if (sw < 30 || sh < 20) return;

  work.width = Math.max(1, Math.round(sw));
  work.height = Math.max(1, Math.round(sh));
  wctx.drawImage(video, sx, sy, sw, sh, 0, 0, work.width, work.height);

  const img = wctx.getImageData(0, 0, work.width, work.height);
  const gray = new Uint8Array(work.width * work.height);
  for (let i = 0, p = 0; i < img.data.length; i += 4, p++) {
    gray[p] = Math.round(img.data[i] * .299 + img.data[i+1] * .587 + img.data[i+2] * .114);
  }

  const chars = [];
  const dbgW = 480, dbgH = 180;
  debug.width = dbgW; debug.height = dbgH;
  dctx.drawImage(work, 0, 0, dbgW, dbgH);

  for (let digit = 0; digit < 3; digit++) {
    const x0 = Math.floor(work.width * digit / 3);
    const x1 = Math.floor(work.width * (digit + 1) / 3);
    const dw = x1 - x0;
    const bits = [];

    for (const [rx, ry, rw, rh] of segmentBoxes) {
      const bx = Math.floor(x0 + rx * dw), by = Math.floor(ry * work.height);
      const bw = Math.max(1, Math.floor(rw * dw)), bh = Math.max(1, Math.floor(rh * work.height));
      let on = 0, total = 0;
      for (let y = by; y < Math.min(work.height, by + bh); y += 2) {
        for (let x = bx; x < Math.min(work.width, bx + bw); x += 2) {
          const g = gray[y * work.width + x];
          const active = polarity.value === 'bright' ? g >= +threshold.value : g <= +threshold.value;
          if (active) on++;
          total++;
        }
      }
      const ratio = total ? on / total : 0;
      bits.push(ratio > 0.42 ? '1' : '0');
      dctx.strokeStyle = ratio > 0.42 ? '#00ff88' : '#ff3b30';
      dctx.lineWidth = 2;
      dctx.strokeRect(bx / work.width * dbgW, by / work.height * dbgH, bw / work.width * dbgW, bh / work.height * dbgH);
    }
    chars.push(SEGMENTS[bits.join('')] ?? '?');
  }

  const value = chars.join('');
  valueEl.textContent = value;
  handleValue(value);
}

function handleValue(value) {
  if (value === '000') {
    zeroCount++;
    statusEl.textContent = `000確認中 ${zeroCount}/${confirmRange.value}`;
  } else {
    zeroCount = 0;
    if (value.includes('?')) statusEl.textContent = '認識を調整してください';
    else statusEl.textContent = '監視中';
    if (value !== '000') notified = false;
  }

  if (zeroCount >= +confirmRange.value && !notified) {
    notified = true;
    statusEl.textContent = '000を検出しました';
    fireAlert();
  }
}

async function fireAlert() {
  if (soundCheck.checked) beep();
  if (vibrateCheck.checked && navigator.vibrate) navigator.vibrate([250,120,250,120,600]);
  if ('Notification' in window && Notification.permission === 'granted') {
    try {
      const reg = await navigator.serviceWorker?.ready;
      if (reg) reg.showNotification('000を検出しました', { body: '指定エリアの3桁表示が000になりました。', tag: 'seven-seg-zero', renotify: true });
      else new Notification('000を検出しました');
    } catch { new Notification('000を検出しました'); }
  }
}

function beep() {
  audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
  const o = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  o.frequency.value = 880; g.gain.value = .08;
  o.connect(g); g.connect(audioCtx.destination);
  o.start();
  setTimeout(() => { o.stop(); }, 900);
}

async function requestNotification() {
  if (!('Notification' in window)) return alert('このブラウザは通知APIに対応していません。');
  const p = await Notification.requestPermission();
  alert(p === 'granted' ? '通知を許可しました。' : '通知は許可されませんでした。');
}

// ROI drag + corner resize
let action = null;
roi.addEventListener('pointerdown', e => {
  e.preventDefault();
  roi.setPointerCapture(e.pointerId);
  const r = roi.getBoundingClientRect(), s = stage.getBoundingClientRect();
  const isHandle = e.target.classList.contains('h');
  action = { isHandle, cls: e.target.className, x:e.clientX, y:e.clientY,
    left:r.left-s.left, top:r.top-s.top, width:r.width, height:r.height, stageW:s.width, stageH:s.height };
});
roi.addEventListener('pointermove', e => {
  if (!action) return;
  const dx=e.clientX-action.x, dy=e.clientY-action.y;
  let {left,top,width,height}=action;
  if (!action.isHandle) { left += dx; top += dy; }
  else {
    const c=action.cls;
    if (c.includes('r')) width += dx;
    if (c.includes('l')) { left += dx; width -= dx; }
    if (c.includes('b')) height += dy;
    if (c.includes('t')) { top += dy; height -= dy; }
  }
  width=Math.max(120,Math.min(width,action.stageW-left));
  height=Math.max(55,Math.min(height,action.stageH-top));
  left=Math.max(0,Math.min(left,action.stageW-width));
  top=Math.max(0,Math.min(top,action.stageH-height));
  roi.style.left=(left/action.stageW*100)+'%'; roi.style.top=(top/action.stageH*100)+'%';
  roi.style.width=(width/action.stageW*100)+'%'; roi.style.height=(height/action.stageH*100)+'%';
});
roi.addEventListener('pointerup', () => { action=null; saveSettings(); });
roi.addEventListener('pointercancel', () => action=null);

$('#start').onclick = startCamera;
$('#stop').onclick = stopCamera;
$('#notify').onclick = requestNotification;
[threshold, polarity, confirmRange, soundCheck, vibrateCheck].forEach(el => el.addEventListener('input', () => {
  thresholdOut.value = threshold.value; confirmOut.value = confirmRange.value; saveSettings();
}));

loadSettings();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./service-worker.js').catch(console.warn);
