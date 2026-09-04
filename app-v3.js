const $=s=>document.querySelector(s);
const video=$('#video'),stage=$('#stage'),roi=$('#roi'),valueEl=$('#value'),statusEl=$('#status');
const threshold=$('#threshold'),thresholdOut=$('#thresholdOut'),polarity=$('#polarity'),confirmRange=$('#confirm'),confirmOut=$('#confirmOut');
const digitWidth=$('#digitWidth'),digitWidthOut=$('#digitWidthOut'),soundCheck=$('#sound'),vibrateCheck=$('#vibrate');
const debug=$('#debug'),dctx=debug.getContext('2d',{willReadFrequently:true});
const work=document.createElement('canvas'),wctx=work.getContext('2d',{willReadFrequently:true});

let stream=null,running=false,lastAnalyzeAt=0,zeroHits=0,nonZeroHits=0,notified=false,audioCtx=null;
let recent=[];
const ANALYZE_MS=80; // 最大約12.5回/秒。video frame callbackなので同じフレームを無駄に再解析しない。

const PATTERNS={
  '0':[1,1,1,1,1,1,0], '1':[0,1,1,0,0,0,0], '2':[1,1,0,1,1,0,1], '3':[1,1,1,1,0,0,1],
  '4':[0,1,1,0,0,1,1], '5':[1,0,1,1,0,1,1], '6':[1,0,1,1,1,1,1], '7':[1,1,1,0,0,0,0],
  '8':[1,1,1,1,1,1,1], '9':[1,1,1,1,0,1,1]
};

// LCDの斜め7セグ向け。広い矩形の平均ではなく、各セグメントの中心付近を狭く見る。
const PROBES=[
  [.27,.08,.47,.11], // a
  [.70,.18,.12,.27], // b
  [.66,.56,.12,.27], // c
  [.22,.83,.47,.11], // d
  [.17,.56,.12,.27], // e
  [.22,.18,.12,.27], // f
  [.25,.455,.47,.11] // g
];

function save(){localStorage.setItem('sevenSegSettings',JSON.stringify({threshold:threshold.value,polarity:polarity.value,confirm:confirmRange.value,digitWidth:digitWidth.value,sound:soundCheck.checked,vibrate:vibrateCheck.checked,roi:{left:roi.style.left,top:roi.style.top,width:roi.style.width,height:roi.style.height}}))}
function load(){try{const s=JSON.parse(localStorage.getItem('sevenSegSettings')||'{}');if(s.threshold)threshold.value=s.threshold;if(s.polarity)polarity.value=s.polarity;if(s.confirm)confirmRange.value=s.confirm;if(s.digitWidth)digitWidth.value=s.digitWidth;if(typeof s.sound==='boolean')soundCheck.checked=s.sound;if(typeof s.vibrate==='boolean')vibrateCheck.checked=s.vibrate;if(s.roi)Object.assign(roi.style,s.roi)}catch{} thresholdOut.value=threshold.value;confirmOut.value=confirmRange.value;digitWidthOut.value=digitWidth.value+'%'}

async function startCamera(){
  try{
    statusEl.textContent='カメラ起動中…';
    stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'},width:{ideal:1920},height:{ideal:1080}},audio:false});
    video.srcObject=stream;
    await new Promise(r=>video.readyState>=1?r():video.addEventListener('loadedmetadata',r,{once:true}));
    await video.play();
    stage.style.aspectRatio=`${video.videoWidth}/${video.videoHeight}`;
    $('#start').disabled=true;$('#stop').disabled=false;
    running=true;lastAnalyzeAt=0;zeroHits=0;nonZeroHits=0;recent=[];valueEl.textContent='---';statusEl.textContent='監視中';
    scheduleFrame();
  }catch(e){statusEl.textContent='カメラを開始できません';alert('カメラ権限を確認してください。\n'+e.message)}
}

function stopCamera(){running=false;stream?.getTracks().forEach(t=>t.stop());stream=null;video.srcObject=null;stage.style.aspectRatio='';$('#start').disabled=false;$('#stop').disabled=true;statusEl.textContent='停止中';valueEl.textContent='---';zeroHits=nonZeroHits=0;recent=[]}

function scheduleFrame(){
  if(!running)return;
  if('requestVideoFrameCallback' in HTMLVideoElement.prototype){
    video.requestVideoFrameCallback((now)=>{if(!running)return;if(now-lastAnalyzeAt>=ANALYZE_MS){lastAnalyzeAt=now;analyze()}scheduleFrame()});
  }else{
    setTimeout(()=>{if(!running)return;analyze();scheduleFrame()},ANALYZE_MS);
  }
}

function percentileFromHist(hist,total,q){let target=total*q,n=0;for(let i=0;i<256;i++){n+=hist[i];if(n>=target)return i}return 255}

