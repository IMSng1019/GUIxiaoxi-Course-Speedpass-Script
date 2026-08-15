// ==UserScript==
// @name         贵小溪学习平台 自动刷课助手
// @namespace    gxx-autowatch
// @version      1.2.0
// @description  自动挂机刷完课程视频(默认1x)，看完自动刷新页面并从课程目录进入下一课
// @author       autogen
// @match        https://gxx-edu.digitlanguage.com/*
// @match        http://gxx-edu.digitlanguage.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';
  if (window.__gxxAutoWatchLoaded) return;
  window.__gxxAutoWatchLoaded = true;

  var LS_KEY = 'gxx_autowatch_v1';
  var DEFAULTS = { mode: 'idle', speed: 1, mute: true, autoNext: true };
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

  /* ---------------- 下一课 ---------------- */
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
  function catalogLinks() {
    var nodes = document.querySelectorAll('a[href*="videoId"], [data-videoid], [data-video-id]');
    return Array.prototype.slice.call(nodes).filter(isVisible);
  }
  function isLastInCatalog() {
    var id = currentVideoId();
    var links = catalogLinks();
    if (links.length && id) {
      var last = links[links.length - 1];
      try {
        var href = last.href || last.getAttribute('data-videoid') || last.getAttribute('data-video-id') || '';
        return href.indexOf(id) !== -1;
      } catch (e) { return false; }
    }
    return false;
  }
  function clickNextInCatalog() {
    var prevHref = location.href;
    var id = currentVideoId();
    var title = currentTitle();
    var links = catalogLinks();
    var idx = -1;
    if (links.length) {
      if (id) {
        for (var i = 0; i < links.length; i++) {
          try {
            var href = links[i].href || links[i].getAttribute('data-videoid') || links[i].getAttribute('data-video-id') || '';
            if (href.indexOf(id) !== -1) { idx = i; break; }
          } catch (e) {}
        }
      }
      if (idx === -1 && title) {
        for (var j = 0; j < links.length; j++) {
          if ((links[j].textContent || '').indexOf(title.slice(0, 6)) !== -1) { idx = j; break; }
        }
      }
      if (idx !== -1 && idx + 1 < links.length) {
        log('从课程目录点击下一课：' + (links[idx + 1].textContent || '').trim().slice(0, 30));
        clickEl(links[idx + 1]);
        sleep(4000).then(function () {
          if (location.href === prevHref) log('⚠ 目录点击后页面未切换');
          else log('✅ 已进入下一课');
        });
        return true;
      }
    }
    if (title && clickNextByTitle()) return true;
    log('⚠ 未能从目录定位下一课');
    return false;
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
  var busy = false;
  function goNext(reason) {
    if (busy) return;
    if (!cfg.autoNext) { log('自动下一课已关闭，跳过：' + reason); return; }
    if (isLastInCatalog()) {
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

  /* ---------------- 悬浮面板 ---------------- */
  var panel = null;
  function buildPanel() {
    if (document.getElementById('gxx-panel')) return;
    var style = document.createElement('style');
    style.textContent = [
      '#gxx-panel{position:fixed;top:90px;right:16px;z-index:2147483000;width:252px;background:rgba(18,22,30,.96);color:#e8e8e8;border-radius:10px;font:12px/1.6 "Microsoft YaHei",sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.55);}',
      '#gxx-panel .gxx-head{padding:8px 10px;cursor:move;font-weight:bold;background:linear-gradient(90deg,#0a9,#087);border-radius:10px 10px 0 0;color:#fff;display:flex;justify-content:space-between;align-items:center;}',
      '#gxx-panel .gxx-body{padding:8px 10px;display:block;}',
      '#gxx-panel.gxx-min .gxx-body{display:none;}',
      '#gxx-panel .gxx-status{color:#9fd;margin-bottom:6px;min-height:16px;word-break:break-all;}',
      '#gxx-panel .gxx-row{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:6px;}',
      '#gxx-panel button{background:#2a3040;color:#eee;border:1px solid #3a4a5a;border-radius:5px;padding:4px 8px;cursor:pointer;font-size:12px;}',
      '#gxx-panel button:hover{background:#3a4558;}',
      '#gxx-panel button.gxx-on{background:#0a9;border-color:#0cb;color:#fff;}',
      '#gxx-panel .gxx-log{max-height:110px;overflow-y:auto;background:rgba(0,0,0,.35);border-radius:6px;padding:6px 8px;color:#bbb;white-space:pre-wrap;word-break:break-all;}',
      '#gxx-panel .gxx-close,#gxx-panel .gxx-minbtn{cursor:pointer;padding:0 6px;font-size:14px;}'
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
  }
  function updateStatus() {
    var el = document.getElementById('gxx-status');
    if (!el) return;
    var v = currentVideo();
    if (!v) { el.textContent = '未发现视频元素，请打开课程视频页面'; return; }
    var rate = v.playbackRate || 0;
    el.textContent = '视频 ' + fmt(v.currentTime) + ' / ' + fmt(v.duration) + ' · ' + rate.toFixed(1) + 'x · ' + MODE_LABEL[cfg.mode];
  }

  /* ---------------- 主循环 ---------------- */
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
  }

  /* ---------------- 刷新后自动点下一课 ---------------- */
  function onLoadAutoNext() {
    var prevHref = sessionStorage.getItem('gxx_next_after_load');
    if (!prevHref) return;
    sessionStorage.removeItem('gxx_next_after_load');
    var id = currentVideoId();
    var replayKey = 'gxx_replay_' + (id || 'none');
    setTimeout(function () {
      sleep(2500).then(function () {
        if (location.href !== prevHref) {
          log('✅ 页面已自动进入下一课');
          sessionStorage.removeItem(replayKey);
          return;
        }
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
    log('脚本已启动。当前模式：' + MODE_LABEL[cfg.mode] + (cfg.mode === 'turbo' ? ' ' + cfg.speed + 'x' : ''));
    log('本平台有服务端时长校验：默认「🐢挂机1x」最稳；加速/跳结尾仅供试验，进度可能不记录');
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
