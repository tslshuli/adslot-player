# -*- coding: utf-8 -*-
"""
把本地 Office 文档转成页面正文片段，放进 docs/ 目录。

支持：.docx / .xlsx / .pptx
不支持：.doc / .xls / .ppt（老二进制格式）、.pdf
        —— 用 Office 另存为 docx/xlsx/pptx 再导入即可。

docx / pptx 里的内嵌图片会一起导出到 docs/img/<文档名>/，
HTML 里用 /docs/img/... 绝对路径引用。

用法：
    python tools/import-doc.py 文件1.docx 文件2.xlsx
    或把文件直接拖到「导入文档.bat」上
"""

import html
import os
import posixpath
import re
import sys
import zipfile
from xml.etree import ElementTree as ET

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DOCS = os.path.join(ROOT, 'docs')

W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'

# Office 包里图片用 r:embed 指向 rels 里的目标，命名空间固定
NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
EMBED = '{%s}embed' % NS_R
LINK_ID = '{%s}id' % NS_R

# 图片在 HTML 里先写占位符，等知道输出文件名再统一替换成真实路径
PH = '%%IMG:%s%%'

# 浏览器能直接显示的图片格式。Office 里的图表常被存成 emf/wmf/tiff，
# 这些浏览器认不了，导出来只会是裂图，所以要识别出来并提示。
WEB_IMG = {'.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'}


def q(tag):
    return '{%s}%s' % (W, tag)


# ------------------------------------------------------------------ 媒体

def read_rels(z, rels_path):
    """读 xx.rels，返回 {rId: 包内绝对路径}（跳过外链）"""
    m = {}
    if rels_path not in z.namelist():
        return m
    base = posixpath.dirname(posixpath.dirname(rels_path))
    try:
        root = ET.fromstring(z.read(rels_path))
    except ET.ParseError:
        return m
    for rel in root:
        rid = rel.get('Id')
        target = rel.get('Target') or ''
        if not rid or not target or rel.get('TargetMode') == 'External':
            continue
        if target.startswith('/'):
            full = target.lstrip('/')
        else:
            full = posixpath.normpath(posixpath.join(base, target))
        m[rid] = full
    return m


def media_ref(el, rels, media, tag='img'):
    """把 a:blip / v:imagedata 变成一个 <img>，同时登记图片"""
    rid = el.get(EMBED) or el.get(LINK_ID)
    if not rid:
        return ''
    target = rels.get(rid)
    if not target:
        return ''
    if target not in media:
        media.append(target)
    return '<img src="%s" alt="">' % (PH % target)


# ------------------------------------------------------------------ 图表渲染
# PPT 里的「图」常常不是图片，而是原生图表对象（c:chart）。
# 这种在图里没有任何像素，只能按数据重新画。这里用内联 SVG 画出来。

C = '{http://schemas.openxmlformats.org/drawingml/2006/chart}'

CHART_COLORS = ['#4a6fa5', '#7fa0c4', '#a9c2da', '#d3e0ec',
                '#5b7fa6', '#93aec8', '#bdd0e0', '#e2ebf3']


def _fmt_num(v):
    if v == int(v):
        return str(int(v))
    return ('%.1f' % v).rstrip('0').rstrip('.')


def _polar(cx, cy, r, deg):
    import math
    a = math.radians(deg)
    return cx + r * math.cos(a), cy + r * math.sin(a)


def _ring_path(cx, cy, ri, ro, a0, a1):
    large = 1 if (a1 - a0) > 180 else 0
    x0o, y0o = _polar(cx, cy, ro, a0)
    x1o, y1o = _polar(cx, cy, ro, a1)
    x1i, y1i = _polar(cx, cy, ri, a1)
    x0i, y0i = _polar(cx, cy, ri, a0)
    return ('M %.2f %.2f A %.2f %.2f 0 %d 1 %.2f %.2f L %.2f %.2f '
            'A %.2f %.2f 0 %d 0 %.2f %.2f Z'
            % (x0o, y0o, ro, ro, large, x1o, y1o,
               x1i, y1i, ri, ri, large, x0i, y0i))


def _read_chart(root):
    """取出 (类目列表, [(系列名, 数值列表), ...])"""
    cats = []
    series = []
    for ser in root.findall('.//' + C + 'ser'):
        name = ''
        tx = ser.find(C + 'tx')
        if tx is not None:
            vs = [x.text for x in tx.iter(C + 'v') if x.text]
            name = vs[0] if vs else ''
        cs = [x.text or '' for x in ser.findall('.//' + C + 'cat//' + C + 'v')]
        raw = [x.text or '' for x in ser.findall('.//' + C + 'val//' + C + 'v')]
        vals = []
        for r in raw:
            try:
                vals.append(float(r))
            except ValueError:
                vals.append(0.0)
        if cs and not cats:
            cats = cs
        series.append((name, vals))
    return cats, series