function probeScore(gray,w,h,x0,dw,probe,lo,hi,isBright){
  const [rx,ry,rw,rh]=probe;
  const bx=Math.max(0,Math.floor(x0+rx*dw)),by=Math.max(0,Math.floor(ry*h));
  const bw=Math.max(2,Math.floor(rw*dw)),bh=Math.max(2,Math.floor(rh*h));
  const vals=[];const range=Math.max(12,hi-lo);
  // 反射や細い欠けに強くするため、プローブ内の「セグメントらしい側」の上位画素を使う。
  for(let y=by;y<Math.min(h,by+bh);y+=2){for(let x=bx;x<Math.min(w,bx+bw);x+=2){const g=gray[y*w+x];let ink=isBright?(g-lo)/range:(hi-g)/range;vals.push(Math.max(0,Math.min(1,ink)))}}
  if(!vals.length)return 0;
  vals.sort((a,b)=>b-a);const n=Math.max(1,Math.floor(vals.length*.45));let s=0;for(let i=0;i<n;i++)s+=vals[i];return s/n;
}

function decodeDigit(gray,w,h,x0,x1){
  const dw=x1-x0,hist=new Uint32Array(256);let total=0;
  // 各桁ごとに明暗レンジを自動推定。LCDの照明ムラや露出変化に追従する。
  for(let y=Math.floor(h*.05);y<Math.floor(h*.95);y+=2){for(let x=x0;x<x1;x+=2){hist[gray[y*w+x]]++;total++}}
  const lo=percentileFromHist(hist,total,.10),hi=percentileFromHist(hist,total,.90);
  if(hi-lo<14)return {digit:'?',confidence:0,scores:[]};
  const isBright=polarity.value==='bright';
  const scores=PROBES.map(p=>probeScore(gray,w,h,x0,dw,p,lo,hi,isBright));
  // スライダーは固定画素値ではなく、判定感度として利用する。
  const sens=.28+(+threshold.value-20)/215*.25; // 0.28〜0.53
  const p=scores.map(v=>1/(1+Math.exp(-(v-sens)*12)));
  let bestDigit='?',best=-1,second=-1;
  for(const [digit,pat] of Object.entries(PATTERNS)){
    let score=0;
    for(let i=0;i<7;i++)score+=pat[i]?p[i]:(1-p[i]);
    score/=7;
    if(score>best){second=best;best=score;bestDigit=digit}else if(score>second)second=score;
  }
  const margin=best-second;
  const confidence=Math.max(0,Math.min(1,(best-.50)*1.5+margin*2.5));
  return {digit:(best>.57&&margin>.012)?bestDigit:'?',confidence,scores};
}

function analyze(){
  if(!running||!video.videoWidth)return;
  const sr=stage.getBoundingClientRect(),rr=roi.getBoundingClientRect();
  // stageはvideoの実アスペクト比に合わせているため、この座標変換で表示と解析位置が一致する。
  const xs=video.videoWidth/sr.width,ys=video.videoHeight/sr.height;
  const sx=Math.max(0,(rr.left-sr.left)*xs),sy=Math.max(0,(rr.top-sr.top)*ys);
  const fullSw=Math.min(video.videoWidth-sx,rr.width*xs),sh=Math.min(video.videoHeight-sy,rr.height*ys);
  const sw=fullSw*(+digitWidth.value/100);
  if(sw<45||sh<30)return;
  // 解析負荷を一定にしつつ十分な細部を残す。
  const targetW=Math.min(720,Math.max(240,Math.round(sw))),scale=targetW/sw,targetH=Math.max(80,Math.round(sh*scale));
  work.width=targetW;work.height=targetH;wctx.drawImage(video,sx,sy,sw,sh,0,0,targetW,targetH);
  const img=wctx.getImageData(0,0,targetW,targetH),gray=new Uint8Array(targetW*targetH);
  for(let i=0,p=0;i<img.data.length;i+=4,p++)gray[p]=Math.round(img.data[i]*.299+img.data[i+1]*.587+img.data[i+2]*.114);

  const decoded=[];
  // 桁間の余白を少し確保して、隣のセグメントがプローブに混ざりにくくする。
  for(let d=0;d<3;d++){
    const cell0=targetW*d/3,cell1=targetW*(d+1)/3,pad=(cell1-cell0)*.025;
    decoded.push(decodeDigit(gray,targetW,targetH,Math.floor(cell0+pad),Math.floor(cell1-pad)));
  }
  const raw=decoded.map(x=>x.digit).join(''),conf=decoded.reduce((s,x)=>s+x.confidence,0)/3;
  drawDebug(decoded,targetW,targetH);
  updateTemporal(raw,conf);
}

