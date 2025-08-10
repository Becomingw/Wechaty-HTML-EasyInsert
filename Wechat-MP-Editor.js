// ==UserScript==
// @name         WeChat MP Editor – 插入HTML
// @namespace    https://blog.becomingw.cn
// @version      0.5.0
// @description  在公众号图文编辑器(ProseMirror)中添加“插入HTML”按钮，使用模拟粘贴将HTML插入到光标处。快捷键 Ctrl/⌘+Shift+H。
// @match        https://mp.weixin.qq.com/*
// @run-at       document-idle
// @grant        GM_addStyle
// ==/UserScript==

(function () {
  'use strict';

  const css = `
  .gm-insert-html-btn{
    position: fixed; left: 24px; bottom: 26px; z-index: 99999;
    background:#23c343; color:#fff; border:none; border-radius:12px;
    padding:10px 14px; font-size:14px; cursor:pointer; box-shadow:0 6px 18px rgba(0,0,0,.16);
  }
  .gm-insert-html-btn:hover{ filter:brightness(1.05); }
  .gm-mask{ position:fixed; inset:0; background:rgba(0,0,0,.35); z-index:100000; display:flex; align-items:center; justify-content:center;}
  .gm-modal{ width:min(960px,92vw); background:#fff; border-radius:12px; overflow:hidden; box-shadow:0 12px 32px rgba(0,0,0,.2); }
  .gm-hd{ padding:12px 16px; font-weight:600; border-bottom:1px solid #eee; display:flex; justify-content:space-between; align-items:center;}
  .gm-body{ display:grid; grid-template-columns:1fr 1fr; height:60vh; }
  .gm-left{ padding:12px; border-right:1px solid #f2f2f2;}
  .gm-right{ padding:12px; background:#fafafa; overflow:auto;}
  .gm-ta{ width:100%; height:100%; resize:none; padding:10px; border:1px solid #e5e7eb; border-radius:8px; font:13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;}
  .gm-actions{ padding:10px 12px; border-top:1px solid #eee; display:flex; gap:8px; justify-content:flex-end;}
  .gm-btn{ padding:8px 12px; border-radius:10px; border:1px solid #e5e7eb; background:#fff; cursor:pointer;}
  .gm-btn.primary{ background:#23c343; color:#fff; border:none;}
  .gm-note{ color:#888; font-size:12px;}
  `;
  if (typeof GM_addStyle === 'function') GM_addStyle(css);
  else { const s=document.createElement('style'); s.textContent=css; document.head.appendChild(s); }

  const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));

  function findCtx(){
    // 优先锁定 ProseMirror
    let doc = document, win = window;
    let editor = doc.querySelector('div.ProseMirror[contenteditable="true"]');

    if(!editor){
      const ifrs = Array.from(doc.querySelectorAll('iframe'));
      for(const f of ifrs){
        try{
          const fd = f.contentDocument || f.contentWindow?.document;
          if(!fd) continue;
          const ed = fd.querySelector('div.ProseMirror[contenteditable="true"]');
          if(ed && f.getBoundingClientRect().width>0) { doc=fd; win=f.contentWindow; editor=ed; break; }
        }catch(e){}
      }
    }
    return {doc, win, editor};
  }

  function moveCaretToEnd(el, doc, sel){
    const r = doc.createRange();
    r.selectNodeContents(el);
    r.collapse(false);
    sel.removeAllRanges(); sel.addRange(r);
  }

  function stripHTML(html){
    const div = document.createElement('div');
    div.innerHTML = html;
    return (div.textContent || '').trim();
  }

// —— 获取编辑区快照，用来判断是否真的插入成功
function snapshotEditor(editor) {
  // 仅取必要信号，避免因随机属性导致误判
  return editor.innerHTML.length + '|' + editor.childNodes.length;
}

  // === 关键：用“模拟粘贴”让 ProseMirror 自己插入 ===
async function tryPasteHTML(ctx, html) {
  try {
    const DT = ctx.win.DataTransfer || window.DataTransfer;
    const CE = ctx.win.ClipboardEvent || window.ClipboardEvent;
    if (!DT || !CE) return false;

    const dt = new DT();
    dt.setData('text/html', html);
    // 给个极简的 text/plain，避免个别 schema fallback 时插入长纯文本
    dt.setData('text/plain', (html.replace(/<[^>]+>/g, '') || '').slice(0, 64));

    // 派发 paste（只这一类事件，交给 ProseMirror 统一处理）
    const evt = new CE('paste', { bubbles: true, cancelable: true });
    // Safari/Chromium 可能不允许在构造器里直接塞 clipboardData，用 defineProperty
    Object.defineProperty(evt, 'clipboardData', { value: dt, writable: false });

    const before = snapshotEditor(ctx.editor);
    const prevented = !ctx.editor.dispatchEvent(evt); // 如果 PM 调用了 preventDefault，值为 true

    // 等一帧让 PM 完成事务
    await new Promise(r => setTimeout(r, 30));
    const after = snapshotEditor(ctx.editor);

    // 只要编辑区发生变化，就认定成功（无论是否preventDefault）
    return before !== after || prevented;
  } catch (e) {
    return false;
  }
}

  function fallbackInsert(ctx, html){
    // 兜底顺序：execCommand -> 文末 append
    try{
      ctx.doc.execCommand('insertHTML', false, html);
      return true;
    }catch(e){}
    try{
      ctx.editor.insertAdjacentHTML('beforeend', html);
      return true;
    }catch(e){}
    return false;
  }

