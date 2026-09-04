import { pipeline, RawImage } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1';

const $=s=>document.querySelector(s);
const video=$('#video'),stage=$('#stage'),roi=$('#roi'),valueEl=$('#value'),statusEl=$('#status');
const gpuStatus=$('#gpuStatus'),modelStatus=$('#modelStatus'),loadModelBtn=$('#loadModel');
const polarity=$('#polarity'),confirmRange=$('#confirm'),confirmOut=$('#confirmOut');
const soundCheck=$('#sound'),vibrateCheck=$('#vibrate'),flashCheck=$('#flash'),flashTest=$('#flashTest'),flashStatus=$('#flashStatus');
const debug=$('#debug'),dctx=debug.getContext('2d',{willReadFrequently:true});
const base=document.createElement('canvas'),bctx=base.getContext('2d',{willReadFrequently:true});
const variant=document.createElement('canvas'),vctx=variant.getContext('2d',{willReadFrequently:true});

let stream=null,videoTrack=null,running=false,torchSupported=false,torchBusy=false,audioCtx=null;
let ocr=null,modelLoading=false,inferBusy=false,lastInfer=0,recent=[],zeroHits=0,nonZeroHits=0,notified=false;
const INFER_GAP=450;

function save(){localStorage.setItem('webgpuOcrSettings',JSON.stringify({polarity:polarity.value,confirm:confirmRange.value,sound:soundCheck.checked,vibrate:vibrateCheck.checked,flash:flashCheck.checked,roi:{left:roi.style.left,top:roi.style.top,width:roi.style.width,height:roi.style.height}}))}
function load(){try{const s=JSON.parse(localStorage.getItem('webgpuOcrSettings')||localStorage.getItem('ocrSettingsV6')||'{}');if(s.polarity)polarity.value=s.polarity;if(s.confirm)confirmRange.value=s.confirm;if(typeof s.sound==='boolean')soundCheck.checked=s.sound;if(typeof s.vibrate==='boolean')vibrateCheck.checked=s.vibrate;if(typeof s.flash==='boolean')flashCheck.checked=s.flash;if(s.roi)Object.assign(roi.style,s.roi)}catch{}confirmOut.value=confirmRange.value}

async function checkWebGPU(){
  if(!navigator.gpu){gpuStatus.textContent='WebGPU非対応です。Chrome/Edgeの最新版で開いてください。';loadModelBtn.disabled=true;statusEl.textContent='WebGPU非対応';return false}
  try{
    const adapter=await navigator.gpu.requestAdapter({powerPreference:'high-performance'});
    if(!adapter){gpuStatus.textContent='WebGPUアダプターを取得できません。';loadModelBtn.disabled=true;return false}
    const info=adapter.info||{};
    const label=[info.vendor,info.architecture,info.device].filter(Boolean).join(' / ');
    gpuStatus.textContent='WebGPU利用可能'+(label?`：${label}`:'。');
    statusEl.textContent='モデル未読み込み';return true;
  }catch(e){gpuStatus.textContent='WebGPU初期化に失敗しました。';loadModelBtn.disabled=true;console.warn(e);return false}
}

async function loadModel(){
  if(ocr||modelLoading)return;
  modelLoading=true;loadModelBtn.disabled=true;modelStatus.textContent='TrOCRモデルを読み込み中… 初回は時間がかかります。';statusEl.textContent='モデル読み込み中…';
  try{
    ocr=await pipeline('image-to-text','Xenova/trocr-small-printed',{
      device:'webgpu',dtype:'fp16',
      progress_callback:p=>{if(p?.status==='progress'&&p.total){modelStatus.textContent=`モデル読み込み中… ${Math.round(p.loaded/p.total*100)}%`}}
    });
    modelStatus.textContent='WebGPU TrOCR 準備完了';statusEl.textContent=running?'監視中':'準備完了';
  }catch(e){console.error(e);modelStatus.textContent='モデル読み込みに失敗しました。WebGPU/VRAM/ブラウザを確認してください。';statusEl.textContent='モデルエラー';ocr=null;loadModelBtn.disabled=false}
  finally{modelLoading=false}
}

function updateTorchSupport(){videoTrack=stream?.getVideoTracks?.()[0]||null;torchSupported=false;try{torchSupported=!!videoTrack?.getCapabilities?.().torch}catch{}flashTest.disabled=!torchSupported;flashStatus.textContent=torchSupported?'フラッシュ対応：利用できます。':'このカメラ/ブラウザではフラッシュ制御を利用できません。'}
async function setTorch(on){if(!torchSupported||!videoTrack)return false;try{await videoTrack.applyConstraints({advanced:[{torch:!!on}]});return true}catch{return false}}
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function flashPattern(force=false){if((!force&&!flashCheck.checked)||!torchSupported||torchBusy)return;torchBusy=true;try{for(const [on,ms] of [[true,180],[false,120],[true,180],[false,120],[true,350],[false,0]]){if(!running)break;await setTorch(on);if(ms)await wait(ms)}}finally{await setTorch(false);torchBusy=false}}

