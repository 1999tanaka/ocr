const $=s=>document.querySelector(s);
const video=$('#video'),stage=$('#stage'),valueEl=$('#value'),statusEl=$('#status');
const threshold=$('#threshold'),thresholdOut=$('#thresholdOut'),polarity=$('#polarity'),confirmRange=$('#confirm'),confirmOut=$('#confirmOut');
const soundCheck=$('#sound'),vibrateCheck=$('#vibrate'),debug=$('#debug'),dctx=debug.getContext('2d',{willReadFrequently:true});
const rois=[...document.querySelectorAll('.digit-roi')];
const work=document.createElement('canvas'),wctx=work.getContext('2d',{willReadFrequently:true});
const ocrCanvas=document.createElement('canvas'),ocrCtx=ocrCanvas.getContext('2d',{willReadFrequently:true});
let stream=null,running=false,lastAnalyzeAt=0,zeroHits=0,nonZeroHits=0,notified=false,audioCtx=null,recent=[];
let tesseractWorker=null,ocrReady=false,ocrBusy=false,lastOcrAt=0,lastOcrResult=null;
const ANALYZE_MS=80, OCR_MS=450;

const PATTERNS={
'0':[1,1,1,1,1,1,0],'1':[0,1,1,0,0,0,0],'2':[1,1,0,1,1,0,1],'3':[1,1,1,1,0,0,1],
'4':[0,1,1,0,0,1,1],'5':[1,0,1,1,0,1,1],'6':[1,0,1,1,1,1,1],'7':[1,1,1,0,0,0,0],
'8':[1,1,1,1,1,1,1],'9':[1,1,1,1,0,1,1]};
const PROBES=[[.27,.08,.47,.11],[.70,.18,.12,.27],[.66,.56,.12,.27],[.22,.83,.47,.11],[.17,.56,.12,.27],[.22,.18,.12,.27],[.25,.455,.47,.11]];

function save(){localStorage.setItem('sevenSegSettingsV5',JSON.stringify({threshold:threshold.value,polarity:polarity.value,confirm:confirmRange.value,sound:soundCheck.checked,vibrate:vibrateCheck.checked,rois:rois.map(r=>({left:r.style.left,top:r.style.top,width:r.style.width,height:r.style.height}))}))}
function load(){try{const s=JSON.parse(localStorage.getItem('sevenSegSettingsV5')||localStorage.getItem('sevenSegSettingsV4')||'{}');if(s.threshold)threshold.value=s.threshold;if(s.polarity)polarity.value=s.polarity;if(s.confirm)confirmRange.value=s.confirm;if(typeof s.sound==='boolean')soundCheck.checked=s.sound;if(typeof s.vibrate==='boolean')vibrateCheck.checked=s.vibrate;if(Array.isArray(s.rois))s.rois.forEach((v,i)=>{if(v&&rois[i])Object.assign(rois[i].style,v)})}catch{}thresholdOut.value=threshold.value;confirmOut.value=confirmRange.value}

function loadTesseract(){
  if(window.Tesseract)return initTesseract();
  const s=document.createElement('script');
  s.src='https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
  s.async=true;s.onload=initTesseract;s.onerror=()=>{ocrReady=false};document.head.appendChild(s);
}
async function initTesseract(){
  if(tesseractWorker||!window.Tesseract)return;
  try{
    tesseractWorker=await Tesseract.createWorker('eng',1,{logger:()=>{}});
    await tesseractWorker.setParameters({tessedit_char_whitelist:'0123456789',tessedit_pageseg_mode:'7',preserve_interword_spaces:'1'});
    ocrReady=true;
  }catch(e){console.warn('OCR init failed',e);ocrReady=false}
}