function updateTemporal(raw,conf){
  const now=performance.now();
  recent.push({raw,conf,t:now});recent=recent.filter(x=>now-x.t<420).slice(-5);
  let chosen=null,chosenConf=0;
  // 高信頼ならそのフレームを即表示。数値変化への遅延を最小化。
  if(!raw.includes('?')&&conf>=.60){chosen=raw;chosenConf=conf}
  else{
    const votes=new Map();
    for(const r of recent){if(r.raw.includes('?'))continue;votes.set(r.raw,(votes.get(r.raw)||0)+(.35+r.conf))}
    const ranked=[...votes.entries()].sort((a,b)=>b[1]-a[1]);
    if(ranked.length&&ranked[0][1]>=1.25){chosen=ranked[0][0];chosenConf=Math.min(1,ranked[0][1]/2.8)}
  }
  if(!chosen){statusEl.textContent='認識中…';return}
  valueEl.textContent=chosen;
  handleValue(chosen,chosenConf);
}

function handleValue(v,conf){
  if(v==='000'){
    nonZeroHits=0;zeroHits++;
    statusEl.textContent=`000確認 ${zeroHits}/${confirmRange.value}`;
    if(zeroHits>=+confirmRange.value&&!notified){notified=true;statusEl.textContent='000を検出しました';fireAlert()}
  }else{
    zeroHits=0;nonZeroHits++;
    // 1フレームの誤認識で再通知可能状態に戻さない。
    if(nonZeroHits>=2)notified=false;
    statusEl.textContent=`監視中 ${Math.round(conf*100)}%`;
  }
}

function drawDebug(decoded,w,h){
  debug.width=480;debug.height=180;dctx.drawImage(work,0,0,480,180);
  dctx.font='16px monospace';dctx.lineWidth=2;
  decoded.forEach((r,d)=>{
    const cellW=480/3;
    dctx.fillStyle='rgba(0,0,0,.65)';dctx.fillRect(d*cellW+4,4,78,22);
    dctx.fillStyle='#fff';dctx.fillText(`${r.digit} ${Math.round(r.confidence*100)}%`,d*cellW+9,21);
    PROBES.forEach((p,i)=>{const [rx,ry,rw,rh]=p;dctx.strokeStyle=(r.scores[i]||0)>.42?'#00ff88':'#ff5252';dctx.strokeRect(d*cellW+rx*cellW,ry*180,rw*cellW,rh*180)})
  })
}

function beep(){audioCtx||=new(window.AudioContext||window.webkitAudioContext)();const o=audioCtx.createOscillator(),g=audioCtx.createGain();o.frequency.value=880;g.gain.value=.08;o.connect(g);g.connect(audioCtx.destination);o.start();setTimeout(()=>o.stop(),900)}
async function fireAlert(){if(soundCheck.checked)beep();if(vibrateCheck.checked&&navigator.vibrate)navigator.vibrate([250,120,250,120,600]);if('Notification'in window&&Notification.permission==='granted'){try{const reg=await navigator.serviceWorker?.ready;if(reg)reg.showNotification('000を検出しました',{body:'3桁表示が000になりました。',tag:'seven-seg-zero'})}catch{}}}
async function requestNotification(){if(!('Notification'in window))return alert('このブラウザは通知に対応していません。');const p=await Notification.requestPermission();alert(p==='granted'?'通知を許可しました。':'通知は許可されませんでした。')}

let action=null;
roi.addEventListener('pointerdown',e=>{e.preventDefault();roi.setPointerCapture(e.pointerId);const r=roi.getBoundingClientRect(),s=stage.getBoundingClientRect();action={h:e.target.classList.contains('h'),c:e.target.className,x:e.clientX,y:e.clientY,l:r.left-s.left,t:r.top-s.top,w:r.width,hh:r.height,sw:s.width,sh:s.height}});
roi.addEventListener('pointermove',e=>{if(!action)return;let l=action.l,t=action.t,w=action.w,h=action.hh,dx=e.clientX-action.x,dy=e.clientY-action.y;if(!action.h){l+=dx;t+=dy}else{const c=action.c;if(c.includes('r'))w+=dx;if(c.includes('l')){l+=dx;w-=dx}if(c.includes('b'))h+=dy;if(c.includes('t')){t+=dy;h-=dy}}w=Math.max(120,Math.min(w,action.sw-l));h=Math.max(55,Math.min(h,action.sh-t));l=Math.max(0,Math.min(l,action.sw-w));t=Math.max(0,Math.min(t,action.sh-h));roi.style.left=l/action.sw*100+'%';roi.style.top=t/action.sh*100+'%';roi.style.width=w/action.sw*100+'%';roi.style.height=h/action.sh*100+'%'});
roi.addEventListener('pointerup',()=>{action=null;recent=[];save()});roi.addEventListener('pointercancel',()=>action=null);

$('#start').onclick=startCamera;$('#stop').onclick=stopCamera;$('#notify').onclick=requestNotification;
[threshold,polarity,confirmRange,digitWidth,soundCheck,vibrateCheck].forEach(el=>el.addEventListener('input',()=>{thresholdOut.value=threshold.value;confirmOut.value=confirmRange.value;digitWidthOut.value=digitWidth.value+'%';recent=[];save()}));
load();if('serviceWorker'in navigator)navigator.serviceWorker.register('./service-worker.js').catch(()=>{});
