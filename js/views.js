/* Screens and focus handling. Each view exposes key(name) and returns
   "up" when focus should leave upward to the tab bar. */
(function () {
  var A = window.ATV;
  var esc = A.esc;
  var PITCH = 392;
  var CARD_W = 352;
  var ROW_H = 366;

  /* ---------- Cards ---------- */

  function capFor(it) {
    var left = A.progress(it) ? A.left(it.offset, it.duration) : "";
    if (it.type === "episode") {
      return { t: it.showTitle || it.title, s: it.label + " \u00b7 " + (left || it.title) };
    }
    if (it.type === "season") return { t: it.showTitle, s: it.title };
    if (it.type === "show") {
      return { t: it.title, s: it.seasonCount ? it.seasonCount + (it.seasonCount === 1 ? " Season" : " Seasons") : String(it.year || "") };
    }
    return { t: it.title, s: left || [it.year, A.dur(it.duration)].filter(function (x) { return x; }).join(" \u00b7 ") };
  }

  /* Cards share one fixed skeleton so off-screen nodes can be recycled for
     other items by updating text, classes and image URLs in place. */
  var SKELETON = '<div class="card-lift"><div class="card-shadow"></div><div class="card-tilt"><div class="card-clip">' +
    '<img class="card-img" alt=""><div class="card-mark"></div><div class="card-name"></div>' +
    '<div class="card-prog"><i></i></div><div class="card-check">' + A.svg.check + '</div>' +
    '<div class="card-rim"></div></div></div></div>';
  var CAP = '<div class="card-cap"><div class="cap-t"></div><div class="cap-s"></div></div>';
  var CAP_EP = '<div class="card-cap"><div class="cap-k"></div><div class="cap-t"></div><div class="cap-d"></div></div>';

  A.makeCard = function (ep, poster) {
    var el = document.createElement("div");
    el.className = "card" + (poster ? " poster" : "");
    el._poster = !!poster;
    el.innerHTML = SKELETON + (ep ? CAP_EP : CAP);
    el._q = {
      img: el.querySelector(".card-img"),
      mark: el.querySelector(".card-mark"),
      name: el.querySelector(".card-name"),
      prog: el.querySelector(".card-prog"),
      bar: el.querySelector(".card-prog i"),
      check: el.querySelector(".card-check"),
      k: el.querySelector(".cap-k"),
      t: el.querySelector(".cap-t"),
      s: el.querySelector(".cap-s") || el.querySelector(".cap-d")
    };
    return el;
  };

  function resetImg(img) {
    img.className = "card-img";
    img.removeAttribute("data-want");
    img.removeAttribute("src");
  }

  /* Point a card node at an item. Refilling with the same item keeps its
     images and focus classes, so a background refresh never flashes. */
  A.fillCard = function (el, it, i, x, y, ep) {
    var q = el._q;
    var same = el._key === it.key;
    var p = A.progress(it);
    var keep = "";
    if (same) {
      var m = el.className.match(/ (focused|from-[lrud])/g);
      if (m) keep = m.join("");
    }
    el.className = "card" + (ep ? " ep" : "") + (el._poster ? " poster" : "") + (p ? " has-prog" : "") + keep;
    el.setAttribute("data-i", i);
    el.style.left = x + "px";
    el.style.top = (y || 0) + "px";
    if (!same || el._img !== it.card) resetImg(q.img);
    el._key = it.key;
    el._img = it.card;
    /* Artwork already carries its own title treatment, so nothing is drawn
       over it; the name only surfaces when the art never arrives. */
    q.name.textContent = it.type === "episode" || it.type === "season" ? it.showTitle : it.title;
    q.prog.style.display = p ? "" : "none";
    if (p) q.bar.style.width = (p * 100).toFixed(1) + "%";
    q.check.style.display = ep && it.watched && !p ? "" : "none";
    if (ep) {
      var k = "Episode " + it.index + (it.duration ? " \u00b7 " + A.dur(it.duration) : "");
      if (p) k += " \u00b7 " + A.left(it.offset, it.duration);
      q.k.textContent = k;
      q.t.textContent = it.title;
      q.s.textContent = it.summary || "";
    } else {
      var c = capFor(it);
      q.t.textContent = c.t;
      q.s.textContent = c.s;
    }
  };

  A.loadCard = function (el, it, still) {
    if (!el || !it) return;
    var url = el._poster ? (it.poster || it.card) : (still ? it.still || it.card : it.card);
    A.loadImg(el._q.img, url);
  };

  function sigOf(items) {
    var s = "";
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      s += it.key + ":" + Math.round((it.offset || 0) / 10000) + ":" + (it.watched ? 1 : 0) + ":" + it.title + ":" + (it.poster || it.card) + "|";
    }
    return s;
  }
  A.sigOf = sigOf;

  /* A card that is already focused keeps its running animation rather than
     forcing a synchronous reflow to restart it. */
  var DIRS = ["from-l", "from-r", "from-u", "from-d"];
  A.focusCard = function (el, dir) {
    if (!el || el.classList.contains("focused")) return;
    for (var i = 0; i < DIRS.length; i++) el.classList.remove(DIRS[i]);
    el.classList.add("from-" + (dir || "r"));
    el.classList.add("focused");
  };
  A.blurCard = function (el) {
    if (el) el.classList.remove("focused");
  };

  /* ---------- Horizontal row (virtualized) ---------- */

  /* About 4.5 cards are visible; keep two spare on each side. */
  var WIN_BEFORE = 3;
  var WIN_AFTER = 8;

  function Row(el, items, opts) {
    opts = opts || {};
    this.el = el;
    this.items = items;
    this.track = el.querySelector(".track");
    this.col = 0;
    this.first = 0;
    this.still = !!opts.still;
    this.ep = !!opts.ep;
    this.focused = false;
    this.nodes = {};
    this.pool = [];
    this.sig = sigOf(items);
  }
  A.Row = Row;

  Row.prototype.card = function (i) { return this.nodes[i] || null; };

  Row.prototype.render = function () {
    var n = this.items.length;
    var base = Math.floor(this.offsetX() / PITCH);
    var lo = Math.max(0, base - WIN_BEFORE);
    var hi = Math.min(n, base + WIN_AFTER);
    var k, i, el;
    for (k in this.nodes) {
      if (!this.nodes.hasOwnProperty(k)) continue;
      i = +k;
      if (i < lo || i >= hi) {
        el = this.nodes[k];
        el.classList.remove("focused");
        this.track.removeChild(el);
        this.pool.push(el);
        delete this.nodes[k];
      }
    }
    for (i = lo; i < hi; i++) {
      if (this.nodes[i]) continue;
      el = this.pool.pop() || A.makeCard(this.ep);
      A.fillCard(el, this.items[i], i, 80 + i * PITCH, 0, this.ep);
      this.track.appendChild(el);
      this.nodes[i] = el;
      A.loadCard(el, this.items[i], this.still);
    }
    var warm = [];
    for (i = hi; i < Math.min(n, hi + 3); i++) warm.push(this.still ? this.items[i].still || this.items[i].card : this.items[i].card);
    if (warm.length) A.warm(warm);
  };

  /* Focus moves freely between the 2nd and 4th visible slots; past that the
     row scrolls, keeping a neighbour peeking on each side. */
  Row.prototype.layout = function () {
    if (this.col - this.first > 3) this.first = this.col - 3;
    if (this.col - this.first < 1) this.first = Math.max(0, this.col - 1);
    this.track.style.transform = "translate3d(" + (-this.offsetX()) + "px,0,0)";
    this.render();
  };

  Row.prototype.focus = function (dir) {
    this.focused = true;
    this.layout();
    A.focusCard(this.card(this.col), dir);
  };

  Row.prototype.blur = function () {
    this.focused = false;
    A.blurCard(this.card(this.col));
  };

  Row.prototype.move = function (d) {
    var next = this.col + d;
    if (next < 0 || next >= this.items.length) return false;
    A.blurCard(this.card(this.col));
    this.col = next;
    this.focus(d > 0 ? "r" : "l");
    return true;
  };

  Row.prototype.item = function () { return this.items[this.col]; };

  /* Swap in fresh items without rebuilding: nodes are refilled where they
     stand and focus stays on the same title if it is still in the row. */
  Row.prototype.update = function (items) {
    var sig = sigOf(items);
    if (sig === this.sig) { this.items = items; return false; }
    this.sig = sig;
    var cur = this.card(this.col);
    var key = cur ? cur._key : "";
    var at = -1;
    for (var i = 0; i < items.length; i++) if (items[i].key === key) { at = i; break; }
    var oldCol = this.col;
    this.items = items;
    if (at >= 0) {
      this.col = at;
      this.first = Math.max(0, this.first + (at - oldCol));
    } else {
      this.col = Math.max(0, Math.min(this.col, items.length - 1));
    }
    var nodes = this.nodes;
    this.nodes = {};
    var spare = [];
    for (var k in nodes) {
      if (!nodes.hasOwnProperty(k)) continue;
      var el = nodes[k];
      var idx = -1;
      for (var j = 0; j < items.length; j++) if (items[j].key === el._key) { idx = j; break; }
      if (idx >= 0 && !this.nodes[idx]) {
        A.fillCard(el, items[idx], idx, 80 + idx * PITCH, 0, this.ep);
        this.nodes[idx] = el;
      } else {
        spare.push(el);
      }
    }
    for (var s = 0; s < spare.length; s++) {
      spare[s].classList.remove("focused");
      this.track.removeChild(spare[s]);
      this.pool.push(spare[s]);
    }
    this.layout();
    for (var n in this.nodes) {
      if (this.nodes.hasOwnProperty(n) && +n !== this.col) this.nodes[n].classList.remove("focused");
    }
    if (this.focused) {
      var f = this.card(this.col);
      if (f && !f.classList.contains("focused")) A.focusCard(f, "r");
    }
    return true;
  };

  Row.prototype.offsetX = function () {
    var maxX = Math.max(0, (this.items.length - 1) * PITCH + CARD_W - 1760);
    return Math.min(this.first * PITCH, maxX);
  };

  /* Vertical moves land on the card closest on screen, like the tvOS focus
     engine, rather than a remembered column. */
  Row.prototype.screenX = function () { return this.col * PITCH - this.offsetX(); };

  Row.prototype.aim = function (x) {
    var best = 0, dist = 1e9;
    for (var i = 0; i < this.items.length; i++) {
      var d = Math.abs(i * PITCH - this.offsetX() - x);
      if (d < dist) { dist = d; best = i; }
    }
    this.col = best;
  };

  function rowShell(title) {
    return '<div class="row"><div class="row-title">' + esc(title) + '</div><div class="track"></div></div>';
  }

  /* ---------- Hero copy (shared by browse + detail) ---------- */

  function metaLine(it, withBadges) {
    var parts;
    if (it.type === "episode") {
      parts = [it.label, it.title, A.progress(it) ? A.left(it.offset, it.duration) : A.dur(it.duration)];
    } else if (it.type === "show") {
      parts = [it.year, it.rating, it.seasonCount ? it.seasonCount + (it.seasonCount === 1 ? " Season" : " Seasons") : "", it.score ? String(it.score) : "", it.genres && it.genres[0]];
    } else {
      parts = [it.year, it.rating, A.progress(it) ? A.left(it.offset, it.duration) : A.dur(it.duration), it.score ? String(it.score) : "", it.genres && it.genres[0]];
    }
    var html = A.dots(parts);
    if (withBadges && it.badges && it.badges.length) html += A.badges(it.badges);
    return html;
  }
  A.metaLine = metaLine;

  /* Titles stay in the system font. The clearLogo artwork is a second
     image per title and was the slow part of moving between items. */
  function setLogo(img, titleEl, it) {
    var name = it.type === "episode" || it.type === "season" ? it.showTitle : it.title;
    titleEl.textContent = name;
    titleEl.className = "big-title";
    img.className = "logo gone";
    img.onload = null;
    img.onerror = null;
    img.removeAttribute("data-want");
    img.removeAttribute("src");
  }
  A.setLogo = setLogo;

  /* ---------- Browse: Watch Now / Movies / TV Shows ---------- */

  function Browse() {
    this.root = A.$("screen-browse");
    this.bd = new A.Backdrop(this.root.querySelector(".bd"));
    this.heroEl = this.root.querySelector(".hero");
    this.logo = this.root.querySelector(".hero .logo");
    this.titleEl = this.root.querySelector(".hero .big-title");
    this.metaEl = this.root.querySelector(".hero .meta");
    this.sumEl = this.root.querySelector(".hero .summary");
    this.rowsEl = this.root.querySelector(".rows");
    this.emptyEl = this.root.querySelector(".empty");
    this.rows = [];
    this.r = 0;
    this.focused = false;
    this.heroKey = "";
    this.states = {};
    this.tab = "";
  }

  Browse.prototype.load = function (tab, rows) {
    if (this.tab && this.rows.length) {
      this.states[this.tab] = { r: this.r, cols: this.rows.map(function (row) { return [row.col, row.first]; }) };
    }
    this.tab = tab;
    this.titles = [];
    var html = "";
    for (var r = 0; r < rows.length; r++) {
      html += rowShell(rows[r].title);
      this.titles.push(rows[r].title);
    }
    A.flushImages();
    this.rowsEl.innerHTML = html;
    this.emptyEl.textContent = tab === "list"
      ? "Your list is empty. Add a movie or show from its page."
      : "Nothing here yet.";
    this.emptyEl.style.display = rows.length ? "none" : "block";
    var els = this.rowsEl.children;
    this.rows = [];
    for (var i = 0; i < rows.length; i++) this.rows.push(new Row(els[i], rows[i].items));
    var st = this.states[tab];
    this.r = st && st.r < this.rows.length ? st.r : 0;
    for (var j = 0; j < this.rows.length; j++) {
      if (st && st.cols[j]) { this.rows[j].col = Math.min(st.cols[j][0], this.rows[j].items.length - 1); this.rows[j].first = st.cols[j][1]; }
      this.rows[j].layout();
    }
    this.place();
    this.heroKey = "";
    var it = this.current();
    if (it) this.hero(it, true);
    else { this.bd.clear(); this.heroEl.style.display = "none"; }
    if (this.focused) this.focus("d");
  };

  /* Background refresh landed: patch rows in place. Only a change in the
     set of rows themselves falls back to a rebuild (focus is restored). */
  Browse.prototype.update = function (tab, rows) {
    if (tab !== this.tab) return;
    var same = rows.length === this.rows.length;
    for (var i = 0; same && i < rows.length; i++) if (this.titles[i] !== rows[i].title) same = false;
    if (!same) { this.load(tab, rows); return; }
    var changed = false;
    for (var r = 0; r < rows.length; r++) if (this.rows[r].update(rows[r].items)) changed = true;
    if (!changed) return;
    var it = this.current();
    if (!it) return;
    if (it.key === this.heroKey) this.metaEl.innerHTML = metaLine(it, true);
    else this.hero(it);
  };

  /* Prefetch what the next keypress is likely to reveal: the next row's
     visible cards and the right-hand neighbour's backdrop. */
  Browse.prototype.warm = function () {
    var urls = [];
    var row = this.rows[this.r];
    var next = this.rows[this.r + 1];
    if (next) {
      for (var i = next.first; i < Math.min(next.items.length, next.first + 5); i++) urls.push(next.items[i].card);
    }
    if (row && row.items[row.col + 1]) urls.push(row.items[row.col + 1].hero);
    A.warm(urls);
  };

  Browse.prototype.loading = function () {
    this.rowsEl.innerHTML = "";
    this.rows = [];
    this.emptyEl.style.display = "none";
  };

  Browse.prototype.current = function () {
    var row = this.rows[this.r];
    return row ? row.item() : null;
  };

  Browse.prototype.place = function () {
    this.rowsEl.style.transform = "translate3d(0," + (-this.r * ROW_H) + "px,0)";
    for (var i = 0; i < this.rows.length; i++) this.rows[i].el.classList.toggle("above", i < this.r);
    A.App.navAway(this.focused && this.r > 0);
  };

  Browse.prototype.hero = function (it, now) {
    if (!it) return;
    this.bd.set(it.hero, now, it.blur);
    if (this.heroKey === it.key) return;
    this.heroKey = it.key;
    this.heroEl.style.display = "block";
    setLogo(this.logo, this.titleEl, it);
    this.metaEl.innerHTML = metaLine(it, true);
    this.sumEl.textContent = it.summary || "";
    /* Two identical keyframe sets restart the fade without a forced reflow. */
    this.swapAlt = !this.swapAlt;
    this.heroEl.classList.remove(this.swapAlt ? "swap-b" : "swap-a");
    this.heroEl.classList.add(this.swapAlt ? "swap-a" : "swap-b");
  };

  Browse.prototype.focus = function (dir) {
    this.focused = true;
    var row = this.rows[this.r];
    if (row) row.focus(dir || "d");
    this.place();
    this.hero(this.current());
    this.warm();
  };

  Browse.prototype.blur = function () {
    this.focused = false;
    var row = this.rows[this.r];
    if (row) row.blur();
    this.place();
  };

  Browse.prototype.key = function (k) {
    var row = this.rows[this.r];
    if (!row) return k === "up" || k === "back" ? "up" : "";
    if (k === "left" || k === "right") {
      if (row.move(k === "left" ? -1 : 1)) { this.hero(row.item()); this.warm(); }
    } else if (k === "up") {
      if (this.r === 0) return "up";
      row.blur();
      this.r -= 1;
      this.rows[this.r].aim(row.screenX());
      this.focus("u");
    } else if (k === "down") {
      if (this.r >= this.rows.length - 1) return "";
      row.blur();
      this.r += 1;
      this.rows[this.r].aim(row.screenX());
      this.focus("d");
    } else if (k === "ok") {
      A.App.select(row.item());
    } else if (k === "back") {
      return "up";
    }
    return "";
  };

  /* ---------- Library: sidebar of sections + 16:9 grid ---------- */

  var GRID_COLS = 5;
  var GRID_PX = 248;
  var GRID_PY = 430;
  var PAGE = 50;

  function Library() {
    this.root = A.$("screen-library");
    this.bd = new A.Backdrop(this.root.querySelector(".bd"), 450);
    this.side = this.root.querySelector(".side");
    this.listEl = this.root.querySelector(".side-list");
    this.grid = this.root.querySelector(".grid");
    this.gridTitle = this.root.querySelector(".grid-title");
    this.sections = [];
    this.sel = 0;
    this.items = [];
    this.total = 0;
    this.i = 0;
    this.zone = "grid";
    this.focused = false;
    this.fetching = false;
    this.timer = 0;
    this.token = 0;
    this.nodes = {};
    this.pool = [];
  }

  Library.prototype.load = function (sections) {
    this.sections = sections.slice(0);
    this.sections.push({ key: "_signout", title: "Sign Out", type: "action" });
    var h = "";
    for (var i = 0; i < this.sections.length; i++) {
      h += '<div class="side-item" data-i="' + i + '"><span>' + esc(this.sections[i].title) + '</span><span class="count"></span></div>';
    }
    this.listEl.innerHTML = h;
    this.paintSide();
    if (this.sections.length > 1) this.openSection(this.sel);
  };

  Library.prototype.paintSide = function () {
    var kids = this.listEl.children;
    for (var i = 0; i < kids.length; i++) kids[i].classList.toggle("sel", i === this.sel);
    this.side.classList.toggle("focus", this.focused && this.zone === "side");
  };

  Library.prototype.cardAt = function (i) { return this.nodes[i] || null; };

  Library.prototype.resetGrid = function () {
    this.grid.innerHTML = "";
    this.nodes = {};
    this.pool = [];
  };

  function gridX(i) { return (i % GRID_COLS) * GRID_PX; }
  function gridY(i) { return Math.floor(i / GRID_COLS) * GRID_PY; }

  /* Only rows near the viewport have nodes; the rest are recycled. */
  Library.prototype.render = function (first, last) {
    var k, i, el;
    for (k in this.nodes) {
      if (!this.nodes.hasOwnProperty(k)) continue;
      i = +k;
      if (i < first || i >= last) {
        el = this.nodes[k];
        el.classList.remove("focused");
        this.grid.removeChild(el);
        this.pool.push(el);
        delete this.nodes[k];
      }
    }
    for (i = first; i < last; i++) {
      if (this.nodes[i]) continue;
      el = this.pool.pop() || A.makeCard(false, true);
      A.fillCard(el, this.items[i], i, gridX(i), gridY(i), false);
      this.grid.appendChild(el);
      this.nodes[i] = el;
      A.loadCard(el, this.items[i]);
    }
  };

  /* Paint a section's first page, from the snapshot or the network.
     Refilling keeps nodes whose item is unchanged, so a revalidation that
     differs only slightly doesn't flash the grid. */
  Library.prototype.firstPage = function (page, i) {
    this.total = page.total;
    var count = this.listEl.children[i] && this.listEl.children[i].querySelector(".count");
    if (count) count.textContent = page.total ? String(page.total) : "";
    this.items = page.items.slice(0);
    for (var k in this.nodes) {
      if (!this.nodes.hasOwnProperty(k)) continue;
      var n = +k;
      if (this.items[n]) A.fillCard(this.nodes[k], this.items[n], n, gridX(n), gridY(n), false);
    }
    this.i = Math.max(0, Math.min(this.i, this.items.length - 1));
    this.place();
    if (this.focused && this.zone === "grid") this.focusGrid("d");
    else if (this.items[0]) this.bd.set(this.items[0].blur, true);
  };

  Library.prototype.openSection = function (i) {
    var self = this;
    var sec = this.sections[i];
    if (!sec || sec.type === "action") return;
    var token = ++this.token;
    this.items = [];
    this.total = 0;
    this.i = 0;
    this.resetGrid();
    this.gridTitle.textContent = sec.title;
    var name = "sec:" + sec.key;
    var hit = A.Cache.get(name);
    if (hit && hit.d && hit.d.items) { this.firstPage(hit.d, i); return; }
    hit = null;
    this.fetching = true;
    A.src.sectionItems(sec, 0, PAGE).then(function (page) {
      if (token !== self.token) return;
      self.fetching = false;
      A.Cache.put(name, page);
      if (hit && A.sigOf(page.items) === A.sigOf(self.items.slice(0, page.items.length))) {
        self.total = page.total;
        self.place();
        return;
      }
      self.firstPage(page, i);
    }, function () {
      if (token !== self.token) return;
      self.fetching = false;
      if (!hit) A.toast("Couldn\u2019t load " + sec.title + ".");
    });
  };

  Library.prototype.append = function (list) {
    this.items = this.items.concat(list);
  };

  Library.prototype.place = function () {
    var gr = Math.floor(this.i / GRID_COLS);
    var top = Math.max(0, gr - 1);
    this.grid.style.transform = "translate3d(0," + (-top * GRID_PY) + "px,0)";
    this.gridTitle.classList.toggle("away", top > 0);
    A.App.navAway(this.focused && gr > 0 && this.zone === "grid");
    var first = Math.max(0, (top - 1) * GRID_COLS);
    var last = Math.min(this.items.length, (top + 4) * GRID_COLS);
    this.render(first, last);
    var warm = [];
    for (var w = last; w < Math.min(this.items.length, last + GRID_COLS); w++) warm.push(this.items[w].poster || this.items[w].card);
    if (warm.length) A.warm(warm);
    if (!this.fetching && this.items.length < this.total && last >= this.items.length - GRID_COLS * 2) this.more();
  };

  Library.prototype.more = function () {
    var self = this;
    var sec = this.sections[this.sel];
    var token = this.token;
    this.fetching = true;
    A.src.sectionItems(sec, this.items.length, PAGE).then(function (page) {
      if (token !== self.token) return;
      self.fetching = false;
      if (page.items.length) { self.append(page.items); self.place(); }
    }, function () { self.fetching = false; });
  };

  Library.prototype.focusGrid = function (dir) {
    if (!this.items[this.i]) return;
    this.place();
    A.focusCard(this.cardAt(this.i), dir);
    this.bd.set(this.items[this.i].blur);
  };

  Library.prototype.focus = function (dir) {
    this.focused = true;
    if (!this.items.length) this.zone = "side";
    if (this.zone === "grid") this.focusGrid(dir || "d");
    this.paintSide();
  };

  Library.prototype.blur = function () {
    this.focused = false;
    A.blurCard(this.cardAt(this.i));
    this.paintSide();
    A.App.navAway(false);
  };

  Library.prototype.key = function (k) {
    var self = this;
    if (k === "back") return "up";
    if (this.zone === "side") {
      if (k === "up") {
        if (this.sel === 0) return "up";
        this.sel -= 1;
      } else if (k === "down") {
        if (this.sel >= this.sections.length - 1) return "";
        this.sel += 1;
      } else if (k === "right") {
        if (!this.items.length) return "";
        this.zone = "grid";
        this.focusGrid("r");
        this.paintSide();
        return "";
      } else if (k === "ok") {
        if (this.sections[this.sel].type === "action") A.App.signOut();
        return "";
      } else {
        return "";
      }
      this.paintSide();
      clearTimeout(this.timer);
      if (this.sections[this.sel].type !== "action") {
        this.timer = setTimeout(function () { self.openSection(self.sel); }, 260);
      }
      return "";
    }
    var i = this.i;
    var col = i % GRID_COLS;
    if (k === "left") {
      if (col === 0) {
        A.blurCard(this.cardAt(i));
        this.zone = "side";
        this.paintSide();
        A.App.navAway(false);
        return "";
      }
      i -= 1;
    } else if (k === "right") {
      if (col === GRID_COLS - 1 || i + 1 >= this.items.length) return "";
      i += 1;
    } else if (k === "up") {
      if (i < GRID_COLS) return "up";
      i -= GRID_COLS;
    } else if (k === "down") {
      if (i + GRID_COLS >= this.items.length) {
        var lastRow = Math.floor((this.items.length - 1) / GRID_COLS);
        if (Math.floor(i / GRID_COLS) >= lastRow) return "";
        i = this.items.length - 1;
      } else {
        i += GRID_COLS;
      }
    } else if (k === "ok") {
      A.App.select(this.items[i]);
      return "";
    } else {
      return "";
    }
    A.blurCard(this.cardAt(this.i));
    var dir = k === "left" ? "l" : k === "right" ? "r" : k === "up" ? "u" : "d";
    this.i = i;
    this.focusGrid(dir);
    return "";
  };

  /* ---------- Search: the TV's own keyboard (IME) + voice ---------- */

  /* Focusing a real <input> is what raises the Samsung IME, and the mic
     button lives on that panel, so the field is both the keyboard and the
     way in to voice search. Nothing here draws its own keys. */
  function Search() {
    this.root = A.$("screen-search");
    this.bd = new A.Backdrop(this.root.querySelector(".bd"), 450);
    this.bar = this.root.querySelector(".search-bar");
    this.box = this.root.querySelector(".search-box");
    this.input = A.$("search-input");
    this.voice = this.root.querySelector(".search-voice");
    this.rowsEl = this.root.querySelector(".rows");
    this.hint = this.root.querySelector(".search-hint");
    this.q = "";
    this.zone = "field";
    this.rows = [];
    this.r = 0;
    this.focused = false;
    this.editing = false;
    this.timer = 0;
    this.token = 0;
    this.suggest = null;
    this.box.querySelector(".search-ico").innerHTML = A.svg.search;
    this.voice.querySelector(".voice-ico").innerHTML = A.svg.mic;
    this.bind();
    this.paintBar();
  }

  Search.prototype.bind = function () {
    var self = this;
    this.input.addEventListener("input", function () { self.changed(); });
    this.input.addEventListener("change", function () { self.changed(); });
    this.input.addEventListener("focus", function () { self.editing = true; self.paintBar(); });
    this.input.addEventListener("blur", function () { self.editing = false; self.paintBar(); });
    /* 65376 is the IME's Done key and 65385 its Cancel; both close the
       panel. Every other key has to reach the field untouched, so this
       listener never calls preventDefault. */
    this.input.addEventListener("keydown", function (e) {
      var c = e.keyCode;
      if (c === 65376 || c === 65385 || c === 10009 || c === 27) { self.input.blur(); return; }
      if (c === 13) { self.input.blur(); self.run(); return; }
      if (c === 40) { self.input.blur(); self.toRows(); }
    });
  };

  /* Raise the TV keyboard. Some firmware only opens it on a click of the
     field, so a focus that didn't take is retried that way. */
  Search.prototype.openIme = function () {
    var self = this;
    try { this.input.focus(); } catch (e) {}
    setTimeout(function () {
      if (document.activeElement === self.input) return;
      try { self.input.click(); self.input.focus(); } catch (e2) {}
    }, 0);
  };

  Search.prototype.startVoice = function () {
    var self = this;
    this.zone = "field";
    this.paintBar();
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SR) {
      var rec = new SR();
      rec.lang = "en-US";
      rec.interimResults = false;
      rec.onresult = function (e) {
        var said = e.results && e.results[0] && e.results[0][0] ? e.results[0][0].transcript : "";
        if (!said) return;
        self.input.value = said;
        self.changed();
        self.run();
      };
      rec.onerror = function () { self.openIme(); };
      try { rec.start(); A.toast("Listening\u2026", 2500); return; } catch (e3) {}
    }
    /* Tizen web apps have no dictation API. The TV keyboard's microphone
       (and the remote mic key, which lands here) is the supported path. */
    A.toast("Use the microphone on the keyboard.", 3200);
    this.openIme();
  };

  Search.prototype.changed = function () {
    var v = this.input.value || "";
    if (v === this.q) return;
    this.q = v;
    this.schedule();
  };

  Search.prototype.paintBar = function () {
    this.box.classList.toggle("on", this.focused && this.zone === "field");
    this.box.classList.toggle("editing", this.editing);
    this.voice.classList.toggle("on", this.focused && this.zone === "voice");
    this.bar.classList.toggle("dim", this.focused && this.zone === "rows");
  };

  /* Preview routes (?q=) and a connected keyboard both type through here. */
  Search.prototype.type = function (ch) {
    this.input.value = ch === null ? this.input.value.slice(0, -1) : this.input.value + ch;
    this.changed();
  };

  Search.prototype.toRows = function () {
    if (!this.rows.length) return;
    this.zone = "rows";
    this.r = 0;
    this.place();
    this.rows[0].focus("d");
    this.paintBar();
  };

  Search.prototype.schedule = function () {
    var self = this;
    clearTimeout(this.timer);
    this.timer = setTimeout(function () { self.run(); }, 420);
  };

  Search.prototype.run = function () {
    var self = this;
    var q = this.q.replace(/^\s+|\s+$/g, "");
    var token = ++this.token;
    if (!q) { this.showSuggestions(); return; }
    A.src.search(q).then(function (rows) {
      if (token !== self.token) return;
      self.render(rows, rows.length ? "" : "No results for \u201c" + q + "\u201d");
    }, function () {
      if (token !== self.token) return;
      self.render([], "Search isn\u2019t available right now.");
    });
  };

  Search.prototype.showSuggestions = function () {
    var self = this;
    var token = this.token;
    var snap = A.Cache.get("watch");
    var p = this.suggest || (snap ? Promise.resolve(snap.d) : A.src.home());
    this.suggest = p;
    p.then(function (rows) {
      if (token !== self.token || self.q) return;
      var keep = rows.filter(function (r) { return r.title !== "Continue Watching"; }).slice(0, 2);
      self.render(keep, keep.length ? "" : "Search your Plex library.");
    }, function () { self.render([], "Search your Plex library."); });
  };

  Search.prototype.render = function (rows, hint) {
    var html = "";
    for (var r = 0; r < rows.length; r++) {
      html += rowShell(rows[r].title);
    }
    this.rowsEl.innerHTML = html;
    this.hint.textContent = hint || "";
    this.rows = [];
    for (var i = 0; i < rows.length; i++) {
      var row = new Row(this.rowsEl.children[i], rows[i].items);
      row.layout();
      this.rows.push(row);
    }
    this.r = 0;
    this.place();
    if (this.zone === "rows") {
      if (this.rows.length) this.rows[0].focus("d");
      else { this.zone = "field"; this.paintBar(); }
    }
    var first = this.rows[0] && this.rows[0].item();
    if (first) this.bd.set(first.blur);
  };

  Search.prototype.place = function () {
    this.rowsEl.style.transform = "translate3d(0," + (-this.r * ROW_H) + "px,0)";
    for (var i = 0; i < this.rows.length; i++) this.rows[i].el.classList.toggle("above", i < this.r);
  };

  Search.prototype.focus = function () {
    this.focused = true;
    if (this.zone === "rows" && !this.rows.length) this.zone = "field";
    this.paintBar();
    if (this.zone === "field") this.openIme();
    if (!this.rows.length && !this.q) this.showSuggestions();
  };

  Search.prototype.blur = function () {
    this.focused = false;
    if (this.editing) this.input.blur();
    var row = this.rows[this.r];
    if (row) row.blur();
    this.paintBar();
  };

  Search.prototype.key = function (k, ch) {
    if (k === "char") {
      if (this.zone !== "field") { this.zone = "field"; this.paintBar(); }
      this.type(ch);
      this.openIme();
      return "";
    }
    if (k === "delete") {
      this.type(null);
      return "";
    }
    if (this.zone === "field" || this.zone === "voice") {
      if (k === "up" || k === "back") return "up";
      if (k === "left" && this.zone === "voice") { this.zone = "field"; this.paintBar(); }
      else if (k === "right" && this.zone === "field") { this.zone = "voice"; this.paintBar(); }
      else if (k === "ok") { if (this.zone === "voice") this.startVoice(); else this.openIme(); }
      else if (k === "down") this.toRows();
      return "";
    }
    var row = this.rows[this.r];
    if (k === "left" || k === "right") {
      if (row.move(k === "left" ? -1 : 1)) this.bd.set(row.item().blur);
    } else if (k === "up" || k === "back") {
      row.blur();
      if (this.r === 0 || k === "back") {
        this.r = 0;
        this.zone = "field";
        this.paintBar();
      } else {
        this.r -= 1;
        this.rows[this.r].aim(row.screenX());
        this.rows[this.r].focus("u");
      }
      this.place();
    } else if (k === "down") {
      if (this.r < this.rows.length - 1) {
        row.blur();
        this.r += 1;
        this.rows[this.r].aim(row.screenX());
        this.rows[this.r].focus("d");
        this.place();
      }
    } else if (k === "ok") {
      A.App.select(row.item());
    }
    return "";
  };

  /* ---------- Detail (movie / show product page) ---------- */

  function Detail() {
    this.root = A.$("screen-detail");
    this.page = this.root.querySelector(".detail-page");
    this.bd = new A.Backdrop(this.root.querySelector(".bd-main"), 0);
    this.bdBlur = new A.Backdrop(this.root.querySelector(".bd-blur"), 0);
    this.logo = this.root.querySelector(".d-copy .logo");
    this.titleEl = this.root.querySelector(".d-copy .big-title");
    this.metaEl = this.root.querySelector(".d-copy .meta");
    this.sumEl = this.root.querySelector(".d-copy .summary");
    this.peopleEl = this.root.querySelector(".d-people");
    this.btnsEl = this.root.querySelector(".buttons");
    this.mini = this.root.querySelector(".d-mini");
    this.seasonsEl = this.root.querySelector(".d-seasons");
    this.epsEl = this.root.querySelector(".d-episodes");
    this.infoEl = this.root.querySelector(".d-info");
    this.item = null;
    this.zone = "buttons";
    this.b = 0;
    this.buttons = [];
    this.seasons = [];
    this.s = 0;
    this.row = null;
    this.token = 0;
    this.focusEp = null;
  }

  Detail.prototype.open = function (it) {
    var self = this;
    var token = ++this.token;
    this.origin = it;
    this.zone = "buttons";
    this.b = 0;
    this.seasons = [];
    this.row = null;
    this.focusEp = it.type === "episode" ? it : null;
    this.seasonsEl.innerHTML = "";
    this.epsEl.innerHTML = "";
    var base = it.type === "episode" || it.type === "season"
      ? { key: it.showKey, type: "show", title: it.showTitle, hero: it.hero, blur: it.blur, logo: it.logo, summary: "", genres: [] }
      : it;
    this.render(base);
    var dkey = it.type === "episode" || it.type === "season" ? it.showKey : it.key;
    A.Cache.keep("detail:" + dkey, function () { return A.src.detail(it); }).then(function (full) {
      if (token !== self.token) return;
      if (full.onDeck && it.type === "episode" && full.onDeck.key === it.key) {
        full.onDeck.offset = it.offset;
        full.onDeck.watched = it.watched;
      }
      if (full.key === it.key) {
        full.offset = it.offset;
        full.watched = it.watched;
      }
      self.render(full);
      if (full.type === "show") self.loadSeasons(full, token);
    }, function () {
      if (token !== self.token) return;
      A.toast("Couldn\u2019t load details.");
    });
  };

  Detail.prototype.render = function (it) {
    this.item = it;
    this.root.classList.toggle("movie", it.type !== "show");
    this.root.classList.remove("down");
    this.page.style.transform = "";
    this.bd.set(it.hero, true, it.blur);
    this.bdBlur.set(it.blur, true);
    setLogo(this.logo, this.titleEl, it);
    this.mini.textContent = it.title || "";
    this.metaEl.innerHTML = metaLine(it, true);
    this.sumEl.textContent = it.summary || "";
    var ppl = "";
    if (it.cast && it.cast.length) ppl += "<b>Starring</b> " + esc(it.cast.slice(0, 3).join(", "));
    if (it.directors && it.directors.length) {
      ppl += (ppl ? '<span class="dot" style="margin:0 12px">\u00b7</span>' : "") +
        "<b>" + (it.type === "show" ? "Created by" : "Director") + "</b> " + esc(it.directors.join(", "));
    }
    if (it.writers && it.writers.length && it.type !== "show") {
      ppl += (ppl ? '<span class="dot" style="margin:0 12px">\u00b7</span>' : "") +
        "<b>Written by</b> " + esc(it.writers.join(", "));
    }
    this.peopleEl.innerHTML = ppl;
    this.buildButtons();
    this.buildInfo();
    this.paint();
  };

  Detail.prototype.playTarget = function () {
    var it = this.item;
    if (it.type !== "show") return it;
    if (this.focusEp) return this.focusEp;
    if (it.onDeck) return it.onDeck;
    var eps = this.row ? this.row.items : null;
    return eps && eps[0] ? eps[0] : null;
  };

  Detail.prototype.buildButtons = function () {
    var it = this.item;
    var b = [];
    var target = this.playTarget();
    var p = A.progress(target);
    if (it.type === "show") {
      if (target) {
        var label = (p ? "Resume " : "Play ") + (target.label || "");
        b.push({ id: "play", icon: A.svg.play, label: label, note: p ? A.left(target.offset, target.duration) : "" });
        if (p) b.push({ id: "restart", icon: A.svg.restart, label: "Start Over" });
      }
    } else if (p) {
      b.push({ id: "play", icon: A.svg.play, label: "Resume", note: A.left(it.offset, it.duration) });
      b.push({ id: "restart", icon: A.svg.restart, label: "Play from Beginning" });
    } else {
      b.push({ id: "play", icon: A.svg.play, label: "Play" });
    }
    var listed = A.src.inList && A.src.inList(it);
    b.push({
      id: "list",
      icon: listed ? A.svg.check : A.svg.plus,
      label: listed ? "In My List" : "Add to My List"
    });
    b.push({ id: "watched", icon: it.watched ? "" : A.svg.check, label: it.watched ? "Mark as Unwatched" : "Mark as Watched" });
    this.buttons = b;
    if (this.b >= b.length) this.b = 0;
    var h = "";
    for (var i = 0; i < b.length; i++) {
      h += '<div class="btn">' + (b[i].icon || "") + "<span>" + esc(b[i].label) + "</span>" +
        (b[i].note ? "<small>" + esc(b[i].note) + "</small>" : "") + "</div>";
    }
    this.btnsEl.innerHTML = h;
  };

  Detail.prototype.buildInfo = function () {
    var it = this.item;
    var cols = [];
    var facts = [];
    if (it.year) facts.push("Released " + it.year);
    if (it.rating) facts.push("Rated " + it.rating);
    if (it.type === "show" && it.seasonCount) facts.push(it.seasonCount + (it.seasonCount === 1 ? " Season" : " Seasons"));
    else if (it.duration) facts.push(A.dur(it.duration));
    if (it.genres && it.genres.length) facts.push(it.genres.join(", "));
    if (it.studio) facts.push(it.studio);
    cols.push({ h: "Information", p: facts });
    if (it.cast && it.cast.length) cols.push({ h: "Starring", p: it.cast.slice(0, 6) });
    if (it.directors && it.directors.length) cols.push({ h: it.type === "show" ? "Created By" : "Director", p: it.directors });
    if (it.writers && it.writers.length) cols.push({ h: "Written By", p: it.writers });
    if (it.badges && it.badges.length) cols.push({ h: "Formats", p: it.badges });
    var h = "<h3>About</h3>";
    if (it.summary) h += '<p class="about">' + esc(it.summary) + "</p>";
    for (var i = 0; i < cols.length; i++) {
      h += '<div class="info-col"><h4>' + esc(cols[i].h) + "</h4>";
      for (var j = 0; j < cols[i].p.length; j++) h += "<p>" + esc(cols[i].p[j]) + "</p>";
      h += "</div>";
    }
    this.infoEl.innerHTML = h;
  };

  Detail.prototype.loadSeasons = function (show, token) {
    var self = this;
    A.Cache.keep("seasons:" + show.key, function () { return A.src.seasons(show); }).then(function (list) {
      if (token !== self.token) return;
      self.seasons = list;
      var want = self.focusEp || show.onDeck;
      self.s = 0;
      for (var i = 0; i < list.length; i++) if (want && list[i].season === want.season) self.s = i;
      var h = "";
      for (var j = 0; j < list.length; j++) h += '<div class="season"><span>' + esc(list[j].title) + "</span></div>";
      self.seasonsEl.innerHTML = h;
      self.paint();
      self.loadEpisodes(token);
    });
  };

  Detail.prototype.loadEpisodes = function (token) {
    var self = this;
    var season = this.seasons[this.s];
    if (!season) return;
    var key = season.key;
    A.Cache.keep("eps:" + key, function () { return A.src.episodes(season); }).then(function (eps) {
      if (token !== self.token || self.seasons[self.s] !== season) return;
      self.epsEl.innerHTML = '<div class="track"></div>';
      self.row = new Row(self.epsEl, eps, { still: true, ep: true });
      var want = self.focusEp || self.item.onDeck;
      for (var i = 0; i < eps.length; i++) if (want && eps[i].key === want.key) self.row.col = i;
      self.row.layout();
      if (self.zone === "episodes") self.row.focus("d");
      if (!self.focusEp && !self.item.onDeck) { self.buildButtons(); self.paint(); }
    });
  };

  Detail.prototype.paint = function () {
    var kids = this.btnsEl.children;
    for (var i = 0; i < kids.length; i++) kids[i].classList.toggle("on", i === this.b);
    this.btnsEl.classList.toggle("focus", this.zone === "buttons");
    var sk = this.seasonsEl.children;
    for (var j = 0; j < sk.length; j++) sk[j].classList.toggle("sel", j === this.s);
    this.seasonsEl.classList.toggle("focus", this.zone === "seasons");
    var y = 0;
    if (this.zone === "seasons" || this.zone === "episodes") y = 600;
    if (this.zone === "info") y = this.item.type === "show" ? 1150 : 600;
    this.page.style.transform = y ? "translate3d(0," + (-y) + "px,0)" : "";
    this.root.classList.toggle("down", y > 0);
  };

  Detail.prototype.setZone = function (z, dir) {
    if (this.zone === "episodes" && this.row) this.row.blur();
    this.zone = z;
    if (z === "episodes" && this.row) this.row.focus(dir);
    this.paint();
  };

  Detail.prototype.act = function () {
    var self = this;
    var btn = this.buttons[this.b];
    if (!btn) return;
    var it = this.item;
    if (btn.id === "play") {
      var target = this.playTarget();
      if (target) A.App.play(target, { resume: true });
    } else if (btn.id === "restart") {
      var t = this.playTarget();
      if (t) A.App.play(t, { resume: false });
    } else if (btn.id === "list") {
      if (!A.src.toggleList) return;
      A.src.toggleList(it).then(function (on) {
        if (A.App.listChanged) A.App.listChanged();
        else { self.buildButtons(); self.paint(); }
        A.toast(on ? "Added to My List" : "Removed from My List", 2000);
      }, function () {
        self.buildButtons();
        self.paint();
        A.toast("Couldn\u2019t update My List.");
      });
    } else if (btn.id === "watched") {
      var next = !it.watched;
      A.src.markWatched(it, next).then(function () {
        it.watched = next;
        if (next) it.offset = 0;
        A.App.itemChanged(it);
        self.buildButtons();
        self.paint();
        A.toast(next ? "Marked as watched" : "Marked as unwatched", 2000);
      }, function () { A.toast("Couldn\u2019t update watched status."); });
    }
  };

  Detail.prototype.key = function (k) {
    var self = this;
    var isShow = this.item && this.item.type === "show";
    if (k === "back") {
      if (this.zone !== "buttons") { this.setZone("buttons"); return ""; }
      return "close";
    }
    if (this.zone === "buttons") {
      if (k === "left" && this.b > 0) { this.b -= 1; this.paint(); }
      else if (k === "right" && this.b < this.buttons.length - 1) { this.b += 1; this.paint(); }
      else if (k === "ok") this.act();
      else if (k === "down") this.setZone(isShow && this.seasons.length ? "seasons" : "info", "d");
    } else if (this.zone === "seasons") {
      if (k === "left" || k === "right") {
        var s = this.s + (k === "left" ? -1 : 1);
        if (s < 0 || s >= this.seasons.length) return "";
        this.s = s;
        this.focusEp = null;
        this.row = null;
        this.paint();
        clearTimeout(this.seasonTimer);
        this.seasonTimer = setTimeout(function () { self.epsEl.innerHTML = ""; self.loadEpisodes(self.token); }, 220);
      } else if (k === "up") this.setZone("buttons");
      else if (k === "down" && this.row) this.setZone("episodes", "d");
    } else if (this.zone === "episodes") {
      if (k === "left" || k === "right") this.row.move(k === "left" ? -1 : 1);
      else if (k === "up") this.setZone("seasons");
      else if (k === "down") this.setZone("info");
      else if (k === "ok") A.App.play(this.row.item(), { resume: true });
    } else if (this.zone === "info") {
      if (k === "up") this.setZone(isShow && this.row ? "episodes" : "buttons", "u");
    }
    return "";
  };

  /* ---------- Login (plex.tv/link PIN) ---------- */

  function Login() {
    this.root = A.$("screen-login");
    this.codeEl = this.root.querySelector(".code");
    this.status = this.root.querySelector(".login-status");
    this.btn = this.root.querySelector(".btn");
    this.root.querySelector(".login-glyph").innerHTML = A.svg.play;
    this.timer = 0;
    this.expire = 0;
  }

  Login.prototype.paintCode = function (code) {
    var chars = (code || "\u2022\u2022\u2022\u2022").split("");
    var h = "";
    for (var i = 0; i < chars.length; i++) h += "<span>" + esc(chars[i]) + "</span>";
    this.codeEl.innerHTML = h;
    this.codeEl.className = "code" + (code ? " fresh" : " wait");
  };

  Login.prototype.waiting = function (text) {
    this.status.innerHTML = '<span class="spinner"></span>' + esc(text);
  };

  Login.prototype.start = function () {
    var self = this;
    this.stop();
    this.paintCode("");
    this.waiting("Getting a code\u2026");
    this.btn.parentNode.classList.add("focus");
    this.btn.classList.add("on");
    if (A.preview) {
      setTimeout(function () { self.paintCode("K7QX"); self.waiting("Waiting for you to sign in\u2026"); }, 150);
      return;
    }
    A.Plex.createPin().then(function (pin) {
      self.paintCode(String(pin.code || "").toUpperCase());
      self.waiting("Waiting for you to sign in\u2026");
      self.expire = Date.now() + (Number(pin.expiresIn) || 900) * 1000;
      self.timer = setInterval(function () {
        if (Date.now() > self.expire) { self.start(); return; }
        A.Plex.checkPin(pin.id).then(function (token) {
          if (!token) return;
          self.stop();
          A.App.signedIn(token);
        }, function () {});
      }, 2000);
    }, function () {
      self.paintCode("");
      self.status.textContent = "Plex didn\u2019t respond. Check the TV\u2019s internet connection, then press OK.";
    });
  };

  Login.prototype.stop = function () { clearInterval(this.timer); this.timer = 0; };

  Login.prototype.key = function (k) {
    if (k === "ok") this.start();
    else if (k === "back") A.App.exit();
  };

  A.views = {};
  A.makeViews = function () {
    A.views.browse = new Browse();
    A.views.library = new Library();
    A.views.search = new Search();
    A.views.detail = new Detail();
    A.views.login = new Login();
  };
})();