async function startCamera(){try{statusEl.textContent='カメラ起動中…';stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'},width:{ideal:1920},height:{ideal:1080}},audio:false});video.srcObject=stream;await new Promise(r=>video.readyState>=1?r():video.addEventListener('loadedmetadata',r,{once:true}));await video.play();stage.style.aspectRatio=`${video.videoWidth}/${video.videoHeight}`;$('#start').disabled=true;$('#stop').disabled=false;running=true;lastAnalyzeAt=0;zeroHits=nonZeroHits=0;recent=[];notified=false;valueEl.textContent='---';statusEl.textContent='監視中';scheduleFrame();if(!ocrReady&&!tesseractWorker)loadTesseract()}catch(e){statusEl.textContent='カメラを開始できません';alert('カメラ権限を確認してください。\n'+e.message)}}
function stopCamera(){running=false;stream?.getTracks().forEach(t=>t.stop());stream=null;video.srcObject=null;stage.style.aspectRatio='';$('#start').disabled=false;$('#stop').disabled=true;statusEl.textContent='停止中';valueEl.textContent='---';zeroHits=nonZeroHits=0;recent=[]}
function scheduleFrame(){if(!running)return;if('requestVideoFrameCallback'in HTMLVideoElement.prototype){video.requestVideoFrameCallback(now=>{if(!running)return;if(now-lastAnalyzeAt>=ANALYZE_MS){lastAnalyzeAt=now;analyze()}scheduleFrame()})}else setTimeout(()=>{if(!running)return;analyze();scheduleFrame()},ANALYZE_MS)}
function percentile(hist,total,q){let target=total*q,n=0;for(let i=0;i<256;i++){n+=hist[i];if(n>=target)return i}return 255}
function probeScore(gray,w,h,probe,lo,hi,isBright){const[rx,ry,rw,rh]=probe,bx=Math.max(0,Math.floor(rx*w)),by=Math.max(0,Math.floor(ry*h)),bw=Math.max(2,Math.floor(rw*w)),bh=Math.max(2,Math.floor(rh*h));const vals=[],range=Math.max(12,hi-lo);for(let y=by;y<Math.min(h,by+bh);y+=2)for(let x=bx;x<Math.min(w,bx+bw);x+=2){const g=gray[y*w+x],ink=isBright?(g-lo)/range:(hi-g)/range;vals.push(Math.max(0,Math.min(1,ink)))}if(!vals.length)return 0;vals.sort((a,b)=>b-a);const n=Math.max(1,Math.floor(vals.length*.42));let s=0;for(let i=0;i<n;i++)s+=vals[i];return s/n}
function decodeWithPolarity(gray,w,h,isBright){const hist=new Uint32Array(256);let total=0;for(let y=Math.floor(h*.04);y<Math.floor(h*.96);y+=2)for(let x=0;x<w;x+=2){hist[gray[y*w+x]]++;total++}const lo=percentile(hist,total,.08),hi=percentile(hist,total,.92);if(hi-lo<12)return{digit:'?',confidence:0,scores:[]};const scores=PROBES.map(p=>probeScore(gray,w,h,p,lo,hi,isBright));const sens=.25+(+threshold.value-20)/215*.23;const probs=scores.map(v=>1/(1+Math.exp(-(v-sens)*13)));let bestDigit='?',best=-1,second=-1;for(const[digit,pat]of Object.entries(PATTERNS)){let score=0;for(let i=0;i<7;i++)score+=pat[i]?probs[i]:1-probs[i];score/=7;if(score>best){second=best;best=score;bestDigit=digit}else if(score>second)second=score}const margin=best-second,confidence=Math.max(0,Math.min(1,(best-.48)*1.7+margin*2.8));return{digit:(best>.55&&margin>.008)?bestDigit:'?',confidence,scores}}
function cropInfo(r,sr,xs,ys){const rr=r.getBoundingClientRect();return{sx:Math.max(0,(rr.left-sr.left)*xs),sy:Math.max(0,(rr.top-sr.top)*ys),sw:Math.min(video.videoWidth,rr.width*xs),sh:Math.min(video.videoHeight,rr.height*ys)}}
function decodeCrop(c){const{sx,sy,sw,sh}=c,targetH=180,targetW=Math.max(80,Math.min(220,Math.round(targetH*sw/sh)));work.width=targetW;work.height=targetH;wctx.drawImage(video,sx,sy,sw,sh,0,0,targetW,targetH);const img=wctx.getImageData(0,0,targetW,targetH),gray=new Uint8Array(targetW*targetH);for(let i=0,p=0;i<img.data.length;i+=4,p++)gray[p]=Math.round(img.data[i]*.299+img.data[i+1]*.587+img.data[i+2]*.114);if(polarity.value==='bright')return decodeWithPolarity(gray,targetW,targetH,true);if(polarity.value==='dark')return decodeWithPolarity(gray,targetW,targetH,false);const dark=decodeWithPolarity(gray,targetW,targetH,false),bright=decodeWithPolarity(gray,targetW,targetH,true);return dark.confidence>=bright.confidence?dark:bright}

function buildOcrCanvas(crops){
  const cellW=150,H=220,gap=42,pad=24;ocrCanvas.width=pad*2+cellW*3+gap*2;ocrCanvas.height=H;
  ocrCtx.fillStyle='#fff';ocrCtx.fillRect(0,0,ocrCanvas.width,H);
  crops.forEach((c,i)=>{
    const tmp=document.createElement('canvas'),tc=tmp.getContext('2d',{willReadFrequently:true});tmp.width=120;tmp.height=180;tc.drawImage(video,c.sx,c.sy,c.sw,c.sh,0,0,120,180);
    const im=tc.getImageData(0,0,120,180),d=im.data,hist=new Uint32Array(256);let total=0;
    for(let p=0;p<d.length;p+=4){const g=Math.round(d[p]*.299+d[p+1]*.587+d[p+2]*.114);hist[g]++;total++}
    const lo=percentile(hist,total,.12),hi=percentile(hist,total,.88),cut=(lo+hi)/2;
    let darkMode=polarity.value==='dark';if(polarity.value==='auto'){let edges=0,center=0,n1=0,n2=0;for(let y=10;y<170;y+=3)for(let x=5;x<115;x+=3){const p=(y*120+x)*4,g=Math.round(d[p]*.299+d[p+1]*.587+d[p+2]*.114);if(x<20||x>100){edges+=g;n1++}else{center+=g;n2++}}darkMode=(center/n2)<(edges/n1)}
    for(let p=0;p<d.length;p+=4){const g=Math.round(d[p]*.299+d[p+1]*.587+d[p+2]*.114),ink=darkMode?g<cut:g>cut,v=ink?0:255;d[p]=d[p+1]=d[p+2]=v;d[p+3]=255}tc.putImageData(im,0,0);
    const x=pad+i*(cellW+gap);ocrCtx.imageSmoothingEnabled=false;ocrCtx.drawImage(tmp,x,18,cellW,H-36);
  });
}
async function runOcr(crops){
  if(!ocrReady||ocrBusy||performance.now()-lastOcrAt<OCR_MS)return;
  ocrBusy=true;lastOcrAt=performance.now();buildOcrCanvas(crops);
  try{const {data}=await tesseractWorker.recognize(ocrCanvas);const digits=(data.text||'').replace(/\D/g,'').slice(0,3);if(digits.length===3){lastOcrResult={raw:digits,conf:Math.max(0,Math.min(1,(data.confidence||0)/100)),t:performance.now()}}}catch(e){console.warn('OCR failed',e)}finally{ocrBusy=false}
}

function analyze(){if(!running||!video.videoWidth)return;const sr=stage.getBoundingClientRect(),xs=video.videoWidth/sr.width,ys=video.videoHeight/sr.height,crops=rois.map(r=>cropInfo(r,sr,xs,ys)),decoded=crops.map(c=>c.sw>=20&&c.sh>=30?decodeCrop(c):{digit:'?',confidence:0,scores:[]});const fastRaw=decoded.map(x=>x.digit).join(''),fastConf=decoded.reduce((s,x)=>s+x.confidence,0)/3;drawDebug(decoded);runOcr(crops);updateTemporal(fastRaw,fastConf)}
function updateTemporal(fastRaw,fastConf){const now=performance.now();recent.push({raw:fastRaw,conf:fastConf,t:now,src:'7seg'});if(lastOcrResult&&now-lastOcrResult.t<900)recent.push({raw:lastOcrResult.raw,conf:.55+.45*lastOcrResult.conf,t:lastOcrResult.t,src:'ocr'});recent=recent.filter(x=>now-x.t<500).slice(-8);let chosen=null,chosenConf=0;if(!fastRaw.includes('?')&&fastConf>=.72){chosen=fastRaw;chosenConf=fastConf}else{const votes=new Map();for(const r of recent){if(r.raw.includes('?')||r.raw.length!==3)continue;let weight=.25+r.conf;if(r.src==='ocr')weight*=1.25;votes.set(r.raw,(votes.get(r.raw)||0)+weight)}const ranked=[...votes.entries()].sort((a,b)=>b[1]-a[1]);if(ranked.length&&ranked[0][1]>=1.0){chosen=ranked[0][0];chosenConf=Math.min(1,ranked[0][1]/2.6)}}if(!chosen){statusEl.textContent=ocrReady?'認識中…':'認識中… OCR準備中';return}valueEl.textContent=chosen;handleValue(chosen,chosenConf)}
function handleValue(v,conf){if(v==='000'){nonZeroHits=0;zeroHits++;statusEl.textContent=`000確認 ${zeroHits}/${confirmRange.value}`;if(zeroHits>=+confirmRange.value&&!notified){notified=true;statusEl.textContent='000を検出しました';fireAlert()}}else{zeroHits=0;nonZeroHits++;if(nonZeroHits>=2)notified=false;statusEl.textContent=`監視中 ${Math.round(conf*100)}%${ocrReady?' +OCR':''}`}}
function drawDebug(decoded){debug.width=480;debug.height=160;dctx.clearRect(0,0,480,160);decoded.forEach((r,d)=>{const x=d*160;dctx.fillStyle='#111';dctx.fillRect(x,0,158,160);dctx.fillStyle='#fff';dctx.font='18px monospace';dctx.fillText(`${d+1}: ${r.digit} ${Math.round(r.confidence*100)}%`,x+8,24);PROBES.forEach((p,i)=>{const[rx,ry,rw,rh]=p;dctx.strokeStyle=(r.scores[i]||0)>.4?'#00e68a':'#ff5252';dctx.strokeRect(x+rx*150,35+ry*115,rw*150,rh*115)})});if(lastOcrResult){dctx.fillStyle='#fff';dctx.font='14px monospace';dctx.fillText(`OCR:${lastOcrResult.raw} ${Math.round(lastOcrResult.conf*100)}%`,8,154)}}
function beep(){audioCtx||=new(window.AudioContext||window.webkitAudioContext)();const o=audioCtx.createOscillator(),g=audioCtx.createGain();o.frequency.value=880;g.gain.value=.08;o.connect(g);g.connect(audioCtx.destination);o.start();setTimeout(()=>o.stop(),900)}
async function fireAlert(){if(soundCheck.checked)beep();if(vibrateCheck.checked&&navigator.vibrate)navigator.vibrate([250,120,250,120,600]);if('Notification'in window&&Notification.permission==='granted'){try{const reg=await navigator.serviceWorker?.ready;if(reg)reg.showNotification('000を検出しました',{body:'3桁表示が000になりました。',tag:'seven-seg-zero'})}catch{}}}
async function requestNotification(){if(!('Notification'in window))return alert('このブラウザは通知に対応していません。');const p=await Notification.requestPermission();alert(p==='granted'?'通知を許可しました。':'通知は許可されませんでした。')}
let action=null;rois.forEach(roi=>{roi.addEventListener('pointerdown',e=>{e.preventDefault();roi.setPointerCapture(e.pointerId);const r=roi.getBoundingClientRect(),s=stage.getBoundingClientRect();action={roi,h:e.target.classList.contains('h'),c:e.target.className,x:e.clientX,y:e.clientY,l:r.left-s.left,t:r.top-s.top,w:r.width,hh:r.height,sw:s.width,sh:s.height}});roi.addEventListener('pointermove',e=>{if(!action||action.roi!==roi)return;let l=action.l,t=action.t,w=action.w,h=action.hh,dx=e.clientX-action.x,dy=e.clientY-action.y;if(!action.h){l+=dx;t+=dy}else{const c=action.c;if(c.includes('r'))w+=dx;if(c.includes('l')){l+=dx;w-=dx}if(c.includes('b'))h+=dy;if(c.includes('t')){t+=dy;h-=dy}}w=Math.max(28,Math.min(w,action.sw-l));h=Math.max(48,Math.min(h,action.sh-t));l=Math.max(0,Math.min(l,action.sw-w));t=Math.max(0,Math.min(t,action.sh-h));roi.style.left=l/action.sw*100+'%';roi.style.top=t/action.sh*100+'%';roi.style.width=w/action.sw*100+'%';roi.style.height=h/action.sh*100+'%'});roi.addEventListener('pointerup',()=>{action=null;recent=[];lastOcrResult=null;save()});roi.addEventListener('pointercancel',()=>action=null)});
$('#start').onclick=startCamera;$('#stop').onclick=stopCamera;$('#notify').onclick=requestNotification;[threshold,polarity,confirmRange,soundCheck,vibrateCheck].forEach(el=>el.addEventListener('input',()=>{thresholdOut.value=threshold.value;confirmOut.value=confirmRange.value;recent=[];lastOcrResult=null;save()}));
load();loadTesseract();if('serviceWorker'in navigator)navigator.serviceWorker.register('./service-worker.js').catch(()=>{});
