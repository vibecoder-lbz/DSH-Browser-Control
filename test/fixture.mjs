import http from 'node:http';

const html = String.raw`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>Browser Use 本地演示</title>
<style>
body{font:18px system-ui;margin:40px;background:#f5f7fb;color:#172234}main{max-width:900px;margin:auto}h1{margin-bottom:8px}.card{background:white;border-radius:16px;padding:24px;margin:20px 0;box-shadow:0 3px 20px #16284b0a}label{display:block;margin:12px 0}input,select,button{font:inherit;padding:10px;border:1px solid #bcc8db;border-radius:8px}button{background:#205bdf;color:white;cursor:pointer}#result{margin-top:20px;color:#126c43}#canvas{border:1px solid #aaa;cursor:crosshair}iframe{width:100%;height:115px;border:1px solid #ddd}.spacer{height:1000px}
</style></head><body><main>
<h1>DSH Browser Use</h1><p>本地测试页 · 表单、Canvas、Shadow DOM 与 iframe</p>
<section class="card"><form id="form"><label>姓名 <input id="name" name="name" aria-label="姓名" placeholder="输入姓名" required></label>
<label>城市 <select id="city" aria-label="城市"><option value="sh">上海</option><option value="bj">北京</option></select></label>
<label>测试密码 <input id="password" type="password" value="secret-value" aria-label="测试密码"></label>
<button id="submit" type="submit">提交演示</button></form><p id="result" aria-live="polite">等待填写</p></section>
<section class="card"><canvas id="canvas" width="360" height="80" aria-label="画布">Canvas</canvas>
<button id="alert" onclick="alert('演示提示')">弹出提示</button><a id="popup" href="/popup" target="_blank">新标签页</a>
<div id="shadow"></div><iframe id="frame" title="内嵌表单" src="/frame"></iframe></section>
<div class="spacer"></div><button id="bottom">页面底部按钮</button></main>
<script>
document.querySelector('#form').addEventListener('submit', e=>{e.preventDefault();document.querySelector('#result').textContent='已提交：'+document.querySelector('#name').value+' / '+document.querySelector('#city').selectedOptions[0].text;});
const canvas=document.querySelector('#canvas'),ctx=canvas.getContext('2d');ctx.fillStyle='#205bdf';ctx.fillRect(0,0,360,80);ctx.fillStyle='white';ctx.font='20px sans-serif';ctx.fillText('点击画布测试坐标操作',35,48);canvas.addEventListener('click',()=>{canvas.dataset.clicked='true';ctx.fillStyle='#169957';ctx.fillRect(0,0,360,80);ctx.fillStyle='white';ctx.fillText('Canvas 已点击',90,48);});
const shadow=document.querySelector('#shadow').attachShadow({mode:'open'});shadow.innerHTML='<button id="shadow-button">Shadow 按钮</button>';shadow.querySelector('button').addEventListener('click',e=>{e.target.textContent='Shadow 已点击';});
</script></body></html>`;

export async function startFixture() {
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (req.url === '/frame') return res.end('<!doctype html><html><body><label>内嵌输入<input aria-label="内嵌输入"></label><button onclick="this.textContent=\'内嵌已点击\'">内嵌按钮</button></body></html>');
    if (req.url === '/popup') return res.end('<!doctype html><html><head><title>Popup</title></head><body><h1>新标签页已打开</h1><button>返回任务</button></body></html>');
    res.end(html);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}

export { html };
