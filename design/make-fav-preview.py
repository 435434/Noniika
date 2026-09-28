# -*- coding: utf-8 -*-
"""生成"收藏功能 + 页面切换动画"的可交互预览。

用的就是面板真实的 index.html 与 style.css（不含 main.js），
所以看到的配色、间距、控件大小与 AE 里完全一致。
生成的 HTML 可以真点：星标能切换、页面能来回切（动画是真的）。

用法： python design/make-fav-preview.py
产出： design/panel-fav-preview.html
"""
import io, os, re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
html = io.open(os.path.join(ROOT, "cep", "index.html"), encoding="utf-8").read()
css = io.open(os.path.join(ROOT, "cep", "css", "style.css"), encoding="utf-8").read()

m = re.search(r"<body[^>]*>(.*)</body>", html, re.S)
body = m.group(1) if m else html
body = re.sub(r"<script\b[^>]*>.*?</script>", "", body, flags=re.S)   # 去掉 main.js 引用

SHELL = """
  /* ---- 预览外壳：把面板放进一块"深色工作区"里，模拟 AE 的观感 ---- */
  body { background: #1b1b1b; }
  .stage { display: flex; gap: 26px; align-items: flex-start; justify-content: center;
           padding: 26px; flex-wrap: wrap; }
  .pane { width: 420px; background: #232323; border: 1px solid #333;
          border-radius: 8px; overflow: hidden; box-shadow: 0 8px 26px rgba(0,0,0,.45); }
  .pane-bar { display: flex; align-items: center; gap: 8px; padding: 7px 10px;
              background: #2e2e2e; border-bottom: 1px solid #3a3a3a;
              font: 11px/1 system-ui, sans-serif; color: #9c9c9c; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #4a4a4a; }
  .pane-body { padding: 10px; height: 560px; overflow: auto; }
  .tip { font: 12px/1.7 system-ui, "Microsoft YaHei", sans-serif; color: #9c9c9c;
         max-width: 880px; margin: 0 auto 4px; }
  .tip b { color: #d8d8d8; font-weight: 500; }
  .tip code { color: #ffd24a; }
"""

