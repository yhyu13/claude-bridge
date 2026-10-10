// serve.js — 本地静态服务 + /api 反代。
//
// 为什么需要反代：web/app.js 里所有请求都是相对路径（/api/poll、/api/status…），
// 所以页面必须和桥接同源。直接开桥接的 tailnet 地址在本机无头 Edge 上会被
// 单实例锁吞掉、内置浏览器还会返回逐字节相同的缓存快照，于是什么都验不了。
// 这里把 web/ 原样静态托管，并把 /api/* 转发到真桥接 —— 跑的是同一份
// app.js / style.css / 真后端，只是换了个源。
//
// 用法: node _mock/_bench/serve.js [port] [bridgeBase] [token]
//
// bridgeBase 不写死任何地址：桥接只绑 tailnet 网卡，它的地址属于**本机身份信息**，
// 提交前的 scan-secrets 会把它当成 IPv4 字面量拦下来（拦得对）。要连真桥接就
// 在命令行上把它当参数传，别写进文件。

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', 'web');
const PORT = Number(process.argv[2] || 8932);
const BRIDGE = process.argv[3] || 'http://127.0.0.1:8787';
const TOKEN = process.argv[4] || '';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
};

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const q = req.url.includes('?') ? '?' + req.url.split('?')[1] : '';

  if (url.startsWith('/api/')) {
    // 页面靠 ?t= 或 X-Bridge-Token 认证；反代负责把 token 补上，
    // 这样页面本身不需要知道自己被代理了。
    // 注意：必须**先剥掉**请求里已有的 t= 再补真的。曾经写成"有 t= 就不补"，
    // 而页面不带 token 时会发 `?t=&since=0`，拼出来是 `?t=&since=0&t=真值`，
    // 服务端读到第一个空值直接 401 —— 表现为页面一片空白，像是渲染坏了。
    const params = new URLSearchParams(req.url.includes('?') ? req.url.split('?')[1] : '');
    params.delete('t');
    if (TOKEN) params.set('t', TOKEN);
    const qs = params.toString();
    const target = BRIDGE + url + (qs ? '?' + qs : '');
    const proxyReq = http.request(target, { method: req.method, headers: { 'X-Bridge-Token': TOKEN } }, (pr) => {
      // Forward the cache directives too. Dropping them is not a neutral act:
      // with no Cache-Control on the response the browser is free to cache
      // /api/poll, which is how this harness reproduced a stale screen once and
      // nearly sent me chasing a bug that was not in the product.
      const h = { 'content-type': pr.headers['content-type'] || 'application/json' };
      for (const k of ['cache-control', 'pragma', 'etag']) if (pr.headers[k]) h[k] = pr.headers[k];
      res.writeHead(pr.statusCode || 502, h);
      pr.pipe(res);
    });
    proxyReq.on('error', (e) => { res.writeHead(502).end(JSON.stringify({ error: String(e) })); });
    req.pipe(proxyReq);
    return;
  }

  const rel = decodeURIComponent(url).replace(/^\/+/, '') || 'index.html';
  const file = path.resolve(ROOT, rel);
  if (!file.startsWith(ROOT)) { res.writeHead(403).end('no'); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404).end('404'); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('serving ' + ROOT);
  console.log('  页面   http://127.0.0.1:' + PORT + '/');
  console.log('  /api/* -> ' + BRIDGE + (TOKEN ? '  （已带 token）' : '  （无 token，将 401）'));
});
