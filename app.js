/* =========================================================
   CableVision 2004 — application logic
   ========================================================= */

// ---------- Storage keys ----------------------------------
const LS = {
  url:      "cv2004.m3uUrl",
  text:     "cv2004.m3uText",
  channels: "cv2004.channels",
  last:     "cv2004.lastCh",
  opts:     "cv2004.opts",
};

const state = {
  channels: [],           // all items (live, movie, series)
  filtered: [],           // guide-visible items (live only)
  searchResults: [],      // search overlay results
  searchKind: "all",
  searchSelected: 0,
  currentIndex: -1,
  guideSelected: 0,
  hls: null,
  numpadBuffer: "",
  numpadTimer: null,
  bannerTimer: null,
  poweredOn: true,
  lastIndex: -1,
  opts: { autoplay: true, mute: false, proxy: "" },
};

// ---------- DOM helpers -----------------------------------
const $ = (id) => document.getElementById(id);
const show = (el) => el.classList.remove("hidden");
const hide = (el) => el.classList.add("hidden");
const anyOverlayOpen = () =>
  [$("guide"), $("info"), $("menu"), $("paste"), $("search")].some((e) => !e.classList.contains("hidden"));

// ---------- Init ------------------------------------------
window.addEventListener("DOMContentLoaded", init);

async function init() {
  loadOptions();
  applyOptionsToUI();
  bindUI();
  startClock();
  setLamp("power", true);

  const cachedChannels = safeParse(localStorage.getItem(LS.channels));
  if (cachedChannels && Array.isArray(cachedChannels) && cachedChannels.length) {
    state.channels = cachedChannels;
    afterChannelsLoaded({ fromCache: true });
  } else {
    // no cached channels — show boot for a moment, then open menu
    setLed("---", "NO PLAYLIST");
    setTimeout(() => {
      finishBoot();
      openMenu();
      setMenuNote("Enter an M3U URL or paste an M3U to get started.");
    }, 1200);
  }
}

// ---------- Options ---------------------------------------
function loadOptions() {
  const o = safeParse(localStorage.getItem(LS.opts));
  if (o && typeof o === "object") state.opts = { ...state.opts, ...o };
}
function saveOptions() {
  localStorage.setItem(LS.opts, JSON.stringify(state.opts));
}
function applyOptionsToUI() {
  $("opt-autoplay").checked = !!state.opts.autoplay;
  $("opt-mute").checked = !!state.opts.mute;
  $("m3u-url").value = localStorage.getItem(LS.url) || "";
  $("proxy-prefix").value = state.opts.proxy || "";
}

// ---------- Clocks / LED ----------------------------------
function startClock() {
  const tick = () => {
    const now = new Date();
    const t = now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    $("banner-clock").textContent = t;
    $("guide-clock").textContent = t;
    $("info-clock").textContent = t;
  };
  tick();
  setInterval(tick, 1000 * 15);
}
function setLed(chStr, msg) {
  $("led-ch").textContent = chStr;
  $("led-msg").textContent = msg;
}
function setLamp(name, on) {
  $("lamp-" + name).classList.toggle("on", !!on);
}

// ---------- Boot ------------------------------------------
function finishBoot() {
  $("boot").classList.add("done");
  setTimeout(() => hide($("boot")), 700);
}

// ---------- Playlist loading ------------------------------
function applyProxy(url) {
  const p = (state.opts.proxy || "").trim();
  if (!p || !url) return url;
  // Don't double-wrap URLs that already go through the proxy
  if (url.startsWith(p) || url.includes("/proxy?url=")) return url;
  return p + encodeURIComponent(url);
}

/* When to route a stream URL through the proxy:
   - user has configured a proxy prefix
   - AND the stream URL is http:// while the page is https:// (mixed content),
     OR the URL is on a different origin (likely to hit CORS on HLS segments)
   Direct https-same-origin URLs are left alone. */
function proxyStreamIfNeeded(url) {
  if (!state.opts.proxy || !url) return url;
  try {
    const u = new URL(url, location.href);
    const mixed = location.protocol === "https:" && u.protocol === "http:";
    const crossOrigin = u.origin !== location.origin;
    if (mixed || crossOrigin) return applyProxy(url);
    return url;
  } catch {
    return url;
  }
}

