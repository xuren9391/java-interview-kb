#!/usr/bin/env node
/**
 * 一键构建脚本：读取所有 md → 生成 index.html → （可选）提交并推送
 *
 * 用法：
 *   node build.js              只重新生成 index.html
 *   node build.js push         生成 + 提交 + 推送到 GitHub（SSH）
 *   node build.js pushall      生成 + 提交 + 推送到 GitHub + Gitee
 *
 * 前提：已经配好 GitHub SSH key（已完成）和 Gitee origin（已完成）
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const BASE = __dirname;
// 输出到 public/ 子目录，Cloudflare Pages 只托管这个目录（源码不暴露）
const PUBLIC_DIR = path.join(BASE, 'public');
fs.mkdirSync(PUBLIC_DIR, { recursive: true });
const HTML_OUT = path.join(PUBLIC_DIR, 'index.html');

// ===== 1. 配置：三个文件夹 =====
const groups = [
  { dir: '资料', name: '📚 知识体系', files: [] },
  { dir: '面试', name: '💼 面试题集', files: [] },
  { dir: '算法', name: '💻 算法专题', files: [] },
];

// ===== 2. Markdown 渲染器 =====
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
let idc = 0;
const slug = () => 'h' + (idc++);

function inlineFn(s) {
  s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img alt="$1" src="$2">');
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  return s;
}
function renderTable(rows) {
  let h = '<table>';
  rows.forEach((row, idx) => {
    const cells = row.replace(/^\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim());
    if (idx === 0) h += '<thead><tr>' + cells.map(c => `<th>${c}</th>`).join('') + '</tr></thead><tbody>';
    else h += '<tr>' + cells.map(c => `<td>${inlineFn(c)}</td>`).join('') + '</tr>';
  });
  return h + '</tbody></table>';
}
function renderMd(md, headings) {
  // 兼容 Windows(CRLF)/Mac 旧式换行：最先统一成 LF，
  // 否则 ```\r\n 开头的代码块、^(#{1,6})\s+(.*)$、^---+$、^\|.*\|\s*$ 等
  // 依赖 \n/$ 锚点的正则会全部失配，导致代码块/标题/表格/引用/分隔线/列表
  // 全部塌成 <p>，整页排版错乱。
  md = md.replace(/\r\n?/g, '\n');
  const codes = [];
  md = md.replace(/```([a-zA-Z0-9]*)\n([\s\S]*?)```/g, (_, lang, code) => {
    codes.push(`<pre class="code-block"><code>${esc(code.replace(/\n$/, ''))}</code></pre>`);
    return `\x00C${codes.length - 1}\x00`;
  });
  const inls = [];
  md = md.replace(/`([^`\n]+)`/g, (_, code) => {
    inls.push(`<code class="inline-code">${esc(code)}</code>`);
    return `\x00I${inls.length - 1}\x00`;
  });
  const lines = md.split('\n');
  let html = '';
  let inUl = false, inOl = false, inTodo = false, inTable = false, tableRows = [];
  // 是否在代码块内（用占位符后的纯文本无法判断，这里用单独标记）
  let inCode = false;
  const closeLists = () => {
    if (inUl) { html += '</ul>'; inUl = false; }
    if (inOl) { html += '</ol>'; inOl = false; }
    if (inTodo) { html += '</ul>'; inTodo = false; }
  };
  const closeTable = () => { if (inTable) { html += renderTable(tableRows); tableRows = []; inTable = false; } };
  for (const line of lines) {
    if (/^---+\s*$/.test(line)) { closeLists(); closeTable(); html += '<hr>'; continue; }
    let m;
    if (m = /^(#{1,6})\s+(.*)$/.exec(line)) {
      closeLists(); closeTable();
      const lv = m[1].length;
      const hid = slug();
      const titleText = m[2].replace(/\*\*|`/g, '').trim();
      // 收集 H2/H3 作为侧边栏二级目录
      if (headings && (lv === 2 || lv === 3)) {
        headings.push({ id: hid, level: lv, text: titleText });
      }
      html += `<h${lv} id="${hid}">${inlineFn(m[2])}</h${lv}>`; continue;
    }
    if (m = /^-\s+\[([ xX])\]\s+(.*)$/.exec(line)) {
      if (!inTodo) { closeLists(); html += '<ul class="todo-list">'; inTodo = true; }
      const done = m[1].toLowerCase() === 'x';
      html += `<li class="${done ? 'done' : ''}">${done ? '☑' : '☐'} ${inlineFn(m[2])}</li>`; continue;
    }
    if (m = /^\s*[-*+]\s+(.*)$/.exec(line)) {
      if (inOl || inTodo) closeLists();
      if (!inUl) { html += '<ul>'; inUl = true; }
      html += `<li>${inlineFn(m[1])}</li>`; continue;
    }
    if (m = /^\s*\d+\.\s+(.*)$/.exec(line)) {
      if (inUl || inTodo) closeLists();
      if (!inOl) { html += '<ol>'; inOl = true; }
      html += `<li>${inlineFn(m[1])}</li>`; continue;
    }
    if (/^\|.*\|\s*$/.test(line)) {
      closeLists();
      if (/^\|\s*[-:]+/.test(line)) continue;
      tableRows.push(line); inTable = true; continue;
    }
    if (m = /^>\s?(.*)$/.exec(line)) {
      closeLists(); closeTable();
      html += `<blockquote>${inlineFn(m[1])}</blockquote>`; continue;
    }
    if (/^\s*$/.test(line)) { closeLists(); closeTable(); continue; }
    closeLists(); closeTable();
    html += `<p>${inlineFn(line)}</p>`;
  }
  closeLists(); closeTable();
  html = html.replace(/\x00C(\d+)\x00/g, (_, i) => codes[+i]);
  html = html.replace(/\x00I(\d+)\x00/g, (_, i) => inls[+i]);
  return html;
}

// ===== 3. 读取所有 md =====
function loadFiles() {
  let total = 0;
  groups.forEach(g => {
    const dir = path.join(BASE, g.dir);
    if (!fs.existsSync(dir)) { g.files = []; return; }
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.md')).sort();
    g.files = files.map(f => ({
      name: f.replace(/\.md$/, ''),
      content: fs.readFileSync(path.join(dir, f), 'utf8'),
    }));
    total += g.files.length;
  });
  return total;
}

// ===== 4. 构建 HTML =====
const CSS = `
:root{
  --bg:#ffffff;--bg-soft:#f6f8fa;--bg-sidebar:#fbfbfc;--border:#e1e4e8;
  --text:#24292e;--text-soft:#57606a;--heading:#1f2328;
  --primary:#0969da;--primary-soft:#ddf4ff;--code-bg:#f6f8fa;
  --block-bg:#fff8c5;--link:#0969da;--table-head:#f6f8fa;--table-stripe:#fafbfc;
}
body.dark{
  --bg:#0d1117;--bg-soft:#161b22;--bg-sidebar:#010409;--border:#30363d;
  --text:#c9d1d9;--text-soft:#8b949e;--heading:#f0f6fc;
  --primary:#58a6ff;--primary-soft:rgba(56,166,255,.18);--code-bg:#161b22;
  --block-bg:#3b2e00;--link:#58a6ff;--table-head:#161b22;--table-stripe:#0d1117;
}
*{box-sizing:border-box;}
html,body{margin:0;padding:0;height:100%;}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;background:var(--bg);color:var(--text);font-size:15px;line-height:1.7;-webkit-font-smoothing:antialiased;}
.topbar{position:fixed;top:0;left:0;right:0;height:52px;background:var(--bg);border-bottom:1px solid var(--border);display:flex;align-items:center;padding:0 16px;z-index:100;gap:12px;}
.topbar-title{font-weight:600;color:var(--heading);font-size:15px;flex:1;}
.topbar-right{display:flex;align-items:center;gap:8px;}
.icon-btn{background:none;border:1px solid var(--border);border-radius:6px;width:34px;height:34px;cursor:pointer;font-size:16px;color:var(--text);display:flex;align-items:center;justify-content:center;transition:.15s;}
.icon-btn:hover{background:var(--bg-soft);}
.search-input{width:280px;padding:7px 12px;border:1px solid var(--border);border-radius:6px;background:var(--bg-soft);color:var(--text);font-size:13px;outline:none;transition:.15s;}
.search-input:focus{border-color:var(--primary);box-shadow:0 0 0 3px var(--primary-soft);}
.layout{display:flex;margin-top:52px;min-height:calc(100vh - 52px);}
.sidebar{width:280px;flex-shrink:0;background:var(--bg-sidebar);border-right:1px solid var(--border);position:fixed;top:52px;bottom:0;left:0;overflow-y:auto;padding:12px 0;transition:transform .2s;z-index:90;}
.sidebar.hidden{transform:translateX(-100%);}
.nav{padding:0 8px;}
.group{margin-bottom:6px;}
.group-title{font-size:12px;font-weight:700;color:var(--text-soft);text-transform:uppercase;letter-spacing:.5px;padding:12px 12px 4px;}
.doc-link{display:block;padding:6px 12px;color:var(--text);text-decoration:none;border-radius:6px;font-size:13.5px;line-height:1.4;cursor:pointer;margin:1px 0;transition:background .1s;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.doc-link:hover{background:var(--bg-soft);}
.doc-link.active{background:var(--primary-soft);color:var(--primary);font-weight:600;}
/* 二级目录（当前文档的 H2/H3 章节） */
.sub-nav{padding:2px 0 6px 8px;max-height:0;overflow:hidden;transition:max-height .25s ease;border-left:2px solid transparent;margin-left:8px;}
.sub-nav.open{max-height:6000px;overflow-y:auto;border-left:2px solid var(--border);}
.sub-nav:empty{display:none;}
.sub-link{display:block;padding:4px 10px;color:var(--text-soft);text-decoration:none;font-size:12.5px;line-height:1.4;cursor:pointer;border-radius:4px;margin:1px 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.sub-link:hover{color:var(--primary);background:var(--bg-soft);}
.sub-link.active{color:var(--primary);font-weight:600;background:var(--primary-soft);}
.sub-link.lv3{padding-left:22px;font-size:12px;}
.doc-inner{scroll-margin-top:64px;}
.doc h2,.doc h3{scroll-margin-top:64px;}
.content{flex:1;margin-left:280px;padding:36px 48px 100px;transition:margin-left .2s;}
.content.full{margin-left:0;}
.doc{display:none;max-width:900px;margin:0 auto;}
.doc.active{display:block;animation:fade .25s ease;}
@keyframes fade{from{opacity:0;transform:translateY(8px);}to{opacity:1;transform:none;}}
.doc-title{font-size:28px;color:var(--heading);border-bottom:2px solid var(--border);padding-bottom:14px;margin:0 0 28px;}
h1,h2,h3,h4,h5,h6{color:var(--heading);margin:28px 0 14px;line-height:1.3;}
h2{font-size:22px;padding-bottom:8px;border-bottom:1px solid var(--border);}
h3{font-size:19px;}
h4{font-size:16px;}
p{margin:12px 0;}
a{color:var(--link);}
ul,ol{padding-left:24px;margin:12px 0;}
li{margin:4px 0;}
blockquote{border-left:4px solid var(--primary);background:var(--block-bg);padding:10px 16px;margin:14px 0;border-radius:0 6px 6px 0;color:var(--text);}
blockquote p{margin:4px 0;}
hr{border:none;border-top:1px solid var(--border);margin:30px 0;}
table{border-collapse:collapse;width:100%;margin:16px 0;font-size:13.5px;display:block;overflow-x:auto;}
th,td{border:1px solid var(--border);padding:8px 12px;text-align:left;}
th{background:var(--table-head);font-weight:600;}
tbody tr:nth-child(even){background:var(--table-stripe);}
.inline-code{background:var(--code-bg);padding:2px 6px;border-radius:4px;font-family:"SFMono-Regular",Consolas,"Liberation Mono",Menlo,monospace;font-size:.88em;color:var(--primary);}
.code-block{background:var(--code-bg);border:1px solid var(--border);border-radius:8px;padding:14px 16px;overflow-x:auto;margin:16px 0;line-height:1.55;}
.code-block code{font-family:"SFMono-Regular",Consolas,"Liberation Mono",Menlo,monospace;font-size:13px;color:var(--text);white-space:pre;}
.todo-list{list-style:none;padding-left:8px;}
.todo-list li.done{color:var(--text-soft);text-decoration:line-through;}
strong{color:var(--heading);}
.search-panel{position:fixed;top:52px;left:0;right:0;background:var(--bg);border-bottom:1px solid var(--border);max-height:65vh;overflow-y:auto;z-index:99;padding:10px 16px 16px;box-shadow:0 4px 12px rgba(0,0,0,.08);}
.search-panel.hidden{display:none;}
.search-result-item{padding:10px 12px;border-radius:6px;cursor:pointer;}
.search-result-item:hover{background:var(--bg-soft);}
.sr-name{font-weight:600;color:var(--primary);font-size:14px;}
.sr-snippet{color:var(--text-soft);font-size:12.5px;margin-top:3px;}
mark{background:#ffd54f;color:#000;padding:0 2px;border-radius:2px;}
.progress-bar{position:fixed;top:0;left:0;height:3px;background:var(--primary);width:0;z-index:200;transition:width .1s;}
@media(max-width:768px){
  .sidebar{transform:translateX(-100%);box-shadow:2px 0 8px rgba(0,0,0,.15);}
  .sidebar.show{transform:translateX(0);}
  .content{margin-left:0;padding:24px 18px 60px;}
  .search-input{width:140px;}
  .topbar-title{font-size:13px;}
}
`;

const JS = `
var links=document.querySelectorAll('.doc-link');
var docs=document.querySelectorAll('.doc');
var progress=document.getElementById('progress');
var DOCS=window.__DOCS__;

// 构建每个文档的二级目录（H2/H3）并注入侧边栏
function buildSubNav(id){
  var sub=document.getElementById('sub-'+id);
  if(!sub||sub.dataset.built)return;
  var doc=DOCS.find(function(d){return d.id===id;});
  if(!doc||!doc.headings||!doc.headings.length){sub.dataset.built='1';return;}
  sub.innerHTML=doc.headings.map(function(h){
    var cls='sub-link'+(h.level===3?' lv3':'');
    return '<a class="'+cls+'" data-hid="'+h.id+'" data-doc="'+id+'">'+h.text+'</a>';
  }).join('');
  sub.dataset.built='1';
}

// 当前文档的高亮跟踪
var currentSubNav=null;
function highlightHeading(){
  if(!currentSubNav)return;
  var docId=currentSubNav;
  // 找当前可视区域内最靠上的 H2/H3
  var headEls=document.querySelectorAll('#'+docId+' h2[id], #'+docId+' h3[id]');
  var cur=null;
  var probe=scrollY+80;
  for(var i=0;i<headEls.length;i++){
    if(headEls[i].offsetTop<=probe)cur=headEls[i];
    else break;
  }
  var curId=cur?cur.id:null;
  var sub=document.getElementById('sub-'+docId);
  if(!sub)return;
  sub.querySelectorAll('.sub-link').forEach(function(s){
    s.classList.toggle('active',s.getAttribute('data-hid')===curId);
  });
  // 让高亮的章节在侧边栏可见
  var act=sub.querySelector('.sub-link.active');
  if(act){var sr=act.getBoundingClientRect();if(sr.top<60||sr.bottom>innerHeight)act.scrollIntoView({block:'nearest'});}
}

function showDoc(id){
  docs.forEach(function(d){d.classList.toggle('active',d.id===id);});
  links.forEach(function(l){l.classList.toggle('active',l.getAttribute('data-id')===id);});
  // 折叠所有二级目录，只展开当前文档的
  document.querySelectorAll('.sub-nav').forEach(function(s){s.classList.remove('open');});
  buildSubNav(id);
  var curSub=document.getElementById('sub-'+id);
  if(curSub)curSub.classList.add('open');
  currentSubNav=id;
  window.scrollTo(0,0);
  history.replaceState(null,'','#'+id);
  var active=document.querySelector('.doc-link.active');
  if(active)active.scrollIntoView({block:'nearest'});
  setTimeout(highlightHeading,50);
}
links.forEach(function(l){l.addEventListener('click',function(e){e.preventDefault();showDoc(l.getAttribute('data-id'));if(innerWidth<=768)document.getElementById('sidebar').classList.remove('show');});});
// 二级目录点击：跳转到对应标题
document.addEventListener('click',function(e){
  var sl=e.target.closest('.sub-link');
  if(!sl)return;
  e.preventDefault();
  var hid=sl.getAttribute('data-hid'),docId=sl.getAttribute('data-doc');
  if(docId!==currentSubNav)showDoc(docId);
  var el=document.getElementById(hid);
  if(el){window.scrollTo(0,el.offsetTop-64);}
  setTimeout(highlightHeading,80);
});
var initId=location.hash?location.hash.slice(1):(links[0]?links[0].getAttribute('data-id'):'');
if(initId&&document.getElementById(initId))showDoc(initId);
else if(docs[0]){docs[0].classList.add('active');if(links[0])links[0].classList.add('active');buildSubNav(docs[0].id);var fs=document.getElementById('sub-'+docs[0].id);if(fs)fs.classList.add('open');currentSubNav=docs[0].id;}
var tb=document.getElementById('theme-toggle');
function setTheme(d){document.body.classList.toggle('dark',d);tb.textContent=d?'☀️':'🌙';try{localStorage.setItem('kb-theme',d?'dark':'light');}catch(e){}}
var sv=null;try{sv=localStorage.getItem('kb-theme');}catch(e){}
setTheme(sv?sv==='dark':false);
tb.addEventListener('click',function(){setTheme(!document.body.classList.contains('dark'));});
document.getElementById('menu-toggle').addEventListener('click',function(){document.getElementById('sidebar').classList.toggle('show');});
var si=document.getElementById('search'),sp=document.getElementById('search-panel'),sr=document.getElementById('search-results');
si.addEventListener('input',function(){
  var q=si.value.trim().toLowerCase();
  if(!q){sp.classList.add('hidden');return;}
  sp.classList.remove('hidden');
  var res=[];
  for(var i=0;i<DOCS.length;i++){
    var d=DOCS[i],idx=d.text.indexOf(q),nm=d.name.toLowerCase().indexOf(q)>=0;
    if(idx>=0||nm){
      var st=idx>=0?idx:0;
      res.push({id:d.id,name:d.name,snippet:d.text.substring(Math.max(0,st-35),st+85),q:q});
      if(res.length>=15)break;
    }
  }
  if(!res.length){sr.innerHTML='<div class="search-result-item"><div class="sr-name">无结果</div><div class="sr-snippet">换个关键词试试</div></div>';return;}
  sr.innerHTML=res.map(function(r){
    function hl(s){var i=s.toLowerCase().indexOf(r.q);return i<0?s:(s.slice(0,i)+'<mark>'+s.slice(i,i+r.q.length)+'</mark>'+s.slice(i+r.q.length));}
    return '<div class="search-result-item" data-id="'+r.id+'"><div class="sr-name">'+r.name+'</div><div class="sr-snippet">'+hl(r.snippet)+'</div></div>';
  }).join('');
  sr.querySelectorAll('.search-result-item').forEach(function(it){it.addEventListener('click',function(){showDoc(it.getAttribute('data-id'));si.value='';sp.classList.add('hidden');});});
});
document.addEventListener('click',function(e){if(!e.target.closest('#search')&&!e.target.closest('#search-panel'))sp.classList.add('hidden');});
document.addEventListener('keydown',function(e){
  if(e.key==='Escape')sp.classList.add('hidden');
  if(e.key==='/'&&e.target.tagName!=='INPUT'){e.preventDefault();si.focus();}
});
window.addEventListener('scroll',function(){
  var h=document.documentElement.scrollHeight-innerHeight;
  progress.style.width=(h>0?(scrollY/h*100):0)+'%';
  highlightHeading();
});
`;

function build() {
  const total = loadFiles();
  let sidebarHtml = '', contentHtml = '';
  const docIndex = [];
  groups.forEach((g, gi) => {
    sidebarHtml += `<div class="group"><div class="group-title">${g.name}</div>`;
    g.files.forEach((f, fi) => {
      const id = `doc-${gi}-${fi}`;
      const headings = [];
      sidebarHtml += `<a class="doc-link" data-id="${id}" href="#${id}">${f.name}</a>`;
      // 二级目录容器：放当前文档的 H2/H3 章节，展开/收起
      sidebarHtml += `<div class="sub-nav" data-for="${id}" id="sub-${id}"></div>`;
      contentHtml += `<article id="${id}" class="doc"><div class="doc-inner"><h1 class="doc-title">${f.name}</h1>${renderMd(f.content, headings)}</div></article>`;
      const plain = f.content.replace(/[#*`>|()\[\]\-]/g, ' ').replace(/\s+/g, ' ');
      docIndex.push({ id, name: f.name, text: plain.toLowerCase(), headings });
    });
    sidebarHtml += `</div>`;
  });

  let html = '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">';
  html += '<meta name="viewport" content="width=device-width,initial-scale=1.0">';
  html += '<title>Java 资深/架构师 · 面试备战知识库</title>';
  html += '<style>' + CSS + '</style></head><body>';
  html += '<div id="progress" class="progress-bar"></div>';
  html += '<header class="topbar">';
  html += '<button id="menu-toggle" class="icon-btn" title="目录">☰</button>';
  html += '<div class="topbar-title">Java 资深 / 架构师 · 面试备战知识库</div>';
  html += '<div class="topbar-right">';
  html += '<input id="search" class="search-input" placeholder="🔍 搜索（按 / 聚焦）" autocomplete="off">';
  html += '<button id="theme-toggle" class="icon-btn" title="切换主题">🌙</button>';
  html += '</div></header>';
  html += '<div class="layout">';
  html += '<aside id="sidebar" class="sidebar"><nav class="nav">' + sidebarHtml + '</nav></aside>';
  html += '<main id="content" class="content">' + contentHtml + '</main>';
  html += '</div>';
  html += '<div id="search-panel" class="search-panel hidden"><div id="search-results"></div></div>';
  html += '<script>window.__DOCS__=' + JSON.stringify(docIndex) + ';</script>';
  html += '<script>' + JS + '</script>';
  html += '</body></html>';

  fs.writeFileSync(HTML_OUT, html, 'utf8');
  return { total, size: Buffer.byteLength(html, 'utf8') };
}