def _svg_bar(cats, vals, horizontal=False):
    """簇状柱形图（也只画第一个系列，够用且不糊）"""
    if not vals or not cats:
        return ''
    n = min(len(vals), len(cats))
    vals, cats = vals[:n], cats[:n]

    if horizontal:
        w, h = 620, max(140, 34 * n + 46)
        pad_l, pad_r, pad_t, pad_b = 96, 54, 14, 18
        plot_w, plot_h = w - pad_l - pad_r, h - pad_t - pad_b
        vmax = max(vals) or 1.0
        slot = plot_h / n
        bh = min(24.0, slot * 0.6)
        out = []
        for i, v in enumerate(vals):
            bw = plot_w * (v / vmax) if vmax else 0
            y = pad_t + slot * i + (slot - bh) / 2
            out.append('<rect x="%.1f" y="%.1f" width="%.1f" height="%.1f" fill="%s" rx="2"/>'
                       % (pad_l, y, bw, bh, CHART_COLORS[0]))
            out.append('<text x="%.1f" y="%.1f" font-size="11" fill="#4a5468" text-anchor="end">%s</text>'
                       % (pad_l - 8, y + bh / 2 + 4, html.escape(cats[i][:12])))
            out.append('<text x="%.1f" y="%.1f" font-size="10.5" fill="#5a6478">%s</text>'
                       % (pad_l + bw + 6, y + bh / 2 + 4, _fmt_num(v)))
    else:
        w, h = 620, 300
        pad_l, pad_r, pad_t, pad_b = 48, 16, 22, 52
        plot_w, plot_h = w - pad_l - pad_r, h - pad_t - pad_b
        vmax = max(vals) or 1.0
        slot = plot_w / n
        bw = min(48.0, slot * 0.55)
        out = []
        for k in range(5):
            y = pad_t + plot_h * k / 4.0
            val = vmax * (4 - k) / 4.0
            out.append('<line x1="%.1f" y1="%.1f" x2="%.1f" y2="%.1f" stroke="#e8ebf0"/>'
                       % (pad_l, y, w - pad_r, y))
            out.append('<text x="%.1f" y="%.1f" font-size="10" fill="#98a1b2" text-anchor="end">%s</text>'
                       % (pad_l - 6, y + 3.5, _fmt_num(val)))
        for i, v in enumerate(vals):
            bh = plot_h * (v / vmax) if vmax else 0
            x = pad_l + slot * i + (slot - bw) / 2
            y = pad_t + plot_h - bh
            out.append('<rect x="%.1f" y="%.1f" width="%.1f" height="%.1f" fill="%s" rx="2"/>'
                       % (x, y, bw, bh, CHART_COLORS[0]))
            out.append('<text x="%.1f" y="%.1f" font-size="10.5" fill="#5a6478" text-anchor="middle">%s</text>'
                       % (x + bw / 2, y - 6, _fmt_num(v)))
            out.append('<text x="%.1f" y="%.1f" font-size="10" fill="#6b7280" text-anchor="middle">%s</text>'
                       % (x + bw / 2, pad_t + plot_h + 18, html.escape(cats[i][:8])))
    return ('<svg viewBox="0 0 %d %d" width="%d" height="%d" '
            'xmlns="http://www.w3.org/2000/svg" class="doc-chart" role="img">%s</svg>'
            % (w, h, w, h, ''.join(out)))