async function loadFromUrl(url) {
  // For the playlist fetch itself, always send through the proxy when
  // one is configured — otherwise a plain http:// playlist URL will be
  // blocked as mixed content from an https:// page before we can even try.
  const fetchUrl = applyProxy(url);
  setMenuNote(`Fetching ${url}${fetchUrl !== url ? " (via proxy)" : ""} …`);
  try {
    const res = await fetch(fetchUrl, { redirect: "follow" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const text = await res.text();
    if (!/#EXTM3U/i.test(text.slice(0, 200)) && !/#EXTINF/i.test(text)) {
      throw new Error("Response does not look like an M3U playlist.");
    }
    localStorage.setItem(LS.url, url);
    localStorage.setItem(LS.text, text);
    ingestPlaylistText(text);
    setMenuNote(`Loaded ${state.channels.length} channels from URL.`);
    closeAllOverlays();
    if (state.channels.length) tuneToIndex(0);
  } catch (err) {
    setMenuNote(
      `Could not fetch: ${err.message}. If your browser blocks it (CORS), open "PASTE M3U TEXT" and paste the file's contents instead.`
    );
  }
}

function ingestPlaylistText(text) {
  const channels = parseM3U(text);
  state.channels = channels;
  localStorage.setItem(LS.channels, JSON.stringify(channels));
  afterChannelsLoaded({ fromCache: false });
}

function afterChannelsLoaded({ fromCache }) {
  // Backfill kind for old cached entries that predate classification.
  for (const c of state.channels) if (!c.kind) c.kind = classifyItem(c);

  populateGroupSelect();
  applyGuideFilter();
  const counts = state.channels.reduce((a, c) => (a[c.kind] = (a[c.kind] || 0) + 1, a), {});
  setMenuNote(
    `${state.channels.length} items ${fromCache ? "loaded from cache" : "parsed"} — ` +
    `${counts.live || 0} live · ${counts.movie || 0} movies · ${counts.series || 0} series.`
  );
  finishBoot();
  const last = parseInt(localStorage.getItem(LS.last) || "-1", 10);
  if (state.opts.autoplay && last >= 0 && last < state.channels.length) {
    tuneToIndex(last);
  } else {
    setLed("---", "READY · PRESS GUIDE");
    showBanner("---", "Ready", "Press GUIDE to browse channels");
  }
}

// ---------- M3U parser ------------------------------------
function parseM3U(text) {
  const lines = text.split(/\r?\n/);
  const channels = [];
  let cur = null;
  let ch = 100;

  const attr = (line, key) => {
    const re = new RegExp(key + '="([^"]*)"', "i");
    const m = line.match(re);
    return m ? m[1] : "";
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#EXTM3U")) continue;

    if (line.startsWith("#EXTINF")) {
      const commaIdx = line.indexOf(",");
      const name = commaIdx >= 0 ? line.slice(commaIdx + 1).trim() : "Unknown";
      cur = {
        name,
        logo: attr(line, "tvg-logo"),
        group: attr(line, "group-title") || "General",
        tvgId: attr(line, "tvg-id"),
        tvgName: attr(line, "tvg-name"),
        chNo: attr(line, "tvg-chno"),
        url: "",
      };
      continue;
    }
    if (line.startsWith("#EXTGRP:")) {
      if (cur) cur.group = line.slice("#EXTGRP:".length).trim() || cur.group;
      continue;
    }
    if (line.startsWith("#")) continue;

    // URL line
    if (cur) {
      cur.url = line;
      if (!cur.chNo) cur.chNo = String(ch++);
      cur.kind = classifyItem(cur);
      channels.push(cur);
      cur = null;
    } else {
      // stray URL, no EXTINF
      const c = {
        name: "Stream " + ch,
        group: "General",
        chNo: String(ch++),
        url: line,
        logo: "", tvgId: "", tvgName: "",
      };
      c.kind = classifyItem(c);
      channels.push(c);
    }
  }
  return channels;
}

/* Best-effort classification: Xtream Codes style URLs use /live/,
   /movie/, and /series/ path prefixes. Plain-file extensions
   (.mp4, .mkv, .avi, .mov, .m4v) are VOD. Everything else is live. */
function classifyItem(c) {
  const u = (c.url || "").toLowerCase();
  const g = (c.group || "").toLowerCase();
  if (/\/series\//.test(u) || /(series|tv shows?|episode|season)/.test(g)) return "series";
  if (/\/movie\//.test(u) || /(movie|vod|film|cinema)/.test(g)) return "movie";
  if (/\.(mp4|mkv|avi|mov|m4v|webm)(\?|$)/.test(u)) return "movie";
  return "live";
}

// ---------- Guide -----------------------------------------
function populateGroupSelect() {
  const sel = $("guide-group");
  const groups = Array.from(new Set(
    state.channels.filter((c) => c.kind === "live").map((c) => c.group || "General")
  )).sort();
  sel.innerHTML =
    `<option value="__all">ALL CATEGORIES</option>` +
    groups.map((g) => `<option value="${escapeHtml(g)}">${escapeHtml(g)}</option>`).join("");
}

function applyGuideFilter() {
  const q = $("guide-search").value.trim().toLowerCase();
  const g = $("guide-group").value;
  state.filtered = state.channels
    .map((c, idx) => ({ c, idx }))
    .filter(({ c }) => c.kind === "live"
      && (g === "__all" || c.group === g)
      && (!q || c.name.toLowerCase().includes(q)));
  $("guide-count").textContent = `${state.filtered.length} CHANNELS`;
  renderGuide();
}

function renderGuide() {
  const list = $("guide-list");
  const html = state.filtered.map((row, i) => {
    const { c, idx } = row;
    const isPlaying = idx === state.currentIndex;
    const isSel = i === state.guideSelected;
    return `
      <div class="guide-row ${isPlaying ? "playing" : ""} ${isSel ? "selected" : ""}"
           data-i="${i}" data-idx="${idx}">
        <div class="col-num">${escapeHtml(c.chNo || String(idx + 1))}</div>
        <div class="col-name">${escapeHtml(c.name)}</div>
        <div class="col-now">${isPlaying ? "▶ NOW PLAYING" : "Live"}</div>
        <div class="col-cat">${escapeHtml(c.group || "General")}</div>
      </div>`;
  }).join("");
  list.innerHTML = html;

  list.querySelectorAll(".guide-row").forEach((row) => {
    row.addEventListener("click", () => {
      const idx = parseInt(row.dataset.idx, 10);
      state.guideSelected = parseInt(row.dataset.i, 10);
      tuneToIndex(idx);
      closeOverlay($("guide"));
    });
  });

  const selEl = list.querySelector(".guide-row.selected");
  if (selEl) selEl.scrollIntoView({ block: "nearest" });
}

function moveGuideSelection(delta) {
  if (!state.filtered.length) return;
  state.guideSelected = Math.max(0, Math.min(state.filtered.length - 1, state.guideSelected + delta));
  renderGuide();
}

function guideSelectPlay() {
  const row = state.filtered[state.guideSelected];
  if (!row) return;
  tuneToIndex(row.idx);
  closeOverlay($("guide"));
}

// ---------- Tuner -----------------------------------------
function tuneToIndex(idx) {
  if (idx < 0 || idx >= state.channels.length) return;
  if (state.currentIndex !== idx) state.lastIndex = state.currentIndex;
  state.currentIndex = idx;
  localStorage.setItem(LS.last, String(idx));

  const c = state.channels[idx];
  const chLabel = c.chNo || String(idx + 1);
  setLed(chLabel.padStart(3, "0"), c.name.toUpperCase().slice(0, 24));
  showBanner(chLabel, c.name, c.group || "");
  playUrl(c.url);
  updateInfoOverlay();
  renderGuide(); // keep playing marker fresh
}

function channelStep(delta) {
  // Cable-box behavior: CH+/- walks through LIVE channels only.
  const liveIdx = state.channels
    .map((c, i) => (c.kind === "live" ? i : -1))
    .filter((i) => i >= 0);
  if (!liveIdx.length) return;
  const here = liveIdx.indexOf(state.currentIndex);
  let pos = here + delta;
  if (pos < 0) pos = liveIdx.length - 1;
  if (pos >= liveIdx.length) pos = 0;
  tuneToIndex(liveIdx[pos]);
}

function channelLast() {
  if (state.lastIndex >= 0) tuneToIndex(state.lastIndex);
}

// ---------- Numpad direct-tune ----------------------------
function numpadPress(digit) {
  state.numpadBuffer += digit;
  setLed(state.numpadBuffer.padStart(3, "-"), "TUNING…");
  clearTimeout(state.numpadTimer);
  if (state.numpadBuffer.length >= 4) {
    numpadCommit();
  } else {
    state.numpadTimer = setTimeout(numpadCommit, 1500);
  }
}
function numpadCommit() {
  clearTimeout(state.numpadTimer);
  const raw = state.numpadBuffer;
  state.numpadBuffer = "";
  if (!raw) return;
  // Match by chNo first (exact), then by numeric position (1-based)
  const byNo = state.channels.findIndex((c) => (c.chNo || "").padStart(raw.length, "0") === raw.padStart(raw.length, "0") || c.chNo === raw);
  if (byNo >= 0) { tuneToIndex(byNo); return; }
  const n = parseInt(raw, 10);
  if (!Number.isNaN(n) && n >= 1 && n <= state.channels.length) {
    tuneToIndex(n - 1); return;
  }
  showBanner("---", "No such channel", `Entered: ${raw}`);
  setLed("---", "NO CHANNEL");
}

// ---------- Playback --------------------------------------
function playUrl(url) {
  const v = $("video");
  destroyHls();
  setLamp("sig", false);

  if (!url) return;
  v.muted = !!state.opts.mute;

  const playUrl_ = proxyStreamIfNeeded(url);
  const isM3U8 = /\.m3u8($|\?)/i.test(url);

  if (isM3U8 && window.Hls && Hls.isSupported()) {
    const hlsOpts = { enableWorker: true, lowLatencyMode: true };
    // When a proxy is configured, route every .m3u8 / .ts fetch through it,
    // so both the manifest AND its segments (which may point at http:// URLs)
    // go through our https:// domain instead of hitting mixed-content blocks.
    if (state.opts.proxy) hlsOpts.loader = makeProxiedLoader();
    const hls = new Hls(hlsOpts);
    state.hls = hls;
    hls.loadSource(playUrl_);
    hls.attachMedia(v);
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      v.play().catch(() => {});
      setLamp("sig", true);
    });
    hls.on(Hls.Events.ERROR, (_e, data) => {
      if (data.fatal) {
        setLamp("sig", false);
        showBanner(currentChLabel(), currentChName(), "SIGNAL ERROR — " + (data.details || "unknown"));
      }
    });
  } else {
    // Native HLS on Safari, or plain mp4/mkv/ts VOD
    v.src = playUrl_;
    v.play().catch(() => {});
    v.addEventListener("playing", () => setLamp("sig", true), { once: true });
    v.addEventListener("error", () => setLamp("sig", false), { once: true });
  }
}

/* Return a hls.js loader subclass that rewrites the context URL through
   our proxy before delegating to the default XHR loader. */
function makeProxiedLoader() {
  const Base = Hls.DefaultConfig.loader;
  return class ProxiedLoader extends Base {
    load(context, config, callbacks) {
      context.url = proxyStreamIfNeeded(context.url);
      return super.load(context, config, callbacks);
    }
  };
}

function destroyHls() {
  if (state.hls) {
    try { state.hls.destroy(); } catch {}
    state.hls = null;
  }
  const v = $("video");
  v.removeAttribute("src");
  v.load();
}

// ---------- Banner / info ---------------------------------
function currentCh() { return state.channels[state.currentIndex] || null; }
function currentChLabel() { const c = currentCh(); return c ? (c.chNo || String(state.currentIndex + 1)) : "---"; }
function currentChName()  { const c = currentCh(); return c ? c.name : "No Signal"; }

function showBanner(num, title, sub) {
  const b = $("banner");
  $("banner-num").textContent = num;
  $("banner-title").textContent = title;
  $("banner-sub").textContent = sub || "";
  b.classList.remove("hidden");
  // reset the shrinking bar animation
  const bar = b.querySelector(".banner-bar-fill");
  bar.style.animation = "none"; void bar.offsetWidth;
  bar.style.animation = "";
  clearTimeout(state.bannerTimer);
  state.bannerTimer = setTimeout(() => b.classList.add("hidden"), 5000);
}

function updateInfoOverlay() {
  const c = currentCh();
  if (!c) return;
  $("info-num").textContent = c.chNo || String(state.currentIndex + 1);
  $("info-name").textContent = c.name;
  $("info-title").textContent = c.name;
  $("info-desc").textContent = "Live stream · " + (c.group || "General");
  const meta = [
    c.tvgId ? "tvg-id: " + c.tvgId : "",
    c.tvgName ? "tvg-name: " + c.tvgName : "",
    "source: " + shortUrl(c.url),
  ].filter(Boolean).join(" · ");
  $("info-meta").textContent = meta;
}
function shortUrl(u) {
  try { const x = new URL(u); return x.host + x.pathname.replace(/\/[^/]*$/, "/…"); }
  catch { return u.length > 60 ? u.slice(0, 57) + "…" : u; }
}

// ---------- Overlays / power ------------------------------
/* =========================================================
   SEARCH OVERLAY
   ========================================================= */
function openSearch() {
  if (!state.channels.length) { openMenu(); return; }
  show($("search"));
  const input = $("search-input");
  input.focus();
  input.select();
  runSearch();
}

function setSearchKind(k) {
  state.searchKind = k;
  document.querySelectorAll("#search-tabs .tab").forEach((t) =>
    t.classList.toggle("active", t.dataset.kind === k)
  );
  state.searchSelected = 0;
  runSearch();
}

function runSearch() {
  const q = $("search-input").value.trim().toLowerCase();
  const kind = state.searchKind;
  const results = [];
  const tokens = q.split(/\s+/).filter(Boolean);

  for (let i = 0; i < state.channels.length; i++) {
    const c = state.channels[i];
    if (kind !== "all" && c.kind !== kind) continue;
    if (tokens.length) {
      const hay = (c.name + " " + (c.group || "") + " " + (c.tvgName || "")).toLowerCase();
      if (!tokens.every((t) => hay.includes(t))) continue;
    }
    results.push({ c, idx: i });
    if (results.length >= 500) break; // cap for performance
  }
  state.searchResults = results;
  if (state.searchSelected >= results.length) state.searchSelected = Math.max(0, results.length - 1);
  renderSearch();
}

function renderSearch() {
  const list = $("search-list");
  const q = $("search-input").value.trim();
  $("search-count").textContent = `${state.searchResults.length} RESULT${state.searchResults.length === 1 ? "" : "S"}`;

  if (!state.searchResults.length) {
    list.innerHTML = `<div class="search-hint">${q ? "No matches. Try a different term or category." : "Start typing to search live TV, movies, and series."}</div>`;
    return;
  }

  const html = state.searchResults.map((row, i) => {
    const { c, idx } = row;
    const isPlaying = idx === state.currentIndex;
    const isSel = i === state.searchSelected;
    const kindLabel = c.kind === "movie" ? "MOVIE" : c.kind === "series" ? "SERIES" : "LIVE";
    return `
      <div class="guide-row search-row ${isPlaying ? "playing" : ""} ${isSel ? "selected" : ""}"
           data-i="${i}" data-idx="${idx}">
        <div class="col-kind kind-${c.kind}">${kindLabel}</div>
        <div class="col-num">${escapeHtml(c.chNo || String(idx + 1))}</div>
        <div class="col-name">${escapeHtml(c.name)}</div>
        <div class="col-cat">${escapeHtml(c.group || "General")}</div>
      </div>`;
  }).join("");
  list.innerHTML = html;

  list.querySelectorAll(".search-row").forEach((row) => {
    row.addEventListener("click", () => {
      state.searchSelected = parseInt(row.dataset.i, 10);
      const idx = parseInt(row.dataset.idx, 10);
      tuneToIndex(idx);
      closeOverlay($("search"));
    });
  });

  const selEl = list.querySelector(".search-row.selected");
  if (selEl) selEl.scrollIntoView({ block: "nearest" });
}

function moveSearchSelection(delta) {
  if (!state.searchResults.length) return;
  state.searchSelected = Math.max(0, Math.min(state.searchResults.length - 1, state.searchSelected + delta));
  renderSearch();
}

function searchSelectPlay() {
  const row = state.searchResults[state.searchSelected];
  if (!row) return;
  tuneToIndex(row.idx);
  closeOverlay($("search"));
}

function cycleSearchTab(delta) {
  const kinds = ["all", "live", "movie", "series"];
  const idx = (kinds.indexOf(state.searchKind) + delta + kinds.length) % kinds.length;
  setSearchKind(kinds[idx]);
}

function openGuide() {
  if (!state.channels.length) { openMenu(); return; }
  // preselect currently playing channel
  const cur = state.filtered.findIndex((r) => r.idx === state.currentIndex);
  state.guideSelected = cur >= 0 ? cur : 0;
  renderGuide();
  show($("guide"));
}
function openInfo() { updateInfoOverlay(); show($("info")); }
function openMenu() { show($("menu")); $("m3u-url").focus(); }
function openPaste() { show($("paste")); $("paste-area").focus(); }
function closeOverlay(el) { hide(el); }
function closeAllOverlays() {
  [$("guide"), $("info"), $("menu"), $("paste"), $("search")].forEach(hide);
}

function togglePower() {
  state.poweredOn = !state.poweredOn;
  setLamp("power", state.poweredOn);
  if (!state.poweredOn) {
    show($("off"));
    setLed("---", "STANDBY");
    const v = $("video"); v.pause();
    setLamp("sig", false);
    closeAllOverlays();
  } else {
    hide($("off"));
    if (state.currentIndex >= 0) tuneToIndex(state.currentIndex);
    else setLed("---", "READY · PRESS GUIDE");
  }
}

// ---------- Menu / UI wiring ------------------------------
function setMenuNote(text) { $("menu-note").textContent = text; }

function bindUI() {
  // Remote — power / mute
  $("btn-power").addEventListener("click", togglePower);
  $("btn-mute").addEventListener("click", () => {
    const v = $("video");
    v.muted = !v.muted;
    state.opts.mute = v.muted; saveOptions();
    showBanner(currentChLabel(), currentChName(), v.muted ? "MUTED" : "UNMUTED");
  });

  // Remote — dpad / channel / vol
  $("btn-chup").addEventListener("click", () => channelStep(+1));
  $("btn-chdn").addEventListener("click", () => channelStep(-1));
  $("btn-volup").addEventListener("click", () => adjustVolume(+0.1));
  $("btn-voldn").addEventListener("click", () => adjustVolume(-0.1));
  $("btn-ok").addEventListener("click", () => {
    if (!$("guide").classList.contains("hidden")) guideSelectPlay();
    else openGuide();
  });

  // Remote — fns
  $("btn-guide").addEventListener("click", () => toggleOverlay($("guide"), openGuide));
  $("btn-info").addEventListener("click", () => toggleOverlay($("info"), openInfo));
  $("btn-menu").addEventListener("click", () => toggleOverlay($("menu"), openMenu));
  $("btn-search").addEventListener("click", () => toggleOverlay($("search"), openSearch));
  $("btn-exit").addEventListener("click", closeAllOverlays);
  $("btn-back").addEventListener("click", channelLast);
  $("btn-enter").addEventListener("click", numpadCommit);

  // Numpad digits
  document.querySelectorAll(".rk.num").forEach((btn) => {
    if (btn.id) return; // LAST / ENTER handled above
    btn.addEventListener("click", () => numpadPress(btn.textContent.trim()));
  });

  // Menu buttons
  $("load-url").addEventListener("click", () => {
    const url = $("m3u-url").value.trim();
    if (!url) { setMenuNote("Enter an M3U URL first."); return; }
    loadFromUrl(url);
  });
  $("paste-open").addEventListener("click", openPaste);
  $("paste-cancel").addEventListener("click", () => hide($("paste")));
  $("paste-load").addEventListener("click", () => {
    const text = $("paste-area").value;
    if (!/#EXTINF/i.test(text) && !/https?:\/\//i.test(text)) {
      setMenuNote("Pasted content does not look like an M3U playlist.");
      return;
    }
    localStorage.setItem(LS.text, text);
    localStorage.removeItem(LS.url);
    ingestPlaylistText(text);
    hide($("paste"));
    closeAllOverlays();
    if (state.channels.length) tuneToIndex(0);
  });
  $("reload-cached").addEventListener("click", () => {
    const text = localStorage.getItem(LS.text);
    if (text) {
      ingestPlaylistText(text);
      setMenuNote(`Reloaded ${state.channels.length} channels from saved playlist.`);
    } else {
      setMenuNote("No saved playlist yet.");
    }
  });
  $("clear-cache").addEventListener("click", () => {
    if (!confirm("Clear the saved playlist and remembered channel?")) return;
    [LS.url, LS.text, LS.channels, LS.last].forEach((k) => localStorage.removeItem(k));
    state.channels = []; state.filtered = []; state.currentIndex = -1; state.lastIndex = -1;
    destroyHls();
    populateGroupSelect();
    renderGuide();
    setLed("---", "NO PLAYLIST");
    setMenuNote("Cleared. Enter a new M3U URL or paste playlist text.");
    $("m3u-url").value = "";
  });

  // Options
  $("opt-autoplay").addEventListener("change", (e) => { state.opts.autoplay = e.target.checked; saveOptions(); });
  $("opt-mute").addEventListener("change", (e) => {
    state.opts.mute = e.target.checked; saveOptions();
    $("video").muted = e.target.checked;
  });
  $("proxy-prefix").addEventListener("change", (e) => {
    state.opts.proxy = e.target.value.trim();
    saveOptions();
    setMenuNote(state.opts.proxy ? `Proxy set: ${state.opts.proxy}` : "Proxy cleared. Fetches go directly.");
  });

  // Search overlay
  $("search-input").addEventListener("input", runSearch);
  document.querySelectorAll("#search-tabs .tab").forEach((t) => {
    t.addEventListener("click", () => setSearchKind(t.dataset.kind));
  });

  // Guide filters
  $("guide-group").addEventListener("change", () => { state.guideSelected = 0; applyGuideFilter(); });
  $("guide-search").addEventListener("input", () => { state.guideSelected = 0; applyGuideFilter(); });

  // Video events
  const v = $("video");
  v.addEventListener("waiting", () => setLamp("sig", false));
  v.addEventListener("playing", () => setLamp("sig", true));

  // Keyboard shortcuts
  document.addEventListener("keydown", onKey);
}

function toggleOverlay(el, opener) {
  if (el.classList.contains("hidden")) opener();
  else hide(el);
}

function adjustVolume(delta) {
  const v = $("video");
  v.muted = false;
  v.volume = Math.max(0, Math.min(1, v.volume + delta));
  showBanner(currentChLabel(), currentChName(), `VOL ${Math.round(v.volume * 100)}%`);
}

function onKey(e) {
  const tag = document.activeElement && document.activeElement.tagName;
  const inField = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
  const guideOpen  = !$("guide").classList.contains("hidden");
  const searchOpen = !$("search").classList.contains("hidden");

  if (e.key === "Escape") { closeAllOverlays(); return; }

  // Slash always opens search (like a browser find), unless already typing there
  if (e.key === "/" && !searchOpen) {
    e.preventDefault();
    openSearch();
    return;
  }

  if (inField) {
    const navKey = e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === "Tab";
    if ((guideOpen || searchOpen) && navKey) {
      // fall through to switch below
    } else {
      return;
    }
  }

  switch (e.key) {
    case "ArrowUp":
      if (searchOpen)      { e.preventDefault(); moveSearchSelection(-1); }
      else if (guideOpen)  { e.preventDefault(); moveGuideSelection(-1); }
      else                 channelStep(+1);
      break;
    case "ArrowDown":
      if (searchOpen)      { e.preventDefault(); moveSearchSelection(+1); }
      else if (guideOpen)  { e.preventDefault(); moveGuideSelection(+1); }
      else                 channelStep(-1);
      break;
    case "ArrowLeft":
      if (searchOpen) { e.preventDefault(); cycleSearchTab(-1); }
      else adjustVolume(-0.1);
      break;
    case "ArrowRight":
      if (searchOpen) { e.preventDefault(); cycleSearchTab(+1); }
      else adjustVolume(+0.1);
      break;
    case "Tab":
      if (searchOpen) { e.preventDefault(); cycleSearchTab(e.shiftKey ? -1 : +1); }
      break;
    case "Enter":
      if (searchOpen)     { e.preventDefault(); searchSelectPlay(); }
      else if (guideOpen) { e.preventDefault(); guideSelectPlay(); }
      else                openGuide();
      break;
    case "g": case "G": toggleOverlay($("guide"), openGuide); break;
    case "i": case "I": toggleOverlay($("info"), openInfo); break;
    case "m": case "M": toggleOverlay($("menu"), openMenu); break;
    case "s": case "S": toggleOverlay($("search"), openSearch); break;
    case "b": case "B": channelLast(); break;
    case " ": e.preventDefault(); { const v = $("video"); v.paused ? v.play() : v.pause(); } break;
    default:
      if (/^[0-9]$/.test(e.key)) numpadPress(e.key);
  }
}

// ---------- Utilities -------------------------------------
function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }
