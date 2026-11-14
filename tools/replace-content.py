# -*- coding: utf-8 -*-
"""把页面从「产业资讯」整体换成「运维手册」风格。"""

import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PAGE = os.path.join(ROOT, '伪装播放器.html')

NEW_LOGO_NAV = '''<div class="logo">运维知识库<span>Ops Wiki</span></div>
    <nav class="nav">
      <a href="#" class="on">手册</a>
      <a href="#">规范</a>
      <a href="#">故障库</a>
      <a href="#">变更记录</a>
    </nav>'''

NEW_HEAD = '''<div class="crumb"><a href="#">知识库</a> &rsaquo; <a href="#">运维手册</a> &rsaquo; 巡检</div>

    <h1 class="art-title">服务器日常巡检与故障处理手册</h1>

    <div class="art-sub">
      覆盖系统层与服务层的日常巡检项、判读阈值与常见故障处置流程，适用于自建机房与云上独立部署。
    </div>

    <div class="art-meta">
      <span>文档编号 <b>OPS-MAN-014</b></span>
      <span>版本 <b>v3.4</b></span>
      <span>更新 2026-11-12</span>
      <span>维护 <b>基础设施组</b></span>
    </div>'''


def main():
    s = open(PAGE, encoding='utf-8').read()

    # 1. 站点标题
    s = s.replace(
        '<title>产业观察 - 2026 消费电子供应链周报</title>',
        '<title>服务器日常巡检与故障处理手册 - 运维知识库</title>'
    )

    # 2. logo + 导航
    a = s.find('<div class="logo">')
    b = s.find('</nav>', a) + len('</nav>')
    assert a > 0 and b > a
    s = s[:a] + NEW_LOGO_NAV + s[b:]

    # 3. 面包屑 / 标题 / 副标题 / 元信息
    a = s.find('<div class="crumb">')
    k = s.find('<div class="art-meta">')
    b = s.find('</div>', k) + len('</div>')
    assert a > 0 and b > a
    s = s[:a] + NEW_HEAD + s[b:]

    # 4. 正文
    art = open(os.path.join(ROOT, '_doc_new.html'), encoding='utf-8').read().strip()

    counter = [0]

    def add_id(_m):
        counter[0] += 1
        return '<h2 id="s%d">' % counter[0]

    art = re.sub(r'<h2>', add_id, art)

    a = s.find('<article class="article">')
    b = s.find('</article>', a) + len('</article>')
    assert a > 0 and b > a
    s = s[:a] + art + s[b:]
    print('正文章节数:', counter[0])

    # 5. 右侧三个 side-card
    side = open(os.path.join(ROOT, '_side_new.html'), encoding='utf-8').read().strip()
    a = s.find('<div class="side-card">')
    b = s.find('<!-- 右侧竖版广告', a)
    assert a > 0 and b > a
    s = s[:a] + side + '\n\n  ' + s[b:]

    # 6. 页脚
    s = s.replace(
        '产业观察研究院 · 内容仅供参考 · 转载请注明出处',
        '运维知识库 · 内部资料 · 请勿外传'
    )

    open(PAGE, 'w', encoding='utf-8').write(s)
    print('完成，文件大小:', len(s))


if __name__ == '__main__':
    main()
