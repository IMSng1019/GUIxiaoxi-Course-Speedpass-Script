// ==UserScript==
// @name         贵小溪学习平台 自动刷课助手
// @namespace    gxx-autowatch
// @version      2.0.0
// @description  自动挂机刷完课程视频并自动切换章节(按学习进度判定)，支持在线测试接入 DeepSeek API 自动答题交卷
// @author       autogen
// @match        https://gxx-edu.digitlanguage.com/*
// @match        http://gxx-edu.digitlanguage.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==
// 提示：如果答题时日志提示「网络请求被拦截(CORS/CSP)」，请把上面两行 @grant/@run-at 之间的
//       @grant none 替换成下面两行（去掉行首注释），保存后刷新页面即可绕过跨域限制：
// @grant        GM_xmlhttpRequest
// @connect      api.deepseek.com

(function () {
  'use strict';
  if (window.__gxxAutoWatchLoaded) return;
  window.__gxxAutoWatchLoaded = true;

  var LS_KEY = 'gxx_autowatch_v1';
  var DEFAULTS = {
    mode: 'idle', speed: 1, mute: true, autoNext: true,
    chapterNav: true,          // 章节切换：看完一章后返回课程列表按学习进度进下一章
    autoQuiz: false,           // 在线测试自动答题
    autoSubmit: true,          // 全部答完后自动交卷
    apiKey: '',                // DeepSeek API Key（仅存本机 localStorage）
    apiBase: 'https://api.deepseek.com/v1',
    apiModel: 'deepseek-chat'
  };
  var MODE_LABEL = { turbo: '⚡加速', seek: '⏭跳结尾', idle: '🐢挂机1x' };
  var cfg = Object.assign({}, DEFAULTS);
  try {
    var saved = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
    cfg = Object.assign(cfg, saved);
  } catch (e) {}

  function save() { try { localStorage.setItem(LS_KEY, JSON.stringify(cfg)); } catch (e) {} }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function fmt(s) {
    s = Math.max(0, Math.floor(s || 0));
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return (h ? h + ':' : '') + p(m) + ':' + p(ss);
  }
  function docCompare(a, b) {
    if (a === b) return 0;
    try {
      if (a.compareDocumentPosition(b) & 4) return -1;
      if (b.compareDocumentPosition(a) & 4) return 1;
      return 0;
    } catch (e) { return 0; }
  }

  /* ---------------- 日志 ---------------- */
  var logLines = [];
  function log() {
    var msg = Array.prototype.slice.call(arguments).join(' ');
    try { console.log('%c[刷课助手]', 'color:#0a7;font-weight:bold', msg); } catch (e) {}
    logLines.push(new Date().toLocaleTimeString() + ' ' + msg);
    if (logLines.length > 60) logLines.shift();
    var el = document.getElementById('gxx-log');
    if (el) { el.textContent = logLines.slice(-8).join('\n'); el.scrollTop = el.scrollHeight; }
  }

  /* ---------------- 视频查找 ---------------- */
  function videosIn(doc) {
    try { return Array.prototype.slice.call(doc.querySelectorAll('video')); } catch (e) { return []; }
  }
  function getAllVideos() {
    var list = videosIn(document);
    var frames = document.querySelectorAll('iframe');
    for (var i = 0; i < frames.length; i++) {
      try { list = list.concat(videosIn(frames[i].contentDocument)); } catch (e) {}
    }
    return list;
  }
  function currentVideo() {
    var all = getAllVideos();
    for (var i = 0; i < all.length; i++) {
      if (all[i].readyState >= 1 && all[i].duration) return all[i];
    }
    return all[0] || null;
  }
  function videoKey(v) {
    return v.currentSrc || v.src || '';
  }

  /* ---------------- 速度 / 跳转控制 ---------------- */
  var seekTries = {};
  function applyToVideo(v) {
    if (!v) return;
    try {
      var rate = cfg.mode === 'turbo' ? cfg.speed : (cfg.mode === 'seek' ? 16 : 1);
      if (Math.abs(v.playbackRate - rate) > 0.01) v.playbackRate = rate;
      if (cfg.mode === 'seek') {
        if (v.duration && isFinite(v.duration) && v.duration > 10 && (v.duration - v.currentTime) > 5) {
          var key = videoKey(v);
          var tries = seekTries[key] || 0;
          if (tries < 40) {
            v.currentTime = v.duration - 3;
            seekTries[key] = tries + 1;
          } else {
            log('跳转被播放器反复阻止，自动退回加速模式');
            cfg.mode = 'turbo'; save(); updatePanel();
          }
        }
      }
      if (cfg.mute) v.muted = true;
    } catch (e) {}
  }
  function applyAll() {
    getAllVideos().forEach(applyToVideo);
  }

  // iframe 内的副本只负责倍速与自动播放，不显示面板、不负责跳转
  if (window.self !== window.top) {
    setInterval(function () {
      var vs = videosIn(document);
      for (var i = 0; i < vs.length; i++) {
        applyToVideo(vs[i]);
        if (vs[i].paused && !vs[i].ended) {
          var p = vs[i].play();
          if (p && p.catch) p.catch(function () {});
        }
      }
    }, 500);
    return;
  }

  // 对抗播放器重置倍速
  try {
    var desc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'playbackRate');
    if (desc && desc.set && desc.get && !window.__gxxRateHooked) {
      Object.defineProperty(HTMLMediaElement.prototype, 'playbackRate', {
        configurable: true,
        get: desc.get,
        set: function (val) {
          var want = (cfg.mode === 'turbo') ? cfg.speed : val;
          try { desc.set.call(this, want); } catch (e) {}
        }
      });
      window.__gxxRateHooked = true;
      log('倍速钩子安装成功');
    }
  } catch (e) { log('倍速钩子安装失败：' + e.message); }

  /* ---------------- 防暂停 / 自动播放 ---------------- */
  document.addEventListener('ratechange', function (e) {
    if (e.target && e.target.tagName === 'VIDEO') applyToVideo(e.target);
  }, true);
  document.addEventListener('pause', function (e) {
    var v = e.target;
    if (v && v.tagName === 'VIDEO' && !v.ended) {
      setTimeout(function () {
        try {
          if (!v.ended && v.paused) { var p = v.play(); if (p && p.catch) p.catch(function () {}); }
        } catch (err) {}
      }, 300);
    }
  }, true);

  /* ---------------- 通用 DOM 工具 ---------------- */
  var NEXT_TEXTS = ['下一讲', '下一课', '下一节', '下一章', '下一个', '继续学习', '继续观看'];
  function isVisible(el) {
    if (!el || !el.getClientRects || !el.getClientRects().length) return false;
    var st = getComputedStyle(el);
    return st.display !== 'none' && st.visibility !== 'hidden';
  }
  function isDisabled(el) {
    if (el.disabled) return true;
    try { return /disable|disabled/.test(el.className || ''); } catch (e) { return false; }
  }
  function clickEl(el) {
    try {
      el.scrollIntoView({ block: 'center' });
      el.click();
      return true;
    } catch (e) {
      try {
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        return true;
      } catch (e2) { return false; }
    }
  }
  function clickableScore(el) {
    var s = 0;
    if (el.tagName === 'A' || el.tagName === 'BUTTON') s += 3;
    try {
      if (el.getAttribute && el.getAttribute('onclick')) s += 3;
      if (el.getAttribute && (el.getAttribute('role') === 'button' || el.getAttribute('role') === 'link')) s += 2;
    } catch (e) {}
    if (el.tagName === 'LI') s += 1;
    if (el.tagName === 'H1' || el.tagName === 'H2' || el.tagName === 'H3') s += 1;
    try {
      var st = getComputedStyle(el);
      if (st && st.cursor === 'pointer') s += 2;
    } catch (e) {}
    return s;
  }
  function findNextButtons() {
    var out = [];
    var nodes = document.querySelectorAll('button, a, div, span');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el.closest && el.closest('#gxx-panel')) continue;
      var t = (el.textContent || '').trim();
      if (t.length > 20) continue;
      if (!isVisible(el) || isDisabled(el)) continue;
      for (var j = 0; j < NEXT_TEXTS.length; j++) {
        if (t.indexOf(NEXT_TEXTS[j]) !== -1) { out.push(el); break; }
      }
    }
    out.sort(function (a, b) {
      var va = (a.tagName === 'BUTTON' || a.tagName === 'A') ? 1 : 0;
      var vb = (b.tagName === 'BUTTON' || b.tagName === 'A') ? 1 : 0;
      return vb - va;
    });
    return out;
  }
  function tryClickNextButton() {
    var btns = findNextButtons();
    if (!btns.length) return false;
    log('点击「下一讲/下一课」按钮：' + (btns[0].textContent || '').trim());
    return clickEl(btns[0]);
  }
  function currentVideoId() {
    try { return new URLSearchParams(location.search).get('videoId'); } catch (e) { return null; }
  }
  function currentTitle() {
    try { return decodeURIComponent(new URLSearchParams(location.search).get('title') || ''); } catch (e) { return ''; }
  }
  function catalogLinks(includeHidden) {
    var nodes = document.querySelectorAll('a[href*="videoId"], [data-videoid], [data-video-id]');
    var arr = Array.prototype.slice.call(nodes);
    if (!includeHidden) arr = arr.filter(isVisible);
    return arr;
  }
  function hrefContains(el, id) {
    if (!id) return false;
    try {
      var href = el.href || el.getAttribute('data-videoid') || el.getAttribute('data-video-id') || '';
      return href.indexOf(id) !== -1;
    } catch (e) { return false; }
  }
  function isLastInCatalog() {
    var id = currentVideoId();
    var links = catalogLinks(true);
    if (links.length && id) {
      var last = links[links.length - 1];
      return hrefContains(last, id);
    }
    return false;
  }
  function findHeaderIn(item) {
    if (!item) return null;
    var kids = Array.prototype.slice.call(item.children || []);
    for (var k = 0; k < kids.length; k++) {
      var el = kids[k];
      try {
        if (el.getAttribute && el.getAttribute('aria-expanded') !== null) return el;
      } catch (e) {}
      var cls = typeof el.className === 'string' ? el.className : '';
      if (/header|title|trigger|tab/i.test(cls)) return el;
      if (el.tagName === 'BUTTON') return el;
    }
    return null;
  }
  function expandForHiddenEntry(el) {
    var node = el;
    for (var i = 0; i < 12 && node && node !== document.documentElement; i++) {
      try {
        if (node.getAttribute && node.getAttribute('aria-expanded') === 'false') { clickEl(node); return true; }
      } catch (e) {}
      var cls = typeof node.className === 'string' ? node.className : '';
      if (/collapse|accordion|chapter|section|group/i.test(cls) && !isVisible(node)) {
        var header = findHeaderIn(node.parentElement) || findHeaderIn(node);
        if (header) { clickEl(header); return true; }
      }
      node = node.parentElement;
    }
    return false;
  }
  function chapterContainerOf(el) {
    var node = el;
    for (var i = 0; i < 12 && node && node !== document.documentElement; i++) {
      node = node.parentElement;
      if (findHeaderIn(node)) return node;
    }
    return null;
  }
  function collapsePrevChapterIfNeeded(prevEl, nextEl) {
    try {
      var a = chapterContainerOf(prevEl);
      var b = chapterContainerOf(nextEl);
      if (!a || !b || a === b) return;
      var header = findHeaderIn(a);
      if (header && isVisible(prevEl)) clickEl(header);
    } catch (e) {}
  }
  function catalogRoot() {
    var links = catalogLinks(true);
    if (!links.length) return null;
    var root = links[0];
    var guard = 0;
    while (root && root !== document.documentElement && guard < 20) {
      var all = true;
      for (var i = 0; i < links.length; i++) {
        if (!root.contains(links[i])) { all = false; break; }
      }
      if (all) break;
      root = root.parentElement;
      guard++;
    }
    return root;
  }
  function chapterHeaders() {
    var root = catalogRoot();
    var cand = document.querySelectorAll('[aria-expanded], [class*="chapter"], [class*="section"], [class*="group"], [class*="collapse"], [class*="accordion"]');
    var heads = [];
    for (var i = 0; i < cand.length; i++) {
      var el = cand[i];
      if (root && !root.contains(el)) continue;
      var cls = typeof el.className === 'string' ? el.className : '';
      var t = (el.textContent || '').trim();
      if (t.length > 80) continue;
      var ok = false;
      try { if (el.getAttribute && el.getAttribute('aria-expanded') !== null) ok = true; } catch (e) {}
      if (!ok) ok = (/chapter|section|group|collapse|accordion/i.test(cls) && /header|title|trigger|head|tab/i.test(cls));
      if (!ok) continue;
      var chapterLike = /chapter|section|group|category|unit/i.test(cls) ||
        /^第[一二三四五六七八九十百0-9]{1,4}[章节篇单元部分]/.test(t) ||
        !!(el.parentElement && el.parentElement.querySelector && el.parentElement.querySelector('a[href*="videoId"], [data-videoid], [data-video-id]'));
      if (!chapterLike) continue;
      if (heads.indexOf(el) === -1) heads.push(el);
    }
    return heads;
  }
  function expandNextChapter(prevEntry) {
    var heads = chapterHeaders();
    if (!heads.length) return false;
    var curIdx = -1;
    for (var i = 0; i < heads.length; i++) {
      try {
        if (heads[i].compareDocumentPosition(prevEntry) & Node.DOCUMENT_POSITION_FOLLOWING) curIdx = i;
      } catch (e) {}
    }
    if (curIdx === -1 || curIdx + 1 >= heads.length) return false;
    var nextHead = heads[curIdx + 1];
    try {
      if (nextHead.getAttribute && nextHead.getAttribute('aria-expanded') === 'true') return false;
    } catch (e) {}
    var container = nextHead.parentElement;
    if (container) {
      var lks = container.querySelectorAll('a[href*="videoId"], [data-videoid], [data-video-id]');
      for (var j = 0; j < lks.length; j++) {
        if (isVisible(lks[j])) return false; // 该章节已展开
      }
    }
    log('展开下一章节：' + (nextHead.textContent || '').trim().slice(0, 20));
    return clickEl(nextHead);
  }
  function locateInCatalog(id, title) {
    var links = catalogLinks(true);
    var idx = -1;
    if (id) {
      for (var i = 0; i < links.length; i++) {
        if (hrefContains(links[i], id)) { idx = i; break; }
      }
    }
    if (idx === -1 && title) {
      for (var j = 0; j < links.length; j++) {
        if ((links[j].textContent || '').indexOf(title.slice(0, 6)) !== -1) { idx = j; break; }
      }
    }
    return { links: links, idx: idx };
  }
  function clickNextInCatalog() {
    var prevHref = location.href;
    var id = currentVideoId();
    var title = currentTitle();
    var plan = locateInCatalog(id, title);
    var links = plan.links, idx = plan.idx;
    if (idx === -1) {
      if (title && clickNextByTitle()) return true;
      log('⚠ 未能从目录定位当前课程');
      return false;
    }
    var step1 = sleep(0);
    if (idx + 1 >= links.length) {
      step1 = step1.then(function () {
        if (!expandNextChapter(links[idx])) return null;
        return sleep(900).then(function () {
          var p2 = locateInCatalog(id, title);
          return (p2.idx === -1 || p2.idx + 1 >= p2.links.length) ? null : p2;
        });
      });
    } else {
      step1 = step1.then(function () { return { links: links, idx: idx }; });
    }
    step1.then(function (res) {
      var L = links, I = idx;
      if (res) { L = res.links; I = res.idx; }
      if (I === -1 || I + 1 >= L.length) {
        log('⚠ 当前已是目录最后一课，或下一章节无法展开');
        return;
      }
      var next = L[I + 1];
      if (!isVisible(next)) expandForHiddenEntry(next);
      return sleep(700).then(function () {
        log('从课程目录点击下一课：' + (next.textContent || '').trim().slice(0, 30));
        clickEl(next);
        collapsePrevChapterIfNeeded(L[I], next);
        return sleep(4000).then(function () {
          if (location.href !== prevHref) { log('✅ 已进入下一课'); return; }
          log('首次点击未切换，确保章节展开后重试一次');
          expandForHiddenEntry(next);
          return sleep(800).then(function () {
            clickEl(next);
            collapsePrevChapterIfNeeded(L[I], next);
            return sleep(4000).then(function () {
              if (location.href === prevHref) log('⚠ 目录点击后页面未切换');
              else log('✅ 已进入下一课');
            });
          });
        });
      });
    }).catch(function (e) {
      log('目录点击出错：' + (e && e.message ? e.message : e));
    });
    return true;
  }
  function clickNextByTitle() {
    var title = currentTitle();
    var lis = Array.prototype.slice.call(document.querySelectorAll('li'));
    var idx = -1;
    for (var i = 0; i < lis.length; i++) {
      var t = (lis[i].textContent || '').trim();
      if (t.length < 300 && t.indexOf(title.slice(0, 6)) !== -1) { idx = i; break; }
    }
    if (idx === -1) return false;
    var parent = lis[idx].parentElement;
    if (!parent) return false;
    var sib = Array.prototype.slice.call(parent.children);
    var pos = sib.indexOf(lis[idx]);
    if (pos === -1 || pos + 1 >= sib.length) return false;
    var next = sib[pos + 1];
    var link = next.querySelector('a, [onclick]') || next;
    log('从课程目录点击下一课：' + (next.textContent || '').trim().slice(0, 30));
    return clickEl(link);
  }

  /* ---------------- 章节识别（视频页目录） ---------------- */
  var CN_NUM = { '零': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };
  function cnToNum(s) {
    if (CN_NUM[s] !== undefined) return CN_NUM[s];
    if (s === '十') return 10;
    if (s.charAt(0) === '十') return 10 + (CN_NUM[s.charAt(1)] || 0);
    if (s.charAt(s.length - 1) === '十') return (CN_NUM[s.charAt(0)] || 0) * 10;
    var p = s.indexOf('十');
    if (p !== -1 && p === s.lastIndexOf('十')) {
      var a = CN_NUM[s.slice(0, p)], b = CN_NUM[s.slice(p + 1)];
      if (a !== undefined && b !== undefined) return a * 10 + b;
    }
    return null;
  }
  function parseChapterNo(text) {
    try {
      var m = String(text || '').match(/第([一二三四五六七八九十百0-9]{1,4})[章节]/);
      if (!m) return null;
      if (/^\d+$/.test(m[1])) return parseInt(m[1], 10);
      return cnToNum(m[1]);
    } catch (e) { return null; }
  }
  function chapterBlocks() {
    var heads = chapterHeaders();
    var links = catalogLinks(true);
    if (!heads.length || !links.length) return [];
    var ordered = heads.slice().sort(docCompare);
    var blocks = [];
    for (var i = 0; i < ordered.length; i++) {
      var head = ordered[i];
      var lks = [];
      for (var j = 0; j < links.length; j++) {
        try { if (head.contains(links[j])) lks.push(links[j]); } catch (e) {}
      }
      if (!lks.length) {
        var nextHead = i + 1 < ordered.length ? ordered[i + 1] : null;
        for (var k = 0; k < links.length; k++) {
          var pos = 0;
          try { pos = head.compareDocumentPosition(links[k]); } catch (e) {}
          var afterHead = !!(pos & 4);
          var beforeNext = true;
          if (nextHead) {
            var pos2 = 0;
            try { pos2 = nextHead.compareDocumentPosition(links[k]); } catch (e) {}
            beforeNext = !(pos2 & 4);
          }
          if (afterHead && beforeNext) lks.push(links[k]);
        }
      }
      lks.sort(docCompare);
      blocks.push({ head: head, no: parseChapterNo(head.textContent || ''), title: (head.textContent || '').trim(), links: lks });
    }
    return blocks;
  }
  function chapterState() {
    var id = currentVideoId();
    var blocks = chapterBlocks();
    if (!blocks.length) return null;
    var curIdx = -1;
    for (var i = 0; i < blocks.length; i++) {
      for (var j = 0; j < blocks[i].links.length; j++) {
        if (hrefContains(blocks[i].links[j], id)) { curIdx = i; break; }
      }
      if (curIdx !== -1) break;
    }
    if (curIdx === -1) return { blocks: blocks, curIdx: -1, curBlock: null, lastInChapter: false };
    var lastLink = blocks[curIdx].links[blocks[curIdx].links.length - 1];
    return { blocks: blocks, curIdx: curIdx, curBlock: blocks[curIdx], lastInChapter: hrefContains(lastLink, id) };
  }

  /* ---------------- 章节切换：返回课程列表 ---------------- */
  function scheduleChapterSwitch(curBlock) {
    busy = true;
    var no = curBlock && curBlock.no ? curBlock.no : 0;
    log('【章节切换】本章已看完' + (no ? '（第' + no + '章）' : '') + '，等待进度上报后返回课程列表...');
    var prevHref = location.href;
    sleep(3500).then(function () {
      sessionStorage.setItem('gxx_goto_chapter', JSON.stringify({ no: no, title: curBlock ? curBlock.title : '', t: Date.now() }));
      sessionStorage.setItem('gxx_next_after_load', prevHref);
      log('刷新页面并返回课程列表，按学习进度进入下一章节');
      setTimeout(function () { location.reload(); }, 300);
    }).catch(function (e) {
      busy = false;
      log('章节切换出错：' + (e && e.message ? e.message : e));
    });
  }
  function goBackToCourseList() {
    return new Promise(function (resolve) {
      var before = location.href;
      log('⏪ 返回课程列表页...');
      try { history.back(); } catch (e) {}
      sleep(4000).then(function () {
        if (location.href !== before) {
          if (!getAllVideos().length) { resolve(true); return; }
          log('⚠ 返回后的页面仍是视频页，改按目录流程继续');
          resolve(false);
          return;
        }
        log('history.back 未生效，尝试点击「返回课程」链接...');
        if (clickBackLink()) {
          sleep(4500).then(function () {
            resolve(location.href !== before && !getAllVideos().length);
          });
        } else {
          resolve(false);
        }
      });
    });
  }
  function clickBackLink() {
    var TEXTS = ['返回课程列表', '返回课程', '课程列表', '课程目录', '返回列表', '返回目录', '返回'];
    var nodes = document.querySelectorAll('a, button');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (!isVisible(el) || isDisabled(el)) continue;
      var t = (el.textContent || '').trim();
      if (t.length > 12) continue;
      for (var j = 0; j < TEXTS.length; j++) {
        if (t === TEXTS[j] || t.indexOf(TEXTS[j]) !== -1) {
          try {
            if (el.href && el.href.indexOf('videoId') !== -1) continue;
          } catch (e) {}
          log('点击返回链接：' + t);
          return clickEl(el);
        }
      }
    }
    return false;
  }

  /* ---------------- 下一课入口（含章节切换判定） ---------------- */
  var busy = false;
  function goNext(reason) {
    if (busy) return;
    if (!cfg.autoNext) { log('自动下一课已关闭，跳过：' + reason); return; }
    var chs = cfg.chapterNav ? chapterState() : null;
    // 1) 目录结构清晰：当前视频是本章最后一课
    if (chs && chs.curIdx !== -1 && chs.lastInChapter) {
      if (chs.blocks.length >= 2) {
        if (chs.curIdx + 1 < chs.blocks.length) {
          scheduleChapterSwitch(chs.blocks[chs.curIdx]);
          return;
        }
        log('🎉 当前已是最后一个章节的最后一课，全部课程已看完！');
        return;
      }
      // 页面上只能看到一个章节 → 后面可能还有章节，返回课程列表按进度判定
      log('📑 本章已看完，返回课程列表按学习进度进入下一章节');
      scheduleChapterSwitch(chs.blocks[chs.curIdx]);
      return;
    }
    // 2) 整个目录已到最后
    if (isLastInCatalog()) {
      if (cfg.chapterNav) {
        var curB = chs && chs.curIdx !== -1 ? chs.blocks[chs.curIdx] : null;
        log('📑 当前目录已到末尾，返回课程列表按学习进度选择下一章节');
        scheduleChapterSwitch(curB);
        return;
      }
      log('🎉 当前已是课程目录的最后一课，全部课程已看完！');
      return;
    }
    var replayN = parseInt(sessionStorage.getItem('gxx_replay_' + (currentVideoId() || 'none')) || '0', 10);
    if (replayN >= 8) {
      log('⚠ 本课已连续多次无法进入下一课，暂停自动刷新，请手动检查课程是否解锁、进度是否记录');
      return;
    }
    busy = true;
    log('【' + reason + '】等待进度上报后自动刷新页面...');
    var prevHref = location.href;
    sleep(3500).then(function () {
      sessionStorage.setItem('gxx_next_after_load', prevHref);
      log('刷新页面，稍后自动从课程目录进入下一课');
      setTimeout(function () { location.reload(); }, 300);
    }).catch(function (e) {
      busy = false;
      log('跳转出错：' + (e && e.message ? e.message : e));
    });
  }
  document.addEventListener('ended', function (e) {
    if (e.target && e.target.tagName === 'VIDEO') goNext('视频播放结束');
  }, true);

  /* ---------------- 课程列表页：按学习进度选下一章节 ---------------- */
  function isActiveEntry(el) {
    var n = el;
    for (var i = 0; i < 4 && n && n !== document.documentElement; i++) {
      try {
        if (n.getAttribute && n.getAttribute('aria-current')) return true;
        if (n.getAttribute && n.getAttribute('aria-selected') === 'true') return true;
      } catch (e) {}
      var cls = typeof n.className === 'string' ? n.className : '';
      if (/\b(active|current|selected|checked|cur|on)\b/i.test(cls)) return true;
      n = n.parentElement;
    }
    return false;
  }
  function readProgress(el) {
    var node = el;
    for (var i = 0; i < 5 && node && node !== document.documentElement; i++) {
      try {
        var t = (node.textContent || '');
        if (t.length > 0 && t.length < 2000) {
          // 若该容器里出现了两个以上章节标题，说明已经爬到整个章节列表，停止
          if (node !== el && /第[一二三四五六七八九十百0-9]{1,4}[章节][\s\S]{0,200}第[一二三四五六七八九十百0-9]{1,4}[章节]/.test(t)) break;
          var m1 = t.match(/(\d{1,3})\s*%/);
          if (m1) return parseInt(m1[1], 10);
          var m2 = t.match(/(?:已学|已看|学习|完成|进度)\D{0,6}(\d{1,3})\s*\/\s*(\d{1,3})/);
          if (m2) return Math.round(100 * parseInt(m2[1], 10) / Math.max(1, parseInt(m2[2], 10)));
          var pb = null;
          try { pb = node.querySelector('[role="progressbar"]'); } catch (e) {}
          if (pb && pb.getAttribute && pb.getAttribute('aria-valuenow')) return parseInt(pb.getAttribute('aria-valuenow'), 10);
          var bar = null;
          try { bar = node.querySelector('[class*="progress"][style*="width"], [class*="bar"][style*="width"]'); } catch (e) {}
          if (bar) {
            var mw = (bar.style && bar.style.width || '').match(/(\d{1,3})\s*%/);
            if (mw) return parseInt(mw[1], 10);
          }
          if (/已学完|已完成|已看完|全部完成|已通过|学习完成/.test(t)) return 100;
        }
      } catch (e) {}
      node = node.parentElement;
    }
    return null;
  }
  function findChapterEntries() {
    var nodes = document.querySelectorAll('a,button,li,div,span,h1,h2,h3,h4,h5,h6');
    var candidates = [];
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (!isVisible(el)) continue;
      var t = (el.textContent || '').trim();
      if (t.length > 120) continue;
      var m = t.match(/第[一二三四五六七八九十百0-9]{1,4}[章节]/);
      if (!m) continue;
      if (t.indexOf(m[0]) > 4) continue;
      candidates.push(el);
    }
    // 嵌套去重：保留可点击性更高的元素
    var kept = [];
    candidates.forEach(function (el) {
      var myScore = clickableScore(el);
      var maxIn = 0;
      for (var k = kept.length - 1; k >= 0; k--) {
        if (el.contains(kept[k].el)) maxIn = Math.max(maxIn, kept[k].score);
      }
      if (maxIn && myScore <= maxIn) return; // 外层可点击性不高于内层 → 丢弃外层
      if (maxIn) {
        for (var k2 = kept.length - 1; k2 >= 0; k2--) {
          if (el.contains(kept[k2].el)) kept.splice(k2, 1);
        }
      }
      kept.push({ el: el, score: myScore });
    });
    kept.sort(function (a, b) { return docCompare(a.el, b.el); });
    var entries = kept.map(function (item) {
      return {
        el: item.el,
        no: parseChapterNo((item.el.textContent || '').trim()),
        text: (item.el.textContent || '').trim(),
        progress: readProgress(item.el),
        active: isActiveEntry(item.el)
      };
    });
    // 同号去重（页头面包屑等可能也有“第X章”字样）：保留文档顺序靠后的
    var final = [];
    var seenNo = {};
    entries.forEach(function (e) {
      if (e.no === null) { final.push(e); return; }
      var prev = seenNo[e.no];
      if (prev !== undefined) final.splice(prev, 1);
      seenNo[e.no] = final.length;
      final.push(e);
    });
    return final;
  }
  function pickTargetChapter(entries, info) {
    var startIdx = -1;
    var no = info && info.no ? info.no : 0;
    if (no > 0) {
      for (var i = 0; i < entries.length; i++) {
        if (entries[i].no === no) { startIdx = i + 1; break; }
      }
      if (startIdx === -1) {
        for (var j = 0; j < entries.length; j++) {
          if (entries[j].no === no - 1) { startIdx = j + 1; break; }
        }
      }
    }
    if (startIdx !== -1) {
      // 从刚看完的章节之后找第一个进度未满的章节（跳过已 100% 的）
      for (var k = startIdx; k < entries.length; k++) {
        if (entries[k].progress === null || entries[k].progress < 100) return entries[k];
      }
      return null; // 后续章节全部 100% → 课程全部学完
    }
    // 没有章节编号：优先进度 < 100 的第一个章节
    for (var a = 0; a < entries.length; a++) {
      if (entries[a].progress !== null && entries[a].progress < 100) return entries[a];
    }
    // 其次：标记为当前章节的下一项
    for (var b = 0; b < entries.length; b++) {
      if (entries[b].active) return b + 1 < entries.length ? entries[b + 1] : null;
    }
    // 标题兜底
    if (info && info.title) {
      for (var c = 0; c < entries.length; c++) {
        if ((entries[c].text || '').indexOf(info.title.slice(0, 6)) !== -1) {
          return c + 1 < entries.length ? entries[c + 1] : null;
        }
      }
    }
    return null;
  }
  function findEnterButton(entryEl) {
    var scope = entryEl;
    for (var i = 0; i < 4 && scope && scope !== document.documentElement; i++) {
      var btns = scope.querySelectorAll('button, a');
      for (var j = 0; j < btns.length; j++) {
        var t = (btns[j].textContent || '').trim();
        if (isVisible(btns[j]) && /开始学习|进入学习|继续学习|去学习|开始观看|进入课程|立即学习/.test(t)) return btns[j];
      }
      scope = scope.parentElement;
    }
    return null;
  }
  function firstVideoLinkIn(entryEl) {
    var scope = entryEl.parentElement || entryEl;
    var as = scope.querySelectorAll('a');
    for (var i = 0; i < as.length; i++) {
      if (!isVisible(as[i])) continue;
      var t = (as[i].textContent || '').trim();
      if (t && !/^第[一二三四五六七八九十百0-9]{1,4}[章节]/.test(t.slice(0, 12))) return as[i];
    }
    return null;
  }
  var consumeBusy = false;
  function consumeChapterFlag() {
    if (consumeBusy) return;
    var raw;
    try { raw = sessionStorage.getItem('gxx_goto_chapter'); } catch (e) { return; }
    if (!raw) return;
    var info = null;
    try { info = JSON.parse(raw); } catch (e) { sessionStorage.removeItem('gxx_goto_chapter'); return; }
    if (!info || Date.now() - (info.t || 0) > 120000) { sessionStorage.removeItem('gxx_goto_chapter'); return; }
    if (getAllVideos().length) return; // 还在视频页（如后退到了上一视频页），不动
    consumeBusy = true;
    var done = function (okMsg) {
      sessionStorage.removeItem('gxx_goto_chapter');
      if (okMsg) log(okMsg);
      consumeBusy = false;
    };
    var entries = findChapterEntries();
    if (!entries.length) {
      var vids = catalogLinks(true);
      if (vids.length) {
        log('检测到视频列表页，进入第一个视频');
        clickEl(vids[0]);
        return done(null);
      }
      consumeBusy = false;
      return; // 页面未就绪，等待下次轮询（flag 2 分钟内有效）
    }
    var target = pickTargetChapter(entries, info);
    if (!target) {
      return done('📖 未找到需要学习的章节（全部章节进度 100%，课程已学完）');
    }
    var t = (target.el.textContent || '').trim().slice(0, 30);
    log('📖 进入下一章节：' + t + (target.progress !== null ? '（学习进度 ' + target.progress + '%）' : ''));
    clickEl(target.el);
    sleep(2500).then(function () {
      if (getAllVideos().length) return done('✅ 已进入新章节视频，开始挂机');
      var links = catalogLinks(true);
      if (links.length) { log('进入章节首个视频'); clickEl(links[0]); return done(null); }
      var l = firstVideoLinkIn(target.el);
      if (l) { log('进入章节首个视频'); clickEl(l); return done(null); }
      var eb = findEnterButton(target.el);
      if (eb) { log('点击章节的「进入学习」按钮'); clickEl(eb); return done(null); }
      var retries = (info.retries || 0) + 1;
      if (retries >= 3) return done('⚠ 多次尝试未能进入章节，请手动点击章节标题');
      info.retries = retries;
      info.t = Date.now();
      try { sessionStorage.setItem('gxx_goto_chapter', JSON.stringify(info)); } catch (e) {}
      log('未能进入章节（第' + retries + '次），稍后重试');
      consumeBusy = false;
    });
  }

  /* ---------------- 弹窗自动确认 ---------------- */
  function startDialogObserver() {
    var CONFIRM = ['继续观看', '继续学习', '继续播放', '知道了', '我知道了', '好的'];
    var WARN = ['请先', '完成上一', '未完成', '解锁', '学习进度', '观看进度'];
    new MutationObserver(function (muts) {
      if (!cfg.autoNext) return;
      for (var i = 0; i < muts.length; i++) {
        var nodes = muts[i].addedNodes;
        for (var j = 0; j < nodes.length; j++) {
          var node = nodes[j];
          if (!node || node.nodeType !== 1 || typeof node.querySelectorAll !== 'function') continue;
          var btn = node.tagName === 'BUTTON' ? node : node.querySelector('button');
          if (!btn) continue;
          var t = (btn.textContent || '').trim();
          var isConfirm = CONFIRM.some(function (x) { return t === x || t.indexOf(x) === 0; });
          if (!isConfirm) continue;
          var ctx = '';
          try { ctx = (node.textContent || '').slice(0, 300); } catch (e) {}
          if (WARN.some(function (x) { return ctx.indexOf(x) !== -1; })) {
            log('⚠ 检测到提示「' + ctx.slice(0, 60) + '」，课程可能未记录完成，请确认是否需切换挂机模式');
            continue;
          }
          setTimeout(function () { try { btn.click(); } catch (e) {} }, 600);
        }
      }
    }).observe(document.documentElement, { childList: true, subtree: true });
  }

  /* ================= 在线测试自动答题（DeepSeek） ================= */
  var quiz = { running: false, done: false, total: 0, answered: 0, page: 0, lastSig: '', sameSigCount: 0, stage: 'idle', lastUrl: '', manual: false };
  var lastShot = null;

  function updateQuizStatus(txt) {
    var el = document.getElementById('gxx-quizstatus');
    if (el) el.textContent = txt || '';
  }
  function quizResetIfNewPage() {
    if (quiz.lastUrl && quiz.lastUrl !== location.href) {
      quiz.done = false; quiz.running = false; quiz.page = 0;
      quiz.lastSig = ''; quiz.sameSigCount = 0; quiz.stage = 'idle'; quiz.total = 0; quiz.answered = 0;
    }
    quiz.lastUrl = location.href;
  }
  function isQuizUrl() {
    return new RegExp('/(test|exam|quiz|paper|kaoshi|shijuan|ceshi|answer)', 'i').test(location.pathname + location.search);
  }
  function findSubmitButton() {
    var TEXTS = ['交卷', '提交答案', '提交试卷', '确认交卷', '交卷提交', '提交', 'submit'];
    var nodes = document.querySelectorAll('button, a, div, span');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el.closest && el.closest('#gxx-panel')) continue;
      if (!isVisible(el) || isDisabled(el)) continue;
      var t = (el.textContent || '').trim();
      if (!t || t.length > 12) continue;
      var hit = false;
      for (var j = 0; j < TEXTS.length; j++) {
        if (t.indexOf(TEXTS[j]) === 0 || t.toLowerCase().indexOf(TEXTS[j]) === 0) { hit = true; break; }
      }
      if (!hit) continue;
      if (clickableScore(el) >= 1) return el;
    }
    return null;
  }
  function findNextPageBtn() {
    var TEXTS = ['下一题', '下一页', '下一部分', '下一大题', '继续答题', '下一步'];
    var nodes = document.querySelectorAll('button, a, div, span');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (!isVisible(el) || isDisabled(el)) continue;
      var t = (el.textContent || '').trim();
      if (!t || t.length > 10) continue;
      for (var j = 0; j < TEXTS.length; j++) {
        if (t.indexOf(TEXTS[j]) === 0) return el;
      }
    }
    return null;
  }
  function radioGroups() {
    var inputs = Array.prototype.slice.call(document.querySelectorAll('input[type=radio], input[type=checkbox]'));
    var byName = {};
    inputs.forEach(function (inp) {
      var n = inp.name || '';
      if (!n) n = '__noname__' + containerKey(inp);
      (byName[n] = byName[n] || []).push(inp);
    });
    var groups = [];
    Object.keys(byName).forEach(function (n) {
      var g = byName[n];
      if (!g.length) return;
      g.sort(docCompare);
      groups.push({ inputs: g, type: g[0].type === 'checkbox' ? 'multi' : 'single', name: n });
    });
    // 若几乎全部组都只有 1 个选项（比如每个选项的 name 都不同），改为按页面容器重新分组
    var singles = 0;
    for (var s = 0; s < groups.length; s++) { if (groups[s].inputs.length === 1) singles++; }
    if (groups.length > 1 && singles === groups.length) {
      var byC = {};
      inputs.forEach(function (inp) {
        var k = containerKey(inp);
        (byC[k] = byC[k] || []).push(inp);
      });
      groups = [];
      Object.keys(byC).forEach(function (k) {
        var g = byC[k];
        if (!g.length) return;
        g.sort(docCompare);
        groups.push({ inputs: g, type: g[0].type === 'checkbox' ? 'multi' : 'single', name: '' });
      });
    }
    groups.sort(function (a, b) { return docCompare(a.inputs[0], b.inputs[0]); });
    return groups;
  }
  function containerKey(inp) {
    var node = inp;
    for (var i = 0; i < 6 && node; i++) {
      node = node.parentElement;
      if (!node || node === document.documentElement) break;
      try {
        var ins = node.querySelectorAll('input[type=radio], input[type=checkbox]');
        if (ins.length >= 2 && ins.length <= 8 && (node.textContent || '').length < 1500) {
          if (!node.__gxxKey) { containerKey._id = (containerKey._id || 0) + 1; node.__gxxKey = 'c' + containerKey._id; }
          return node.__gxxKey;
        }
      } catch (e) {}
    }
    var p = inp.parentElement || inp;
    if (!p.__gxxKey) { containerKey._id = (containerKey._id || 0) + 1; p.__gxxKey = 'p' + containerKey._id; }
    return p.__gxxKey;
  }
  function getLabelText(inp) {
    try {
      if (inp.labels && inp.labels.length) return (inp.labels[0].textContent || '').trim();
      if (inp.id) {
        var sel = inp.id.replace(/["\\]/g, '\\$&');
        var l = document.querySelector('label[for="' + sel + '"]');
        if (l) return (l.textContent || '').trim();
      }
      var p = inp.closest ? (inp.closest('label') || inp.parentElement) : inp.parentElement;
      if (p && p !== document.documentElement && p.textContent && p.textContent.trim().length < 300) {
        return (p.textContent || '').trim();
      }
      return inp.value || '';
    } catch (e) { return inp.value || ''; }
  }
  function optionLetter(inp, idx) {
    var t = getLabelText(inp);
    var m = t.match(/^\s*([A-Ha-h])\s*[\.、．:：)）]/);
    if (m) return m[1].toUpperCase();
    return String.fromCharCode(65 + (idx % 26));
  }
  function uniqueKeys(opts) {
    var used = {};
    opts.forEach(function (o) {
      if (used[o.key]) {
        var i = 0, k = '';
        do { k = String.fromCharCode(65 + (i++ % 26)); } while (used[k]);
        o.key = k;
      }
      used[o.key] = true;
    });
    return opts;
  }
  function groupStem(inputs) {
    try {
      var first = inputs[0];
      var cont = first;
      var node = first;
      while (node && node !== document.documentElement) {
        var all = true;
        for (var i = 0; i < inputs.length; i++) {
          if (!node.contains(inputs[i])) { all = false; break; }
        }
        if (all) { cont = node; break; }
        node = node.parentElement;
      }
      if (!cont || !cont.textContent) return '';
      var t = (cont.textContent || '').replace(/\s+/g, ' ').trim();
      inputs.forEach(function (inp) {
        var lt = getLabelText(inp);
        if (lt) t = t.split(lt).join('');
      });
      if (t.length > 400) t = t.slice(0, 400);
      return t;
    } catch (e) { return ''; }
  }
  function normalizeInputGroups(groups) {
    return groups.map(function (g, i) {
      var opts = g.inputs.map(function (inp, idx) {
        return { key: optionLetter(inp, idx), text: getLabelText(inp).slice(0, 200), el: inp, input: true };
      });
      uniqueKeys(opts);
      return { index: i + 1, type: g.type, stem: groupStem(g.inputs) || ('第' + (i + 1) + '题'), options: opts };
    });
  }
  function ownText(el) {
    try {
      var t = '';
      for (var i = 0; i < el.childNodes.length; i++) {
        var n = el.childNodes[i];
        if (n.nodeType === 3) t += n.nodeValue;
        if (t.trim().length > 4) break;
      }
      return t.trim();
    } catch (e) { return ''; }
  }
  function isLetterOption(el) {
    if (!isVisible(el)) return false;
    var t = ownText(el);
    return /^[A-Ha-h]\s*[\.、．:：)）]\s*/.test(t) && t.length >= 3 && t.length <= 300;
  }
  function divGroups() {
    var all = document.querySelectorAll('div,li,span,p,label,td');
    var opts = [];
    for (var i = 0; i < all.length; i++) {
      if (isLetterOption(all[i])) opts.push(all[i]);
    }
    if (!opts.length) return [];
    var groups = [];
    opts.forEach(function (el) {
      var container = null;
      var node = el;
      for (var u = 0; u < 7 && node; u++) {
        node = node.parentElement;
        if (!node || node === document.documentElement) break;
        if (!node.querySelectorAll) continue;
        var cnt = 0;
        for (var k = 0; k < opts.length; k++) {
          try { if (opts[k] !== el && node.contains(opts[k])) cnt++; } catch (e) {}
        }
        try {
          if (cnt >= 1 && (node.textContent || '').length < 2000) { container = node; break; }
        } catch (e) {}
      }
      if (!container) container = el.parentElement || el;
      if (!container.__gxxDivKey) { divGroups._id = (divGroups._id || 0) + 1; container.__gxxDivKey = 'd' + divGroups._id; }
      var g = null;
      for (var gi = 0; gi < groups.length; gi++) {
        if (groups[gi].key === container.__gxxDivKey) { g = groups[gi]; break; }
      }
      if (!g) { g = { key: container.__gxxDivKey, container: container, opts: [] }; groups.push(g); }
      g.opts.push(el);
    });
    groups.forEach(function (g) { g.opts.sort(docCompare); });
    groups.sort(function (a, b) { return docCompare(a.container, b.container); });
    return groups;
  }
  function normalizeDivGroups(gs) {
    return gs.map(function (g, i) {
      var opts = g.opts.map(function (el, idx) {
        var t = ownText(el) || '';
        if (t.length < 3) t = (el.textContent || '').trim();
        var m = t.match(/^([A-Ha-h])\s*[\.、．:：)）]\s*/);
        var key = m ? m[1].toUpperCase() : String.fromCharCode(65 + (idx % 26));
        return { key: key, text: t.slice(0, 200), el: el };
      });
      uniqueKeys(opts);
      var stem = '';
      try { stem = (g.container.textContent || '').replace(/\s+/g, ' ').trim(); } catch (e) {}
      opts.forEach(function (o) {
        var piece = o.text.slice(0, 20);
        if (piece) stem = stem.split(piece).join('');
      });
      if (stem.length > 400) stem = stem.slice(0, 400);
      return { index: i + 1, type: 'unknown', stem: stem || ('第' + (i + 1) + '题'), options: opts };
    });
  }
  function collectAllQuestions() {
    var ig = radioGroups();
    if (ig.length) return normalizeInputGroups(ig);
    return normalizeDivGroups(divGroups());
  }
  function detectQuiz() {
    if (getAllVideos().length) return null;
    var groups = radioGroups();
    var submit = findSubmitButton();
    var urlQuiz = isQuizUrl();
    if (groups.length >= 1) return { kind: 'input' };
    if (urlQuiz && submit) return { kind: 'div' };
    return null;
  }
  function selectOption(el) {
    try { el.scrollIntoView({ block: 'center' }); } catch (e) {}
    try {
      if (el.tagName === 'INPUT') {
        var was = el.checked;
        el.checked = true;
        if (!was) el.click();
        try { el.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) {}
        try { el.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) {}
        return true;
      }
      el.click();
      return true;
    } catch (e) {
      try { el.click(); return true; } catch (e2) { return false; }
    }
  }
  function lettersOf(a) {
    var ls = [];
    if (Array.isArray(a.answer)) {
      ls = a.answer.map(function (x) { return typeof x === 'number' ? String.fromCharCode(64 + x) : x; });
    }
    else if (typeof a.answer === 'string') {
      var m = a.answer.match(/[A-Ha-h]/g);
      if (m) ls = m;
    } else if (typeof a.answer === 'number') ls = [String.fromCharCode(64 + a.answer)];
    return ls.map(function (x) { return String(x).trim().toUpperCase().charAt(0); })
      .filter(function (x) { return x >= 'A' && x <= 'H'; });
  }
  function applyAnswers(groups, answers) {
    var byIdx = {};
    answers.forEach(function (a) { if (a && a.index) byIdx[a.index] = a; });
    var done = 0;
    groups.forEach(function (g) {
      var a = byIdx[g.index];
      if (!a) return;
      var letters = lettersOf(a);
      if (!letters.length) return;
      if (g.type === 'single') letters = letters.slice(0, 1);
      var applied = 0;
      g.options.forEach(function (o) {
        if (letters.indexOf(o.key) !== -1 && selectOption(o.el)) applied++;
      });
      if (applied > 0) done++;
    });
    return done;
  }
  function callDeepSeek(system, user) {
    var base = (cfg.apiBase || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
    var body = {
      model: cfg.apiModel || 'deepseek-chat',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ],
      temperature: 0.1,
      stream: false
    };
    if (/deepseek/i.test(base)) body.response_format = { type: 'json_object' };
    var headers = {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + cfg.apiKey
    };
    var transport;
    if (typeof GM_xmlhttpRequest === 'function') {
      transport = new Promise(function (resolve, reject) {
        try {
          GM_xmlhttpRequest({
            method: 'POST',
            url: base + '/chat/completions',
            headers: headers,
            data: JSON.stringify(body),
            timeout: 180000,
            onload: function (res) {
              try {
                if (res.status >= 200 && res.status < 300) resolve(JSON.parse(res.responseText));
                else reject(new Error('HTTP ' + res.status + ' ' + String(res.responseText || '').slice(0, 200)));
              } catch (e) { reject(e); }
            },
            onerror: function () { reject(new Error('GM_xmlhttpRequest 网络错误')); },
            ontimeout: function () { reject(new Error('请求超时')); }
          });
        } catch (e) { reject(e); }
      });
    } else {
      transport = fetch(base + '/chat/completions', {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(body)
      }).then(function (r) {
        if (!r.ok) {
          return r.text().then(function (t) { throw new Error('HTTP ' + r.status + ' ' + String(t).slice(0, 200)); });
        }
        return r.json();
      }).catch(function (e) {
        if (e && /Failed to fetch|NetworkError|fetch failed|CORS|TypeError/i.test(String(e.message || e))) {
          throw new Error('网络请求被拦截(CORS/CSP)：' + String(e.message || e) + '。可尝试按脚本头部注释切换为 GM_xmlhttpRequest 方式');
        }
        throw e;
      });
    }
    return transport.then(function (j) {
      var msg = j && j.choices && j.choices[0] && j.choices[0].message;
      if (!msg || !msg.content) {
        var err = j && j.error && j.error.message ? j.error.message : '响应格式异常';
        throw new Error('API 返回异常：' + String(err).slice(0, 120));
      }
      return msg.content;
    });
  }
  function parseAnswers(text) {
    var arr = null;
    try {
      var obj = JSON.parse(text);
      if (obj) {
        if (Array.isArray(obj.answers)) arr = obj.answers;
        else if (!obj.answers) {
          var alt = [];
          Object.keys(obj).forEach(function (k) {
            if (/^\d+$/.test(k)) {
              var v = obj[k];
              var ls = Array.isArray(v) ? v : (typeof v === 'string' ? v.split('') : [v]);
              alt.push({ index: parseInt(k, 10), answer: ls });
            }
          });
          if (alt.length) arr = alt;
        }
      }
    } catch (e) {}
    if (!arr) {
      var m = String(text || '').match(/\{[\s\S]*\}/);
      if (m) {
        try {
          var o2 = JSON.parse(m[0]);
          if (o2 && Array.isArray(o2.answers)) arr = o2.answers;
        } catch (e2) {}
      }
    }
    if (!arr) throw new Error('模型输出无法解析为JSON');
    return arr.filter(function (a) { return a && a.index && a.answer; });
  }
  function askModel(groups) {
    var payload = groups.map(function (g) {
      return {
        index: g.index,
        type: g.type,
        stem: g.stem,
        options: g.options.map(function (o) { return { key: o.key, text: o.text }; })
      };
    });
    var sys = '你是一名专业的考试答题助手。用户会给你一份JSON格式的题目列表，请认真分析每道题并选出正确答案。要求：\n' +
      '1. 必须输出一个JSON对象，格式：{"answers":[{"index":1,"answer":["B"]},{"index":2,"answer":["A","C"]}]}\n' +
      '2. 单选题 answer 数组只含一个字母；多选题可含多个字母\n' +
      '3. 每题都要给出答案，不要遗漏；不确定的题也选择最可能的答案\n' +
      '4. 除JSON外不要输出任何其他内容';
    var usr = '题目列表：\n' + JSON.stringify(payload);
    return callDeepSeek(sys, usr).then(parseAnswers);
  }
  function inDialog(el) {
    var n = el;
    for (var i = 0; i < 6 && n && n !== document.documentElement; i++) {
      try {
        var cls = typeof n.className === 'string' ? n.className : '';
        if (/dialog|modal|popup|confirm|alert|mask|layer|message/i.test(cls)) return true;
      } catch (e) {}
      n = n.parentElement;
    }
    return false;
  }
  function watchQuizConfirm(submitBtn) {
    var obs = new MutationObserver(function () {
      if (quiz.stage !== 'submitting') { try { obs.disconnect(); } catch (e) {} return; }
      var nodes = document.querySelectorAll('button, a');
      for (var i = 0; i < nodes.length; i++) {
        var b = nodes[i];
        if (b === submitBtn || !isVisible(b)) continue;
        var t = (b.textContent || '').trim();
        if (t === '确定' || t === '确认' || t === '确认交卷' || t === '确认提交' || t === '交卷') {
          if (t === '交卷' && !inDialog(b)) continue;
          log('确认交卷弹窗 → 点击「' + t + '」');
          clickEl(b);
          quiz.stage = 'done';
          quiz.done = true;
          updateQuizStatus('交卷完成');
          try { obs.disconnect(); } catch (e) {}
          return;
        }
      }
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(function () {
      if (quiz.stage === 'submitting') {
        quiz.stage = 'done';
        quiz.done = true;
        updateQuizStatus('已交卷');
        try { obs.disconnect(); } catch (e) {}
      }
    }, 8000);
  }
  function submitQuiz() {
    var btn = findSubmitButton();
    if (!btn) { log('⚠ 未找到交卷按钮，请手动交卷'); return; }
    quiz.stage = 'submitting';
    log('📋 所有题目作答完成，自动交卷');
    clickEl(btn);
    watchQuizConfirm(btn);
  }
  function runQuiz() {
    if (quiz.running) return;
    if (!cfg.apiKey) {
      log('⚠ 未填写 DeepSeek API Key：点面板「⚙ 答题设置」填写后保存');
      return;
    }
    if (getAllVideos().length) { log('当前页面有视频，非答题页'); return; }
    var det = detectQuiz();
    if (!det) {
      if (isQuizUrl()) log('检测到测试页面但未发现题目元素（可能在跨域 iframe 中或尚未加载），稍后自动重试');
      return;
    }
    quiz.running = true;
    quiz.stage = 'answering';
    var groups = collectAllQuestions();
    if (!groups.length) {
      log('⚠ 未识别到题目结构，请手动作答并反馈页面 HTML 结构');
      quiz.running = false;
      return;
    }
    var sig = groups.map(function (g) { return g.stem.slice(0, 40); }).join('|') + '#' + groups.length;
    if (sig === quiz.lastSig) {
      quiz.sameSigCount++;
      if (quiz.sameSigCount >= 3) {
        log('⚠ 页面内容未变化，停止自动答题，请手动检查');
        quiz.done = true;
        quiz.running = false;
        return;
      }
    } else {
      quiz.sameSigCount = 0;
      quiz.lastSig = sig;
    }
    quiz.total += groups.length;
    quiz.page++;
    log('🤖 第 ' + quiz.page + ' 页：识别到 ' + groups.length + ' 道题（直接读取页面文字），正在调用 DeepSeek 作答...');
    updateQuizStatus('答题中：已识别 ' + quiz.total + ' 题');
    captureQuizShot();
    askModel(groups).then(function (answers) {
      var doneCount = applyAnswers(groups, answers);
      quiz.answered += doneCount;
      log('✅ 本页已作答 ' + doneCount + ' / ' + groups.length);
      updateQuizStatus('已作答 ' + quiz.answered + ' 题');
      var missing = groups.filter(function (g) {
        var a = null;
        for (var ai = 0; ai < answers.length; ai++) {
          if (answers[ai] && answers[ai].index === g.index) { a = answers[ai]; break; }
        }
        if (!a) return true;
        var ls = lettersOf(a);
        if (!ls.length) return true;
        var hit = false;
        for (var oi = 0; oi < g.options.length; oi++) {
          if (ls.indexOf(g.options[oi].key) !== -1) { hit = true; break; }
        }
        return !hit;
      });
      var proceed = function () {
        if (!findSubmitButton()) {
          var nx = findNextPageBtn();
          if (nx && (cfg.autoQuiz || quiz.manual)) {
            log('本页无交卷按钮，点击「下一题/下一页」继续作答');
            clickEl(nx);
            sleep(2200).then(function () { quiz.running = false; runQuiz(); });
            return;
          }
        }
        finish();
      };
      var finish = function () {
        quiz.running = false;
        quiz.stage = 'idle';
        quiz.manual = false;
        if (cfg.autoSubmit) {
          quiz.done = true;
          submitQuiz();
        } else {
          quiz.done = true;
          log('已全部作答（自动交卷已关闭，可点面板「📋 交卷」手动交卷）');
          updateQuizStatus('作答完成，待交卷');
        }
      };
      if (!missing.length) { proceed(); return; }
      log('有 ' + missing.length + ' 题未作答，重试一次...');
      askModel(missing).then(function (ans2) {
        applyAnswers(missing, ans2);
        proceed();
      }).catch(function (e) {
        log('重试失败：' + (e && e.message ? e.message : e));
        proceed();
      });
    }).catch(function (e) {
      log('⚠ 答题出错：' + (e && e.message ? e.message : e));
      quiz.running = false;
      quiz.stage = 'idle';
      quiz.manual = false;
      updateQuizStatus('答题出错，可点「▶ 手动答题」重试');
    });
  }
  function maybeAutoQuiz() {
    quizResetIfNewPage();
    if (!cfg.autoQuiz || !cfg.apiKey || quiz.done || quiz.running) return;
    if (getAllVideos().length) return;
    if (detectQuiz()) runQuiz();
  }

  /* ---------------- 可选：试卷截屏记录（不影响答题） ---------------- */
  var h2cLoading = null;
  function ensureHtml2canvas() {
    if (window.html2canvas) return Promise.resolve(window.html2canvas);
    if (h2cLoading) return h2cLoading;
    var cdns = [
      'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js',
      'https://unpkg.com/html2canvas@1.4.1/dist/html2canvas.min.js',
      'https://registry.npmmirror.com/html2canvas/1.4.1/files/dist/html2canvas.min.js'
    ];
    h2cLoading = new Promise(function (resolve, reject) {
      var i = 0;
      function tryNext() {
        if (i >= cdns.length) { reject(new Error('CDN加载失败(可能被CSP拦截)')); return; }
        var s = document.createElement('script');
        s.src = cdns[i++];
        s.onload = function () { resolve(window.html2canvas); };
        s.onerror = function () { tryNext(); };
        document.head.appendChild(s);
        setTimeout(function () {
          if (!window.html2canvas && s.parentNode) {
            try { s.parentNode.removeChild(s); } catch (e) {}
            tryNext();
          }
        }, 15000);
      }
      tryNext();
    });
    return h2cLoading;
  }
  function captureQuizShot() {
    ensureHtml2canvas().then(function (h2c) {
      var area = document.querySelector('[class*="paper"],[class*="exam"],[class*="test"],[class*="question"],[class*="subject"]') || document.body;
      try {
        h2c(area, { scale: 1, useCORS: true, logging: false, backgroundColor: '#ffffff' }).then(function (canvas) {
          lastShot = canvas.toDataURL('image/png');
          log('📸 试卷画面已截屏（点面板「📸 截图」可下载查看）');
        }).catch(function (e) { log('截屏失败（不影响答题）：' + (e && e.message ? e.message : e)); });
      } catch (e) { log('截屏失败（不影响答题）：' + (e && e.message ? e.message : e)); }
    }).catch(function (e) { log('截图组件加载失败（不影响答题）：' + (e && e.message ? e.message : e)); });
  }
  function saveShot() {
    if (!lastShot) { log('暂无截图，正在截屏...'); captureQuizShot(); return; }
    try {
      var a = document.createElement('a');
      a.href = lastShot;
      a.download = 'quiz_' + new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-') + '.png';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { try { a.remove(); } catch (e) {} }, 100);
    } catch (e) { log('保存截图失败：' + (e && e.message ? e.message : e)); }
  }

  /* ---------------- 悬浮面板 ---------------- */
  var panel = null;
  function buildPanel() {
    if (document.getElementById('gxx-panel')) return;
    var style = document.createElement('style');
    style.textContent = [
      '#gxx-panel{position:fixed;top:90px;right:16px;z-index:2147483000;width:300px;background:rgba(18,22,30,.96);color:#e8e8e8;border-radius:10px;font:12px/1.6 "Microsoft YaHei",sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.55);}',
      '#gxx-panel .gxx-head{padding:8px 10px;cursor:move;font-weight:bold;background:linear-gradient(90deg,#0a9,#087);border-radius:10px 10px 0 0;color:#fff;display:flex;justify-content:space-between;align-items:center;}',
      '#gxx-panel .gxx-body{padding:8px 10px;display:block;}',
      '#gxx-panel.gxx-min .gxx-body{display:none;}',
      '#gxx-panel .gxx-status{color:#9fd;margin-bottom:6px;min-height:16px;word-break:break-all;}',
      '#gxx-panel .gxx-row{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:6px;}',
      '#gxx-panel button{background:#2a3040;color:#eee;border:1px solid #3a4a5a;border-radius:5px;padding:4px 8px;cursor:pointer;font-size:12px;}',
      '#gxx-panel button:hover{background:#3a4558;}',
      '#gxx-panel button.gxx-on{background:#0a9;border-color:#0cb;color:#fff;}',
      '#gxx-panel .gxx-log{max-height:110px;overflow-y:auto;background:rgba(0,0,0,.35);border-radius:6px;padding:6px 8px;color:#bbb;white-space:pre-wrap;word-break:break-all;}',
      '#gxx-panel .gxx-close,#gxx-panel .gxx-minbtn{cursor:pointer;padding:0 6px;font-size:14px;}',
      '#gxx-panel input{width:100%;box-sizing:border-box;background:#151a24;color:#eee;border:1px solid #3a4a5a;border-radius:5px;padding:4px 6px;font-size:12px;margin-bottom:4px;}',
      '#gxx-panel .gxx-hint{color:#8a93a3;font-size:11px;line-height:1.5;margin-bottom:4px;}',
      '#gxx-panel .gxx-quizstatus{color:#ffd76a;min-height:16px;margin-bottom:4px;word-break:break-all;}',
      '#gxx-panel .gxx-sep{border-top:1px dashed #3a4a5a;margin:6px 0;}'
    ].join('');
    document.head.appendChild(style);

    panel = document.createElement('div');
    panel.id = 'gxx-panel';
    panel.innerHTML =
      '<div class="gxx-head"><span>🎓 贵小溪刷课助手</span><span><span class="gxx-minbtn" title="最小化">—</span> <span class="gxx-close" title="关闭面板(刷新恢复)">×</span></span></div>' +
      '<div class="gxx-body">' +
      '<div class="gxx-status" id="gxx-status">初始化中...</div>' +
      '<div class="gxx-row">' +
      '<button data-mode="turbo">⚡ 加速</button>' +
      '<button data-mode="seek">⏭ 跳结尾</button>' +
      '<button data-mode="idle">🐢 挂机1x</button>' +
      '</div>' +
      '<div class="gxx-row">' +
      '<button data-spd="1">1x</button><button data-spd="2">2x</button><button data-spd="4">4x</button>' +
      '<button data-spd="8">8x</button><button data-spd="16">16x</button>' +
      '</div>' +
      '<div class="gxx-row">' +
      '<button id="gxx-mute">🔇 静音:开</button>' +
      '<button id="gxx-autonext">🔁 自动下一课:开</button>' +
      '</div>' +
      '<div class="gxx-row">' +
      '<button id="gxx-nextnow">⏩ 立即下一课</button>' +
      '<button id="gxx-seekend">⏭ 跳到结尾</button>' +
      '</div>' +
      '<div class="gxx-sep"></div>' +
      '<div class="gxx-row">' +
      '<button id="gxx-chapnav">📑 章节切换:开</button>' +
      '<button id="gxx-chapback">⬅ 回列表换章</button>' +
      '</div>' +
      '<div class="gxx-sep"></div>' +
      '<div class="gxx-row">' +
      '<button id="gxx-autotest">🤖 自动答题:关</button>' +
      '<button id="gxx-quiznow">▶ 手动答题</button>' +
      '<button id="gxx-quizsubmit">📋 交卷</button>' +
      '</div>' +
      '<div class="gxx-row">' +
      '<button id="gxx-autosubmit">✅ 自动交卷:开</button>' +
      '<button id="gxx-quizshot">📸 截图</button>' +
      '<button id="gxx-settoggle">⚙ 答题设置</button>' +
      '</div>' +
      '<div class="gxx-setbody" id="gxx-setbody" style="display:none">' +
      '<input id="gxx-apikey" type="password" placeholder="DeepSeek API Key (sk-...)" spellcheck="false">' +
      '<input id="gxx-apibase" placeholder="API地址(默认 https://api.deepseek.com/v1)" spellcheck="false">' +
      '<input id="gxx-apimodel" placeholder="模型(默认 deepseek-chat)" spellcheck="false">' +
      '<div class="gxx-row">' +
      '<button id="gxx-savekey">💾 保存</button>' +
      '<button id="gxx-showkey">👁 显示Key</button>' +
      '</div>' +
      '<div class="gxx-hint">Key 仅保存在本机浏览器 localStorage。答题时直接读取页面题目文字（无需截图），调 DeepSeek 选择答案，答完自动交卷。</div>' +
      '</div>' +
      '<div class="gxx-quizstatus" id="gxx-quizstatus"></div>' +
      '<div class="gxx-log" id="gxx-log"></div>' +
      '</div>';
    document.body.appendChild(panel);

    var head = panel.querySelector('.gxx-head');
    head.addEventListener('mousedown', function (e) {
      if (e.target.classList.contains('gxx-close') || e.target.classList.contains('gxx-minbtn')) return;
      var ox = e.clientX - panel.offsetLeft, oy = e.clientY - panel.offsetTop;
      function mv(ev) { panel.style.left = (ev.clientX - ox) + 'px'; panel.style.top = (ev.clientY - oy) + 'px'; panel.style.right = 'auto'; }
      function up() { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); }
      document.addEventListener('mousemove', mv);
      document.addEventListener('mouseup', up);
      e.preventDefault();
    });
    panel.querySelector('.gxx-close').addEventListener('click', function () { panel.style.display = 'none'; });
    panel.querySelector('.gxx-minbtn').addEventListener('click', function () { panel.classList.toggle('gxx-min'); });

    panel.querySelectorAll('[data-mode]').forEach(function (b) {
      b.addEventListener('click', function () {
        cfg.mode = b.getAttribute('data-mode');
        if (cfg.mode === 'idle') cfg.speed = 1;
        save(); updatePanel(); applyAll();
        log('切换模式：' + MODE_LABEL[cfg.mode]);
        if (cfg.mode !== 'idle') log('⚠ 本平台有服务端校验，加速/跳结尾可能不记录学习进度');
      });
    });
    panel.querySelectorAll('[data-spd]').forEach(function (b) {
      b.addEventListener('click', function () {
        cfg.speed = parseInt(b.getAttribute('data-spd'), 10);
        cfg.mode = 'turbo';
        save(); updatePanel(); applyAll();
        log('倍速设为 ' + cfg.speed + 'x');
      });
    });
    document.getElementById('gxx-mute').addEventListener('click', function () {
      cfg.mute = !cfg.mute; save(); updatePanel();
      if (!cfg.mute) getAllVideos().forEach(function (v) { try { v.muted = false; } catch (e) {} });
      log(cfg.mute ? '已静音' : '已取消静音');
    });
    document.getElementById('gxx-autonext').addEventListener('click', function () {
      cfg.autoNext = !cfg.autoNext; save(); updatePanel();
      log(cfg.autoNext ? '自动下一课：开' : '自动下一课：关');
    });
    document.getElementById('gxx-nextnow').addEventListener('click', function () {
      busy = false;
      goNext('手动点击');
    });
    document.getElementById('gxx-seekend').addEventListener('click', function () {
      var v = currentVideo();
      if (v && v.duration) { try { v.currentTime = v.duration - 1.5; v.play(); } catch (e) {} }
      else log('未找到视频');
    });
    document.getElementById('gxx-chapnav').addEventListener('click', function () {
      cfg.chapterNav = !cfg.chapterNav; save(); updatePanel();
      log(cfg.chapterNav ? '章节切换：开（看完一章自动回课程列表按进度进下一章）' : '章节切换：关');
    });
    document.getElementById('gxx-chapback').addEventListener('click', function () {
      if (busy) { log('正在跳转中，请稍候'); return; }
      var chs = chapterState();
      var curB = chs && chs.curIdx !== -1 ? chs.blocks[chs.curIdx] : null;
      scheduleChapterSwitch(curB);
    });
    document.getElementById('gxx-autotest').addEventListener('click', function () {
      cfg.autoQuiz = !cfg.autoQuiz; save(); updatePanel();
      log(cfg.autoQuiz ? '自动答题：开（进入在线测试将自动作答并交卷）' : '自动答题：关');
    });
    document.getElementById('gxx-autosubmit').addEventListener('click', function () {
      cfg.autoSubmit = !cfg.autoSubmit; save(); updatePanel();
      log(cfg.autoSubmit ? '自动交卷：开' : '自动交卷：关（答完不交卷，可手动点「📋 交卷」）');
    });
    document.getElementById('gxx-quiznow').addEventListener('click', function () {
      quiz.done = false;
      quiz.manual = true;
      runQuiz();
    });
    document.getElementById('gxx-quizsubmit').addEventListener('click', function () { submitQuiz(); });
    document.getElementById('gxx-quizshot').addEventListener('click', function () { saveShot(); });
    document.getElementById('gxx-settoggle').addEventListener('click', function () {
      var b = document.getElementById('gxx-setbody');
      if (b) b.style.display = b.style.display === 'none' ? 'block' : 'none';
    });
    document.getElementById('gxx-savekey').addEventListener('click', function () {
      cfg.apiKey = (document.getElementById('gxx-apikey').value || '').trim();
      cfg.apiBase = (document.getElementById('gxx-apibase').value || '').trim() || 'https://api.deepseek.com/v1';
      cfg.apiModel = (document.getElementById('gxx-apimodel').value || '').trim() || 'deepseek-chat';
      save(); updatePanel();
      if (cfg.apiKey) {
        cfg.autoQuiz = true;
        save(); updatePanel();
        log('✅ DeepSeek Key 已保存（仅存本机浏览器），自动答题已开启');
      } else {
        log('已清空 API Key');
      }
    });
    document.getElementById('gxx-showkey').addEventListener('click', function () {
      var k = document.getElementById('gxx-apikey');
      if (k) k.type = k.type === 'password' ? 'text' : 'password';
    });
  }
  function setInputVal(id, v) {
    var el = document.getElementById(id);
    if (!el) return;
    if (document.activeElement === el) return;
    el.value = v || '';
  }
  function updatePanel() {
    if (!panel) return;
    panel.querySelectorAll('[data-mode]').forEach(function (b) {
      b.classList.toggle('gxx-on', b.getAttribute('data-mode') === cfg.mode);
    });
    panel.querySelectorAll('[data-spd]').forEach(function (b) {
      b.classList.toggle('gxx-on', cfg.mode === 'turbo' && parseInt(b.getAttribute('data-spd'), 10) === cfg.speed);
    });
    var mb = document.getElementById('gxx-mute');
    if (mb) mb.textContent = cfg.mute ? '🔇 静音:开' : '🔊 静音:关';
    var ab = document.getElementById('gxx-autonext');
    if (ab) ab.textContent = '🔁 自动下一课:' + (cfg.autoNext ? '开' : '关');
    var cn = document.getElementById('gxx-chapnav');
    if (cn) cn.textContent = '📑 章节切换:' + (cfg.chapterNav ? '开' : '关');
    var at = document.getElementById('gxx-autotest');
    if (at) at.textContent = '🤖 自动答题:' + (cfg.autoQuiz ? '开' : '关');
    var as = document.getElementById('gxx-autosubmit');
    if (as) as.textContent = '✅ 自动交卷:' + (cfg.autoSubmit ? '开' : '关');
    setInputVal('gxx-apikey', cfg.apiKey);
    setInputVal('gxx-apibase', cfg.apiBase);
    setInputVal('gxx-apimodel', cfg.apiModel);
  }
  function updateStatus() {
    var el = document.getElementById('gxx-status');
    if (!el) return;
    var v = currentVideo();
    if (!v) {
      try {
        if (sessionStorage.getItem('gxx_goto_chapter')) {
          el.textContent = '已返回课程列表，正在按学习进度选择下一章节...';
          return;
        }
      } catch (e) {}
      el.textContent = '未发现视频元素，请打开课程视频页面';
      return;
    }
    var rate = v.playbackRate || 0;
    el.textContent = '视频 ' + fmt(v.currentTime) + ' / ' + fmt(v.duration) + ' · ' + rate.toFixed(1) + 'x · ' + MODE_LABEL[cfg.mode];
  }

  /* ---------------- 主循环 ---------------- */
  var quizTick = 0;
  function mainLoop() {
    var vs = getAllVideos();
    for (var i = 0; i < vs.length; i++) {
      var v = vs[i];
      applyToVideo(v);
      if (v.paused && !v.ended) {
        var p = v.play();
        if (p && p.catch) p.catch(function () {});
      }
    }
    var cur = currentVideo();
    if (cur && cur.duration && isFinite(cur.duration) && cur.duration > 0 && (cur.duration - cur.currentTime) < 0.6 && !cur.ended) {
      goNext('接近结尾');
    }
    updateStatus();
    quizTick++;
    if (quizTick % 4 === 0) maybeAutoQuiz();
  }

  /* ---------------- 刷新后自动下一课 / 返回课程列表 ---------------- */
  function oldNextFlow(replayKey, prevHref) {
    log('刷新完成，尝试进入下一课...');
    var clicked = tryClickNextButton();
    var p = clicked ? sleep(3500) : sleep(0);
    return p.then(function () {
      if (clicked && location.href !== prevHref) {
        log('✅ 已通过「下一讲」按钮进入下一课');
        sessionStorage.removeItem(replayKey);
        return;
      }
      if (clicked) log('按钮未切换页面，改从课程目录点击');
      var ok = clickNextInCatalog();
      if (ok) {
        return sleep(4000).then(function () {
          if (location.href !== prevHref) {
            log('✅ 已进入下一课');
            sessionStorage.removeItem(replayKey);
          } else {
            markReplay(replayKey);
          }
        });
      }
      markReplay(replayKey);
    });
  }
  function onLoadAutoNext() {
    var prevHref = sessionStorage.getItem('gxx_next_after_load');
    if (!prevHref) return;
    sessionStorage.removeItem('gxx_next_after_load');
    var chapRaw = sessionStorage.getItem('gxx_goto_chapter');
    var id = currentVideoId();
    var replayKey = 'gxx_replay_' + (id || 'none');
    setTimeout(function () {
      sleep(2500).then(function () {
        if (location.href !== prevHref) {
          log('✅ 页面已自动进入下一课');
          sessionStorage.removeItem(replayKey);
          return;
        }
        if (chapRaw) {
          return goBackToCourseList().then(function (ok) {
            if (ok) {
              log('✅ 已返回课程列表，正在按学习进度选择下一章节...');
              sessionStorage.removeItem(replayKey);
              return;
            }
            log('⚠ 未能返回课程列表，改用课程目录进入下一课');
            sessionStorage.removeItem('gxx_goto_chapter');
            return oldNextFlow(replayKey, prevHref);
          });
        }
        return oldNextFlow(replayKey, prevHref);
      });
    }, 300);
  }
  function markReplay(replayKey) {
    var n = parseInt(sessionStorage.getItem(replayKey) || '0', 10) + 1;
    sessionStorage.setItem(replayKey, String(n));
    if (n >= 3) {
      var v = currentVideo();
      if (v) { try { v.currentTime = 0; } catch (e) {} }
      log('⚠ 连续 ' + n + ' 次未能进入下一课，已从头重播本课（挂机继续）');
    } else {
      log('⚠ 未能进入下一课（第' + n + '次），本课将重播后自动重试');
    }
  }

  /* ---------------- 启动 ---------------- */
  function init() {
    buildPanel();
    updatePanel();
    applyAll();
    startDialogObserver();
    onLoadAutoNext();
    setInterval(mainLoop, 500);
    setTimeout(function () { consumeChapterFlag(); }, 800);
    setTimeout(function () { maybeAutoQuiz(); }, 1500);
    setInterval(function () {
      if (!getAllVideos().length) consumeChapterFlag();
    }, 4000);
    window.addEventListener('pageshow', function () {
      setTimeout(function () { consumeChapterFlag(); }, 600);
      setTimeout(function () { maybeAutoQuiz(); }, 1200);
    });
    log('脚本已启动。当前模式：' + MODE_LABEL[cfg.mode] + (cfg.mode === 'turbo' ? ' ' + cfg.speed + 'x' : ''));
    log('本平台有服务端时长校验：默认「🐢挂机1x」最稳；加速/跳结尾仅供试验，进度可能不记录');
    log('看完一章后会自动返回课程列表，按各章学习进度进入下一章；在线测试可接入 DeepSeek 自动答题');
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
