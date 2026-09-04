// Compatibility loader. The page still references app-v2.js; load the current recognizer.
import('./app-v3.js?v=6').catch(err => {
  console.error(err);
  const status = document.querySelector('#status');
  if (status) status.textContent = '認識エンジンの読み込みに失敗しました';
});
