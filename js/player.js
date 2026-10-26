/* Player: Samsung AVPlay with direct play, then HLS transcode if the TV
   rejects the file. Play/pause sits under the timeline. Up opens Info.
   The TV plays the file's own audio and does not load a subtitle track.
   In preview mode playback is simulated over a still. */
(function () {
  var A = window.ATV;
  var P = A.Plex;

  var TABS = [
    { id: "info", label: "Info" }
  ];
  var LIST_ROWS = 5;
  var OPT_H = 64;
  /* Text codecs PMS will extract to a file we can paint. Everything else
     in a subtitle stream is an image track and has to be burned. */
  var TEXT_SUB = /^(srt|subrip|ass|ssa|webvtt|vtt|mov_text|tx3g|text|utf-?8|smi|sami|microdvd|sub)$/;
  var IMAGE_SUB = /^(pgs|hdmv_pgs_subtitle|pgssub|vobsub|dvd_subtitle|dvb_subtitle|xsub)$/;
  var DIRECT_AUDIO = /^(aac|ac3|eac3|mp3)$/;
  var STYLE_FIELDS = [
    { key: "font", label: "Font", options: [
      { id: "system", label: "System" },
      { id: "serif", label: "Serif" },
      { id: "mono", label: "Monospace" }
    ] },
    { key: "size", label: "Size", options: [
      { id: "sm", label: "Small" },
      { id: "md", label: "Medium" },
      { id: "lg", label: "Large" },
      { id: "xl", label: "Extra Large" }
    ] },
    { key: "color", label: "Color", options: [
      { id: "white", label: "White" },
      { id: "yellow", label: "Yellow" },
      { id: "cyan", label: "Cyan" },
      { id: "green", label: "Green" }
    ] },
    { key: "bg", label: "Background", options: [
      { id: "shadow", label: "Shadow" },
      { id: "box", label: "Box" },
      { id: "none", label: "None" }
    ] }
  ];
  var AUDIO_NAMES = {
    eac3: "Dolby Digital Plus", ac3: "Dolby Digital", truehd: "Dolby TrueHD", dca: "DTS", dts: "DTS",
    "dca-ma": "DTS-HD MA", aac: "AAC", mp3: "MP3", mp2: "MP2", flac: "FLAC", opus: "Opus", vorbis: "Vorbis", pcm: "PCM"
  };
  var SUB_NAMES = {
    srt: "SRT", subrip: "SRT", ass: "ASS", ssa: "SSA", pgs: "PGS", hdmv_pgs_subtitle: "PGS", vobsub: "VobSub",
    dvd_subtitle: "VobSub", dvb_subtitle: "DVB", mov_text: "Text", webvtt: "WebVTT", vtt: "WebVTT", smi: "SAMI"
  };

  var root, chrome, fill, head, headTime, bar, elapsedEl, remainEl, stateEl, statusEl;
  var panel, tabsEl, infoPane, listPane, listIn, transport, btns, subsEl, subsText;

  var item = null;
  var paused = false;
  var mode = "";            // "direct" | "transcode" | "sim"
  var triedTranscode = false;
  var noDirect = false;     // direct play couldn't honour the chosen audio track
  var session = "";
  var base = 0;             // transcode start offset (ms)
  var relative = null;      // whether AVPlay time is relative to base
  var poll = 0;
  var ticks = 0;
  var hideTimer = 0;
  var stateTimer = 0;
  var scrubTimer = 0;
  var scrubTarget = -1;
  var scrubStart = 0;
  var simPos = 0;
  var lastPos = 0;
  var started = false;
  var buffering = false;
  var barW = 1760;

  var zone = "bar";         // "bar" | "transport" | "tabs" | "list"
  var tab = 0;
  var opt = 0;
  var optTop = 0;
  var opts = [];

  var sel = { audio: 0, sub: 0 };
  var burned = 0;           // subtitle stream burned into the running transcode
  var streamAudio = 0;      // audio stream the running transcode was asked for
  var persisting = null;    // pending PUT /library/parts, awaited before a restart
  var nativeSubs = false;
  var cues = null;          // sidecar or preview cues [{s, e, t}], sorted by start
  var cueTimer = 0;
  var cueClear = 0;
  var cueShown = "";
  var subToken = 0;
  var audioPicked = false;
  var subPicked = false;    // user chose a subtitle this session (image burn is allowed)
  var burnBail = false;     // a burned-in subtitle already failed; don't try twice
  var subStyle = loadStyle();

  function loadStyle() {
    var base = { font: "system", size: "md", color: "white", bg: "shadow" };
    try {
      var o = JSON.parse(localStorage.getItem("atv.subStyle") || "null");
      if (!o) return base;
      for (var k in base) if (o[k]) base[k] = o[k];
    } catch (e) {}
    return base;
  }

  function styleOptions(key) {
    for (var i = 0; i < STYLE_FIELDS.length; i++) if (STYLE_FIELDS[i].key === key) return STYLE_FIELDS[i].options;
    return [];
  }

  function styleLabel(key) {
    var opts = styleOptions(key);
    for (var i = 0; i < opts.length; i++) if (opts[i].id === subStyle[key]) return opts[i].label;
    return opts.length ? opts[0].label : "";
  }

  function av() {
    var w = window.webapis;
    return w && w.avplay ? w.avplay : null;
  }

  function els() {
    if (root) return;
    root = A.$("screen-player");
    chrome = root.querySelector(".p-chrome");
    fill = root.querySelector(".p-fill");
    head = root.querySelector(".p-head");
    bar = root.querySelector(".p-bar");
    elapsedEl = root.querySelector(".p-time.l");
    remainEl = root.querySelector(".p-time.r");
    stateEl = root.querySelector(".p-state");
    statusEl = root.querySelector(".p-status");
    panel = root.querySelector(".p-panel");
    tabsEl = root.querySelector(".p-tabs");
    infoPane = root.querySelector(".p-info-body");
    listPane = root.querySelector(".p-list");
    listIn = root.querySelector(".p-list-in");
    transport = root.querySelector(".p-transport");
    btns = transport.querySelectorAll(".p-btn");
    subsEl = root.querySelector(".p-subs");
    subsText = subsEl.querySelector("span");
  }

  function status(text) {
    statusEl.innerHTML = text ? '<span class="spinner"></span>' + A.esc(text) : "";
  }

  function newSession() {
    return "atv" + Date.now().toString(16) + Math.random().toString(16).slice(2, 6);
  }

  function find(list, id) {
    for (var i = 0; list && i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }
  function curSub() { return item ? find(item.subs, sel.sub) : null; }
  function curAudio() { return item ? find(item.audio, sel.audio) : null; }
  function isImageSub(s) { return !!(s && !s.nativeOnly && IMAGE_SUB.test(s.codec)); }
  /* Burn only after the user picks an image track. A selected PGS/VobSub
     track, or a text track PMS won't extract, must not abandon a stream
     that was already playing. */
  function burnFor(s) { return subPicked && isImageSub(s) ? s.id : 0; }
  function wantDirect() {
    if (subPicked && isImageSub(curSub())) return false;
    if (audioPicked) {
      var a = curAudio();
      if (a && a.codec && !DIRECT_AUDIO.test(a.codec)) return false;
    }
    return P.canDirect(item) && !noDirect;
  }

  /* AVPlay reports PLAYER_ERROR_* for a bad seek or an unsupported
     setSpeed. Those must not tear the video down. */
  function fatalAv(err) {
    var s = String(err || "");
    return !/INVALID_PARAMETER|INVALID_OPERATION|NOT_SUPPORTED|SEEK_FAILED|setSpeed|SEEK/i.test(s);
  }

  /* ---------- Clock ---------- */

  function duration() {
    var d = item && item.duration ? item.duration : 0;
    if (mode !== "sim" && av()) {
      try {
        var x = av().getDuration();
        if (x && !d) d = x;
        if (x && mode === "transcode" && relative && x + base > d) d = x + base;
      } catch (e) {}
    }
    return d;
  }

  /* Position in the file. A transcode started at `offset` may report its
     clock from zero; detect that on the first sample and add the base. */
  function position() {
    if (mode === "sim") return simPos;
    var p = av();
    if (!p) return lastPos;
    var t = 0;
    try { t = p.getCurrentTime(); } catch (e) { return lastPos; }
    if (mode === "transcode" && base > 5000) {
      if (relative === null && t > 0) relative = t + 5000 < base;
      if (relative) t += base;
    }
    lastPos = t;
    return t;
  }

  function paint() {
    var d = duration();
    var now = scrubTarget >= 0 ? scrubTarget : position();
    var pct = d ? Math.max(0, Math.min(1, now / d)) : 0;
    fill.style.transform = "scaleX(" + pct.toFixed(4) + ")";
    head.style.transform = "translate3d(" + Math.round(pct * barW) + "px,0,0)";
    elapsedEl.textContent = A.clock(now);
    remainEl.textContent = "-" + A.clock(Math.max(0, d - now));
  }

  /* ---------- Chrome, zones, panel ---------- */

  function panelOpen() { return zone === "tabs" || zone === "list"; }

  function zoneClasses() {
    var open = panelOpen();
    panel.classList.toggle("on", open);
    root.classList.toggle("panel-open", open);
    bar.classList.toggle("focus", zone === "bar");
    tabsEl.classList.toggle("focus", zone === "tabs");
    listPane.classList.toggle("focus", zone === "list");
    paintBtns();
  }

  function bump() {
    chrome.classList.remove("hide");
    root.classList.remove("chrome-off");
    clearTimeout(hideTimer);
    hideTimer = setTimeout(function () {
      if (paused || panelOpen() || scrubTarget >= 0) return;
      chrome.classList.add("hide");
      root.classList.add("chrome-off");
      if (zone === "transport") { zone = "bar"; zoneClasses(); }
    }, 4500);
  }

  function setZone(z) {
    zone = z;
    if (panelOpen()) paintPanel();
    zoneClasses();
    bump();
  }

  function openPanel(id) {
    tab = 0;
    for (var i = 0; i < TABS.length; i++) if (TABS[i].id === id) tab = i;
    setZone(tab ? "list" : "tabs");
  }

  function paintBtns() {
    btns[0].innerHTML = paused ? A.svg.play : A.svg.pause;
    btns[0].classList.toggle("on", zone === "transport");
    transport.classList.toggle("focus", zone === "transport");
  }

  function flashState(icon, stay) {
    stateEl.innerHTML = icon;
    stateEl.classList.add("on");
    clearTimeout(stateTimer);
    if (!stay) stateTimer = setTimeout(function () { stateEl.classList.remove("on"); }, 700);
  }

  function audioLayout(n) {
    return n === 1 ? "Mono" : n === 2 ? "Stereo" : n === 6 ? "5.1" : n === 8 ? "7.1" : n ? n + " ch" : "";
  }

  function trackLabel(s) {
    if (s.display) return s.display;
    var extra = s.title && s.title !== s.lang ? " \u2013 " + s.title : "";
    return (s.lang || "Unknown") + extra;
  }

  function rows() {
    var id = TABS[tab].id;
    var out = [];
    var i;
    if (id === "subtitles") {
      if (item && !item.streamsLoaded) {
        return [{ id: 0, label: "Loading tracks\u2026", tags: [], detail: "", on: false, inert: true }];
      }
      out.push({ id: 0, label: "Off", tags: [], detail: "", on: !sel.sub });
      var subs = item.subs || [];
      for (i = 0; i < subs.length; i++) {
        var s = subs[i];
        var tags = [];
        if (s.sdh) tags.push("SDH");
        if (s.forced) tags.push("Forced");
        var how = s.external ? "External" : (isImageSub(s) ? "Burned in" : "");
        out.push({
          id: s.id,
          label: trackLabel(s),
          tags: tags,
          detail: [s.display ? (SUB_NAMES[s.codec] || "") : (SUB_NAMES[s.codec] || (s.codec ? s.codec.toUpperCase() : "")), how].filter(Boolean).join(" \u00b7 "),
          on: s.id === sel.sub
        });
      }
      if (!subs.length) out.push({ id: -1, label: "No subtitle tracks", tags: [], detail: "Nothing embedded or alongside the file", on: false, inert: true });
    } else if (id === "audio") {
      if (item && !item.streamsLoaded) {
        return [{ id: 0, label: "Loading tracks\u2026", tags: [], detail: "", on: false, inert: true }];
      }
      var audio = item.audio || [];
      for (i = 0; i < audio.length; i++) {
        var a = audio[i];
        out.push({
          id: a.id,
          label: trackLabel(a),
          tags: [],
          detail: a.display ? "" : [AUDIO_NAMES[a.codec] || (a.codec ? a.codec.toUpperCase() : ""), audioLayout(a.channels)].filter(Boolean).join(" "),
          on: a.id === sel.audio
        });
      }
      if (!out.length) out.push({ id: 0, label: "Original Audio", tags: [], detail: "No alternate tracks", on: true, inert: true });
    } else if (id === "style") {
      for (i = 0; i < STYLE_FIELDS.length; i++) {
        var f = STYLE_FIELDS[i];
        out.push({ id: f.key, label: f.label, tags: [], detail: styleLabel(f.key), on: false, style: true });
      }
    }
    return out;
  }

  function tabLabel(t) {
    if (!item || !item.streamsLoaded) return t.label;
    if (t.id === "subtitles") return "Subtitles (" + (item.subs ? item.subs.length : 0) + ")";
    if (t.id === "audio") return "Audio (" + (item.audio ? item.audio.length : 0) + ")";
    return t.label;
  }

  function paintPanel() {
    var h = "";
    for (var i = 0; i < TABS.length; i++) {
      h += '<div class="season' + (i === tab ? " sel" : "") + '"><span>' + A.esc(tabLabel(TABS[i])) + "</span></div>";
    }
    tabsEl.innerHTML = h;
    paintList(false);
  }

  function paintList(keep) {
    var info = TABS[tab].id === "info";
    infoPane.style.display = info ? "" : "none";
    listPane.style.display = info ? "none" : "";
    if (info) return;
    opts = rows();
    if (!keep) {
      opt = 0;
      optTop = 0;
      for (var j = 0; j < opts.length; j++) if (opts[j].on) opt = j;
    }
    var h = "";
    for (var i = 0; i < opts.length; i++) {
      var o = opts[i];
      h += '<div class="p-opt' + (o.on ? " on" : "") + (i === opt ? " at" : "") + '"><i>' + (o.on ? A.svg.check : "") +
        "</i><span>" + A.esc(o.label) + "</span>";
      for (var t = 0; t < o.tags.length; t++) h += "<em>" + o.tags[t] + "</em>";
      if (o.detail) h += "<small>" + A.esc(o.detail) + "</small>";
      h += "</div>";
    }
    listIn.innerHTML = h;
    listPane.style.height = Math.min(opts.length, LIST_ROWS) * OPT_H + "px";
    scrollList();
  }

  function scrollList() {
    if (opt < optTop) optTop = opt;
    if (opt >= optTop + LIST_ROWS) optTop = opt - LIST_ROWS + 1;
    listIn.style.transform = "translate3d(0," + (-optTop * OPT_H) + "px,0)";
  }

  function moveOpt(d) {
    var next = opt + d;
    if (next < 0 || next >= opts.length) return false;
    var nodes = listIn.children;
    nodes[opt].classList.remove("at");
    opt = next;
    nodes[opt].classList.add("at");
    scrollList();
    return true;
  }

  function fillInfo() {
    var show = item.type === "episode";
    root.querySelector(".p-kicker").textContent = show ? item.showTitle : [item.year, item.rating].filter(Boolean).join(" \u00b7 ");
    root.querySelector(".p-title").textContent = show ? item.label + " \u00b7 " + item.title : item.title;
    var art = root.querySelector(".p-info-art img");
    art.removeAttribute("src");
    A.loadNow(art, item.still || item.card);
    root.querySelector(".p-info-copy h2").textContent = item.title;
    root.querySelector(".p-info-copy .meta").innerHTML = show
      ? A.dots([item.showTitle, item.label, A.dur(item.duration)]) + A.badges(item.badges)
      : A.metaLine(item, true);
    root.querySelector(".p-info-copy .summary").textContent = item.summary || "";
  }

  /* ---------- Subtitle painting ---------- */

  function showCue(text, ms) {
    text = String(text || "").replace(/<[^>]*>/g, "").replace(/\{[^}]*\}/g, "").replace(/^\s+|\s+$/g, "");
    clearTimeout(cueClear);
    if (text && ms) cueClear = setTimeout(function () { showCue(""); }, ms);
    if (text === cueShown) return;
    cueShown = text;
    subsText.textContent = text;
    subsEl.classList.toggle("on", !!text);
  }

  /* AVPlay reports cue duration in microseconds for embedded tracks and
     milliseconds on other paths; 0 means "until the next cue". */
  function nativeCue(dur, text) {
    if (!nativeSubs) return;
    var d = Number(dur) || 0;
    if (d >= 100000) d = Math.round(d / 1000);
    if (d <= 0 || d > 30000) d = 8000;
    showCue(text, d);
  }

  function stamp(h, m, s, f) {
    var ms = Number((String(f) + "00").slice(0, 3));
    return ((h ? parseInt(h, 10) : 0) * 3600 + parseInt(m, 10) * 60 + parseInt(s, 10)) * 1000 + ms;
  }

  function cleanCue(body) {
    return String(body || "")
      .replace(/\\N/gi, "\n").replace(/\\n/g, "\n").replace(/\\h/g, " ")
      .replace(/\{[^}]*\}/g, "").replace(/<[^>]*>/g, "")
      .replace(/^\s+|\s+$/g, "");
  }

  function assStamp(t) {
    var m = /(\d+):(\d{2}):(\d{2})\.(\d{1,3})/.exec(t || "");
    if (!m) return 0;
    var frac = m[4];
    if (frac.length === 1) frac += "00";
    else if (frac.length === 2) frac += "0";
    else frac = frac.slice(0, 3);
    return (parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10)) * 1000 + parseInt(frac, 10);
  }

  function parseAss(text) {
    var out = [];
    var lines = String(text || "").replace(/\r/g, "").split("\n");
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].indexOf("Dialogue:") !== 0) continue;
      var parts = lines[i].slice(9).replace(/^\s+/, "").split(",");
      if (parts.length < 10) continue;
      var body = cleanCue(parts.slice(9).join(","));
      if (!body) continue;
      out.push({ s: assStamp(parts[1]), e: assStamp(parts[2]), t: body });
    }
    return out;
  }

  function parseCues(text) {
    var out = [];
    var re = /(\d+:)?(\d{1,2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d+:)?(\d{1,2}):(\d{2})[,.](\d{1,3})/;
    var blocks = String(text || "").replace(/^\uFEFF/, "").replace(/\r/g, "").split(/\n[ \t]*\n/);
    for (var i = 0; i < blocks.length; i++) {
      var lines = blocks[i].split("\n");
      for (var j = 0; j < lines.length; j++) {
        var m = re.exec(lines[j]);
        if (!m) continue;
        var body = cleanCue(lines.slice(j + 1).join("\n"));
        if (body) out.push({ s: stamp(m[1], m[2], m[3], m[4]), e: stamp(m[5], m[6], m[7], m[8]), t: body });
        break;
      }
    }
    if (!out.length && /Dialogue:/.test(text || "")) out = parseAss(text);
    out.sort(function (a, b) { return a.s - b.s; });
    return out;
  }

  function paintCue() {
    if (!cues || !cues.length) return;
    var t = position();
    var lo = 0, hi = cues.length - 1, last = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (cues[mid].s <= t) { last = mid; lo = mid + 1; } else hi = mid - 1;
    }
    var text = "";
    for (var i = Math.max(0, last - 3); i <= last; i++) {
      if (cues[i].s <= t && t < cues[i].e) text += (text ? "\n" : "") + cues[i].t;
    }
    showCue(text, 0);
  }

  function startCues(list) {
    cues = list;
    clearInterval(cueTimer);
    cueTimer = setInterval(paintCue, 250);
    paintCue();
  }

  function stopCues() {
    cues = null;
    clearInterval(cueTimer);
    cueTimer = 0;
    showCue("");
  }

  /* Preview: a few lines on a loop so the overlay can be seen and styled. */
  var FAKE = {
    sdh: ["[distant thunder]", "We don\u2019t have much time.", "[door creaks open]", "Then we go now. Together.", "[tense music swells]"],
    forced: ["(in Spanish) Where did they take him?", "(in Spanish) Across the river."],
    es: ["No tenemos mucho tiempo.", "Entonces vamos ahora. Juntos.", "\u00bfQui\u00e9n est\u00e1 ah\u00ed?"],
    en: ["We don\u2019t have much time.", "Then we go now. Together.", "Who\u2019s there?"]
  };
  function fakeCues(s) {
    var lines = s.sdh ? FAKE.sdh : s.forced ? FAKE.forced : s.code === "spa" ? FAKE.es : FAKE.en;
    var gap = s.forced ? 15000 : 5000;
    var out = [];
    for (var t = 2000, i = 0; t < (item.duration || 7200000); t += gap, i++) {
      out.push({ s: t, e: t + 3200, t: lines[i % lines.length] });
    }
    return out;
  }

  /* A subtitle that won't parse stays off. Restarting into a burn here is
     what made the TV report that the video could not be played. */
  function dropSub() {
    sel.sub = 0;
    subPicked = false;
    mark(item.subs, 0);
    if (panelOpen()) paintPanel();
    A.toast("Couldn\u2019t load those subtitles.", 3000);
  }

  function loadTextSub(s) {
    var my = ++subToken;
    if (!P.subtitleText) { dropSub(); return; }
    P.subtitleText(s).then(function (text) {
      if (my !== subToken || !item) return;
      var list = parseCues(text);
      if (!list.length) throw new Error("no cues");
      startCues(list);
    }).catch(function () {
      if (my !== subToken || !item) return;
      dropSub();
    });
  }

  /* ---------- Track control ---------- */

  function silent(on) {
    var p = av();
    if (p) { try { p.setSilentSubtitle(on); } catch (e) {} }
  }

  function selectTrack(type, idx) {
    var p = av();
    if (!p) return false;
    try { p.setSelectTrack(type, idx); return true; } catch (e) {}
    if (type === "TEXT") {
      try { p.setSelectTrack("SUBTITLE", idx); return true; } catch (e2) {}
    }
    return false;
  }

  function avTracks(type) {
    var out = [];
    try {
      var info = av().getTotalTrackInfo();
      for (var i = 0; i < info.length; i++) {
        var t = info[i].type;
        if (t === type || (type === "TEXT" && t === "SUBTITLE")) out.push(info[i].index);
      }
    } catch (e) {}
    return out;
  }

  function avCurrent(type) {
    try {
      var cur = av().getCurrentStreamInfo();
      for (var i = 0; i < cur.length; i++) if (cur[i].type === type) return cur[i].index;
    } catch (e) {}
    return -1;
  }

  /* Plex and AVPlay both list a container's audio tracks in file order, so
     the n-th Plex stream is the n-th AVPlay track when the counts agree.
     A stream that already carries avIndex was synthesized from AVPlay. */
  function avIndex(type, s) {
    if (s && s.avIndex !== undefined) return s.avIndex;
    var list = type === "AUDIO" ? item.audio : item.subs;
    var n = list.indexOf(s);
    if (n < 0) return -1;
    var tracks = avTracks(type);
    if (tracks.length === list.length) return tracks[n];
    return -1;
  }

  function switchAudioTrack(idx) {
    var p = av();
    var state = "", at = 0, resumed = false;
    try { state = p.getState(); at = p.getCurrentTime(); } catch (e) {}
    if (state === "PAUSED") {
      try { p.play(); resumed = true; } catch (e2) {}
    }
    try {
      p.setSelectTrack("AUDIO", idx);
    } catch (e3) {
      if (resumed) { try { p.pause(); } catch (e4) {} }
      return false;
    }
    if (at > 1000) { try { p.seekTo(Math.max(0, at - 750)); } catch (e5) {} }
    if (resumed) setTimeout(function () { try { p.pause(); } catch (e6) {} }, 200);
    return true;
  }

  /* Bring the running stream in line with sel.sub. Text is painted from
     the file PMS extracts; false means the burn-in transcode has to restart. */
  function applySub() {
    var s = curSub();
    subToken += 1;
    stopCues();
    nativeSubs = false;
    silent(true);
    if (mode === "sim") {
      if (s) startCues(fakeCues(s));
      return true;
    }
    if (mode === "transcode" && burned !== burnFor(s)) return false;
    if (!s) return true;
    if (s.nativeOnly) {
      var idx = avIndex("TEXT", s);
      nativeSubs = true;
      silent(false);
      if (idx < 0 || !selectTrack("TEXT", idx)) {
        nativeSubs = false;
        silent(true);
      }
      return true;
    }
    if (isImageSub(s)) {
      if (!subPicked) return true;
      return mode === "transcode" && burned === s.id;
    }
    loadTextSub(s);
    return true;
  }

  /* PMS sometimes analyzes a file without listing its streams. AVPlay has
     already opened it by the time this runs, so its track list fills the
     chooser instead of leaving Subtitles and Audio blank. */
  function absorbAvTracks() {
    if (!item || mode === "sim") return;
    var p = av();
    if (!p) return;
    var info = [];
    try { info = p.getTotalTrackInfo() || []; } catch (e) { return; }
    var audio = [], subs = [], ai = 0, si = 0;
    for (var i = 0; i < info.length; i++) {
      var t = info[i];
      if (t.type === "AUDIO") {
        ai += 1;
        audio.push({
          id: 1000 + ai, lang: "Track " + ai, codec: "", channels: 0, title: "",
          display: "Audio " + ai, selected: ai === 1, avIndex: t.index
        });
      } else if (t.type === "TEXT" || t.type === "SUBTITLE") {
        si += 1;
        subs.push({
          id: 2000 + si, lang: "Track " + si, codec: "srt", forced: false, sdh: false,
          title: "", display: "Subtitle " + si, key: "", selected: false,
          avIndex: t.index, nativeOnly: true
        });
      }
    }
    var added = false;
    if ((!item.audio || !item.audio.length) && audio.length) { item.audio = audio; added = true; }
    if ((!item.subs || !item.subs.length) && subs.length) { item.subs = subs; added = true; }
    if (!added) return;
    item.streamsLoaded = true;
    if (!audioPicked) initialSelection(item);
    if (panelOpen()) paintPanel();
  }

  /* Until the user picks a track this session, an unmappable track list
     just means "play what AVPlay chose", not a reason to transcode. */
  function applyAudio() {
    var a = curAudio();
    if (mode === "sim" || !a) return true;
    if (mode === "transcode") return streamAudio === a.id;
    if (item.audio.length < 2) return true;
    var idx = avIndex("AUDIO", a);
    if (idx < 0) return !audioPicked;
    if (avCurrent("AUDIO") === idx) return true;
    return switchAudioTrack(idx);
  }

  function persist(params) {
    persisting = A.src.selectStreams ? A.src.selectStreams(item, params) : null;
  }

  function mark(list, id) {
    for (var i = 0; list && i < list.length; i++) list[i].selected = list[i].id === id;
  }

  /* Reopen at the current position, as direct play when the selection
     allows it, otherwise as a transcode carrying the chosen streams. */
  function restart(why) {
    if (!item || mode === "sim") return;
    var at = started ? position() : (item.resumeAt || 0);
    var old = mode === "transcode" ? session : "";
    started = false;
    status(why || "Switching streams");
    Promise.resolve(persisting).then(function () {
      if (!item) return;
      if (old) P.stopTranscode(old);
      session = newSession();
      if (wantDirect()) {
        mode = "direct";
        triedTranscode = false;
        item.resumeAt = at;
        openAv(P.directUrl(item));
      } else {
        transcode(at);
      }
    });
  }

  function pickSub(id) {
    if (id === sel.sub) return;
    sel.sub = id;
    subPicked = !!id;
    mark(item.subs, id);
    persist({ subtitleStreamID: id || 0 });
    var s = curSub();
    if (mode === "sim" && s && isImageSub(s)) {
      status("Preparing subtitles");
      setTimeout(function () { status(""); }, 1200);
    }
    if (!applySub()) restart(s ? "Preparing subtitles" : "Switching streams");
  }

  function pickAudio(id) {
    if (id === sel.audio) return;
    sel.audio = id;
    audioPicked = true;
    mark(item.audio, id);
    persist({ audioStreamID: id });
    if (applyAudio()) return;
    if (mode === "direct") noDirect = true;
    restart("Switching audio");
  }

  function applySubStyle() {
    if (!subsEl) return;
    subsEl.setAttribute("data-font", subStyle.font);
    subsEl.setAttribute("data-size", subStyle.size);
    subsEl.setAttribute("data-color", subStyle.color);
    subsEl.setAttribute("data-bg", subStyle.bg);
  }

  function cycleStyle(key, dir) {
    var options = styleOptions(key);
    if (!options.length) return;
    var cur = 0;
    for (var i = 0; i < options.length; i++) if (options[i].id === subStyle[key]) cur = i;
    var n = cur + (dir || 1);
    if (n < 0) n = options.length - 1;
    if (n >= options.length) n = 0;
    subStyle[key] = options[n].id;
    try { localStorage.setItem("atv.subStyle", JSON.stringify(subStyle)); } catch (e) {}
    applySubStyle();
    if (!cueShown) showCue("Subtitle preview", 1600);
  }

  function choose() {
    var o = opts[opt];
    if (!o || o.inert) return;
    var id = TABS[tab].id;
    if (id === "subtitles") pickSub(o.id);
    else if (id === "audio") pickAudio(o.id);
    else if (id === "style") cycleStyle(o.id, 1);
    paintList(true);
  }

  /* ---------- AVPlay lifecycle ---------- */

  function startPolling() {
    clearInterval(poll);
    ticks = 0;
    poll = setInterval(function () {
      if (mode === "sim" && !paused) {
        simPos += 500;
        if (simPos >= duration()) simPos = 0;
      }
      paint();
      ticks += 1;
      if (ticks % 20 === 0 && mode !== "sim") P.timeline(item, paused ? "paused" : "playing", position(), session);
    }, 500);
  }

  function openAv(url) {
    var p = av();
    if (!p) { status(""); A.toast("This TV didn\u2019t expose its video player."); return; }
    nativeSubs = false;
    try { p.stop(); } catch (e) {}
    try { p.close(); } catch (e2) {}
    try {
      p.open(url);
    } catch (err) {
      fail("open: " + (err && err.message));
      return;
    }
    try {
      p.setListener({
        onbufferingstart: function () { buffering = true; status("Loading"); },
        onbufferingcomplete: function () { buffering = false; status(""); },
        onstreamcompleted: function () { finish(true); },
        onerror: function (e) { if (fatalAv(e)) fail("runtime: " + e); else A.log("avplay ignored", e); },
        onerrormsg: function (c, m) { if (fatalAv(m || c)) fail("runtime: " + (m || c)); else A.log("avplay ignored", m || c); },
        oncurrentplaytime: function () {},
        onsubtitlechange: nativeCue,
        onevent: function () {}
      });
    } catch (e3) {}
    try { p.onsubtitlechange = nativeCue; } catch (e3b) {}
    try { p.setDisplayRect(0, 0, 1920, 1080); } catch (e4) {}
    try { p.setDisplayMethod("PLAYER_DISPLAY_MODE_LETTER_BOX"); } catch (e5) {}
    var ready = function () {
      if (!item) return;
      try { p.setDisplayRect(0, 0, 1920, 1080); } catch (e6) {}
      try { p.setDisplayMethod("PLAYER_DISPLAY_MODE_LETTER_BOX"); } catch (e7) {}
      silent(true);
      try { p.play(); } catch (e8) {}
      started = true;
      paused = false;
      buffering = false;
      status("");
      if (mode === "direct" && item.resumeAt > 1000) {
        try { p.seekTo(Math.floor(item.resumeAt)); } catch (e9) {}
      }
      paintBtns();
      startPolling();
      P.timeline(item, "playing", position(), session);
    };
    try {
      p.prepareAsync(ready, function (e) { fail("prepare: " + e); });
    } catch (e10) {
      try { p.prepare(); ready(); } catch (e11) { fail("prepare"); }
    }
  }

  function transcode(fromMs) {
    mode = "transcode";
    triedTranscode = true;
    base = Math.max(0, fromMs || 0);
    relative = null;
    burned = 0;
    streamAudio = 0;
    openAv(P.transcodeUrl(item, session, base, {}));
  }

  function fail(why) {
    A.log("playback error", mode, why);
    if (!item) return;
    /* A burned subtitle rejected by the transcoder must not be reported as
       a video that cannot be played. Drop it and open the picture again. */
    if (!burnBail && subPicked && isImageSub(curSub())) {
      burnBail = true;
      subPicked = false;
      sel.sub = 0;
      mark(item.subs, 0);
      burned = 0;
      triedTranscode = false;
      noDirect = false;
      A.toast("That subtitle can\u2019t be shown. Playing without it.", 3500);
      restart();
      return;
    }
    if (mode === "direct" && !triedTranscode) {
      status("Switching to a compatible stream");
      var at = started ? lastPos : item.resumeAt;
      started = false;
      transcode(at);
      return;
    }
    status("");
    A.toast("This video couldn\u2019t be played.", 4000);
    close();
  }

  function finish(completed) {
    if (completed) P.timeline(item, "stopped", duration(), session);
    close(true);
  }

  function close(skipTimeline) {
    clearInterval(poll);
    clearTimeout(hideTimer);
    clearTimeout(scrubTimer);
    poll = 0;
    subToken += 1;
    stopCues();
    nativeSubs = false;
    if (mode !== "sim") {
      var p = av();
      var now = position();
      if (p) {
        try { p.stop(); } catch (e) {}
        try { p.close(); } catch (e2) {}
      }
      if (!skipTimeline) P.timeline(item, "stopped", now, session);
      if (mode === "transcode") P.stopTranscode(session);
      if (item && now > 0) item.offset = now;
    } else if (item) {
      item.offset = simPos;
    }
    document.documentElement.classList.remove("av-on");
    document.documentElement.classList.remove("playing");
    var played = item;
    mode = "";
    session = "";
    item = null;
    A.App.playerClosed(played);
  }

  function seekTo(ms) {
    var d = duration();
    ms = Math.max(0, d ? Math.min(d - 2000, ms) : ms);
    if (mode === "sim") { simPos = ms; return; }
    var p = av();
    if (!p) return;
    var target = mode === "transcode" && relative ? ms - base : ms;
    try { p.seekTo(Math.max(0, Math.floor(target))); } catch (e) {}
  }

  /* Left/right and the remote's seek keys move the playhead, then one
     seekTo lands after the keys settle. AVPlay has no skip API. */
  function scrub(delta) {
    if (scrubTarget < 0) scrubStart = position();
    var from = scrubTarget >= 0 ? scrubTarget : scrubStart;
    var d = duration();
    scrubTarget = Math.max(0, d ? Math.min(d - 2000, from + delta) : from + delta);
    bar.classList.add("scrub");
    paint();
    bump();
    clearTimeout(scrubTimer);
    scrubTimer = setTimeout(function () {
      seekTo(scrubTarget);
      scrubTarget = -1;
      bar.classList.remove("scrub");
      paint();
      bump();
    }, 450);
  }

  function toggle() {
    var p = av();
    if (paused) {
      if (mode !== "sim" && p) { try { p.play(); } catch (e) {} }
      paused = false;
      flashState(A.svg.play);
    } else {
      if (mode !== "sim" && p) { try { p.pause(); } catch (e2) {} }
      paused = true;
      flashState(A.svg.pause, true);
    }
    if (mode !== "sim") P.timeline(item, paused ? "paused" : "playing", position(), session);
    paintBtns();
    bump();
  }

  function initialSelection(it) {
    var i;
    sel = { audio: 0, sub: 0 };
    for (i = 0; it.audio && i < it.audio.length; i++) if (it.audio[i].selected) sel.audio = it.audio[i].id;
    if (!sel.audio && it.audio && it.audio.length) sel.audio = it.audio[0].id;
    for (i = 0; it.subs && i < it.subs.length; i++) {
      if (it.subs[i].selected && !isImageSub(it.subs[i])) sel.sub = it.subs[i].id;
    }
  }

  /* ---------- Keys ---------- */

  function panelKey(k) {
    if (zone === "tabs") {
      if (k === "left" && tab > 0) { tab -= 1; paintPanel(); }
      else if (k === "right" && tab < TABS.length - 1) { tab += 1; paintPanel(); }
      else if (k === "down" || k === "ok") setZone(TABS[tab].id === "info" ? "bar" : "list");
      bump();
      return;
    }
    if (k === "up") { if (!moveOpt(-1)) setZone("tabs"); }
    else if (k === "down") moveOpt(1);
    else if (k === "ok") choose();
    else if ((k === "left" || k === "right") && TABS[tab].id === "style" && opts[opt] && opts[opt].style) {
      cycleStyle(opts[opt].id, k === "right" ? 1 : -1);
      paintList(true);
    } else if (k === "left" && tab > 0) { tab -= 1; setZone("tabs"); }
    else if (k === "right" && tab < TABS.length - 1) { tab += 1; setZone("tabs"); }
    bump();
  }

  A.Player = {
    open: function (it, o) {
      els();
      item = it;
      o = o || {};
      paused = false;
      triedTranscode = false;
      noDirect = false;
      audioPicked = false;
      subPicked = false;
      burnBail = false;
      started = false;
      scrubTarget = -1;
      lastPos = 0;
      persisting = null;
      it.resumeAt = o.resume && A.progress(it) ? it.offset : 0;
      initialSelection(it);
      fillInfo();
      zone = "bar";
      tab = 0;
      zoneClasses();
      barW = bar.clientWidth || 1760;
      showCue("");
      stateEl.classList.remove("on");
      bar.classList.remove("scrub");
      chrome.classList.remove("hide");
      root.classList.remove("chrome-off");
      document.documentElement.classList.add("playing");
      if (A.preview) {
        mode = "sim";
        simPos = it.resumeAt;
        var frame = A.$("pv-frame");
        frame.src = it.frame || it.hero;
        status("");
        paint();
        startPolling();
        bump();
        return;
      }
      document.documentElement.classList.add("av-on");
      session = newSession();
      status("Loading");
      paint();
      bump();
      if (wantDirect()) {
        mode = "direct";
        openAv(P.directUrl(it));
      } else {
        transcode(it.resumeAt);
      }
    },

    openPanel: function (id) { if (item) openPanel(id); },
    showInfo: function () { if (item) openPanel("info"); },

    key: function (k) {
      if (k === "playpause") { toggle(); return; }
      if (k === "play") { if (paused) toggle(); return; }
      if (k === "pause") { if (!paused) toggle(); return; }
      if (k === "stop") { close(); return; }
      if (k === "rew") { scrub(-10000); return; }
      if (k === "ff") { scrub(10000); return; }
      if (k === "back") {
        if (zone !== "bar") { setZone("bar"); return; }
        close();
        return;
      }
      if (panelOpen()) { panelKey(k); return; }
      if (zone === "transport") {
        if (k === "up") { setZone("bar"); return; }
        if (k === "ok") toggle();
        else if (k === "left") scrub(-10000);
        else if (k === "right") scrub(10000);
        bump();
        return;
      }
      if (k === "ok") { toggle(); return; }
      if (k === "left") { scrub(-10000); return; }
      if (k === "right") { scrub(10000); return; }
      if (k === "up") { setZone("tabs"); return; }
      if (k === "down") { setZone("transport"); return; }
      bump();
    }
  };
})();