INJECT = r"""
(function () {
  // 只看「字幕样式」页
  ['pageHome', 'pageUvr', 'pageSet'].forEach(function (id) {
    var n = document.getElementById(id);
    if (n) { n.classList.remove('on'); n.style.display = 'none'; }
  });
  var st = document.getElementById('pageStyle');
  if (st) st.classList.add('on');

  // 面板真实数据靠 main.js 填，这里塞一份等价的假数据
  function opt(parent, value, text) {
    var o = document.createElement('option');
    o.value = value; o.textContent = text;
    parent.appendChild(o); return o;
  }
  function group(sel, labelContent) {
    var g = document.createElement('optgroup');
    g.label = labelContent;
    sel.appendChild(g); return g;
  }

  var FAV_FONT = 'SourceHanSansSC-Regular';
  var fs = document.getElementById('fontSelect');
  if (fs) {
    fs.innerHTML = '';
    var gf = group(fs, '★ 收藏的字体');
    gf.appendChild(mk(FAV_FONT, '★ 思源黑体 · Regular'));
    // 真实面板里非收藏的字体是直接挂在 select 下（只有收藏组才用 optgroup）
    fs.appendChild(mk('STXingkai', '华文行楷 · Regular'));
    fs.appendChild(mk('SimHei', 'SimHei · Regular'));
    fs.appendChild(mk('SimSun', '宋体 · Regular'));
    fs.value = FAV_FONT;
  }
  function mk(value, text) {
    var o = document.createElement('option');
    o.value = value; o.textContent = text; return o;
  }

  var ps = document.getElementById('presetSelect');
  if (ps) {
    ps.innerHTML = '';
    opt(ps, '', '不使用预设');
    var g1 = group(ps, '★ 收藏的预设');
    opt(g1, '/p/打字机.ffx', '★ 打字机');
    opt(g1, '/p/飞入.ffx', '★ 飞入');
    // 真实面板：一层 optgroup +「分类 / 名字」文本前缀，**不嵌套** optgroup
    var g2 = group(ps, 'AE 自带文字预设');
    opt(g2, '/p/飞入2.ffx', 'Animate In / 飞入');
    opt(g2, '/p/淡入.ffx', 'Animate In / 淡入');
    opt(g2, '/p/打字机2.ffx', 'Animate In / 打字机');
    ps.value = '/p/飞入2.ffx';   // 故意选一个「未收藏」的：两种星标状态同屏可见
  }

  // 星标：跟随选中项，且可点
  function sync(sel, btn, favKey) {
    var v = sel.value || '';
    var has = window.__fav[favKey].indexOf(v) >= 0;
    btn.textContent = has ? '★' : '☆';
    btn.classList.toggle('on', has);
    btn.disabled = !v;
    btn.title = !v ? '先在列表里选一个字体' : (has ? '已收藏（点一下取消收藏）' : '收藏它');
  }
  window.__fav = { font: [FAV_FONT], preset: ['/p/打字机.ffx', '/p/飞入.ffx'] };
  var bf = document.getElementById('btnFavFont');
  var bp = document.getElementById('btnFavPreset');
  if (fs && bf) { sync(fs, bf, 'font'); fs.addEventListener('change', function () { sync(fs, bf, 'font'); }); }
  if (ps && bp) { sync(ps, bp, 'preset'); ps.addEventListener('change', function () { sync(ps, bp, 'preset'); }); }

  function toggle(sel, btn, key) {
    var v = sel.value; if (!v) return;
    var i = window.__fav[key].indexOf(v);
    if (i >= 0) window.__fav[key].splice(i, 1); else window.__fav[key].push(v);
    sync(sel, btn, key);
  }
  if (bf) bf.addEventListener('click', function () { toggle(fs, bf, 'font'); });
  if (bp) bp.addEventListener('click', function () { toggle(ps, bp, 'preset'); });

  // 页面切换（真实逻辑照搬：先清 animation 再设，保证每次都重播）
  window.__go = function (name) {
    var ids = { home: 'pageHome', style: 'pageStyle' };
    Object.keys(ids).forEach(function (k) {
      var p = document.getElementById(ids[k]);
      if (!p) return;
      var on = (k === name);
      p.style.display = on ? '' : 'none';
      p.classList.toggle('on', on);
      if (on) {
        p.style.animation = 'none';
        void p.offsetWidth;
        p.style.animation = (name === 'home' ? 'pgBack' : 'pgIn') + ' .19s ease';
      }
    });
  };
  window.__go('style');
})();
"""

out = u"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>AE 自动字幕 · 收藏 & 切页动画 预览</title>
<style>
%s
%s
</style>
</head>
<body>
<div class="tip">
  <b>预览说明</b>：下面就是面板本体（真实 index.html + style.css 渲染，420px 宽 ≈ AE 里常见宽度）。<br>
  可交互：<code>点星标</code>切换收藏（★ 实心＝已收藏）；<code>点右上角两个按钮</code>来回切页，看过渡动画。<br>
  收藏了之后，对应下拉的<b>最上方会出现「★ 收藏的…」分组</b>，且已收藏的项不会在下面重复列出。
</div>

<div class="stage">
  <div class="pane">
    <div class="pane-bar"><span class="dot"></span><span>AE 自动字幕 · 面板</span>
      <span style="flex:1"></span>
      <button class="ghost small" onclick="__go('home')">← 返回首页</button>
      <button class="ghost small" onclick="__go('style')">进二级页 →</button>
    </div>
    <div class="pane-body">
%s
    </div>
  </div>
</div>

<script>%s</script>
</body>
</html>
""" % (css, SHELL, body, INJECT)

dst = os.path.join(ROOT, "design", "panel-fav-preview.html")
io.open(dst, "w", encoding="utf-8", newline="").write(out)
print("  已生成: %s  (%.1f KB)" % (dst, os.path.getsize(dst) / 1024))
print("  body 抽取长度: %d 字符 | CSS: %d 字符" % (len(body), len(css)))
print("  含 keyframes pgIn:", "@keyframes pgIn" in out)
print("  含 favBtn 样式 :", "button.favBtn" in out)
print("  含 btnFavFont  :", 'id="btnFavFont"' in out)
