/**
 * live-server.js —— 伪装播放器的本地服务
 *
 * 作用：
 *   1. 用 http 协议提供页面（file:// 下 flv.js 会被 CORS 拦）
 *   2. /proxy?u=xxx  转发抖音 CDN 的流，补上 Referer / UA，绕开防盗链
 *   3. /resolve?u=xxx 传入直播间链接，返回 flv / m3u8 直链
 *
 * 用法：node live-server.js   然后浏览器打开 http://127.0.0.1:8848/
 */

'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 8848;
const ROOT = __dirname;
const PAGE = '伪装播放器.html';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm'
};

/* ---------------------------------------------------------------- 工具 */

function get(targetUrl, headers, redirectsLeft) {
  redirectsLeft = redirectsLeft === undefined ? 4 : redirectsLeft;

  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(targetUrl); } catch (e) { return reject(new Error('URL 不合法: ' + targetUrl)); }

    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'GET',
      headers: Object.assign({
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
      }, headers || {})
    }, (res) => {
      // 跟随重定向
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
        res.resume();
        const next = new URL(res.headers.location, targetUrl).href;
        return resolve(get(next, headers, redirectsLeft - 1));
      }

      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
          url: targetUrl
        });
      });
    });

    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('请求超时')));
    req.end();
  });
}

function collectCookies(setCookie) {
  if (!setCookie) return '';
  return setCookie.map((c) => String(c).split(';')[0]).filter(Boolean).join('; ');
}

function unescapeAll(text) {
  return String(text)
    .replace(/\\u0026/gi, '&')
    .replace(/\\u002F/gi, '/')
    .replace(/\\\//g, '/')
    .replace(/&amp;/g, '&');
}

function uniq(arr) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    if (!seen.has(x)) { seen.add(x); out.push(x); }
  }
  return out;
}

/**
 * 从页面 HTML 里捞流地址。
 * 注意：抖音把 URL 里的 & 写成 \u0026，必须先整体反转义再匹配，
 * 否则正则遇到反斜杠就截断，sign 参数会整个丢掉（导致 CDN 返回 403）。
 */