def _svg_ring(cats, vals, hole=0.55):
    """饼图 / 环形图（hole=0 就是饼图）"""
    if not vals or not cats:
        return ''
    n = min(len(vals), len(cats))
    vals, cats = vals[:n], cats[:n]
    total = sum(vals)
    if total <= 0:
        return ''

    w, h = 460, 300
    cx, cy = 150.0, h / 2.0
    ro = 118.0
    ri = ro * hole
    out = []
    start = -90.0
    for i, v in enumerate(vals):
        ang = 360.0 * v / total
        end = start + ang
        color = CHART_COLORS[i % len(CHART_COLORS)]
        if ang >= 359.99:
            # 整圆：单段圆弧画不出 360°，用描边圆环代替
            out.append('<circle cx="%.1f" cy="%.1f" r="%.1f" fill="none" stroke="%s" stroke-width="%.1f"/>'
                       % (cx, cy, (ro + ri) / 2, color, ro - ri))
        else:
            out.append('<path d="%s" fill="%s"/>'
                       % (_ring_path(cx, cy, ri, ro, start, end), color))
        start = end

    # 右侧图例：条目多时自动压缩行距，别溢出画布
    step = min(44.0, (h - 56.0) / max(1, n))
    ly = 50.0
    for i, v in enumerate(vals):
        color = CHART_COLORS[i % len(CHART_COLORS)]
        pct = 100.0 * v / total
        out.append('<rect x="288" y="%.1f" width="10" height="10" fill="%s" rx="2"/>'
                   % (ly - 9, color))
        out.append('<text x="304" y="%.1f" font-size="11" fill="#4a5468">%s</text>'
                   % (ly, html.escape(cats[i][:10])))
        out.append('<text x="304" y="%.1f" font-size="10.5" fill="#8a94a6">%s（%.0f%%）</text>'
                   % (ly + 13, _fmt_num(v), pct))
        ly += step

    return ('<svg viewBox="0 0 %d %d" width="%d" height="%d" '
            'xmlns="http://www.w3.org/2000/svg" class="doc-chart" role="img">%s</svg>'
            % (w, h, w, h, ''.join(out)))


def chart_svg(z, path):
    """把一个 OOXML 图表渲染成内联 SVG；不认识的类型返回空串"""
    if not path or path not in z.namelist():
        return ''
    try:
        root = ET.fromstring(z.read(path))
    except ET.ParseError:
        return ''

    kind = ''
    for el in root.iter():
        t = el.tag.split('}')[-1]
        if t in ('barChart', 'pieChart', 'doughnutChart', 'lineChart', 'areaChart'):
            kind = t
            break
    if not kind:
        return ''

    cats, series = _read_chart(root)
    if not cats or not series:
        return ''
    vals = series[0][1]

    if kind == 'barChart':
        bar_dir = root.find('.//' + C + 'barDir')
        horizontal = bool(bar_dir is not None and bar_dir.get('val') == 'bar')
        return _svg_bar(cats, vals, horizontal)
    if kind == 'pieChart':
        return _svg_ring(cats, vals, hole=0.0)
    if kind == 'doughnutChart':
        return _svg_ring(cats, vals, hole=0.55)
    return ''




# ------------------------------------------------------------------ docx

def para_text(p):
    return ''.join(t.text or '' for t in p.iter(q('t')))


def para_html(p, rels, media):
    """一个段落可能既有图又有字：先出图，再出字"""
    figs = []
    for el in p.iter():
        if el.tag.endswith('}blip') or el.tag.endswith('}imagedata'):
            img = media_ref(el, rels, media)
            if img:
                figs.append(img)

    txt = para_text(p).strip()
    if not txt and not figs:
        return ''

    out = []
    if figs:
        out.append('<p class="doc-fig">%s</p>' % ''.join(figs))
    if not txt:
        return '\n'.join(out)

    style = ''
    ppr = p.find(q('pPr'))
    if ppr is not None:
        ps = ppr.find(q('pStyle'))
        if ps is not None:
            style = (ps.get(q('val')) or '')

    low = style.lower()
    m = re.match(r'heading(\d)', low)
    if m:
        lvl = int(m.group(1))
        tag = 'h2' if lvl <= 1 else 'h3'
        out.append('<%s>%s</%s>' % (tag, html.escape(txt), tag))
    elif low.startswith('title'):
        out.append('<h2>%s</h2>' % html.escape(txt))
    else:
        out.append('<p>%s</p>' % html.escape(txt))
    return '\n'.join(out)


def table_html(tbl):
    rows = []
    for tr in tbl.findall(q('tr')):
        cells = []
        for tc in tr.findall(q('tc')):
            txt = ' '.join(para_text(p).strip() for p in tc.findall(q('p'))).strip()
            cells.append(html.escape(txt))
        if cells:
            rows.append(cells)

    if not rows:
        return ''

    head = ''.join('<th>%s</th>' % c for c in rows[0])
    body = ''.join(
        '<tr>%s</tr>' % ''.join('<td>%s</td>' % c for c in r)
        for r in rows[1:]
    )
    return ('<table class="data-table"><thead><tr>%s</tr></thead>'
            '<tbody>%s</tbody></table>' % (head, body))


