/* Plex: plex.tv PIN sign-in, server discovery, library API, playback URLs.
   Every list method resolves to normalised items (see map()). */
(function () {
  var A = window.ATV;
  var TV = "https://plex.tv/api/v2";
  var PRODUCT = "ATV for Plex";
  var VERSION = "1.0.10";
  var TYPES = { movie: 1, show: 1, season: 1, episode: 1 };

  var clientId = localStorage.getItem("atv.clientId");
  if (!clientId) {
    clientId = "atv-" + Math.random().toString(16).slice(2) + Date.now().toString(16);
    localStorage.setItem("atv.clientId", clientId);
  }

  var P = A.Plex = { server: null, account: "" };

  /* Identity params; also appended as query params to URLs handed to AVPlay,
     which cannot send headers. */
  P.identity = function (token) {
    var p = {
      "X-Plex-Product": PRODUCT,
      "X-Plex-Version": VERSION,
      "X-Plex-Client-Identifier": clientId,
      "X-Plex-Platform": "Tizen",
      "X-Plex-Platform-Version": "6.0",
      "X-Plex-Device": "Samsung TV",
      "X-Plex-Device-Name": "Samsung TV (ATV)",
      "X-Plex-Model": "Tizen TV"
    };
    if (token) p["X-Plex-Token"] = token;
    return p;
  };

  P.request = function (url, opts) {
    opts = opts || {};
    var ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, opts.timeout || 15000) : 0;
    var headers = P.identity(opts.token);
    headers.Accept = "application/json";
    return fetch(A.withQuery(url, opts.params || {}), {
      method: opts.method || "GET",
      headers: headers,
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.text();
    }).then(function (text) {
      clearTimeout(timer);
      return text ? JSON.parse(text) : {};
    }, function (err) {
      clearTimeout(timer);
      throw err;
    });
  };

  function get(path, params, timeout) {
    var s = P.server;
    return P.request(s.uri + path, { token: s.token, params: params, timeout: timeout }).then(function (json) {
      return json.MediaContainer || json;
    });
  }
  P.get = get;

  /* ---------- Sign-in ---------- */

  P.createPin = function () {
    return P.request(TV + "/pins", { method: "POST", params: { strong: "false" } });
  };

  P.checkPin = function (id) {
    return P.request(TV + "/pins/" + id).then(function (pin) { return pin.authToken || ""; });
  };

  /* Plain HTTP on the LAN first (no TLS cost on the TV CPU), then local
     https (plex.direct), then remote, then relay. Each tier is probed in
     parallel; the first URI that answers /identity wins. */
  P.tiers = function (resource) {
    var conns = resource.connections || [];
    var lanHttp = [], local = [], remote = [], relay = [];
    for (var i = 0; i < conns.length; i++) {
      var c = conns[i];
      if (c.relay) { if (c.uri) relay.push(c.uri); continue; }
      if (c.local) {
        if (resource.httpsRequired !== true && c.address) lanHttp.push("http://" + c.address + ":" + c.port);
        if (c.uri) local.push(c.uri);
      } else if (c.uri) {
        remote.push(c.uri);
      }
    }
    return [lanHttp, local, remote, relay].filter(function (t) { return t.length; });
  };

  function firstOf(uris, token) {
    return new Promise(function (resolve, reject) {
      var pending = uris.length;
      uris.forEach(function (uri) {
        P.request(uri + "/identity", { token: token, timeout: 4000 }).then(function () {
          resolve(uri);
        }, function () {
          pending -= 1;
          if (!pending) reject(new Error("tier failed"));
        });
      });
    });
  }

  P.connect = function (resource, onTry) {
    var tiers = P.tiers(resource);
    var i = 0;
    function next() {
      if (i >= tiers.length) return Promise.reject(new Error("Could not reach " + (resource.name || "the server")));
      var tier = tiers[i++];
      if (onTry) onTry(tier[0]);
      return firstOf(tier, resource.accessToken).catch(next);
    }
    return next();
  };

  P.discover = function (accountToken, onTry) {
    P.account = accountToken;
    return P.request(TV + "/resources", {
      token: accountToken,
      params: { includeHttps: 1, includeRelay: 1, includeIPv6: 0 }
    }).then(function (resources) {
      var list = (resources || []).filter(function (r) {
        return (r.provides || "").indexOf("server") !== -1 && r.accessToken;
      });
      list.sort(function (a, b) { return (b.owned ? 1 : 0) - (a.owned ? 1 : 0); });
      if (!list.length) throw new Error("No Plex Media Server is linked to this account.");
      var i = 0;
      function next() {
        if (i >= list.length) return Promise.reject(new Error("Could not reach a Plex Media Server."));
        var res = list[i++];
        return P.connect(res, onTry).then(function (uri) {
          P.server = { uri: uri, token: res.accessToken, name: res.name || "Plex", id: res.clientIdentifier };
          P.save();
          return P.server;
        }).catch(next);
      }
      return next();
    });
  };

  P.save = function () {
    localStorage.setItem("atv.account", P.account || "");
    localStorage.setItem("atv.server", JSON.stringify(P.server));
  };

  /* Saved session, read synchronously for the warm-start paint. */
  P.peek = function () {
    P.account = localStorage.getItem("atv.account") || "";
    try { P.server = JSON.parse(localStorage.getItem("atv.server") || "null"); } catch (e) { P.server = null; }
    return P.account && P.server && P.server.uri && P.server.id ? P.server : null;
  };

  P.restore = function () {
    P.account = localStorage.getItem("atv.account") || "";
    try { P.server = JSON.parse(localStorage.getItem("atv.server") || "null"); } catch (e) { P.server = null; }
    if (!P.account) return Promise.resolve(null);
    if (!P.server || !P.server.uri) return P.discover(P.account);
    return P.request(P.server.uri + "/identity", { token: P.server.token, timeout: 4000 }).then(function () {
      return P.server;
    }, function () {
      return P.discover(P.account);
    });
  };

  P.signOut = function () {
    localStorage.removeItem("atv.account");
    localStorage.removeItem("atv.server");
    P.server = null;
    P.account = "";
  };

  /* ---------- Images ---------- */

  /* The server's photo transcoder resizes (and blurs, when asked) so the TV
     only decodes the pixels it shows. */
  P.img = function (path, w, h, opts) {
    if (!path || !P.server) return "";
    opts = opts || {};
    return A.withQuery(P.server.uri + "/photo/:/transcode", {
      width: w,
      height: h,
      minSize: opts.fit ? 0 : 1,
      upscale: 1,
      blur: opts.blur || "",
      quality: opts.quality || 82,
      format: opts.format || "jpeg",
      url: path,
      "X-Plex-Token": P.server.token
    });
  };

  /* ---------- Mapping ---------- */

  function tags(list, n) {
    var out = [];
    for (var i = 0; i < (list || []).length && out.length < (n || 99); i++) if (list[i].tag) out.push(list[i].tag);
    return out;
  }

  function badgesOf(m) {
    var out = [];
    var media = (m.Media && m.Media[0]) || {};
    var part = (media.Part && media.Part[0]) || {};
    var streams = part.Stream || [];
    var res = String(media.videoResolution || "").toLowerCase();
    if (res === "4k") out.push("4K");
    else if (res === "1080" || res === "720") out.push("HD");
    var dv = false, hdr = false, atmos = false, cc = false;
    for (var i = 0; i < streams.length; i++) {
      var s = streams[i];
      if (s.streamType === 1) {
        if (s.DOVIPresent) dv = true;
        if (/smpte2084|arib-std-b67/.test(s.colorTrc || "")) hdr = true;
      } else if (s.streamType === 2) {
        if (/atmos/i.test(s.displayTitle || "") || /atmos/i.test(s.extendedDisplayTitle || "")) atmos = true;
      } else if (s.streamType === 3) {
        cc = true;
      }
    }
    if (dv) out.push("Dolby Vision");
    else if (hdr) out.push("HDR");
    if (atmos) out.push("Dolby Atmos");
    else if (Number(media.audioChannels) >= 6) out.push(Number(media.audioChannels) >= 8 ? "7.1" : "5.1");
    if (cc) out.push("CC");
    return out;
  }

  /* PMS JSON is usually an array, but a one-stream part (and the XML
     converter) comes back as a bare object. A string check on streamType
     drops every track, which is how the chooser ended up empty. */
  function asList(x) {
    if (!x) return [];
    return Object.prototype.toString.call(x) === "[object Array]" ? x : [x];
  }

  function flag(v) { return v === true || v === 1 || v === "1"; }

  function streamLang(s) {
    if (s.language && s.language !== "Unknown") return s.language;
    if (s.languageTag) return s.languageTag;
    if (s.languageCode) return s.languageCode;
    return "Unknown";
  }

  /* Sidecar files omit `index`. Embedded tracks always have one, even when
     PMS also gives them a /library/streams key. */
  function isExternal(s) {
    if (flag(s.external)) return true;
    var idx = s.index;
    return !!(s.key && (idx === undefined || idx === null || idx === ""));
  }

  function streamsOf(it, part) {
    if (!part || !part.Stream) return;
    var list = asList(part.Stream);
    var audio = [], subs = [];
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      var type = Number(s.streamType);
      var display = s.extendedDisplayTitle || s.displayTitle || "";
      if (type === 2) {
        audio.push({
          id: Number(s.id),
          lang: streamLang(s),
          code: s.languageCode || "",
          codec: String(s.codec || "").toLowerCase(),
          channels: Number(s.channels) || 0,
          title: s.title || "",
          display: display,
          selected: flag(s.selected)
        });
      } else if (type === 3) {
        subs.push({
          id: Number(s.id),
          lang: streamLang(s),
          code: s.languageCode || "",
          codec: String(s.codec || "").toLowerCase(),
          forced: flag(s.forced),
          sdh: flag(s.hearingImpaired),
          title: s.title || "",
          display: display,
          key: isExternal(s) ? (s.key || ("/library/streams/" + s.id)) : "",
          external: isExternal(s),
          selected: flag(s.selected)
        });
      }
    }
    it.audio = audio;
    it.subs = subs;
  }

  /* The selected version when PMS marks one, otherwise the first.
     mediaIndex has to match, or a transcode plays a different file than
     the tracks we just listed. */
  function pickPart(m) {
    var medias = asList(m.Media);
    var mi = 0;
    for (var i = 0; i < medias.length; i++) if (flag(medias[i].selected)) { mi = i; break; }
    var media = medias[mi] || {};
    var parts = asList(media.Part);
    return { media: media, part: parts[0] || {}, mediaIndex: medias.length ? mi : 0, partIndex: 0 };
  }

  P.map = function (m) {
    var picked = pickPart(m);
    var media = picked.media;
    var part = picked.part;
    var t = m.type;
    var it = {
      key: String(m.ratingKey),
      type: t,
      title: m.title || "",
      year: m.year || "",
      rating: m.contentRating || "",
      duration: Number(m.duration) || 0,
      offset: Number(m.viewOffset) || 0,
      summary: m.summary || "",
      tagline: m.tagline || "",
      genres: tags(m.Genre, 2),
      cast: tags(m.Role, 6),
      directors: tags(m.Director, 2),
      writers: tags(m.Writer, 2),
      studio: m.studio || "",
      score: m.audienceRating || m.rating || "",
      released: m.originallyAvailableAt || "",
      watched: Number(m.viewCount) > 0,
      partKey: part.key || "",
      partId: part.id || "",
      mediaIndex: picked.mediaIndex,
      partIndex: picked.partIndex,
      container: media.container || part.container || "",
      videoCodec: media.videoCodec || "",
      audioCodec: media.audioCodec || "",
      badges: badgesOf(m)
    };
    streamsOf(it, part);
    var cardPath, artPath;
    if (t === "episode") {
      it.showTitle = m.grandparentTitle || "";
      it.showKey = m.grandparentRatingKey ? String(m.grandparentRatingKey) : "";
      it.seasonKey = m.parentRatingKey ? String(m.parentRatingKey) : "";
      it.season = Number(m.parentIndex) || 0;
      it.index = Number(m.index) || 0;
      it.label = "S" + it.season + ", E" + it.index;
      cardPath = m.thumb || m.art || m.grandparentArt;
      artPath = m.grandparentArt || m.art || m.thumb;
    } else if (t === "season") {
      it.showTitle = m.parentTitle || "";
      it.showKey = m.parentRatingKey ? String(m.parentRatingKey) : "";
      it.season = Number(m.index) || 0;
      cardPath = m.art || m.parentArt || m.thumb;
      artPath = m.art || m.parentArt || m.thumb;
    } else {
      cardPath = m.art || m.thumb;
      artPath = m.art || m.thumb;
      if (t === "show") {
        it.leafCount = Number(m.leafCount) || 0;
        it.watched = it.leafCount > 0 && Number(m.viewedLeafCount) >= it.leafCount;
        it.seasonCount = Number(m.childCount) || 0;
      }
    }
    /* Landscape cards for rows; poster thumbs for the library grid.
       Hero is 1280-wide so the transcoder answers before the user moves on. */
    it.card = P.img(cardPath, 432, 243);
    it.still = it.card;
    it.poster = P.img(m.thumb || cardPath, 280, 420);
    it.hero = P.img(artPath, 1280, 720, { quality: 78 });
    it.blur = P.img(artPath, 480, 270, { blur: 40, quality: 65 });
    it.logo = "";
    it.cardLogo = "";
    return it;
  };

  function items(mc) {
    var list = mc.Metadata || [];
    var out = [];
    for (var i = 0; i < list.length; i++) if (TYPES[list[i].type]) out.push(P.map(list[i]));
    return out;
  }

  /* Recently-added show libraries return seasons/episodes; collapse to one
     card per show so the row isn't five episodes of the same thing. */
  function byShow(list) {
    var seen = {};
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var it = list[i];
      var k = it.showKey || it.key;
      if (seen[k]) continue;
      seen[k] = 1;
      out.push(it);
    }
    return out;
  }

  var SIZE = { "X-Plex-Container-Start": 0, "X-Plex-Container-Size": 24 };
  function sized(extra) {
    var p = { "X-Plex-Container-Start": 0, "X-Plex-Container-Size": 24 };
    for (var k in extra) if (extra.hasOwnProperty(k)) p[k] = extra[k];
    return p;
  }

  var sectionsCache = null;
  var sectionsPending = null;
  P.invalidate = function () { sectionsCache = null; sectionsPending = null; };
  P.sections = function () {
    if (sectionsCache) return Promise.resolve(sectionsCache);
    if (sectionsPending) return sectionsPending;
    sectionsPending = get("/library/sections").then(function (mc) {
      sectionsPending = null;
      var dirs = mc.Directory || [];
      sectionsCache = dirs.filter(function (d) { return d.type === "movie" || d.type === "show"; }).map(function (d) {
        return { key: String(d.key), title: d.title, type: d.type };
      });
      return sectionsCache;
    }, function (err) {
      sectionsPending = null;
      throw err;
    });
    return sectionsPending;
  };

  function rowsOf(specs) {
    return Promise.all(specs.map(function (s) {
      return get(s.path, s.params).then(function (mc) {
        var list = items(mc);
        if (s.collapse) list = byShow(list);
        return { title: s.title, items: list };
      }, function () { return { title: s.title, items: [] }; });
    })).then(function (rows) {
      return rows.filter(function (r) { return r.items.length; });
    });
  }

  P.home = function () {
    return P.sections().then(function (secs) {
      var specs = [{ title: "Continue Watching", path: "/library/onDeck", params: SIZE }];
      secs.forEach(function (s) {
        specs.push({
          title: "Recently Added in " + s.title,
          path: "/library/sections/" + s.key + "/recentlyAdded",
          params: SIZE,
          collapse: s.type === "show"
        });
      });
      return rowsOf(specs).then(function (rows) {
        var mine = P.listItems();
        if (mine.length) rows.unshift({ title: "My List", items: mine });
        return rows;
      });
    });
  };

  function tabRows(type) {
    return P.sections().then(function (secs) {
      var mine = secs.filter(function (s) { return s.type === type; });
      var specs = [];
      mine.forEach(function (s) {
        var pre = mine.length > 1 ? s.title + ": " : "";
        if (type === "movie") {
          specs.push({ title: pre + "Recently Added", path: "/library/sections/" + s.key + "/all", params: sized({ type: 1, sort: "addedAt:desc" }) });
          specs.push({ title: pre + "New Releases", path: "/library/sections/" + s.key + "/all", params: sized({ type: 1, sort: "originallyAvailableAt:desc" }) });
          specs.push({ title: pre + "Top Rated", path: "/library/sections/" + s.key + "/all", params: sized({ type: 1, sort: "audienceRating:desc" }) });
          specs.push({ title: pre + "Unwatched", path: "/library/sections/" + s.key + "/all", params: sized({ type: 1, unwatched: 1, sort: "addedAt:desc" }) });
        } else {
          specs.push({ title: pre + "Up Next", path: "/library/sections/" + s.key + "/onDeck", params: SIZE });
          specs.push({ title: pre + "Recently Added", path: "/library/sections/" + s.key + "/all", params: sized({ type: 2, sort: "addedAt:desc" }) });
          specs.push({ title: pre + "Top Rated", path: "/library/sections/" + s.key + "/all", params: sized({ type: 2, sort: "audienceRating:desc" }) });
          specs.push({ title: pre + "Unwatched", path: "/library/sections/" + s.key + "/all", params: sized({ type: 2, unwatched: 1, sort: "titleSort" }) });
        }
      });
      return rowsOf(specs);
    });
  }
  P.movies = function () { return tabRows("movie"); };
  P.shows = function () { return tabRows("show"); };

  P.sectionItems = function (section, start, size) {
    return get("/library/sections/" + section.key + "/all", {
      type: section.type === "show" ? 2 : 1,
      sort: "titleSort",
      "X-Plex-Container-Start": start,
      "X-Plex-Container-Size": size
    }).then(function (mc) {
      return { total: Number(mc.totalSize !== undefined ? mc.totalSize : mc.size) || 0, items: items(mc) };
    });
  };

  P.detail = function (it) {
    var key = it.type === "episode" || it.type === "season" ? it.showKey : it.key;
    return get("/library/metadata/" + key, { includeOnDeck: 1 }).then(function (mc) {
      var m = (mc.Metadata || [])[0];
      if (!m) throw new Error("Not found");
      var full = P.map(m);
      var deck = mc.OnDeck && mc.OnDeck.Metadata ? mc.OnDeck.Metadata[0] : (m.OnDeck && m.OnDeck.Metadata ? m.OnDeck.Metadata[0] : null);
      if (deck) full.onDeck = P.map(deck);
      return full;
    });
  };

  P.seasons = function (show) {
    return get("/library/metadata/" + show.key + "/children", { excludeAllLeaves: 1 }).then(function (mc) {
      var list = (mc.Metadata || mc.Directory || []).filter(function (s) { return s.type === "season"; });
      return list.map(P.map);
    });
  };

  P.episodes = function (season) {
    return get("/library/metadata/" + season.key + "/children").then(items);
  };

  P.search = function (q) {
    return get("/hubs/search", { query: q, limit: 24, includeCollections: 0 }).then(function (mc) {
      var hubs = mc.Hub || [];
      var rows = [];
      for (var i = 0; i < hubs.length; i++) {
        var h = hubs[i];
        if (!TYPES[h.type] || !h.Metadata || !h.Metadata.length) continue;
        var list = items(h);
        if (list.length) rows.push({ title: h.title, items: list });
      }
      return rows;
    });
  };

  P.markWatched = function (it, watched) {
    return P.request(P.server.uri + (watched ? "/:/scrobble" : "/:/unscrobble"), {
      token: P.server.token,
      params: { identifier: "com.plexapp.plugins.library", key: it.key }
    });
  };

  /* Hide an in-progress title from Continue Watching. Progress on the
     item itself is left alone, so Resume still works from its page. */
  P.removeFromContinue = function (it) {
    return P.request(P.server.uri + "/actions/removeFromContinueWatching", {
      token: P.server.token,
      method: "PUT",
      timeout: 8000,
      params: { ratingKey: it.key }
    });
  };

  /* ---------- My List ---------- */

  /* A normal Plex playlist named "My List" is the bucket, so the same
     titles show up in Plex's own apps. This TV keeps a copy for the row
     and the tab, and writes through to the playlist when the server is up. */
  var LIST_TITLE = "My List";
  var listGen = 0;
  var playlistId = "";
  var playlistFor = "";

  function listStoreKey() {
    var id = P.server && P.server.id ? P.server.id : "";
    return id ? "atv.mylist." + id : "";
  }

  function readList() {
    var key = listStoreKey();
    if (!key) return [];
    try {
      var x = JSON.parse(localStorage.getItem(key) || "[]");
      return x && x.length !== undefined ? x : [];
    } catch (e) { return []; }
  }

  function writeList(items) {
    var key = listStoreKey();
    if (!key) return;
    try { localStorage.setItem(key, JSON.stringify(items)); } catch (e) {}
  }

  function slim(it) {
    return {
      key: String(it.key),
      type: it.type,
      title: it.title || "",
      year: it.year || "",
      rating: it.rating || "",
      duration: it.duration || 0,
      offset: it.offset || 0,
      summary: it.summary || "",
      tagline: it.tagline || "",
      genres: it.genres || [],
      cast: it.cast || [],
      directors: it.directors || [],
      writers: it.writers || [],
      studio: it.studio || "",
      score: it.score || "",
      watched: !!it.watched,
      badges: it.badges || [],
      showTitle: it.showTitle || "",
      showKey: it.showKey || "",
      seasonCount: it.seasonCount || 0,
      partKey: it.partKey || "",
      mediaIndex: it.mediaIndex || 0,
      partIndex: it.partIndex || 0,
      container: it.container || "",
      videoCodec: it.videoCodec || "",
      audioCodec: it.audioCodec || "",
      card: it.card || "",
      still: it.still || "",
      poster: it.poster || "",
      hero: it.hero || "",
      blur: it.blur || "",
      logo: "",
      cardLogo: "",
      playlistItemID: it.playlistItemID || ""
    };
  }

  function itemUri(it) {
    return "server://" + P.server.id + "/com.plexapp.plugins.library/library/metadata/" + it.key;
  }

  P.listItems = function () { return readList(); };

  P.inList = function (it) {
    if (!it || !it.key) return false;
    var key = String(it.key);
    var list = readList();
    for (var i = 0; i < list.length; i++) if (String(list[i].key) === key) return true;
    return false;
  };

  P.myList = function () {
    var items = readList();
    return Promise.resolve(items.length ? [{ title: LIST_TITLE, items: items }] : []);
  };

  function playlistRows(mc) { return (mc && (mc.Metadata || mc.Playlist)) || []; }

  function ensurePlaylist() {
    var sid = P.server && P.server.id ? P.server.id : "";
    if (sid !== playlistFor) { playlistId = ""; playlistFor = sid; }
    if (playlistId) return Promise.resolve(playlistId);
    if (!P.server) return Promise.resolve("");
    return get("/playlists").then(function (mc) {
      var rows = playlistRows(mc);
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i];
        var kind = r.playlistType || "video";
        if (r.title === LIST_TITLE && !flag(r.smart) && kind === "video" && r.ratingKey) {
          playlistId = String(r.ratingKey);
          return playlistId;
        }
      }
      return "";
    });
  }

  function remoteAdd(it) {
    if (!P.server) return Promise.resolve();
    return ensurePlaylist().then(function (id) {
      if (!id) {
        return P.request(P.server.uri + "/playlists", {
          method: "POST",
          token: P.server.token,
          params: { type: "video", title: LIST_TITLE, smart: 0, uri: itemUri(it) }
        }).then(function (json) {
          var mc = json.MediaContainer || json;
          var created = playlistRows(mc)[0];
          var id = created && created.ratingKey ? created.ratingKey : mc.ratingKey;
          if (id) { playlistId = String(id); return; }
          playlistId = "";
          return ensurePlaylist();
        });
      }
      return P.request(P.server.uri + "/playlists/" + id + "/items", {
        method: "PUT",
        token: P.server.token,
        params: { uri: itemUri(it) }
      });
    });
  }

  function remoteRemove(it) {
    if (!P.server) return Promise.resolve();
    return ensurePlaylist().then(function (id) {
      if (!id) return;
      var find = it.playlistItemID ? Promise.resolve(it.playlistItemID) : get("/playlists/" + id + "/items").then(function (mc) {
        var metas = mc.Metadata || [];
        for (var i = 0; i < metas.length; i++) {
          if (String(metas[i].ratingKey) === String(it.key)) return metas[i].playlistItemID || "";
        }
        return "";
      });
      return find.then(function (itemId) {
        if (!itemId) return;
        return P.request(P.server.uri + "/playlists/" + id + "/items/" + itemId, {
          method: "DELETE",
          token: P.server.token
        });
      });
    });
  }

  /* Local copy updates immediately. The playlist write happens behind it;
     a failed add stays on this TV and is uploaded on the next sync, a
     failed remove is put back so the button matches the server. */
  P.toggleList = function (it) {
    var key = String(it.key);
    var list = readList();
    var was = null;
    var next = [];
    for (var i = 0; i < list.length; i++) {
      if (String(list[i].key) === key) was = list[i];
      else next.push(list[i]);
    }
    var on = !was;
    if (on) next.unshift(slim(it));
    var gen = ++listGen;
    writeList(next);
    var job = (on ? remoteAdd(it) : remoteRemove(was || it)).then(function () {}, function () {
      if (gen !== listGen) return;
      if (on) {
        if (A.toast) A.toast("Saved here. Plex didn\u2019t take the add.", 3000);
        return;
      }
      var back = readList();
      back.unshift(was);
      writeList(back);
      if (A.App && A.App.listChanged) A.App.listChanged();
      if (A.toast) A.toast("Couldn\u2019t remove it from My List.");
    });
    return Promise.resolve(on).then(function (v) { job.catch(function () {}); return v; });
  };

  P.syncList = function () {
    if (!P.server) return Promise.resolve();
    var gen = listGen;
    return ensurePlaylist().then(function (id) {
      if (gen !== listGen) return;
      if (!id) {
        var local = readList();
        if (!local.length) return;
        var chain = Promise.resolve();
        for (var i = 0; i < local.length; i++) {
          (function (it) { chain = chain.then(function () { return remoteAdd(it); }); })(local[i]);
        }
        return chain;
      }
      return get("/playlists/" + id + "/items").then(function (mc) {
        if (gen !== listGen) return;
        var metas = mc.Metadata || [];
        var items = [];
        var have = {};
        for (var i = 0; i < metas.length; i++) {
          if (!TYPES[metas[i].type]) continue;
          var mapped = slim(P.map(metas[i]));
          mapped.playlistItemID = metas[i].playlistItemID || "";
          have[mapped.key] = 1;
          items.push(mapped);
        }
        var extra = [];
        var local = readList();
        for (var j = 0; j < local.length; j++) {
          if (!have[String(local[j].key)]) extra.push(local[j]);
        }
        writeList(extra.concat(items));
        var chain = Promise.resolve();
        for (var k = 0; k < extra.length; k++) {
          (function (it) { chain = chain.then(function () { return remoteAdd(it); }); })(extra[k]);
        }
        return chain;
      });
    }, function () {});
  };

  /* A hub item already carries the part key playback needs. Fetch the full
     record only when that key is missing. */
  P.playable = function (it) {
    if (it.partKey) return Promise.resolve(it);
    return get("/library/metadata/" + it.key).then(function (mc) {
      var m = (mc.Metadata || [])[0];
      if (!m) return it;
      var full = P.map(m);
      full.streamsLoaded = !!m.Media;
      if (!full.offset && it.offset) full.offset = it.offset;
      if (it.watched) full.watched = true;
      return full;
    }, function (err) {
      if (it.partKey) return it;
      throw err;
    });
  };

  /* Persist the stream choice on the part so the next play (and the
     transcoder, which reads the part's selected streams) uses it.
     subtitleStreamID 0 means "no subtitles". */
  P.selectStreams = function (it, params) {
    if (!it.partId || !P.server) return Promise.resolve();
    var p = { allParts: 1 };
    for (var k in params) if (params.hasOwnProperty(k)) p[k] = params[k];
    return P.request(P.server.uri + "/library/parts/" + it.partId, {
      token: P.server.token, method: "PUT", timeout: 4000, params: p
    }).then(function () {}, function () {});
  };

  /* PMS extracts embedded text tracks (SRT, ASS, MOV_TEXT) at this URL,
     same as an external sidecar. Image tracks (PGS, VobSub) 404 and the
     player burns those instead. */
  /* Token only. The full client-identity query makes PMS reject the
     download, and a rejected download used to restart playback. */
  P.subtitleText = function (sub) {
    function grab(path) {
      return fetch(A.withQuery(P.server.uri + path, { "X-Plex-Token": P.server.token })).then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.text();
      });
    }
    var path = "/library/streams/" + sub.id;
    return grab(path).catch(function () {
      if (sub.key && sub.key !== path) return grab(sub.key);
      throw new Error("no sub");
    });
  };

  /* ---------- Playback ---------- */

  P.canDirect = function (it) {
    if (!it.partKey) return false;
    var v = String(it.videoCodec).toLowerCase();
    var a = String(it.audioCodec).toLowerCase();
    var c = String(it.container).toLowerCase();
    if (v && !/^(h264|hevc|h265)$/.test(v)) return false;
    if (a && !/^(aac|ac3|eac3|mp3)$/.test(a)) return false;
    if (c && !/^(mp4|m4v|mkv|mpegts|ts)$/.test(c)) return false;
    return true;
  };

  P.directUrl = function (it) {
    return A.withQuery(P.server.uri + it.partKey, P.identity(P.server.token));
  };

  /* opts.audio: audio stream id; opts.sub: subtitle stream id to burn in.
     The profile lists only codecs Tizen 6 AVPlay decodes. A matching file is
     remuxed; anything else is transcoded to H.264 HLS at 1080p. */
  P.transcodeUrl = function (it, session, offsetMs, opts) {
    opts = opts || {};
    var extra = [
      "add-transcode-target(type=videoProfile&context=streaming&protocol=hls&container=mpegts&videoCodec=h264&audioCodec=aac,mp3,ac3,eac3)",
      "add-direct-play-profile(type=videoProfile&container=mp4,mkv,mpegts&videoCodec=h264,hevc&audioCodec=aac,mp3,ac3,eac3)",
      "add-limitation(scope=videoCodec&scopeName=hevc&type=upperBound&name=video.bitDepth&value=10&isRequired=false)"
    ].join("+");
    var p = P.identity(P.server.token);
    p.path = "/library/metadata/" + it.key;
    p.mediaIndex = it.mediaIndex || 0;
    p.partIndex = it.partIndex || 0;
    p.protocol = "hls";
    p.fastSeek = 1;
    p.directPlay = 0;
    p.directStream = 1;
    p.directStreamAudio = 1;
    p.offset = Math.floor((offsetMs || 0) / 1000);
    p.videoResolution = "1920x1080";
    p.maxVideoBitrate = 20000;
    p.location = "lan";
    if (opts.audio) p.audioStreamID = opts.audio;
    if (opts.sub) {
      p.subtitleStreamID = opts.sub;
      p.subtitles = "burn";
    } else {
      p.subtitles = "none";
    }
    p.session = session;
    p["X-Plex-Session-Identifier"] = session;
    p["X-Plex-Client-Profile-Extra"] = extra;
    return A.withQuery(P.server.uri + "/video/:/transcode/universal/start.m3u8", p);
  };

  P.stopTranscode = function (session) {
    if (!session || !P.server) return;
    P.request(P.server.uri + "/video/:/transcode/universal/stop", {
      token: P.server.token, timeout: 5000, params: { session: session }
    }).catch(function () {});
  };

  P.timeline = function (it, state, timeMs, session) {
    if (!it || !P.server) return;
    P.request(P.server.uri + "/:/timeline", {
      token: P.server.token,
      timeout: 8000,
      params: {
        ratingKey: it.key,
        key: "/library/metadata/" + it.key,
        state: state,
        time: Math.max(0, Math.floor(timeMs || 0)),
        duration: Math.floor(it.duration || 0),
        "X-Plex-Session-Identifier": session || ""
      }
    }).catch(function () {});
  };
})();