async function startCamera(){
  try{
    statusEl.textContent='カメラ起動中…';
    stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'},width:{ideal:2560},height:{ideal:1440}},audio:false});
    video.srcObject=stream;await new Promise(r=>video.readyState>=1?r():video.addEventListener('loadedmetadata',r,{once:true}));await video.play();
    stage.style.aspectRatio=`${video.videoWidth}/${video.videoHeight}`;updateTorchSupport();
    $('#start').disabled=true;$('#stop').disabled=false;running=true;recent=[];zeroHits=nonZeroHits=0;notified=false;valueEl.textContent='---';statusEl.textContent=ocr?'監視中':'モデル未読み込み';schedule();
  }catch(e){statusEl.textContent='カメラを開始できません';alert('カメラ権限を確認してください。\n'+e.message)}
}
async function stopCamera(){running=false;try{await setTorch(false)}catch{}stream?.getTracks().forEach(t=>t.stop());stream=null;videoTrack=null;torchSupported=false;video.srcObject=null;stage.style.aspectRatio='';flashTest.disabled=true;flashStatus.textContent='カメラ開始後にフラッシュ対応状況を確認します。';$('#start').disabled=false;$('#stop').disabled=true;statusEl.textContent='停止中';valueEl.textContent='---';recent=[];zeroHits=nonZeroHits=0}
function schedule(){if(!running)return;requestAnimationFrame(()=>{if(!running)return;runRecognition();schedule()})}

function getCrop(){
  const sr=stage.getBoundingClientRect(),rr=roi.getBoundingClientRect(),xs=video.videoWidth/sr.width,ys=video.videoHeight/sr.height;
  const sx=Math.max(0,(rr.left-sr.left)*xs),sy=Math.max(0,(rr.top-sr.top)*ys),sw=Math.min(video.videoWidth-sx,rr.width*xs),sh=Math.min(video.videoHeight-sy,rr.height*ys);
  if(sw<50||sh<30)return null;
  const H=320,W=Math.max(320,Math.min(1280,Math.round(H*sw/sh)));
  base.width=W;base.height=H;bctx.drawImage(video,sx,sy,sw,sh,0,0,W,H);return {W,H};
}

function otsuThreshold(data){
  const hist=new Uint32Array(256);let total=0,sum=0;
  for(let i=0;i<data.length;i+=4){const g=Math.round(data[i]*.299+data[i+1]*.587+data[i+2]*.114);hist[g]++;sum+=g;total++}
  let sumB=0,wB=0,max=0,t=127;
  for(let i=0;i<256;i++){wB+=hist[i];if(!wB)continue;const wF=total-wB;if(!wF)break;sumB+=i*hist[i];const mB=sumB/wB,mF=(sum-sumB)/wF,v=wB*wF*(mB-mF)*(mB-mF);if(v>max){max=v;t=i}}
  return t;
}

function prepareVariant(mode){
  const W=base.width,H=base.height;variant.width=W;variant.height=H;vctx.drawImage(base,0,0);
  const im=vctx.getImageData(0,0,W,H),d=im.data,cut=otsuThreshold(d);
  let invert=false;
  if(polarity.value==='bright')invert=true;
  if(polarity.value==='auto'){
    let border=0,center=0,nb=0,nc=0;
    for(let y=0;y<H;y+=6)for(let x=0;x<W;x+=6){const p=(y*W+x)*4,g=.299*d[p]+.587*d[p+1]+.114*d[p+2];if(x<W*.14||x>W*.86||y<H*.12||y>H*.88){border+=g;nb++}else{center+=g;nc++}}
    invert=(center/nc)>(border/nb);
  }
  for(let p=0;p<d.length;p+=4){let g=Math.round(d[p]*.299+d[p+1]*.587+d[p+2]*.114);let v;if(mode==='binary'){const ink=invert?g>cut:g<cut;v=ink?0:255}else{if(invert)g=255-g;v=Math.max(0,Math.min(255,(g-128)*1.65+128));}d[p]=d[p+1]=d[p+2]=v;d[p+3]=255}
  vctx.putImageData(im,0,0);
  dctx.clearRect(0,0,debug.width,debug.height);debug.width=480;debug.height=Math.max(80,Math.round(480*H/W));dctx.drawImage(variant,0,0,debug.width,debug.height);
  return RawImage.fromCanvas(variant);
}

function digitsOnly(text){const m=String(text||'').match(/\d+/g);if(!m)return '';return m.join('').slice(0,4)}
async function recognizeOne(mode){const image=prepareVariant(mode);const out=await ocr(image,{max_new_tokens:8});const text=Array.isArray(out)?out[0]?.generated_text:out?.generated_text;return digitsOnly(text)}