def docx_to_html(path):
    media = []
    with zipfile.ZipFile(path) as z:
        root = ET.fromstring(z.read('word/document.xml'))
        rels = read_rels(z, 'word/_rels/document.xml.rels')

    body = root.find(q('body'))
    if body is None:
        return '', media

    out = []
    for el in body:
        if el.tag == q('p'):
            h = para_html(el, rels, media)
            if h:
                out.append(h)
        elif el.tag == q('tbl'):
            h = table_html(el)
            if h:
                out.append(h)
    return '\n'.join(out), media


# ------------------------------------------------------------------ xlsx

def xlsx_to_html(path, max_rows=200, max_cols=20):
    with zipfile.ZipFile(path) as z:
        names = z.namelist()

        shared = []
        if 'xl/sharedStrings.xml' in names:
            sx = ET.fromstring(z.read('xl/sharedStrings.xml'))
            for si in sx:
                shared.append(''.join(t.text or '' for t in si.iter() if t.tag.endswith('}t')))

        sheets = sorted([n for n in names if re.match(r'xl/worksheets/sheet\d+\.xml$', n)],
                        key=lambda s: int(re.search(r'(\d+)', s).group(1)))
        if not sheets:
            return ''

        ws = ET.fromstring(z.read(sheets[0]))

    rows = []
    for row in ws.iter():
        if not row.tag.endswith('}row'):
            continue
        cells = []
        for c in row:
            if not c.tag.endswith('}c'):
                continue
            t = c.get('t')
            val = ''
            for child in c:
                if child.tag.endswith('}v'):
                    val = child.text or ''
                    if t == 's':
                        try:
                            val = shared[int(val)]
                        except (ValueError, IndexError):
                            pass
                    break
                if child.tag.endswith('}is'):
                    val = ''.join(x.text or '' for x in child.iter() if x.tag.endswith('}t'))
                    break
            cells.append(val)
        if any(x.strip() for x in cells):
            rows.append(cells)
        if len(rows) >= max_rows:
            break

    if not rows:
        return ''

    width = min(max(len(r) for r in rows), max_cols)

    def pad(r):
        return (r + [''] * width)[:width]

    head = ''.join('<th>%s</th>' % html.escape(c) for c in pad(rows[0]))
    body = ''.join(
        '<tr>%s</tr>' % ''.join('<td>%s</td>' % html.escape(c) for c in pad(r))
        for r in rows[1:]
    )

    note = ''
    if len(rows) >= max_rows:
        note = '<p>（表格较长，仅导入前 %d 行）</p>' % max_rows

    return ('<table class="data-table"><thead><tr>%s</tr></thead>'
            '<tbody>%s</tbody></table>%s' % (head, body, note))


# ------------------------------------------------------------------ pptx

def pptx_to_html(path):
    """按幻灯片顺序遍历，文字、图片、原生图表按原始先后输出"""
    media = []
    chart_total = 0
    chart_ok = 0
    with zipfile.ZipFile(path) as z:
        slides = sorted(
            [n for n in z.namelist() if re.match(r'ppt/slides/slide\d+\.xml$', n)],
            key=lambda s: int(re.search(r'slide(\d+)', s).group(1))
        )
        out = []
        for i, s in enumerate(slides, 1):
            rels = read_rels(z, 'ppt/slides/_rels/%s.rels' % posixpath.basename(s))
            root = ET.fromstring(z.read(s))
            rows = []
            for el in root.iter():
                if el.tag.endswith('}t'):
                    t = (el.text or '').strip()
                    if t:
                        rows.append('<p>%s</p>' % html.escape(t))
                elif el.tag.endswith('}blip') or el.tag.endswith('}imagedata'):
                    img = media_ref(el, rels, media)
                    if img:
                        rows.append('<p class="doc-fig">%s</p>' % img)
                elif el.tag.endswith('}chart'):
                    # 原生图表对象：图里没有像素，只能按数据重画成 SVG
                    chart_total += 1
                    rid = el.get(LINK_ID)
                    svg = chart_svg(z, rels.get(rid) if rid else None)
                    if svg:
                        chart_ok += 1
                        rows.append('<p class="doc-fig">%s</p>' % svg)
            if not rows:
                continue
            out.append('<h2>第 %d 页</h2>' % i)
            out.extend(rows)

    if chart_total:
        print('  [图表] 共 %d 个，已渲染 %d 个%s'
              % (chart_total, chart_ok,
                 '，其余类型暂不支持' if chart_ok < chart_total else ''))
    return '\n'.join(out), media