async function insertHTML(ctx, html) {
  if (!ctx?.editor) return false;

  ctx.editor.focus();
  const sel = (() => {
    try { return ctx.win.getSelection(); } catch { return window.getSelection(); }
  })();
  if (!(sel && sel.rangeCount > 0 && ctx.editor.contains(sel.anchorNode))) {
    // 没有效光标 -> 移到文末
    moveCaretToEnd(ctx.editor, ctx.doc, sel || ctx.doc.getSelection());
    await new Promise(r => setTimeout(r, 20));
  }

  // 先走粘贴（唯一的首选路径）
  const ok = await tryPasteHTML(ctx, html);
  if (ok) return true;

  // 粘贴路径确实失败时，再兜底一次（不会重复）
  try {
    ctx.doc.execCommand('insertHTML', false, html);
    return true;
  } catch {}
  try {
    ctx.editor.insertAdjacentHTML('beforeend', html);
    return true;
  } catch {}
  return false;
}

  function openModal(onInsert){
    const mask = document.createElement('div');
    mask.innerHTML = `
      <div class="gm-mask">
        <div class="gm-modal" role="dialog" aria-modal="true">
          <div class="gm-hd">
            <div>插入 HTML <span class="gm-note">（ProseMirror 将按平台规则过滤不安全标签）</span></div>
            <button class="gm-btn gm-close">✕</button>
          </div>
          <div class="gm-body">
            <div class="gm-left">
              <textarea class="gm-ta" placeholder="<p>在此粘贴 HTML 片段...</p>"></textarea>
            </div>
            <div class="gm-right">
              <div class="gm-preview" style="height:100%; background:#fff; border:1px dashed #e5e7eb; border-radius:8px; padding:12px; overflow:auto; color:#999;">预览区</div>
            </div>
          </div>
          <div class="gm-actions">
            <button class="gm-btn gm-preview-btn">预览</button>
            <button class="gm-btn primary gm-insert-btn">插入</button>
            <button class="gm-btn gm-close">取消</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(mask);

    const ta = mask.querySelector('.gm-ta');
    const preview = mask.querySelector('.gm-preview');
    const close = ()=>mask.remove();
    mask.querySelectorAll('.gm-close').forEach(b=>b.addEventListener('click', close));
    mask.querySelector('.gm-preview-btn').addEventListener('click', ()=>{ preview.innerHTML = ta.value || '<span style="color:#999;">（空）</span>'; });
    mask.querySelector('.gm-insert-btn').addEventListener('click', ()=>{ onInsert(ta.value||''); close(); });
    ta.addEventListener('keydown', (e)=>{ if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='enter'){ onInsert(ta.value||''); close(); }});
    ta.focus();
  }

  function mountUI(){
    if(document.querySelector('.gm-insert-html-btn')) return;
    const btn = document.createElement('button');
    btn.className = 'gm-insert-html-btn';
    btn.textContent = '插入HTML';
    btn.title = '在光标处插入 HTML（Ctrl/⌘+Shift+H）';
    btn.addEventListener('click', async ()=>{
      await sleep(80);
      const ctx = findCtx();
      if(!ctx.editor){ alert('未找到编辑器（ProseMirror）。请确认在图文编辑页。'); return; }
      openModal(async (html)=>{
        if(!html.trim()) return;
        const ok = await insertHTML(ctx, html);
        if(!ok) alert('插入失败：请先在编辑区点一下以获取光标，再重试。');
      });
    });
    document.body.appendChild(btn);

    // 快捷键
    document.addEventListener('keydown', (e)=>{
      if((e.ctrlKey||e.metaKey) && e.shiftKey && e.key.toLowerCase()==='h'){
        e.preventDefault();
        const ctx = findCtx();
        if(!ctx.editor){ alert('未找到编辑器。'); return; }
        openModal(async (html)=>{
          if(!html.trim()) return;
          const ok = await insertHTML(ctx, html);
          if(!ok) alert('插入失败：请先在编辑区点一下以获取光标。');
        });
      }
    }, true);
  }

  async function boot(){
    if(location.hostname!=='mp.weixin.qq.com') return;
    // mp 页面异步加载，轮询等待
    for(let i=0;i<40;i++){
      const {editor} = findCtx();
      if(editor){ mountUI(); return; }
      await sleep(500);
    }
    mountUI(); // 兜底也挂按钮
  }

  boot();
})();
