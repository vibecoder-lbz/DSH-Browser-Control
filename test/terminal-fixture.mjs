import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const terminalScript = require.resolve('@xterm/xterm');
const terminalCss = path.join(path.dirname(terminalScript), '../css/xterm.css');
const webglScript = require.resolve('@xterm/addon-webgl');

// A local fake remote shell exercises real xterm.onData; it never runs host or cluster commands.
const terminalHTML = String.raw`<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/xterm.css">
<style>body{margin:10px;background:#101820;color:#eee;font-family:monospace}#terminal{height:400px;width:960px}</style></head><body>
<div id="terminal"></div><script src="/xterm.js"></script><script src="/webgl.js"></script><script>
const params=new URLSearchParams(location.search), visual=params.get('visual')==='1';
const terminal=new Terminal({cols:90,rows:18,screenReaderMode:!visual,allowProposedApi:true});
terminal.open(document.querySelector('#terminal'));
if(visual) terminal.loadAddon(new WebglAddon.WebglAddon());
window.received=[];window.executed=[];let line='';
const prompt=()=>terminal.write('\r\nasset$ ');
terminal.write('Local JumpServer-style terminal fixture');prompt();
terminal.onData(data=>{
 window.received.push(data);
 for(const ch of data){
  if(ch==='\r'){
   const command=line;line='';window.executed.push(command);terminal.write('\r\n');
   if(command==='kubectl config current-context') terminal.write('test-cluster-'+(params.get('name')||'one'));
   else if(command.startsWith('kubectl rollout status ')) {terminal.write('Waiting for rollout...');setTimeout(()=>{terminal.write('\r\ndeployment "demo" successfully rolled out');prompt();},600);continue;}
   else if(command==='sleep-test') {setTimeout(()=>{terminal.write('\r\nJOB_DONE_7f31');prompt();},500);continue;}
   else terminal.write('received: '+command);
   prompt();
  } else if(ch==='\u0015'){line='';terminal.write('\r\x1b[2Kasset$ ');}
  else if(ch==='\u0003'){line='';terminal.write('^C');prompt();}
  else if(ch==='\u007f'){if(line){line=line.slice(0,-1);terminal.write('\b \b');}}
  else{line+=ch;terminal.write(ch);}
 }
});
window.fixtureReady=true;
</script></body></html>`;

export async function startTerminalFixture() {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      const assets = { '/xterm.js': [terminalScript, 'application/javascript'], '/xterm.css': [terminalCss, 'text/css'], '/webgl.js': [webglScript, 'application/javascript'] };
      if (assets[url.pathname]) {
        const [filePath, mediaType] = assets[url.pathname];
        res.setHeader('Content-Type', mediaType);
        return res.end(await readFile(filePath));
      }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      if (url.pathname === '/ssh') return res.end(terminalHTML);
      const src = url.pathname === '/visual' ? '/ssh?visual=1' : '/ssh?name=one&token=fixture-token-7b91';
      return res.end(`<!doctype html><html><head><title>JumpServer terminal fixture</title></head><body><h1>Web SSH local fixture</h1><iframe title="SSH one" src="${src}" style="width:1000px;height:450px"></iframe>${url.pathname === '/multiple' ? '<iframe title="SSH two" src="/ssh?name=two" style="width:1000px;height:450px"></iframe>' : ''}</body></html>`);
    } catch (error) { res.writeHead(500); res.end(error.message); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}
