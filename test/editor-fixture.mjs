import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);
const aceRoot = path.dirname(require.resolve('ace-builds/src-noconflict/ace.js'));
const monacoRoot = path.join(path.dirname(require.resolve('monaco-editor/package.json')), 'min');
const cmRoot = path.dirname(require.resolve('codemirror/package.json'));
export const sourceYaml = '# Nacos runtime settings\nserver:\n  port: 8080\nenv:\n  EXISTING: "keep this" # preserve comment\n  API_KEY: "fixture-private-value"\n';

export async function startEditorFixture() {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname.startsWith('/ace/') || url.pathname.startsWith('/vs/') || url.pathname.startsWith('/cm/')) {
        const isAce = url.pathname.startsWith('/ace/'), isCM = url.pathname.startsWith('/cm/');
        const root = isAce ? aceRoot : isCM ? cmRoot : monacoRoot;
        const relative = isAce ? url.pathname.slice(5) : isCM ? url.pathname.slice(4) : url.pathname.slice(1);
        const file = path.resolve(root, relative);
        if (!file.startsWith(path.resolve(root) + path.sep)) { res.writeHead(403); return res.end(); }
        res.setHeader('Content-Type', file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'application/javascript' : file.endsWith('.ttf') ? 'font/ttf' : 'application/octet-stream');
        return res.end(await readFile(file));
      }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      const value = JSON.stringify(sourceYaml);
      const shared = '<style>body{font:16px system-ui;margin:24px}.editor{width:1000px;height:550px;border:1px solid #aaa}textarea.editor{white-space:pre;font:16px monospace}</style><h1>Nacos-style YAML editor</h1>';
      let editor;
      if (url.pathname === '/ace') editor = `<div id="editor" class="editor"></div><script src="/ace/ace.js"></script><script>const editor=ace.edit('editor');editor.session.setUseWorker(false);editor.session.setMode('ace/mode/yaml');editor.setValue(${value},-1);window.fixtureReady=true;</script>`;
      else if (url.pathname === '/monaco') editor = `<div id="editor" class="editor"></div><script src="/vs/loader.js"></script><script>require.config({paths:{vs:'/vs'}});require(['vs/editor/editor.main'],function(){window.fixtureEditor=monaco.editor.create(document.querySelector('#editor'),{value:${value},language:'yaml',automaticLayout:true,minimap:{enabled:false}});window.fixtureReady=true;});</script>`;
      else if (url.pathname === '/codemirror5') editor = `<link rel="stylesheet" href="/cm/lib/codemirror.css"><div id="editor"></div><script src="/cm/lib/codemirror.js"></script><script>window.fixtureEditor=CodeMirror(document.querySelector('#editor'),{value:${value},mode:'yaml'});fixtureEditor.setSize(1000,550);window.fixtureReady=true;</script>`;
      else if (url.pathname === '/iframe') editor = '<iframe src="/textarea" style="width:1100px;height:630px" title="配置编辑器"></iframe><script>window.fixtureReady=true;</script>';
      else if (url.pathname === '/unsupported') editor = '<div class="cm-editor"><textarea></textarea></div><script>window.fixtureReady=true;</script>';
      else if (url.pathname === '/multiple') editor = `<textarea id="one" class="editor"></textarea><textarea id="two" class="editor"></textarea><script>one.value=${value};two.value='other: true\\n';window.fixtureReady=true;</script>`;
      else editor = `<textarea id="editor" class="editor" data-language="yaml"></textarea><script>editor.value=${value};window.fixtureReady=true;</script>`;
      res.end(`<!doctype html><html><head><title>YAML editor fixture</title></head><body>${shared}${editor}<button id="publish" onclick="window.publishCount++">发布</button><script>window.publishCount=0;</script></body></html>`);
    } catch (error) { res.writeHead(500); res.end(error.message); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) };
}
