/* Preview data source (?preview=1). Same interface as ATV.Plex's list
   methods, backed by js/sample.js (real titles and TMDB artwork). */
(function () {
  var A = window.ATV;
  var S = window.ATV_SAMPLE || { movies: [], shows: [] };
  var T = "https://image.tmdb.org/t/p/";
  var BADGES = [["4K", "Dolby Vision", "Dolby Atmos", "CC"], ["4K", "HDR", "5.1", "CC"], ["HD", "5.1", "CC"]];

  function ms(text) {
    var h = /(\d+)\s*h/.exec(text || "");
    var m = /(\d+)\s*m/.exec(text || "");
    return ((h ? +h[1] * 60 : 0) + (m ? +m[1] : 0)) * 60000;
  }

  function art(path, size) { return path ? T + size + path : ""; }

  var movies = S.movies.map(function (m, i) {
    return {
      key: m.id, type: "movie", title: m.title, year: m.year, rating: m.rating,
      duration: ms(m.runtime) || 6600000, offset: 0, summary: m.summary, tagline: m.tagline,
      genres: m.genres, cast: m.cast || [], directors: m.directors || [], studio: "",
      badges: BADGES[i % 3], watched: i % 5 === 3,
      card: art(m.art, "w780"), still: art(m.art, "w780"), poster: art(m.poster || m.art, "w500"),
      hero: art(m.art, "w1280"), blur: art(m.art, "w300"), logo: "", cardLogo: ""
    };
  });

  var shows = [];
  var episodesBy = {};
  S.shows.forEach(function (s, i) {
    var show = {
      key: s.id, type: "show", title: s.title, year: s.year, rating: s.rating, duration: 0, offset: 0,
      summary: s.summary, tagline: s.tagline, genres: s.genres, cast: s.cast || [], directors: s.directors || [],
      studio: "", badges: BADGES[(i + 1) % 3], watched: false, seasonCount: s.seasons.length,
      card: art(s.art, "w780"), still: art(s.art, "w780"), poster: art(s.poster || s.art, "w500"),
      hero: art(s.art, "w1280"), blur: art(s.art, "w300"), logo: "", cardLogo: "", seasonList: []
    };
    s.seasons.forEach(function (season) {
      var sk = s.id + "-s" + season.index;
      show.seasonList.push({ key: sk, type: "season", title: "Season " + season.index, season: season.index, showKey: s.id, showTitle: s.title });
      episodesBy[sk] = season.episodes.map(function (e) {
        return {
          key: sk + "e" + e.index, type: "episode", title: e.title, showTitle: s.title, showKey: s.id,
          seasonKey: sk, season: season.index, index: e.index, label: "S" + season.index + ", E" + e.index,
          year: s.year, rating: s.rating, genres: s.genres, duration: ms(e.runtime) || 3000000, offset: 0,
          summary: e.summary, badges: show.badges, watched: false,
          card: art(e.still, "w780"), still: art(e.still, "w780"), frame: art(e.still, "original"), hero: show.hero, blur: show.blur, logo: show.logo, cardLogo: show.cardLogo
        };
      });
    });
    shows.push(show);
  });

  function byKey(list, key) {
    for (var i = 0; i < list.length; i++) if (list[i].key === key) return list[i];
    return null;
  }
  function showByTitle(t) {
    for (var i = 0; i < shows.length; i++) if (shows[i].title === t) return shows[i];
    return null;
  }
  function ep(title, season, index, pct) {
    var show = showByTitle(title);
    if (!show) return null;
    var list = episodesBy[show.key + "-s" + season] || [];
    var e = list[index - 1] || list[0];
    if (!e) return null;
    for (var i = 0; i < index - 1 && i < list.length; i++) list[i].watched = true;
    e.offset = Math.round(e.duration * pct);
    return e;
  }
  function movieByTitle(t, pct) {
    for (var i = 0; i < movies.length; i++) {
      if (movies[i].title === t) { movies[i].offset = Math.round(movies[i].duration * pct); return movies[i]; }
    }
    return null;
  }
  function compact(list) { return list.filter(function (x) { return !!x; }); }

  var continueRow = compact([
    ep("Severance", 1, 4, 0.42),
    movieByTitle("Dune: Part Two", 0.36),
    ep("The Bear", 2, 3, 0.64),
    ep("Slow Horses", 1, 5, 0.22),
    movieByTitle("Past Lives", 0.71),
    ep("Shōgun", 1, 6, 0.5),
    ep("Silo", 1, 3, 0.3)
  ]);
  var upNext = continueRow.filter(function (x) { return x.type === "episode"; });

  function genre(list, g) { return list.filter(function (x) { return x.genres.indexOf(g) !== -1; }); }
  function pick(list, order) { return order.map(function (i) { return list[i % list.length]; }); }
  /* &latency=ms simulates a slow server, to see the cached first paint. */
  var LATENCY = Number(A.param("latency")) || 60;
  function resolve(v) { return new Promise(function (ok) { setTimeout(function () { ok(v); }, LATENCY); }); }

  var P = A.Preview = { server: { id: "preview" } };

  P.home = function () {
    var rows = [
      { title: "Continue Watching", items: continueRow },
      { title: "Recently Added in Movies", items: movies.slice(0, 12) },
      { title: "Recently Added in TV Shows", items: shows.slice(0) },
      { title: "Top Rated", items: pick(movies.concat(shows), [4, 19, 2, 22, 6, 24, 9, 27, 13, 16]) },
      { title: "Science Fiction", items: genre(movies.concat(shows), "Science Fiction").concat(genre(shows, "Sci-Fi & Fantasy")) }
    ];
    var mine = P.listItems();
    if (mine.length) rows.unshift({ title: "My List", items: mine });
    return resolve(rows);
  };

  P.movies = function () {
    var newest = movies.slice(0).sort(function (a, b) { return b.year - a.year; });
    return resolve([
      { title: "Recently Added", items: movies.slice(0) },
      { title: "New Releases", items: newest },
      { title: "Top Rated", items: pick(movies, [4, 16, 2, 10, 0, 6, 12, 1, 14, 8]) },
      { title: "Unwatched", items: movies.filter(function (m) { return !m.watched; }).reverse() }
    ]);
  };

  P.shows = function () {
    return resolve([
      { title: "Up Next", items: upNext },
      { title: "Recently Added", items: shows.slice(0) },
      { title: "Drama", items: genre(shows, "Drama") },
      { title: "Comedy", items: genre(shows, "Comedy").concat(genre(shows, "Mystery")) }
    ]);
  };

  P.sections = function () {
    return resolve([
      { key: "movies", title: "Movies", type: "movie" },
      { key: "shows", title: "TV Shows", type: "show" }
    ]);
  };

  P.sectionItems = function (section, start, size) {
    var all = (section.type === "show" ? shows : movies).slice(0).sort(function (a, b) {
      return a.title.replace(/^The /, "") < b.title.replace(/^The /, "") ? -1 : 1;
    });
    return resolve({ total: all.length, items: all.slice(start, start + size) });
  };

  P.detail = function (it) {
    if (it.type === "episode" || it.type === "season") it = byKey(shows, it.showKey) || it;
    var full = byKey(movies, it.key) || byKey(shows, it.key) || it;
    if (full.type === "show") {
      var deck = null;
      for (var i = 0; i < upNext.length; i++) if (upNext[i].showKey === full.key) deck = upNext[i];
      full.onDeck = deck;
    }
    return resolve(full);
  };

  P.seasons = function (show) {
    var s = byKey(shows, show.key);
    return resolve(s ? s.seasonList : []);
  };

  P.episodes = function (season) { return resolve(episodesBy[season.key] || []); };

  P.search = function (q) {
    q = String(q || "").toLowerCase();
    function hit(x) { return x.title.toLowerCase().indexOf(q) !== -1; }
    var m = movies.filter(hit);
    var s = shows.filter(hit);
    var e = [];
    for (var k in episodesBy) if (episodesBy.hasOwnProperty(k)) e = e.concat(episodesBy[k].filter(hit));
    var rows = [];
    var top = s.slice(0, 3).concat(m.slice(0, 3));
    if (top.length) rows.push({ title: "Top Results", items: top });
    if (m.length) rows.push({ title: "Movies", items: m });
    if (s.length) rows.push({ title: "TV Shows", items: s });
    if (e.length) rows.push({ title: "Episodes", items: e.slice(0, 16) });
    return resolve(rows);
  };

  P.markWatched = function (it, watched) {
    it.watched = watched;
    if (watched) it.offset = 0;
    return resolve({});
  };

  /* Plausible streams for the player's Subtitles and Audio tabs: an embedded
     text track, a sidecar, and an image track that would need burning in. */
  function tracks(it) {
    if (it.audio) return;
    it.partId = "pv-" + it.key;
    it.audio = [
      { id: 101, lang: "English", code: "eng", codec: "eac3", channels: 6, title: "", selected: true },
      { id: 102, lang: "Spanish", code: "spa", codec: "ac3", channels: 2, title: "", selected: false },
      { id: 103, lang: "English", code: "eng", codec: "aac", channels: 2, title: "Director\u2019s Commentary", selected: false }
    ];
    it.subs = [
      { id: 201, lang: "English", code: "eng", codec: "srt", forced: false, sdh: true, title: "", display: "English SDH", key: "", selected: false },
      { id: 202, lang: "English", code: "eng", codec: "srt", forced: true, sdh: false, title: "", display: "English Forced", key: "/library/streams/202", external: true, selected: false },
      { id: 203, lang: "Spanish", code: "spa", codec: "pgs", forced: false, sdh: false, title: "", display: "Spanish (PGS)", key: "", selected: false },
      { id: 204, lang: "English", code: "eng", codec: "ass", forced: false, sdh: false, title: "Signs", display: "English Signs (ASS)", key: "", selected: false }
    ];
    it.streamsLoaded = true;
  }

  var myList = [];
  P.listItems = function () { return myList.slice(); };
  P.myList = function () {
    var items = P.listItems();
    return resolve(items.length ? [{ title: "My List", items: items }] : []);
  };
  P.inList = function (it) {
    if (!it) return false;
    for (var i = 0; i < myList.length; i++) if (myList[i].key === it.key) return true;
    return false;
  };
  P.toggleList = function (it) {
    if (P.inList(it)) {
      myList = myList.filter(function (x) { return x.key !== it.key; });
      return resolve(false);
    }
    myList.unshift(it);
    return resolve(true);
  };
  P.syncList = function () { return resolve(); };
  P.subtitleText = function () { return Promise.reject(new Error("preview")); };

  P.playable = function (it) { return resolve(it); };

  P.removeFromContinue = function (it) {
    for (var i = continueRow.length - 1; i >= 0; i--) {
      if (continueRow[i].key === it.key) continueRow.splice(i, 1);
    }
    return resolve({});
  };

  P.selectStreams = function () { return resolve({}); };

  P.sample = { movies: movies, shows: shows, episodes: episodesBy, upNext: upNext };
})();