# ------------------------------------------------------------------ 主流程

def next_index():
    if not os.path.isdir(DOCS):
        os.makedirs(DOCS, exist_ok=True)
        return 1
    nums = []
    for f in os.listdir(DOCS):
        m = re.match(r'(\d+)-', f)
        if m:
            nums.append(int(m.group(1)))
    return (max(nums) + 1) if nums else 1


def safe_name(name):
    name = re.sub(r'[\\/:*?"<>|]', '_', name)
    return name.strip()[:60] or 'document'


def convert(path):
    """返回 (html, media)；media 是包里要一起导出的图片路径列表"""
    ext = os.path.splitext(path)[1].lower()
    if ext == '.docx':
        return docx_to_html(path)
    if ext == '.xlsx':
        return xlsx_to_html(path), []
    if ext == '.pptx':
        return pptx_to_html(path)
    raise ValueError('不支持的格式：%s' % ext)


def export_media(zip_path, media, doc_stem, body):
    """把字节里的图片复制到 docs/img/<doc_stem>/，并把占位符换成真实 URL
    返回 (body, 导出数量, 跳过的扩展名集合)"""
    if not media:
        return body, 0, set()

    img_dir = os.path.join(DOCS, 'img', doc_stem)
    os.makedirs(img_dir, exist_ok=True)
    count = 0
    skipped = set()
    with zipfile.ZipFile(zip_path) as z:
        for i, mp in enumerate(media, 1):
            ext = posixpath.splitext(mp)[1].lower()
            if ext not in WEB_IMG:
                skipped.add(ext or '(无扩展名)')
                continue
            try:
                data = z.read(mp)
            except KeyError:
                continue
            name = 'img%02d%s' % (i, ext)
            with open(os.path.join(img_dir, name), 'wb') as f:
                f.write(data)
            body = body.replace(PH % mp, '/docs/img/%s/%s' % (doc_stem, name))
            count += 1

    # 没导出的图（emf/wmf 之类）会留占位符或空 src，收拾干净
    body = re.sub(r'%IMG:[^%]+%', '', body)
    body = re.sub(r'<img src="" alt="">', '', body)
    body = re.sub(r'<p class="doc-fig">\s*</p>', '', body)
    return body, count, skipped


def main():
    args = [a for a in sys.argv[1:] if a.strip()]
    if not args:
        print('用法：python tools/import-doc.py 文件1.docx [文件2.xlsx ...]')
        print('或者把文件拖到「导入文档.bat」上。')
        return 1

    os.makedirs(DOCS, exist_ok=True)
    ok, fail = 0, 0

    for path in args:
        if not os.path.isfile(path):
            print('[跳过] 文件不存在：%s' % path)
            fail += 1
            continue

        ext = os.path.splitext(path)[1].lower()
        if ext in ('.doc', '.xls', '.ppt'):
            print('[跳过] %s —— 老二进制格式，请用 Office 另存为 %sx 再导入' % (os.path.basename(path), ext))
            fail += 1
            continue
        if ext == '.pdf':
            print('[跳过] %s —— PDF 暂不支持，可先转成 docx' % os.path.basename(path))
            fail += 1
            continue

        try:
            body, media = convert(path)
        except Exception as e:
            print('[失败] %s —— %s' % (os.path.basename(path), e))
            fail += 1
            continue

        if not body.strip():
            print('[失败] %s —— 没提取到内容' % os.path.basename(path))
            fail += 1
            continue

        idx = next_index()
        title = safe_name(os.path.splitext(os.path.basename(path))[0])
        doc_stem = '%02d-%s' % (idx, title)

        try:
            body, n_img, skipped = export_media(path, media, doc_stem, body)
        except Exception as e:
            print('[警告] 图片导出失败：%s' % e)
            n_img, skipped = 0, set()

        out = os.path.join(DOCS, doc_stem + '.html')
        with open(out, 'w', encoding='utf-8') as f:
            f.write(body)

        extra = ('，含 %d 张图片' % n_img) if n_img else ''
        print('[完成] %s -> docs/%s.html（%d 字符%s）'
              % (os.path.basename(path), doc_stem, len(body), extra))
        if skipped:
            print('  [提示] 另有 %d 张图是 %s 格式，浏览器显示不了，已跳过'
                  % (len(skipped), '、'.join(sorted(skipped))))
        ok += 1

    print()
    print('成功 %d 个，跳过/失败 %d 个。刷新页面即可看到新文档。' % (ok, fail))
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
