/* Shared helpers. Classic script, ES5 only (Tizen 6.0 / Chromium 76). */
(function () {
  var A = window.ATV = window.ATV || {};

  A.preview = /[?&]preview=1/.test(location.search);

  A.param = function (name) {
    var m = new RegExp("[?&]" + name + "=([^&]*)").exec(location.search);
    return m ? decodeURIComponent(m[1].replace(/\+/g, " ")) : "";
  };

  A.$ = function (id) { return document.getElementById(id); };

  A.esc = function (s) {
    return String(s === undefined || s === null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  };

  A.withQuery = function (url, params) {
    var parts = [];
    for (var k in params) {
      if (!params.hasOwnProperty(k)) continue;
      var v = params[k];
      if (v === undefined || v === null || v === "") continue;
      parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(v));
    }
    if (!parts.length) return url;
    return url + (url.indexOf("?") === -1 ? "?" : "&") + parts.join("&");
  };

  function z(n) { return (n < 10 ? "0" : "") + n; }

  A.clock = function (ms) {
    var s = Math.max(0, Math.floor((ms || 0) / 1000));
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    s = s % 60;
    return h ? h + ":" + z(m) + ":" + z(s) : m + ":" + z(s);
  };

  /* tvOS phrasing: "2 hr 47 min", "52 min". */
  A.dur = function (ms) {
    var m = Math.round((ms || 0) / 60000);
    if (m <= 0) return "";
    if (m < 60) return m + " min";
    var h = Math.floor(m / 60);
    var r = m % 60;
    return h + " hr" + (r ? " " + r + " min" : "");
  };

  A.left = function (offset, duration) {
    if (!duration || !offset) return "";
    var d = A.dur(Math.max(60000, duration - offset));
    return d ? d + " left" : "";
  };

  A.progress = function (it) {
    if (!it || !it.duration || !it.offset) return 0;
    var p = it.offset / it.duration;
    return p > 0.01 && p < 0.97 ? p : 0;
  };

  /* "2024 · PG-13 · 2 hr 47 min · Drama" with escaped parts. */
  A.dots = function (parts) {
    var out = [];
    for (var i = 0; i < parts.length; i++) if (parts[i]) out.push(A.esc(parts[i]));
    return out.join('<span class="dot">\u00b7</span>');
  };

  A.badges = function (list) {
    var html = "";
    for (var i = 0; i < (list || []).length; i++) {
      html += '<span class="badge">' + A.esc(list[i]) + "</span>";
    }
    return html;
  };

  A.reflow = function (el) { return el ? el.offsetWidth : 0; };

  /* Phosphor Icons, MIT, @phosphor-icons/core 2.1.1. Fill for play/pause/mic,
     bold for the small chrome glyphs. Each one is the library file, not a
     hand-drawn path. */
  function ph(path) {
    return '<svg viewBox="0 0 256 256"><path d="' + path + '"/></svg>';
  }
  A.svg = {
    play: ph("M240,128a15.74,15.74,0,0,1-7.6,13.51L88.32,229.65a16,16,0,0,1-16.2.3A15.86,15.86,0,0,1,64,216.13V39.87a15.86,15.86,0,0,1,8.12-13.82,16,16,0,0,1,16.2.3L232.4,114.49A15.74,15.74,0,0,1,240,128Z"),
    pause: ph("M216,48V208a16,16,0,0,1-16,16H160a16,16,0,0,1-16-16V48a16,16,0,0,1,16-16h40A16,16,0,0,1,216,48ZM96,32H56A16,16,0,0,0,40,48V208a16,16,0,0,0,16,16H96a16,16,0,0,0,16-16V48A16,16,0,0,0,96,32Z"),
    search: ph("M232.49,215.51,185,168a92.12,92.12,0,1,0-17,17l47.53,47.54a12,12,0,0,0,17-17ZM44,112a68,68,0,1,1,68,68A68.07,68.07,0,0,1,44,112Z"),
    check: ph("M232.49,80.49l-128,128a12,12,0,0,1-17,0l-56-56a12,12,0,1,1,17-17L96,183,215.51,63.51a12,12,0,0,1,17,17Z"),
    plus: ph("M228,128a12,12,0,0,1-12,12H140v76a12,12,0,0,1-24,0V140H40a12,12,0,0,1,0-24h76V40a12,12,0,0,1,24,0v76h76A12,12,0,0,1,228,128Z"),
    restart: ph("M228,128a100,100,0,0,1-98.66,100H128a99.39,99.39,0,0,1-68.62-27.29,12,12,0,0,1,16.48-17.45,76,76,0,1,0-1.57-109c-.13.13-.25.25-.39.37L54.89,92H72a12,12,0,0,1,0,24H24a12,12,0,0,1-12-12V56a12,12,0,0,1,24,0V76.72L57.48,57.06A100,100,0,0,1,228,128Z"),
    mic: ph("M80,128V64a48,48,0,0,1,96,0v64a48,48,0,0,1-96,0Zm128,0a8,8,0,0,0-16,0,64,64,0,0,1-128,0,8,8,0,0,0-16,0,80.11,80.11,0,0,0,72,79.6V240a8,8,0,0,0,16,0V207.6A80.11,80.11,0,0,0,208,128Z")
  };

  /* Image loads go through a small queue so a fast scroll never has more
     than a handful of requests in flight on the TV's network stack.
     Warm-up requests (artwork the user is likely to reach next) share the
     same budget but only run when no visible image is waiting, and never
     take the last slot. */
  var queue = [];
  var warmQueue = [];
  var active = 0;
  var MAX_LOADS = 4;
  var WARM_MAX = 40;

  /* URLs that decoded once this session: revisits skip the fade-in so
     artwork doesn't flash when a row is rebuilt or a screen reopens. */
  var loaded = {};
  var loadedCount = 0;
  function remember(src) {
    if (loaded[src]) return;
    if (loadedCount > 1500) { loaded = {}; loadedCount = 0; }
    loaded[src] = 1;
    loadedCount += 1;
  }
  A.isLoaded = function (src) { return !!loaded[src]; };

  A.loadImg = function (img, src) {
    if (!img || !src) return;
    if (img.getAttribute("data-want") === src) return;
    img.setAttribute("data-want", src);
    if (loaded[src]) {
      img.onload = img.onerror = null;
      img.src = src;
      img.classList.add("ok", "seen");
      return;
    }
    queue.push({ img: img, src: src });
    pump();
  };

  A.loadNow = function (img, src) {
    if (!img || !src) return;
    img.setAttribute("data-want", src);
    img.onload = function () { remember(src); img.classList.add("ok"); };
    img.onerror = function () { img.classList.add("bad"); };
    img.src = src;
  };

  /* Low-priority prefetch through the shared queue. */
  A.warm = function (urls) {
    for (var i = 0; i < urls.length; i++) {
      var u = urls[i];
      if (!u || loaded[u]) continue;
      warmQueue.push(u);
    }
    if (warmQueue.length > WARM_MAX) warmQueue = warmQueue.slice(warmQueue.length - WARM_MAX);
    pump();
  };

  A.flushImages = function () { queue = []; warmQueue = []; };

  function pump() {
    while (active < MAX_LOADS && queue.length) {
      var job = queue.shift();
      if (!document.body.contains(job.img)) continue;
      if (job.img.getAttribute("data-want") !== job.src) continue;
      start(job);
    }
    while (!queue.length && active < MAX_LOADS - 1 && warmQueue.length) {
      var url = warmQueue.pop();
      if (!loaded[url]) startWarm(url);
    }
  }

  function startWarm(url) {
    var probe = new Image();
    var done = false;
    active++;
    function finish(ok) {
      if (done) return;
      done = true;
      active--;
      if (ok) remember(url);
      pump();
    }
    probe.onload = function () { finish(true); };
    probe.onerror = function () { finish(false); };
    setTimeout(function () { finish(false); }, 12000);
    probe.src = url;
  }

  function start(job) {
    var done = false;
    var timer = 0;
    active++;
    function finish(ok) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      active--;
      if (ok === true) { remember(job.src); job.img.classList.add("ok"); }
      else if (ok === false) job.img.classList.add("bad");
      pump();
    }
    job.img.onload = function () { finish(true); };
    job.img.onerror = function () { finish(false); };
    timer = setTimeout(function () { finish(null); }, 12000);
    job.img.src = job.src;
  }

  /* Full-bleed backdrop: two stacked <img> layers, the hidden one is loaded
     and then the pair swaps opacity. Debounced so fast scrolling settles
     before anything is fetched. */
  A.Backdrop = function (el, delay) {
    this.el = el;
    this.layers = el.querySelectorAll(".bd-img");
    this.front = 0;
    this.url = "";
    this.wanted = "";
    this.ok = false;
    this.timer = 0;
    this.delay = delay === undefined ? 300 : delay;
  };

  /* `fallback` paints at once (usually the small blur) so the hero never
     sits on black while the full frame is still coming from Plex. */
  A.Backdrop.prototype.set = function (url, now, fallback) {
    var self = this;
    if (url === this.wanted && this.ok) return;
    this.wanted = url || "";
    clearTimeout(this.timer);
    if (!url) { this.url = ""; this.ok = false; this.show(""); return; }
    if (fallback && fallback !== url && !loaded[url]) this.show(fallback, true);
    this.timer = setTimeout(function () { self.show(url); }, now ? 0 : this.delay);
  };

  A.Backdrop.prototype.show = function (url, placeholder) {
    var self = this;
    if (!url) {
      for (var i = 0; i < this.layers.length; i++) this.layers[i].classList.remove("on");
      return;
    }
    function swap() {
      if (!placeholder && self.wanted !== url) return;
      var back = self.layers[1 - self.front];
      var front = self.layers[self.front];
      back.src = url;
      back.classList.add("on");
      front.classList.remove("on");
      self.front = 1 - self.front;
      if (!placeholder) { self.url = url; self.ok = true; }
    }
    if (loaded[url]) { swap(); return; }
    var probe = new Image();
    var done = false;
    function finish(ok) {
      if (done) return;
      done = true;
      if (ok) { remember(url); swap(); }
      else if (!placeholder && self.wanted === url) { self.url = ""; self.ok = false; }
    }
    probe.onload = function () { finish(true); };
    probe.onerror = function () { finish(false); };
    setTimeout(function () { finish(false); }, 14000);
    probe.src = url;
  };

  A.Backdrop.prototype.clear = function () {
    this.wanted = "";
    this.url = "";
    this.ok = false;
    clearTimeout(this.timer);
    this.show("");
  };

  var toastTimer = 0;
  A.toast = function (text, ms) {
    var el = A.$("toast");
    if (!el) return;
    if (!text) { el.classList.remove("on"); return; }
    el.innerHTML = "<span>" + A.esc(text) + "</span>";
    el.classList.add("on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove("on"); }, ms || 3200);
  };

  A.log = function () {
    try { console.log.apply(console, ["[atv]"].concat([].slice.call(arguments))); } catch (e) {}
  };
})();
