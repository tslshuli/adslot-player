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

// TVBox 配置源：只取 type=1 的 JSON CMS 站点（能直接按 ?wd= 搜索）
const TVBOX_CONFIG = 'https://8899-agqwhgsg5mulbeqpyjhjxw4azm.instabox.tech/tvbox.json';
let tvboxSites = null;          // 缓存站点列表
let tvboxSitesAt = 0;

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

function get(targetUrl, headers, redirectsLeft, timeoutMs) {
  redirectsLeft = redirectsLeft === undefined ? 4 : redirectsLeft;
  timeoutMs = timeoutMs || 15000;

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
        return resolve(get(next, headers, redirectsLeft - 1, timeoutMs));
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
    req.setTimeout(timeoutMs, () => req.destroy(new Error('请求超时')));
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

/* 纯文本 / 源码文件（.js / .css / .json / .txt / .md 等）：
   没有 HTML 结构，整段转义后包成代码块，避免被当标签清洗掉 */
function codeToArticle(text, finalUrl) {
  let src = String(text);
  const dbg = { srcLen: src.length, kind: 'code' };

  // 标题：优先取油猴脚本的 @name，否则取 URL 最后一段
  let title = '';
  const nm = src.match(/@name\s+([^\r\n]+)/i);
  if (nm) title = nm[1].trim();
  if (!title) {
    try {
      const last = new URL(finalUrl || '').pathname.split('/').filter(Boolean).pop();
      title = decodeURIComponent(last || '源码');
    } catch (e) { title = '源码'; }
  }
  if (title.length > 60) title = title.slice(0, 60);

  // 关键：转义 & < > " '，否则代码里的尖括号会被当 HTML 标签吃掉
  const esc = src.replace(/&/g, '&amp;')
                 .replace(/</g, '&lt;')
                 .replace(/>/g, '&gt;')
                 .replace(/"/g, '&quot;')
                 .replace(/'/g, '&#39;');

  const html = '<pre><code>' + esc + '</code></pre>';
  dbg.bodyLen = html.length;
  return { title, html, debug: dbg };
}

/* 判断响应是否为纯文本/源码（非 HTML 网页） */
function isPlainTextContent(ctype, rawBody, finalUrl) {
  const ct = String(ctype || '').toLowerCase();
  // 明确的文本/代码类型
  if (/\b(text\/|application\/(javascript|json|xml|x-sh)|application\/octet-stream)/i.test(ct)) {
    return !/text\/html/i.test(ct);
  }
  // 没有 content-type 时，看内容和扩展名兜底
  if (!ct) {
    const ext = String(finalUrl || '').toLowerCase().match(/\.(js|mjs|ts|css|json|txt|md|xml|py|sh|yml|yaml|log)(\?|$)/);
    if (ext) return true;
    if (/^\s*(\/\/==UserScript==|<!DOCTYPE html|<html[\s>])/i.test(rawBody) === false && !/[<]/.test(rawBody)) return true;
  }
  return false;
}

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

// 取单集播放直链（不带 fnval，返回单文件 mp4，比 DASH 好处理）
async function fetchBiliDirect(bvid, cid) {
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

  return durl.map((d) => d.url).filter(Boolean);
}

// opt.bvid / opt.cid：切集时指定目标集，避免只按 p= 定位在合集里失效
async function resolveBilibiliVideo(videoUrl, opt) {
  opt = opt || {};

  // 先从链接里找 BV 号；短链（b23.tv）需要跟随跳转后再找
  let m = String(videoUrl).match(/BV[0-9A-Za-z]{10}/);

  if (!m) {
    const r0 = await get(videoUrl, { Referer: 'https://www.bilibili.com/' });
    m = String(r0.url || '').match(/BV[0-9A-Za-z]{10}/) ||
        String(r0.body || '').match(/BV[0-9A-Za-z]{10}/);
  }

  if (!m) throw new Error('链接里没找到 BV 号，请用完整视频链接');

  const bvid = m[0];

  // ?p=N 只用于分P视频的起点
  let startPage = 1;
  const pm = String(videoUrl).match(/[?&]p=(\d+)/);
  if (pm) startPage = Math.max(1, parseInt(pm[1], 10) || 1);

  const vp = JSON.parse((await get('https://api.bilibili.com/x/web-interface/view?bvid=' + bvid, {
    Referer: 'https://www.bilibili.com/'
  })).body);

  if (vp.code !== 0 || !vp.data) {
    throw new Error('取视频信息失败：' + (vp.message || vp.code));
  }

  const d = vp.data;
  let episodes = [];
  let hasSeason = false;

  // 形态一：UP 主合集 / 系列 —— 每集是独立 BV
  const season = d.ugc_season;
  if (season && season.sections) {
    season.sections.forEach(function (sec) {
      (sec.episodes || []).forEach(function (ep) {
        if (ep.bvid && ep.cid) {
          episodes.push({
            bvid: ep.bvid,
            cid: ep.cid,
            title: String(ep.title || ep.page?.part || '').slice(0, 40),
            section: String(sec.title || '').slice(0, 20)
          });
        }
      });
    });
    hasSeason = episodes.length > 0;
  }

  // 形态二：分P视频 —— 同一个 BV，不同 cid
  if (!episodes.length && d.pages && d.pages.length > 1) {
    episodes = d.pages.map(function (p) {
      return {
        bvid: bvid,
        cid: p.cid,
        title: String(p.part || '').slice(0, 40),
        page: p.page
      };
    });
  }

  // 形态三：单集兜底
  if (!episodes.length) {
    episodes = [{ bvid: bvid, cid: d.cid, title: String(d.title || '').slice(0, 40), page: 1 }];
  }

  // 决定从第几集开始
  let index = 0;
  if (opt.bvid && opt.cid) {
    const found = episodes.findIndex(function (e) {
      return e.bvid === opt.bvid && String(e.cid) === String(opt.cid);
    });
    if (found >= 0) index = found;
  } else if (hasSeason) {
    // 合集：定位到用户粘贴的那一集
    const found = episodes.findIndex(function (e) { return e.bvid === bvid; });
    if (found >= 0) index = found;
  } else if (episodes.length > 1) {
    // 分P：按 ?p=
    const found = episodes.findIndex(function (e) { return e.page === startPage; });
    if (found >= 0) index = found;
  }

  const cur = episodes[index];
  const direct = await fetchBiliDirect(cur.bvid, cur.cid);

  return {
    title: cur.title,
    direct: direct,
    multi: direct.length > 1,
    referer: 'https://www.bilibili.com/',
    episodes: episodes,
    index: index
  };
}

/* --------------------------------------------- TVBox 资源搜索 */

// 拉配置并缓存 type=1 的 JSON CMS 站点
async function loadTvboxSites() {
  if (tvboxSites && Date.now() - tvboxSitesAt < 3600 * 1000) return tvboxSites;
  const r = await get(TVBOX_CONFIG, { 'User-Agent': UA }, 4, 12000);
  const cfg = JSON.parse(r.body);
  tvboxSites = (cfg.sites || []).filter((s) => s.type === 1 && s.api && s.searchable !== 0);
  tvboxSitesAt = Date.now();
  return tvboxSites;
}

// 单站点搜索：CMS 的 ?wd= 接口
async function tvboxSearchOne(site, wd) {
  const sep = site.api.indexOf('?') > -1 ? '&' : '?';
  const url = site.api + sep + 'wd=' + encodeURIComponent(wd);
  const r = await get(url, { 'User-Agent': UA, 'Referer': 'https://' }, 3, 9000);
  const j = JSON.parse(r.body);
  const list = Array.isArray(j.list) ? j.list : [];
  return list.map((v) => ({
    key: site.key,
    site: String(site.name || '').replace(/[^\u4e00-\u9fa5A-Za-z0-9 ]/g, '').trim().slice(0, 12),
    id: String(v.vod_id),
    name: String(v.vod_name || '').slice(0, 60),
    type: String(v.type_name || ''),
    year: String(v.vod_year || ''),
    remarks: String(v.vod_remarks || '').slice(0, 20),
    pic: String(v.vod_pic || '')
  }));
}

// 搜全部站点，并发 + 超时保护
// 关键：有些站点不认 wd 参数，会返回默认热门列表，必须按关键词过滤掉，
// 否则无关结果会把真正搜到的挤到后面，用户翻不到
async function tvboxSearch(wd) {
  const sites = await loadTvboxSites();
  const results = await Promise.all(sites.map((s) =>
    tvboxSearchOne(s, wd).then((list) => ({ ok: true, list })).catch(() => ({ ok: false, list: [] }))
  ));

  const okSites = results.filter((r) => r.ok).length;
  const kw = String(wd).replace(/\s+/g, '');

  // 按「名字是否含关键词」过滤 + 打分，不同站点同一部剧合并成一条
  const byKey = new Map();
  for (const r of results) {
    for (const v of r.list) {
      const nm = v.name.replace(/\s+/g, '');
      if (nm.indexOf(kw) === -1) continue;   // 名字不含关键词 → 丢弃
      // 相关度：完全等于 100，以关键词开头 80，包含 60
      let score = 60;
      if (nm === kw) score = 100;
      else if (nm.indexOf(kw) === 0) score = 80;

      const k = v.name + '|' + v.year;
      const cur = byKey.get(k);
      if (cur) {
        // 同一部剧，多个站点来源合并，保留分最高的
        cur.sites.push({ key: v.key, site: v.site, id: v.id });
        if (score > cur.score) { cur.score = score; cur.name = v.name; cur.key = v.key; cur.site = v.site; cur.id = v.id; }
      } else {
        byKey.set(k, { ...v, score: score, sites: [{ key: v.key, site: v.site, id: v.id }] });
      }
    }
  }

  const merged = Array.from(byKey.values()).sort((a, b) => b.score - a.score);
  return {
    sites: sites.length,
    okSites: okSites,
    list: merged.slice(0, 60)
  };
}

// 判断一个地址是不是「网页播放页」而不是视频直链
// 有些源给 /share/xxx 这种网页，播放器当视频加载会失败，要优先避开
function isPageUrl(u) {
  return /\/share\//i.test(u) || /\/play\//i.test(u) && !/\.(m3u8|mp4|flv)(\?|$)/i.test(u);
}

// 解析 vod_play_url：格式 "第01集$url#第02集$url#..."
// 多个播放源用 $$$ 分隔：vod_play_from = "源A$$$源B"
// 策略：优先选「所有集都是直链」的源；都含网页页时退而取其全集数最多的
function parseVodPlayUrl(playFrom, playUrl) {
  const froms = String(playFrom || '').split('$$$').filter(Boolean);
  const blocks = String(playUrl || '').split('$$$');

  function parseBlock(block) {
    const lines = String(block || '').split('#').filter(Boolean);
    const eps = [];
    for (const line of lines) {
      const at = line.indexOf('$');
      if (at < 0) continue;
      const title = line.slice(0, at).trim();
      const url = line.slice(at + 1).trim();
      if (!/^https?:\/\//i.test(url)) continue;
      eps.push({ title: title.slice(0, 30), url: url, page: isPageUrl(url) });
    }
    return eps;
  }

  let best = { bi: 0, eps: [], score: -1 };
  blocks.forEach((blk, i) => {
    const eps = parseBlock(blk);
    if (!eps.length) return;
    const pageCount = eps.filter((e) => e.page).length;
    // 全直链 = 1000 分；含网页页则按直链比例扣分；集数多加分
    const score = (pageCount === 0 ? 1000 : Math.round((1 - pageCount / eps.length) * 500)) + eps.length;
    if (score > best.score) best = { bi: i, eps: eps, score: score };
  });

  return {
    source: froms[best.bi] || '默认',
    episodes: best.eps,
    hasPageUrl: best.eps.some((e) => e.page)
  };
}

// 详情：拿分集列表
async function tvboxDetail(key, id) {
  const sites = await loadTvboxSites();
  const site = sites.find((s) => s.key === key);
  if (!site) throw new Error('站点不存在：' + key);
  const sep = site.api.indexOf('?') > -1 ? '&' : '?';
  const url = site.api + sep + 'ac=detail&ids=' + encodeURIComponent(id)
            + '&wd=' + encodeURIComponent('');
  const r = await get(url, { 'User-Agent': UA, 'Referer': 'https://' }, 3, 10000);
  const j = JSON.parse(r.body);
  const v = (j.list || [])[0];
  if (!v) throw new Error('没找到这部剧的详情');
  const parsed = parseVodPlayUrl(v.vod_play_from, v.vod_play_url);
  return {
    name: String(v.vod_name || '').slice(0, 60),
    site: key,
    source: parsed.source,
    episodes: parsed.episodes,
    hasPageUrl: !!parsed.hasPageUrl
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

// 改写 m3u8：把相对路径的 key / 分片改成走本地代理的绝对地址，
// 否则 hls.js 会把 enc.key 解析到 127.0.0.1 根目录导致 404
function rewriteM3u8(body, baseUrl, ref) {
  let text = String(body);
  let base;
  try { base = new URL(baseUrl); } catch (e) { return text; }

  const proxify = (raw) => {
    const u = new URL(raw, baseUrl).href;
    let p = '/proxy?u=' + encodeURIComponent(u);
    if (ref) p += '&r=' + encodeURIComponent(ref);
    return p;
  };

  // #EXT-X-KEY 的 URI="..."（相对或绝对都统一走代理）
  text = text.replace(/URI="([^"]+)"/g, (m, uri) => {
    if (/^data:/i.test(uri)) return m;
    return 'URI="' + proxify(uri) + '"';
  });

  // 分片行 / 子播放列表行：非 # 开头、非绝对 URL、非空
  text = text.split('\n').map(function (line) {
    const t = line.trim();
    if (!t || t.charAt(0) === '#') return line;
    if (/^https?:\/\//i.test(t)) {
      // 绝对地址也走代理，避免浏览器直连被防盗链拦
      return proxify(t);
    }
    return proxify(t);
  }).join('\n');

  return text;
}

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
    headers,
    // 每个分段单独建连，不复用连接池，避免长连接卡死后续请求
    agent: false
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
    // 隐私：视频分片一律禁止落盘缓存。原先点播给了 max-age=3600，
    // 会把 ts/mp4 写进浏览器磁盘缓存躺一小时，这里全部改成 no-store。
    out['cache-control'] = 'no-store, no-cache, must-revalidate';
    out['pragma'] = 'no-cache';
    delete out['expires'];

    let code = pres.statusCode;
    if (code < 200 || code > 599) code = 200;

    // m3u8 需要改写相对路径（key/分片），收集后重写再发
    const isM3u8 = /\.m3u8(\?|$)/i.test(target) || /mpegurl/i.test(ctype);
    if (isM3u8) {
      const chunks = [];
      pres.on('data', (c) => chunks.push(c));
      pres.on('error', () => { try { res.end(); } catch (_) {} });
      pres.on('aborted', () => { try { res.end(); } catch (_) {} });
      pres.on('end', () => {
        try {
          const raw = Buffer.concat(chunks).toString('utf8');
          const body = rewriteM3u8(raw, target, ref);
          const buf = Buffer.from(body, 'utf8');
          delete out['content-length'];
          out['content-length'] = String(buf.length);
          out['cache-control'] = 'no-store, no-cache, must-revalidate';
          res.writeHead(code, out);
          res.end(buf);
        } catch (e) {
          try { res.end(); } catch (_) {}
        }
      });
      res.on('close', () => { try { pres.destroy(); } catch (_) {} });
      return;
    }

    res.writeHead(code, out);

    // 上游中途断开时必须把响应结束掉，否则这条连接会挂住，
    // 浏览器并发数很快被占满，表现就是"卡住不动"。
    pres.on('error', () => { try { res.end(); } catch (_) {} });
    pres.on('aborted', () => { try { res.end(); } catch (_) {} });

    res.on('close', () => { try { pres.destroy(); } catch (_) {} });
    res.on('finish', () => { try { pres.destroy(); } catch (_) {} });

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

  // 浏览器总会自动请求 favicon，回一个空响应，免得控制台留一条 404 红字
  if (p === '/favicon.ico') {
    res.writeHead(204, { 'Cache-Control': 'no-store' });
    return res.end();
  }

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
      // 彻底禁缓存：避免重启服务后浏览器仍复用旧页面
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0'
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
      // 纯代码 / 文本文件（如 .user.js）走代码块分支，不套网页正文清洗逻辑
      const ctype = r.headers && r.headers['content-type'];
      const a = isPlainTextContent(ctype, r.body, r.url)
        ? codeToArticle(r.body, r.url)
        : extractArticle(r.body);
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

  if (u.pathname === '/tvbox') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    const action = u.searchParams.get('action') || 'search';
    try {
      if (action === 'search') {
        const wd = String(u.searchParams.get('wd') || '').trim();
        if (!wd) throw new Error('请输入片名');
        const out = await tvboxSearch(wd);
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, wd: wd, sites: out.sites, okSites: out.okSites, list: out.list }));
      } else if (action === 'detail') {
        const key = u.searchParams.get('key') || '';
        const id = u.searchParams.get('id') || '';
        const out = await tvboxDetail(key, id);
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, name: out.name, site: out.site, source: out.source, episodes: out.episodes, hasPageUrl: out.hasPageUrl }));
      } else {
        throw new Error('未知操作');
      }
    } catch (e) {
      res.writeHead(200);
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
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
        r = await resolveBilibiliVideo(room, {
          bvid: u.searchParams.get('bvid') || '',
          cid: u.searchParams.get('cid') || ''
        });
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
        multi: !!r.multi,
        episodes: r.episodes || [],
        index: r.index || 0
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