function scanStreams(text) {
  const t = unescapeAll(text);

  const grab = (ext) => {
    const re = new RegExp('https?://[^"\'\\s<>\\\\]+?\\.' + ext + '[^"\'\\s<>\\\\]*', 'gi');
    const m = t.match(re) || [];
    return m.map((s) => s.replace(/[\\"',)\]]+$/, ''));
  };

  return { flv: grab('flv'), m3u8: grab('m3u8') };
}

/** 挑可用的流：带签名的优先，避开可能是 H.265 的 or4 */
function rankFlv(list) {
  const score = (u) => {
    let s = 0;
    if (/sign=/.test(u)) s += 200;
    if (/_or4\.flv/.test(u)) s -= 120;
    if (/_uhd\.flv/.test(u)) s -= 20;
    if (/_hd\.flv/.test(u)) s += 30;
    if (/_sd\.flv/.test(u)) s += 40;
    if (/_ld\.flv/.test(u)) s += 15;
    if (/^https:/.test(u)) s += 5;
    return s;
  };
  return list.slice().sort((a, b) => score(b) - score(a));
}

/* ------------------------------------------------- 取抖音直播流地址 */

async function resolveStream(roomUrl) {
  // 第一次请求只为拿 ttwid 等 cookie
  let cookie = '';
  try {
    const first = await get(roomUrl);
    cookie = collectCookies(first.headers['set-cookie']);
  } catch (e) {
    /* 拿不到 cookie 也继续试 */
  }

  const page = await get(roomUrl, cookie ? { Cookie: cookie, Referer: 'https://live.douyin.com/' } : {});
  const html = page.body || '';

  if (page.status !== 200) {
    throw new Error('直播间页面返回 HTTP ' + page.status + '（可能需要登录或房间号无效）');
  }

  // 抖音把流地址塞在 RENDER_DATA / _ROUTER_DATA 里，可能被 URL 编码或转义
  let decoded = html;
  try { decoded = decodeURIComponent(html); } catch (e) { /* 忽略 */ }

  const a = scanStreams(html);
  const b = scanStreams(decoded);

  const flv = rankFlv(uniq(a.flv.concat(b.flv)));
  const m3u8 = uniq(a.m3u8.concat(b.m3u8));

  if (!flv.length && !m3u8.length) {
    throw new Error('页面里没找到流地址。可能房间未开播、需要登录，或抖音改了页面结构。');
  }

  return { flv, m3u8, cookie, referer: 'https://live.douyin.com/' };
}

/* ------------------------------------------------- B 站直播取流 */

async function resolveBilibili(roomUrl) {
  const m = String(roomUrl).match(/live\.bilibili\.com\/(\d+)/);
  if (!m) throw new Error('链接里没找到房间号，格式应为 https://live.bilibili.com/12345');

  let rid = m[1];

  // 短号转真实房间号，顺便判断开播状态
  try {
    const info = JSON.parse((await get('https://api.live.bilibili.com/room/v1/Room/get_info?room_id=' + rid, {
      Referer: 'https://live.bilibili.com/'
    })).body);
    if (info.code === 0 && info.data) {
      if (info.data.room_id) rid = info.data.room_id;
      if (info.data.live_status === 0 || info.data.live_status === 2) {
        throw new Error('这个房间当前未开播');
      }
    }
  } catch (e) {
    if (/未开播/.test(e.message)) throw e;
  }

  const api = 'https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo'
    + '?room_id=' + rid
    + '&protocol=0,1&format=0,1,2&codec=0&qn=10000&platform=web&ptype=8';

  const resp = await get(api, { Referer: 'https://live.bilibili.com/' });

  let data;
  try { data = JSON.parse(resp.body); } catch (e) { throw new Error('B 站接口返回异常'); }
  if (data.code !== 0) throw new Error('B 站接口报错：' + (data.message || data.code));

  const d = data.data || {};
  if (d.live_status === 0) throw new Error('这个房间当前未开播');

  const streams = (((d.playurl_info || {}).playurl || {}).stream) || [];
  const flv = [];
  const m3u8 = [];

  streams.forEach((st) => {
    (st.format || []).forEach((fmt) => {
      (fmt.codec || []).forEach((c) => {
        const ui = (c.url_info || [])[0];
        if (!ui || !c.base_url) return;
        const url = String((ui.host || '') + c.base_url + (ui.extra || '')).replace(/^http:\/\//, 'https://');
        if (st.protocol_name === 'http_stream') flv.push(url);
        else m3u8.push(url);
      });
    });
  });

  if (!flv.length && !m3u8.length) {
    throw new Error('没找到可用流（可能是付费直播或需要登录）');
  }

  return { flv, m3u8, referer: 'https://live.bilibili.com/' };
}

/* --------------------------------------------- 网页正文提取 */

/* 结构化提取失败时的兜底：按文本块切分，不依赖标签结构 */
function textBlocksToHtml(html) {
  let t = String(html)
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/(?:div|p|li|h[1-6]|tr|section|article|blockquote|td)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '');

  t = t.replace(/&nbsp;/g, ' ')
       .replace(/&amp;/g, '&')
       .replace(/&lt;/g, '<')
       .replace(/&gt;/g, '>')
       .replace(/&quot;/g, '"')
       .replace(/&#39;/g, "'");

  const lines = t.split('\n')
    .map((x) => x.replace(/\s+/g, ' ').trim())
    .filter((x) => x.length >= 15);

  if (lines.length < 3) return '';

  return lines.map((x) => '<p>' + x + '</p>').join('\n');
}

function extractArticle(rawHtml) {
  let s = String(rawHtml);
  const dbg = { srcLen: s.length };

  let title = '';
  const tm = s.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (tm) title = tm[1].replace(/\s+/g, ' ').trim();

  // 去掉不会出现在正文里的块
  s = s.replace(/<script[\s\S]*?<\/script>/gi, '')
       .replace(/<style[\s\S]*?<\/style>/gi, '')
       .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
       .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
       .replace(/<svg[\s\S]*?<\/svg>/gi, '')
       .replace(/<head[\s\S]*?<\/head>/gi, '')
       .replace(/<nav[\s\S]*?<\/nav>/gi, '')
       .replace(/<footer[\s\S]*?<\/footer>/gi, '')
       .replace(/<aside[\s\S]*?<\/aside>/gi, '')
       .replace(/<!--[\s\S]*?-->/g, '');

  // 优先取语义化的正文容器
  const cands = [
    /<article[^>]*>([\s\S]*?)<\/article>/i,
    /<main[^>]*>([\s\S]*?)<\/main>/i,
    /<div[^>]+(?:id|class)="[^"]*(?:article|content|post|detail|entry|main)[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    /<body[^>]*>([\s\S]*?)<\/body>/i
  ];

  // 挑选「最像正文」的容器：段落数量优先，其次文本长度
  let best = null;
  let bestScore = -1;
  for (const re of cands) {
    const m = re.exec(s);
    if (!m || !m[1]) continue;

    const txt = m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const pCount = (m[1].match(/<p\b/gi) || []).length;
    const score = pCount * 800 + txt.length;

    if (score > bestScore) {
      bestScore = score;
      best = m[1];
    }
  }
  if (!best) best = s;
  let body = best;

  dbg.bestScore = bestScore;
  dbg.bestPLen = (best.match(/<p\b/gi) || []).length;
  dbg.bestLen = best.length;

  // 拿到正文区域之后，再把「段落型 div」还原成 <p>。
  // 要求内部不含 div / section，否则非贪婪匹配会在第一个 </div> 截断，把结构搞乱。
  body = body.replace(
    /<(div|section)[^>]*class="[^"]*(?:bjh-p|rich_media_content|article-content|para|paragraph|text-p|content-text)[^"]*"[^>]*>((?:(?!<(?:div|section)\b)[\s\S])*?)<\/\1>/gi,
    '<p>$2</p>'
  );

  // 只保留这些标签，其余去掉但保留文字
  const ALLOW = new Set([
    'h1', 'h2', 'h3', 'h4', 'p', 'ul', 'ol', 'li', 'blockquote',
    'pre', 'code', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'strong', 'em', 'b', 'i', 'br', 'hr'
  ]);

  body = body.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g, (m, tag) => {
    const t = tag.toLowerCase();
    if (!ALLOW.has(t)) return '';
    return m.charAt(1) === '/' ? '</' + t + '>' : '<' + t + '>';
  });

  // 页面标题已经是 h1，正文里的 h1 降级
  body = body.replace(/<h1>/g, '<h2>').replace(/<\/h1>/g, '</h2>');

  // 丢掉过短的列表项和段落，多半是导航菜单或零碎按钮文字
  body = body.replace(/<li>([\s\S]*?)<\/li>/g, (m, inner) => {
    const t = inner.replace(/<[^>]+>/g, '').trim();
    return t.length >= 10 ? m : '';
  });
  body = body.replace(/<p>([\s\S]*?)<\/p>/g, (m, inner) => {
    const t = inner.replace(/<[^>]+>/g, '').trim();
    return t.length >= 5 ? m : '';
  });

  // 清理空标签与连续空行
  body = body.replace(/<p>\s*<\/p>/g, '')
             .replace(/<ul>\s*<\/ul>/g, '')
             .replace(/<ol>\s*<\/ol>/g, '')
             .replace(/\n{3,}/g, '\n\n')
             .trim();

  // 段落太少，说明结构化提取没成功，退回按文本块切分
  const bodyP = (body.match(/<p>/g) || []).length;
  dbg.bodyP = bodyP;
  dbg.bodyLen = body.length;

  if (bodyP < 2) {
    const fallback = textBlocksToHtml(s);
    dbg.fallbackLen = fallback.length;
    if (fallback) return { title, html: fallback, debug: dbg };
    return { title, html: '', debug: dbg };
  }

  return { title, html: body, debug: dbg };
}

/* --------------------------------------------- B 站普通视频（点播） */

async function resolveBilibiliVideo(videoUrl) {
  // 先从链接里找 BV 号；短链（b23.tv）需要跟随跳转后再找
  let m = String(videoUrl).match(/BV[0-9A-Za-z]{10}/);

  if (!m) {
    const r0 = await get(videoUrl, { Referer: 'https://www.bilibili.com/' });
    m = String(r0.url || '').match(/BV[0-9A-Za-z]{10}/) ||
        String(r0.body || '').match(/BV[0-9A-Za-z]{10}/);
  }

  if (!m) throw new Error('链接里没找到 BV 号，请用完整视频链接');

  const bvid = m[0];

  // 取 cid
  const vp = JSON.parse((await get('https://api.bilibili.com/x/web-interface/view?bvid=' + bvid, {
    Referer: 'https://www.bilibili.com/'
  })).body);

  if (vp.code !== 0 || !vp.data) {
    throw new Error('取视频信息失败：' + (vp.message || vp.code));
  }

  const cid = vp.data.cid;

  // 不带 fnval 时返回单文件（mp4 / flv），比 DASH 好处理
  const api = 'https://api.bilibili.com/x/player/playurl'
    + '?bvid=' + bvid + '&cid=' + cid + '&qn=64&fnver=0&fourk=0';

  const pp = JSON.parse((await get(api, { Referer: 'https://www.bilibili.com/' })).body);

  if (pp.code !== 0 || !pp.data) {
    throw new Error('取播放地址失败：' + (pp.message || pp.code));
  }

  const durl = pp.data.durl || [];
  if (!durl.length) {
    throw new Error('没拿到播放地址（付费或大会员专享视频无法播放）');
  }

  const direct = durl.map((d) => d.url).filter(Boolean);

  return {
    title: (vp.data.title || '').slice(0, 40),
    direct: direct,
    multi: direct.length > 1,
    referer: 'https://www.bilibili.com/'
  };
}

/* --------------------------------------------- 按域名选 Referer */

function refererFor(target) {
  const t = String(target).toLowerCase();
  if (t.indexOf('douyin') > -1) return 'https://live.douyin.com/';
  if (t.indexOf('bilivideo') > -1 || t.indexOf('bilibili') > -1) return 'https://live.bilibili.com/';
  return '';
}

/* ------------------------------------------------------------ 流转发 */

function proxyStream(target, req, res, refOverride) {
  let tu;
  try { tu = new URL(target); } catch (e) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('流地址不合法');
  }

  const mod = tu.protocol === 'https:' ? https : http;

  const ref = refOverride || refererFor(target);
  const headers = {
    'User-Agent': UA,
    'Accept': '*/*',
    'Accept-Encoding': 'identity'
  };
  if (ref) {
    headers['Referer'] = ref;
    headers['Origin'] = ref.replace(/\/$/, '');
  }
  if (req.headers.range) headers['Range'] = req.headers.range;

  const preq = mod.request({
    hostname: tu.hostname,
    port: tu.port || (tu.protocol === 'https:' ? 443 : 80),
    path: tu.pathname + tu.search,
    method: 'GET',
    headers
  }, (pres) => {
    const out = Object.assign({}, pres.headers);
    // 放开跨域，去掉会拦死我们的头
    delete out['content-security-policy'];
    delete out['content-security-policy-report-only'];
    delete out['x-frame-options'];

    // 点播（mp4 / 206 分段）必须保留 content-length 和 content-range，
    // 否则浏览器算不出总时长、也算不出进度，拖进度条会直接卡死。
    // 直播（FLV）是无限流，反而不能带 content-length，否则浏览器会一直等"下完"。
    const isPartial = pres.statusCode === 206;
    const ctype = String(pres.headers['content-type'] || '');
    const isVod = isPartial || /^(video|audio)\//i.test(ctype);

    if (isVod) {
      delete out['transfer-encoding'];
    } else {
      delete out['content-length'];
      delete out['transfer-encoding'];
    }

    delete out['content-encoding'];
    delete out['connection'];
    delete out['keep-alive'];

    if (isVod && !out['accept-ranges']) out['accept-ranges'] = 'bytes';

    out['access-control-allow-origin'] = '*';
    out['cache-control'] = isVod ? 'max-age=3600' : 'no-cache';

    let code = pres.statusCode;
    if (code < 200 || code > 599) code = 200;

    res.writeHead(code, out);
    pres.pipe(res);
  });

  preq.on('error', (e) => {
    try {
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('转发失败：' + e.message);
    } catch (_) { /* 已断开 */ }
  });

  req.on('close', () => { try { preq.destroy(); } catch (_) {} });

  preq.end();
}

/* ---------------------------------------------------------- 静态文件 */

function serveStatic(pathname, res) {
  let p = decodeURIComponent(pathname);
  if (p === '/' || p === '') p = '/' + PAGE;

  const full = path.join(ROOT, p);
  const rel = path.relative(ROOT, full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    res.writeHead(403);
    return res.end('forbidden');
  }

  fs.readFile(full, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 not found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(data);
  });
}

/* -------------------------------------------------------------- 服务 */

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1:' + PORT);

  if (u.pathname === '/ads') {
    const dir = path.join(ROOT, 'ads');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    fs.readdir(dir, (err, files) => {
      if (err) return res.end(JSON.stringify({ ok: true, files: [] }));
      const list = files
        .filter((f) => /\.(mp4|webm)$/i.test(f))
        .sort();
      res.end(JSON.stringify({ ok: true, files: list }));
    });
    return;
  }

  if (u.pathname === '/docs-list') {
    const dir = path.join(ROOT, 'docs');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    fs.readdir(dir, (err, files) => {
      if (err) return res.end(JSON.stringify({ ok: true, files: [] }));
      const list = files
        .filter((f) => /\.(html?|md)$/i.test(f))
        .sort()
        .map((f) => {
          const base = f.replace(/\.[^.]+$/, '');
          const m = base.match(/^\d+[-_.\s]+(.+)$/);
          return {
            file: f,
            title: (m ? m[1] : base).trim(),
            type: /\.md$/i.test(f) ? 'md' : 'html'
          };
        });
      res.end(JSON.stringify({ ok: true, files: list, dir: 'docs' }));
    });
    return;
  }

  if (u.pathname === '/fetch') {
    const target = u.searchParams.get('u');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (!target) {
      res.writeHead(400);
      return res.end(JSON.stringify({ ok: false, error: '缺少参数 u' }));
    }
    try {
      const r = await get(target);
      if (r.status !== 200) throw new Error('目标页面返回 HTTP ' + r.status);

      // 百度系常见：被风控后 302 到安全验证页，页面本身还能返回 200，但内容没用
      if (/wappass\.baidu\.com|\/captcha\//i.test(r.url || '') || /百度安全验证/.test(r.body)) {
        throw new Error('被百度的安全验证拦了，等十几分钟再试，或者换个来源');
      }
      const a = extractArticle(r.body);
      if (!a.html) {
        res.writeHead(200);
        return res.end(JSON.stringify({
          ok: false,
          error: '这个页面没找到成段的正文（可能是列表页，或需要登录）',
          debug: Object.assign({}, a.debug || {}, {
            status: r.status,
            finalUrl: r.url,
            rawHead: String(r.body).slice(0, 160)
          })
        }));
      }
      if (a.html.replace(/<[^>]+>/g, '').trim().length < 80) {
        throw new Error('正文太短，不适合当文档');
      }
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, title: a.title, html: a.html, url: r.url }));
    } catch (e) {
      res.writeHead(200);
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  if (u.pathname === '/save-doc' && req.method === 'POST') {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 3 * 1024 * 1024) req.destroy();
    });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      try {
        const d = JSON.parse(raw);
        const title = String(d.title || '网页内容')
          .replace(/[\\/:*?"<>|]/g, '_')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 60) || '网页内容';
        const html = String(d.html || '');

        if (html.replace(/<[^>]+>/g, '').trim().length < 50) {
          throw new Error('内容太短，不保存');
        }

        const dir = path.join(ROOT, 'docs');
        fs.mkdirSync(dir, { recursive: true });

        const nums = fs.readdirSync(dir).map((f) => {
          const m = f.match(/^(\d+)-/);
          return m ? Number(m[1]) : 0;
        });
        const next = (nums.length ? Math.max.apply(null, nums) : 0) + 1;
        const name = String(next).padStart(2, '0') + '-' + title + '.html';

        fs.writeFileSync(path.join(dir, name), html, 'utf8');

        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, file: name }));
      } catch (e) {
        res.writeHead(200);
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  if (u.pathname === '/proxy') {
    const target = u.searchParams.get('u');
    if (!target) {
      res.writeHead(400);
      return res.end('缺少参数 u');
    }
    return proxyStream(target, req, res, u.searchParams.get('r') || '');
  }

  if (u.pathname === '/resolve') {
    const room = u.searchParams.get('u');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (!room) {
      res.writeHead(400);
      return res.end(JSON.stringify({ ok: false, error: '缺少参数 u' }));
    }
    try {
      let r;
      if (/live\.bilibili\.com/i.test(room)) {
        r = await resolveBilibili(room);
      } else if (/bilibili\.com|b23\.tv|BV[0-9A-Za-z]{10}/i.test(room)) {
        r = await resolveBilibiliVideo(room);
      } else if (/douyin\.com/i.test(room)) {
        r = await resolveStream(room);
      } else {
        throw new Error('暂不支持这个站点，可以直接粘贴 .flv / .m3u8 / .mp4 直链');
      }
      res.writeHead(200);
      res.end(JSON.stringify({
        ok: true,
        flv: r.flv || [],
        m3u8: r.m3u8 || [],
        direct: r.direct || [],
        referer: r.referer || '',
        title: r.title || '',
        multi: !!r.multi
      }));
    } catch (e) {
      res.writeHead(200);
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  serveStatic(u.pathname, res);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('  伪装播放器已启动');
  console.log('  ─────────────────────────────────────');
  console.log('  地址： http://127.0.0.1:' + PORT + '/');
  console.log('  取流： 在页面里按 L 粘贴直播间链接');
  console.log('');
  console.log('  关闭这个窗口即停止服务。');
  console.log('');
});