// ===== 5. 主流程 =====
function sh(cmd, opts = {}) {
  try {
    execSync(cmd, { cwd: BASE, stdio: 'inherit', ...opts });
    return true;
  } catch (e) {
    return false;
  }
}

const mode = process.argv[2] || '';
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('🔨 开始构建 index.html ...');
const { total, size } = build();
console.log(`✅ 构建完成：${total} 篇文档，index.html ${(size / 1024).toFixed(1)} KB`);

if (mode === 'push' || mode === 'pushall') {
  console.log('\n📦 提交更改 ...');
  sh('git add -A');
  // 用时间戳作为提交信息，避免空提交报错
  const msg = '更新知识库内容 ' + new Date().toLocaleString('zh-CN', { hour12: false });
  sh(`git commit -m "${msg}"`) || console.log('（没有变更需要提交）');

  console.log('\n🚀 推送到 GitHub（SSH）...');
  if (sh('git push github master')) {
    console.log('✅ GitHub 推送成功');
  } else {
    console.log('❌ GitHub 推送失败，请检查网络或 SSH 配置');
  }

  if (mode === 'pushall') {
    console.log('\n🚀 推送到 Gitee ...');
    if (sh('git push origin master')) {
      console.log('✅ Gitee 推送成功');
    } else {
      console.log('❌ Gitee 推送失败');
    }
  }
  console.log('\n🎉 全部完成！');
  console.log('🌐 在线访问: https://xuren9391.github.io/java-interview-kb/');
}
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