async function runRecognition(){
  if(!running||!ocr||inferBusy||!video.videoWidth||performance.now()-lastInfer<INFER_GAP)return;
  lastInfer=performance.now();if(!getCrop())return;inferBusy=true;statusEl.textContent='WebGPU認識中…';
  try{
    const a=await recognizeOne('contrast');
    const b=await recognizeOne('binary');
    const candidates=[a,b].filter(x=>/^\d{1,4}$/.test(x));
    if(!candidates.length){statusEl.textContent='数字を認識できません';return}
    let raw=candidates[0];if(candidates.length===2&&a===b)raw=a;else if(candidates.length===2){const counts=new Map();for(const r of [...recent.map(x=>x.raw),a,b])counts.set(r,(counts.get(r)||0)+1);raw=[...counts.entries()].sort((x,y)=>y[1]-x[1])[0][0]}
    updateTemporal(raw,a===b&&a?2:1);
  }catch(e){console.warn('WebGPU OCR',e);statusEl.textContent='認識エラー'}finally{inferBusy=false}
}

function updateTemporal(raw,weight){
  const now=performance.now();recent.push({raw,weight,t:now});recent=recent.filter(x=>now-x.t<2600).slice(-6);
  const votes=new Map();for(const r of recent)votes.set(r.raw,(votes.get(r.raw)||0)+r.weight);
  const ranked=[...votes.entries()].sort((a,b)=>b[1]-a[1]);if(!ranked.length)return;
  const chosen=ranked[0][0],score=ranked[0][1];
  if(score<2){statusEl.textContent=`確認中：${raw}`;return}
  valueEl.textContent=chosen;handleValue(chosen,score);
}
function handleValue(v,score){if(/^0{1,4}$/.test(v)){nonZeroHits=0;zeroHits++;statusEl.textContent=`0確認 ${zeroHits}/${confirmRange.value}`;if(zeroHits>=+confirmRange.value&&!notified){notified=true;statusEl.textContent='0を検出しました';fireAlert()}}else{zeroHits=0;nonZeroHits++;if(nonZeroHits>=2)notified=false;statusEl.textContent=`監視中 WebGPU（票${score}）`}}

function beep(){audioCtx||=new(window.AudioContext||window.webkitAudioContext)();const o=audioCtx.createOscillator(),g=audioCtx.createGain();o.frequency.value=880;g.gain.value=.08;o.connect(g);g.connect(audioCtx.destination);o.start();setTimeout(()=>o.stop(),900)}
async function fireAlert(){if(soundCheck.checked)beep();if(vibrateCheck.checked&&navigator.vibrate)navigator.vibrate([250,120,250,120,600]);flashPattern();if('Notification'in window&&Notification.permission==='granted'){try{const reg=await navigator.serviceWorker?.ready;if(reg)reg.showNotification('0を検出しました',{body:'指定した表示が0になりました。',tag:'webgpu-ocr-zero'})}catch{}}}
async function requestNotification(){if(!('Notification'in window))return alert('このブラウザは通知に対応していません。');const p=await Notification.requestPermission();alert(p==='granted'?'通知を許可しました。':'通知は許可されませんでした。')}

let action=null;roi.addEventListener('pointerdown',e=>{e.preventDefault();roi.setPointerCapture(e.pointerId);const r=roi.getBoundingClientRect(),s=stage.getBoundingClientRect();action={h:e.target.classList.contains('h'),c:e.target.className,x:e.clientX,y:e.clientY,l:r.left-s.left,t:r.top-s.top,w:r.width,hh:r.height,sw:s.width,sh:s.height}});roi.addEventListener('pointermove',e=>{if(!action)return;let l=action.l,t=action.t,w=action.w,h=action.hh,dx=e.clientX-action.x,dy=e.clientY-action.y;if(!action.h){l+=dx;t+=dy}else{const c=action.c;if(c.includes('r'))w+=dx;if(c.includes('l')){l+=dx;w-=dx}if(c.includes('b'))h+=dy;if(c.includes('t')){t+=dy;h-=dy}}w=Math.max(90,Math.min(w,action.sw-l));h=Math.max(45,Math.min(h,action.sh-t));l=Math.max(0,Math.min(l,action.sw-w));t=Math.max(0,Math.min(t,action.sh-h));roi.style.left=l/action.sw*100+'%';roi.style.top=t/action.sh*100+'%';roi.style.width=w/action.sw*100+'%';roi.style.height=h/action.sh*100+'%'});roi.addEventListener('pointerup',()=>{action=null;recent=[];save()});roi.addEventListener('pointercancel',()=>action=null);

$('#start').onclick=startCamera;$('#stop').onclick=stopCamera;$('#notify').onclick=requestNotification;loadModelBtn.onclick=loadModel;flashTest.onclick=()=>flashPattern(true);
[polarity,confirmRange,soundCheck,vibrateCheck,flashCheck].forEach(el=>el.addEventListener('input',()=>{confirmOut.value=confirmRange.value;recent=[];save()}));
load();checkWebGPU();if('serviceWorker'in navigator)navigator.serviceWorker.register('./service-worker.js').catch(()=>{});
