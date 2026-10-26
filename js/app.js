/* App shell: tab bar, screen routing, remote keys, boot. */
(function () {
  var A = window.ATV;

  var TABS = [
    { id: "watch", label: "Watch Now", view: "browse", load: "home" },
    { id: "movies", label: "Movies", view: "browse", load: "movies" },
    { id: "tv", label: "TV Shows", view: "browse", load: "shows" },
    { id: "list", label: "My List", view: "browse", load: "myList" },
    { id: "search", label: "Search", view: "search", icon: "search" },
    { id: "library", label: "Library", view: "library" }
  ];
  var SCREENS = ["login", "loading", "browse", "search", "library", "detail", "player"];

  var App = A.App = { tab: 0, zone: "content", overlay: "", screen: "" };
  var inflight = {};
  var libraryLoaded = false;
  var playOrigin = null;
  var playFrom = "";
  var nav;

  function show(id, noAnim) {
    for (var i = 0; i < SCREENS.length; i++) {
      var el = A.$("screen-" + SCREENS[i]);
      var on = SCREENS[i] === id;
      el.classList.toggle("on", on);
      if (on) el.classList.toggle("no-anim", !!noAnim);
    }
    var tabScreen = id === "browse" || id === "search" || id === "library";
    nav.classList.toggle("hidden", !tabScreen);
  }

  function renderNav() {
    var h = '<div class="nav-bar">';
    for (var i = 0; i < TABS.length; i++) {
      h += '<div class="tab">' + (TABS[i].icon ? A.svg[TABS[i].icon] : "") + "<span>" + A.esc(TABS[i].label) + "</span></div>";
    }
    nav.innerHTML = h + "</div>";
  }

  function paintNav() {
    var tabs = nav.querySelectorAll(".tab");
    for (var i = 0; i < tabs.length; i++) tabs[i].classList.toggle("sel", i === App.tab);
    nav.classList.toggle("focus", App.zone === "nav" && !App.overlay);
  }

  App.navAway = function (away) {
    if (nav) nav.classList.toggle("away", !!away && App.zone !== "nav");
  };

  App.view = function () { return A.views[TABS[App.tab].view]; };

  function tabIndex(id) {
    for (var i = 0; i < TABS.length; i++) if (TABS[i].id === id) return i;
    return 0;
  }

  /* My List changed: patch the saved Watch Now rows and the My List tab,
     and flip the button if that title's page is open. */
  App.listChanged = function () {
    var items = A.src && A.src.listItems ? A.src.listItems() : [];
    var row = { title: "My List", items: items };
    A.Cache.put("list", items.length ? [row] : []);
    var watch = A.Cache.get("watch");
    if (watch && watch.d && watch.d.length !== undefined) {
      var d = [];
      for (var i = 0; i < watch.d.length; i++) if (watch.d[i].title !== "My List") d.push(watch.d[i]);
      if (items.length) d.unshift(row);
      watch.d = d;
      A.Cache.save("watch");
      if (TABS[App.tab].id === "watch" && A.views.browse.tab === "watch") A.views.browse.update("watch", d);
    }
    if (TABS[App.tab].id === "list" && A.views.browse.tab === "list") {
      A.views.browse.update("list", items.length ? [row] : []);
    }
    if (App.overlay === "detail") {
      A.views.detail.buildButtons();
      A.views.detail.paint();
    }
  };

  function syncList() {
    if (!A.src || !A.src.syncList) return;
    A.src.syncList().then(function () { App.listChanged(); }, function () {});
  }

  /* A saved tab paints as-is. The network is only used when that tab has
     never been stored, or when the user asks to refresh. */
  function revalidate(tab) {
    if (inflight[tab.id]) return;
    var v = A.views.browse;
    var had = !!A.Cache.get(tab.id);
    inflight[tab.id] = true;
    A.src[tab.load]().then(function (rows) {
      inflight[tab.id] = false;
      A.Cache.put(tab.id, rows);
      if (TABS[App.tab].id !== tab.id) return;
      if (v.tab === tab.id) v.update(tab.id, rows);
      else v.load(tab.id, rows);
    }, function () {
      inflight[tab.id] = false;
      if (had || TABS[App.tab].id !== tab.id) return;
      v.load(tab.id, []);
      A.toast("Couldn\u2019t reach your Plex server.");
    });
  }

  function loadTab(tab, force) {
    if (tab.view === "browse") {
      var v = A.views.browse;
      var hit = A.Cache.get(tab.id);
      if (v.tab !== tab.id) {
        if (hit) v.load(tab.id, hit.d);
        else v.loading();
      }
      if (hit && !force) return;
      revalidate(tab);
    } else if (tab.view === "library") {
      if (libraryLoaded && !force) return;
      libraryLoaded = true;
      var snap = A.Cache.get("sections");
      if (snap) A.views.library.load(snap.d);
      if (snap && !force) return;
      A.src.sections().then(function (secs) {
        var same = snap && JSON.stringify(snap.d) === JSON.stringify(secs);
        A.Cache.put("sections", secs);
        if (!same) A.views.library.load(secs);
      }, function () {
        if (snap) return;
        libraryLoaded = false;
        A.toast("Couldn\u2019t load your libraries.");
      });
    }
  }

  /* Pull everything fresh: hold Up on the tab bar, or after the server
     changed underneath a warm start. */
  App.refresh = function (quiet) {
    A.Cache.clear();
    inflight = {};
    libraryLoaded = false;
    if (A.Plex && A.Plex.invalidate) A.Plex.invalidate();
    if (!quiet) A.toast("Refreshing\u2026", 1500);
    var go = function () {
      loadTab(TABS[App.tab], true);
      App.precache();
    };
    if (A.src && A.src.syncList) A.src.syncList().then(go, go);
    else go();
  };

  /* Download every home tab, the library list, and each library's first
     page, but only where nothing is stored yet. A tab already on screen
     is left alone, so opening the app does not rebuild it. */
  App.precache = function () {
    var steps = [];
    for (var i = 0; i < TABS.length; i++) {
      (function (tab) {
        if (tab.view !== "browse") return;
        steps.push(function () {
          if (A.Cache.get(tab.id) || inflight[tab.id]) return Promise.resolve();
          inflight[tab.id] = true;
          return A.src[tab.load]().then(function (rows) {
            inflight[tab.id] = false;
            A.Cache.put(tab.id, rows);
            if (TABS[App.tab].id === tab.id && A.views.browse.tab !== tab.id) A.views.browse.load(tab.id, rows);
          }, function () { inflight[tab.id] = false; });
        });
      })(TABS[i]);
    }
    steps.push(function () {
      var have = A.Cache.get("sections");
      if (have) return have.d;
      return A.src.sections().then(function (secs) {
        A.Cache.put("sections", secs);
        return secs;
      }, function () { return []; });
    });
    steps.push(function (secs) {
      var list = secs || [];
      var n = 0;
      function next() {
        if (n >= list.length) return Promise.resolve();
        var sec = list[n++];
        if (!sec || !sec.key || A.Cache.get("sec:" + sec.key)) return next();
        return A.src.sectionItems(sec, 0, 50).then(function (page) {
          A.Cache.put("sec:" + sec.key, page);
          return next();
        }, function () { return next(); });
      }
      return next();
    });
    var run = Promise.resolve();
    for (var s = 0; s < steps.length; s++) run = run.then(steps[s], steps[s]);
    return run;
  };

  /* An item's watched state or progress changed: patch every cached copy
     and the rows on screen, leave everything else alone. */
  App.itemChanged = function (it) {
    var changed = A.Cache.patchItem(it);
    var tab = TABS[App.tab];
    if (tab.view === "browse" && changed.indexOf(tab.id) !== -1) {
      var snap = A.Cache.get(tab.id);
      if (snap) A.views.browse.update(tab.id, snap.d);
    }
  };

  App.selectTab = function (i, focusContent) {
    var prev = App.view();
    if (prev && prev.focused) prev.blur();
    App.tab = i;
    var tab = TABS[i];
    show(tab.view, true);
    paintNav();
    loadTab(tab);
    if (focusContent) App.focusContent();
    else App.navAway(false);
  };

  App.focusNav = function () {
    var v = App.view();
    if (v.focused) v.blur();
    App.zone = "nav";
    paintNav();
    App.navAway(false);
  };

  App.focusContent = function () {
    App.zone = "content";
    paintNav();
    App.view().focus("d");
  };

  /* ---------- Detail + player ---------- */

  App.select = function (it) {
    if (!it) return;
    App.overlay = "detail";
    show("detail");
    paintNav();
    A.views.detail.open(it);
  };

  App.closeDetail = function () {
    App.overlay = "";
    var tab = TABS[App.tab];
    show(tab.view);
    paintNav();
  };

  App.play = function (it, opts) {
    if (!it) return;
    playOrigin = it;
    playFrom = App.overlay;
    A.toast("");
    A.src.playable(it).then(function (full) {
      if (!full.offset && it.offset) full.offset = it.offset;
      App.overlay = "player";
      show("player");
      A.Player.open(full, opts);
    }, function () { A.toast("Couldn\u2019t start playback."); });
  };

  App.playerClosed = function (played) {
    if (played) {
      if (played.duration && played.offset >= played.duration * 0.95) {
        played.watched = true;
        played.offset = 0;
      }
      if (playOrigin && played !== playOrigin && playOrigin.key === played.key) {
        playOrigin.offset = played.offset;
        playOrigin.watched = played.watched;
      }
      App.itemChanged(played);
    }
    App.overlay = playFrom;
    if (playFrom === "detail") {
      show("detail");
      var d = A.views.detail;
      if (d.row) d.row.update(d.row.items.slice(0));
      d.buildButtons();
      d.paint();
    } else {
      App.overlay = "";
      show(TABS[App.tab].view);
      paintNav();
    }
  };

  /* ---------- Session ---------- */

  App.startMain = function () {
    App.screen = "main";
    App.overlay = "";
    A.views.login.stop();
    renderNav();
    App.selectTab(0, true);
  };

  App.signedIn = function (token) {
    App.screen = "loading";
    show("loading");
    loadingText("Finding your Plex server\u2026");
    A.Plex.discover(token, function (uri) {
      loadingText("Connecting to " + uri.replace(/^https?:\/\//, "").split("/")[0].split(".plex.direct")[0] + "\u2026");
    }).then(App.startMain, function (err) {
      App.login();
      A.toast((err && err.message) || "Couldn\u2019t find a Plex server.", 6000);
    });
  };

  App.login = function () {
    App.screen = "login";
    show("login");
    A.views.login.start();
  };

  App.signOut = function () {
    if (A.preview) { A.toast("Sign out is disabled in preview."); return; }
    A.Plex.signOut();
    location.reload();
  };

  App.exit = function () {
    try { tizen.application.getCurrentApplication().exit(); return; } catch (e) {}
    if (A.preview) A.toast("Back on Watch Now exits the app on the TV.");
  };

  function loadingText(t) { A.$("loading-text").textContent = t; }

  /* ---------- Keys ---------- */

  var NAMED = { ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Enter: 13, Escape: 27, Backspace: 8, " ": 32 };

  function keyName(e) {
    var code = e.keyCode || NAMED[e.key] || 0;
    switch (code) {
      case 37: return "left";
      case 38: return "up";
      case 39: return "right";
      case 40: return "down";
      case 13: return "ok";
      case 10009: case 27: case 461: return "back";
      case 8: return App.overlay === "" && App.zone === "content" && TABS[App.tab].view === "search" ? "delete" : "back";
      case 10252: return "playpause";
      case 415: return "play";
      case 19: return "pause";
      case 412: return "rew";
      case 417: return "ff";
      case 413: return "stop";
      case 32: if (App.overlay === "player") return "playpause"; break;
      case 10253: case 10255: case 403: case 404: return "voice";
    }
    if (e.key && /voice|mic/i.test(e.key)) return "voice";
    if (e.key && e.key.length === 1 && /[a-z0-9 ]/i.test(e.key) && !e.ctrlKey && !e.metaKey) return "char";
    return "";
  }

  /* The title a long press can take out of Continue Watching: a poster,
     a search result, a library card, or an episode on its show page. */
  function focusedSelection() {
    if (App.screen !== "main" || App.overlay === "player" || App.sheetOpen) return null;
    if (App.overlay === "detail") {
      var d = A.views.detail;
      if (d.zone === "episodes" && d.row) return d.row.item();
      return null;
    }
    if (App.zone !== "content") return null;
    var v = App.view();
    return v && v.current ? v.current() : null;
  }

  var sheetEl, sheetButtons, sheetIndex, sheetItem;
  App.sheetOpen = false;

  function paintSheet() {
    var btns = sheetButtons;
    for (var i = 0; i < btns.length; i++) btns[i].classList.toggle("on", i === sheetIndex);
  }

  App.openRemove = function (it) {
    if (!it) return;
    sheetEl = sheetEl || A.$("sheet");
    sheetButtons = sheetEl.querySelectorAll(".btn");
    sheetItem = it;
    sheetIndex = 0;
    var name = it.type === "episode" ? it.showTitle + " \u00b7 " + (it.label || it.title) : it.title;
    sheetEl.querySelector(".sheet-title").textContent = name;
    sheetEl.querySelector(".sheet-sub").textContent = "Take this out of Continue Watching. You can still resume it from its page.";
    paintSheet();
    App.sheetOpen = true;
    sheetEl.classList.add("on");
  };

  App.closeSheet = function () {
    App.sheetOpen = false;
    sheetItem = null;
    if (sheetEl) sheetEl.classList.remove("on");
  };

  App.sheetKey = function (k) {
    if (k === "back" || (k === "ok" && sheetButtons[sheetIndex].getAttribute("data-act") === "cancel")) {
      App.closeSheet();
      return;
    }
    if (k === "up" || k === "left") { sheetIndex = 0; paintSheet(); return; }
    if (k === "down" || k === "right") { sheetIndex = 1; paintSheet(); return; }
    if (k !== "ok") return;
    var it = sheetItem;
    App.closeSheet();
    A.src.removeFromContinue(it).then(function () {
      var changed = A.Cache.dropContinue(it);
      var tab = TABS[App.tab];
      if (tab.view === "browse" && changed.indexOf(tab.id) !== -1) {
        var snap = A.Cache.get(tab.id);
        if (snap) A.views.browse.update(tab.id, snap.d);
      }
      A.toast("Removed from Continue Watching", 2000);
    }, function () {
      A.toast("Couldn\u2019t remove it from Continue Watching.");
    });
  };

  /* Holding Up on the tab bar (nothing above it) for about a second forces
     a refresh; key repeat delivers a steady stream of "up" presses. */
  var upStart = 0;
  var upLast = 0;
  function holdUp() {
    var now = Date.now();
    if (now - upLast > 350) upStart = now;
    upLast = now;
    if (now - upStart > 900) {
      upStart = now + 60000;
      App.refresh();
    }
  }

  App.key = function (k, ch) {
    if (App.screen === "login") { A.views.login.key(k); return; }
    if (App.screen === "loading") { if (k === "back") App.exit(); return; }
    if (App.overlay === "player") { A.Player.key(k); return; }
    if (App.overlay === "detail") {
      if (A.views.detail.key(k) === "close") App.closeDetail();
      return;
    }
    if (k === "voice") {
      var search = tabIndex("search");
      if (TABS[App.tab].view !== "search") App.selectTab(search, true);
      else if (App.zone !== "content") App.focusContent();
      A.views.search.startVoice();
      return;
    }
    var tab = TABS[App.tab];
    if (App.zone === "nav") {
      if (k === "up") { holdUp(); return; }
      if (k === "left" && App.tab > 0) App.selectTab(App.tab - 1);
      else if (k === "right" && App.tab < TABS.length - 1) App.selectTab(App.tab + 1);
      else if (k === "down" || k === "ok") App.focusContent();
      else if (k === "back") { if (App.tab !== 0) App.selectTab(0); else App.exit(); }
      else if (k === "char" && tab.view === "search") { App.focusContent(); App.view().key(k, ch); }
      return;
    }
    if (k === "char" && tab.view !== "search") return;
    if (App.view().key(k, ch) === "up") App.focusNav();
  };

  /* Arrow presses closer than 130ms apart (a held key) mark the page as
     fast-scrolling so the parallax animations stay off until it settles. */
  var lastArrow = 0;
  var fastTimer = 0;
  function trackSpeed(k) {
    if (k !== "left" && k !== "right" && k !== "up" && k !== "down") return;
    var now = Date.now();
    if (now - lastArrow < 130 && App.overlay !== "player") {
      document.documentElement.classList.add("fast");
      clearTimeout(fastTimer);
      fastTimer = setTimeout(function () { document.documentElement.classList.remove("fast"); }, 280);
    }
    lastArrow = now;
  }

  /* OK is handled on release. A hold longer than this, on a title that is
     in progress, opens Remove from Continue Watching instead of the page. */
  var okAt = 0;
  var okArmed = false;
  var HOLD_OK = 650;

  document.addEventListener("keydown", function (e) {
    /* While the TV keyboard is up the field owns every key, and
       preventDefault() there would stop the text from being inserted. */
    if (e.target && e.target.id === "search-input") return;
    var k = keyName(e);
    if (!k) return;
    e.preventDefault();
    if (App.sheetOpen) { App.sheetKey(k); return; }
    if (k === "ok") {
      if (!okArmed) { okAt = Date.now(); okArmed = true; }
      return;
    }
    okArmed = false;
    trackSpeed(k);
    App.key(k, k === "char" ? e.key.toLowerCase() : "");
  });

  document.addEventListener("keyup", function (e) {
    if (e.target && e.target.id === "search-input") return;
    if (keyName(e) !== "ok" || !okArmed) return;
    okArmed = false;
    e.preventDefault();
    var held = Date.now() - okAt > HOLD_OK;
    var it = held ? focusedSelection() : null;
    if (it && A.progress(it)) { App.openRemove(it); return; }
    App.key("ok");
  });

  function registerKeys() {
    try {
      if (typeof tizen === "undefined" || !tizen.tvinputdevice) return;
      var names = ["MediaPlayPause", "MediaPlay", "MediaPause", "MediaRewind", "MediaFastForward", "MediaStop"];
      try {
        var supported = tizen.tvinputdevice.getSupportedKeys() || [];
        for (var i = 0; i < supported.length; i++) {
          if (/voice|mic|speech/i.test(supported[i].name)) names.push(supported[i].name);
        }
      } catch (e0) {}
      ["VoiceAssist", "Voice", "Microphone"].forEach(function (n) { names.push(n); });
      names.forEach(function (name) {
        try { tizen.tvinputdevice.registerKey(name); } catch (e) {}
      });
    } catch (e2) {}
  }

  /* ---------- Preview routes (?preview=1&screen=...) ---------- */

  function loadScript(src, done) {
    var s = document.createElement("script");
    s.src = src;
    s.onload = done;
    s.onerror = done;
    document.body.appendChild(s);
  }

  function fit() {
    var s = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
    A.$("app").style.transform = Math.abs(s - 1) < 0.005 ? "" : "scale(" + s + ")";
  }

  function previewItem(id) {
    var S = A.Preview.sample;
    var all = S.movies.concat(S.shows);
    for (var i = 0; i < all.length; i++) if (all[i].key === id) return all[i];
    for (var k in S.episodes) {
      if (!S.episodes.hasOwnProperty(k)) continue;
      for (var j = 0; j < S.episodes[k].length; j++) if (S.episodes[k][j].key === id) return S.episodes[k][j];
    }
    return null;
  }

  function previewRoute() {
    A.src = A.Preview;
    var screen = A.param("screen") || "home";
    var S = A.Preview.sample;
    if (screen === "login") { App.login(); return; }
    if (screen === "loading") { App.screen = "loading"; show("loading"); loadingText("Connecting to Plex Media Server\u2026"); return; }
    App.screen = "main";
    renderNav();
    var idx = { home: 0, watch: 0, movies: 1, tv: 2, shows: 2, list: 3, search: 4, library: 5 }[screen];
    if (screen === "detail") {
      App.selectTab(0, false);
      App.select(previewItem(A.param("item")) || S.shows[0]);
      var zone = A.param("zone");
      if (zone) {
        setTimeout(function () {
          var d = A.views.detail;
          if (zone === "episodes" || zone === "seasons" || zone === "info") d.key("down");
          if (zone === "episodes" || zone === "info") d.key("down");
          if (zone === "info") d.key("down");
        }, 500);
      }
      return;
    }
    if (screen === "player") {
      App.selectTab(0, false);
      var it = previewItem(A.param("item")) || S.upNext[0];
      App.play(it, { resume: true });
      var panel = A.param("panel") || (A.param("info") === "1" ? "info" : "");
      if (panel) {
        var tries = 0;
        var wait = setInterval(function () {
          tries += 1;
          if (App.overlay === "player" || tries > 40) {
            clearInterval(wait);
            A.Player.openPanel(panel);
          }
        }, 100);
      }
      return;
    }
    App.selectTab(idx === undefined ? 0 : idx, A.param("focus") !== "nav");
    if (A.param("focus") === "nav") App.focusNav();
    var q = A.param("q");
    if (screen === "search" && q) {
      for (var i = 0; i < q.length; i++) A.views.search.type(q.charAt(i));
    }
  }

  function boot() {
    nav = A.$("nav");
    A.makeViews();
    if (A.preview) {
      document.documentElement.classList.add("preview");
      fit();
      window.addEventListener("resize", fit);
      loadScript("js/sample.js", function () { loadScript("js/preview.js", previewRoute); });
      return;
    }
    registerKeys();
    A.src = A.Plex;
    /* Warm start: with a saved server and a snapshot, paint Watch Now at
       once and confirm the connection in the background. */
    var saved = A.Plex.peek();
    if (saved && A.Cache.get("watch")) {
      App.startMain();
      A.Plex.restore().then(function (server) {
        if (!server) { App.login(); return; }
        if (server.id !== saved.id) App.refresh(true);
        else if (server.uri !== saved.uri) { inflight = {}; loadTab(TABS[App.tab], true); }
        else { App.precache(); syncList(); }
      }, function () {
        A.toast("Couldn\u2019t reach your Plex server. Showing saved content.", 4000);
      });
      return;
    }
    App.screen = "loading";
    show("loading");
    loadingText("Connecting\u2026");
    A.Plex.restore().then(function (server) {
      if (server) { App.startMain(); App.precache(); syncList(); }
      else App.login();
    }, function () {
      App.login();
    });
  }

  boot();
})();
