/* Cache: versioned localStorage snapshots of mapped rows (stale-while-
   revalidate), short-lived in-memory memos for detail data, and surgical
   patching of items after playback. Every storage access is guarded: a
   corrupt, foreign or full store degrades to "no cache", never to a broken
   boot. */
(function () {
  var A = window.ATV;
  var VERSION = 2;
  var ROOT = "atv.cache.";
  var PREFIX = ROOT + "v" + VERSION + ".";
  var INDEX = PREFIX + "index";

  /* Fresh-for windows; older data still paints instantly, then revalidates. */
  var TTL = {
    watch: 2 * 60000,
    movies: 15 * 60000,
    tv: 15 * 60000,
    sections: 60 * 60000,
    section: 15 * 60000,
    detail: 5 * 60000,
    seasons: 30 * 60000,
    episodes: 10 * 60000
  };

  var C = A.Cache = { TTL: TTL };
  var snaps = {};   // name -> { t, d } for the current server
  var memos = {};   // name -> { t, p, v }
  var snapsFor = "";

  function serverId() {
    var s = A.src && A.src.server;
    return s && s.id ? String(s.id) : "";
  }

  function storeKey(name) {
    var id = serverId();
    return id ? PREFIX + id + "." + name : "";
  }

  function sync() {
    var id = serverId();
    if (id !== snapsFor) { snaps = {}; memos = {}; snapsFor = id; }
  }

  function readIndex() {
    try {
      var x = JSON.parse(localStorage.getItem(INDEX) || "{}");
      return x && typeof x === "object" ? x : {};
    } catch (e) { return {}; }
  }

  function writeIndex(ix) {
    try { localStorage.setItem(INDEX, JSON.stringify(ix)); } catch (e) {}
  }

  /* Drop snapshots written by an older schema version. */
  function purgeOld() {
    try {
      var dead = [];
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf(ROOT) === 0 && k.indexOf(PREFIX) !== 0) dead.push(k);
      }
      for (var j = 0; j < dead.length; j++) localStorage.removeItem(dead[j]);
    } catch (e) {}
  }
  purgeOld();

  /* Stream lists and the player's scratch offset stay out of the snapshot.
     onDeck stays: it is the Resume target on a show. */
  function strip(k, v) {
    if (k === "audio" || k === "subs" || k === "resumeAt" || k === "streamsLoaded") return undefined;
    return v;
  }

  function writeSnap(name, entry) {
    var key = storeKey(name);
    if (!key) return;
    var text;
    try {
      text = JSON.stringify({ v: VERSION, s: serverId(), t: entry.t, d: entry.d }, strip);
    } catch (e) { return; }
    var ix = readIndex();
    for (var tries = 0; tries < 12; tries++) {
      try {
        localStorage.setItem(key, text);
        ix[key] = entry.t;
        writeIndex(ix);
        return;
      } catch (err) {
        var oldest = "", ot = Infinity;
        for (var k in ix) if (ix.hasOwnProperty(k) && k !== key && ix[k] < ot) { ot = ix[k]; oldest = k; }
        if (!oldest) return;
        try { localStorage.removeItem(oldest); } catch (e2) {}
        delete ix[oldest];
      }
    }
  }

  function readSnap(name) {
    var key = storeKey(name);
    if (!key) return null;
    try {
      var raw = localStorage.getItem(key);
      if (!raw) return null;
      var o = JSON.parse(raw);
      if (!o || o.v !== VERSION || o.s !== serverId() || typeof o.t !== "number" || o.d === undefined || o.d === null) {
        localStorage.removeItem(key);
        return null;
      }
      return { t: o.t, d: o.d };
    } catch (e) {
      try { localStorage.removeItem(key); } catch (e2) {}
      return null;
    }
  }

  /* ---------- Snapshots ---------- */

  C.get = function (name) {
    sync();
    if (!snaps[name]) {
      var s = readSnap(name);
      if (s) snaps[name] = s;
    }
    return snaps[name] || null;
  };

  C.fresh = function (name, group) {
    var e = C.get(name);
    return !!e && Date.now() - e.t < (TTL[group || name] || 0);
  };

  C.put = function (name, data) {
    sync();
    var e = { t: Date.now(), d: data };
    snaps[name] = e;
    writeSnap(name, e);
    return e;
  };

  /* Re-persist after an in-place patch, keeping the fetch timestamp. */
  C.save = function (name) {
    var e = snaps[name];
    if (e) writeSnap(name, e);
  };

  C.names = function () {
    var out = [];
    for (var k in snaps) if (snaps.hasOwnProperty(k)) out.push(k);
    return out;
  };

  /* Forget everything for this server (long-press refresh). */
  C.clear = function () {
    snaps = {};
    memos = {};
    var id = serverId();
    if (!id) return;
    var ix = readIndex();
    var pre = PREFIX + id + ".";
    for (var k in ix) {
      if (!ix.hasOwnProperty(k) || k.indexOf(pre) !== 0) continue;
      try { localStorage.removeItem(k); } catch (e) {}
      delete ix[k];
    }
    writeIndex(ix);
  };

  /* Return a saved snapshot, or run fn once and keep the result on disk.
     A hit never goes back to the network, so a relaunch paints what was
     already downloaded. */
  C.keep = function (name, fn) {
    var hit = C.get(name);
    if (hit) return Promise.resolve(hit.d);
    return fn().then(function (v) {
      C.put(name, v);
      return v;
    });
  };

  C.drop = function (name) {
    delete snaps[name];
    delete memos[name];
    var key = storeKey(name);
    if (!key) return;
    try { localStorage.removeItem(key); } catch (e) {}
    var ix = readIndex();
    if (ix[key]) { delete ix[key]; writeIndex(ix); }
  };

  /* ---------- Memos (detail, seasons, episodes): memory only ---------- */

  C.memo = function (name, group, fn) {
    sync();
    var m = memos[name];
    if (m && Date.now() - m.t < (TTL[group] || 0)) return m.p;
    var p = fn();
    m = memos[name] = { t: Date.now(), p: p, v: null };
    p.then(function (v) { m.v = v; }, function () { if (memos[name] === m) delete memos[name]; });
    return p;
  };

  C.forget = function (name) { delete memos[name]; };

  /* ---------- Surgical patching ---------- */

  function sameShow(a, b) {
    return a.type === "episode" && b.type === "episode" && a.showKey && a.showKey === b.showKey;
  }

  /* Copy playback state onto every cached copy of `src`. */
  function patchList(list, src) {
    var hit = false;
    for (var i = 0; list && i < list.length; i++) {
      var it = list[i];
      if (!it || it.key !== src.key) continue;
      if (it !== src) { it.offset = src.offset; it.watched = src.watched; }
      hit = true;
    }
    return hit;
  }

  /* Continue Watching: the played item moves to the front (or leaves the
     row once finished); another episode of the same show gives way to it. */
  function reorderContinue(row, src, episodesOnly) {
    var done = !A.progress(src);
    var rest = [];
    var mine = null;
    for (var i = 0; i < row.items.length; i++) {
      var it = row.items[i];
      if (it.key === src.key) { mine = it; continue; }
      if (!done && sameShow(it, src)) continue;
      rest.push(it);
    }
    if (done) return rest;
    if (!mine && episodesOnly && src.type !== "episode") return row.items;
    return [mine || src].concat(rest);
  }

  C.patchItem = function (src) {
    if (!src || !src.key) return [];
    sync();
    var changed = [];
    for (var name in snaps) {
      if (!snaps.hasOwnProperty(name)) continue;
      var d = snaps[name].d;
      var hit = false;
      if (d && d.length !== undefined) {
        for (var r = 0; r < d.length; r++) {
          var row = d[r];
          if (!row || !row.items) continue;
          if (patchList(row.items, src)) hit = true;
          if (row.title === "Continue Watching" || /Up Next$/.test(row.title)) {
            var next = reorderContinue(row, src, row.title !== "Continue Watching");
            if (next.length !== row.items.length || next[0] !== row.items[0]) {
              d[r] = { title: row.title, items: next };
              hit = true;
            }
          }
        }
        d = d.filter(function (row) { return !row || !row.items || row.items.length; });
        snaps[name].d = d;
      } else if (d && d.items) {
        hit = patchList(d.items, src);
      } else if (d && d.key) {
        if (d.key === src.key) {
          d.offset = src.offset;
          d.watched = src.watched;
          hit = true;
        }
        if (d.onDeck && d.onDeck.key === src.key) {
          d.onDeck.offset = src.offset;
          d.onDeck.watched = src.watched;
          hit = true;
        }
      }
      if (hit) { changed.push(name); C.save(name); }
    }
    for (var key in memos) {
      if (!memos.hasOwnProperty(key) || !memos[key].v) continue;
      var v = memos[key].v;
      if (v.length !== undefined) patchList(v, src);
    }
    if (src.showKey) C.forget("detail:" + src.showKey);
    C.forget("detail:" + src.key);
    return changed;
  };
})();
