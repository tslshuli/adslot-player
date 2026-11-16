# -*- coding: utf-8 -*-
"""
把本地 Office 文档转成页面正文片段，放进 docs/ 目录。

支持：.docx / .xlsx / .pptx
不支持：.doc / .xls / .ppt（老二进制格式）、.pdf
        —— 用 Office 另存为 docx/xlsx/pptx 再导入即可。

用法：
    python tools/import-doc.py 文件1.docx 文件2.xlsx
    或把文件直接拖到「导入文档.bat」上
"""

import html
import os
import re
import sys
import zipfile
from xml.etree import ElementTree as ET

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DOCS = os.path.join(ROOT, 'docs')

W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'


def q(tag):
    return '{%s}%s' % (W, tag)


# ------------------------------------------------------------------ docx

def para_text(p):
    return ''.join(t.text or '' for t in p.iter(q('t')))


def para_html(p):
    txt = para_text(p).strip()
    if not txt:
        return ''
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
        return '<%s>%s</%s>' % (tag, html.escape(txt), tag)
    if low.startswith('title'):
        return '<h2>%s</h2>' % html.escape(txt)
    return '<p>%s</p>' % html.escape(txt)


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
    with zipfile.ZipFile(path) as z:
        root = ET.fromstring(z.read('word/document.xml'))

    body = root.find(q('body'))
    if body is None:
        return ''

    out = []
    for el in body:
        if el.tag == q('p'):
            h = para_html(el)
            if h:
                out.append(h)
        elif el.tag == q('tbl'):
            h = table_html(el)
            if h:
                out.append(h)
    return '\n'.join(out)


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
    with zipfile.ZipFile(path) as z:
        slides = sorted(
            [n for n in z.namelist() if re.match(r'ppt/slides/slide\d+\.xml$', n)],
            key=lambda s: int(re.search(r'slide(\d+)', s).group(1))
        )
        out = []
        for i, s in enumerate(slides, 1):
            root = ET.fromstring(z.read(s))
            texts = [t.text.strip() for t in root.iter()
                     if t.tag.endswith('}t') and t.text and t.text.strip()]
            if not texts:
                continue
            out.append('<h2>第 %d 页</h2>' % i)
            for t in texts:
                out.append('<p>%s</p>' % html.escape(t))
        return '\n'.join(out)


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
    ext = os.path.splitext(path)[1].lower()
    if ext == '.docx':
        return docx_to_html(path)
    if ext == '.xlsx':
        return xlsx_to_html(path)
    if ext == '.pptx':
        return pptx_to_html(path)
    raise ValueError('不支持的格式：%s' % ext)


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
            body = convert(path)
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
        out = os.path.join(DOCS, '%02d-%s.html' % (idx, title))
        with open(out, 'w', encoding='utf-8') as f:
            f.write(body)

        print('[完成] %s -> docs/%02d-%s.html（%d 字符）'
              % (os.path.basename(path), idx, title, len(body)))
        ok += 1

    print()
    print('成功 %d 个，跳过/失败 %d 个。刷新页面即可看到新文档。' % (ok, fail))
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
