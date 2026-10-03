"use strict";

const $ = (id) => document.getElementById(id);
const SUGGESTIONS = ["Licht im Wohnzimmer an", "Alle Lichter aus", "Spiel Queen", "Pause", "Lauter", "Was läuft?", "Hilfe"];
let pollTimer = null;
let speakOn = localStorage.getItem("sh-speak") === "on";
let busyUntil = 0; // pause polling briefly after a user action so sliders don't jump back
let dragging = false; // a fader is being moved: don't redraw underneath it
let lastNow = null; // last Spotify state, used to animate the progress bar between polls
let lastSync = 0;
let playlistsLoadedAt = 0;
let playlists = [];

// All text from Home Assistant / Spotify is inserted with textContent, never as HTML.
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (value !== undefined && value !== null) node.setAttribute(key, value);
  }
  node.append(...children.filter((c) => c !== null && c !== undefined));
  return node;
}

async function api(path, body) {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 401) {
    showLogin();
    throw new Error("Bitte melde dich an.");
  }
  if (response.status === 403 && response.headers.get("x-must-change-password")) {
    showChange();
    const error = new Error("Bitte ändere zuerst dein Einmalpasswort.");
    error.mustChange = true;
    throw error;
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.detail || `Das hat nicht geklappt (Status ${response.status}).`);
  return data;
}

function showLogin() {
  clearInterval(pollTimer);
  $("app").hidden = true;
  $("change").hidden = true;
  $("login").hidden = false;
  $("password").focus();
}

// After the first login with the one-time password only this screen is usable.
function showChange() {
  clearInterval(pollTimer);
  $("app").hidden = true;
  $("login").hidden = true;
  $("change").hidden = false;
  $("pw-old").focus();
}

function showApp() {
  $("login").hidden = true;
  $("change").hidden = true;
  $("app").hidden = false;
  refresh();
  clearInterval(pollTimer);
  pollTimer = setInterval(refresh, 5000);
}

function banner(text) {
  $("banner").hidden = !text;
  $("banner").textContent = text || "";
}

function chip(node, text, cls) {
  node.textContent = text;
  node.className = `chip ${cls}`;
}

// Resolves to true when the command worked, false when it failed (the banner already shows why).
async function act(path, body) {
  busyUntil = Date.now() + 1500;
  let ok = true;
  try {
    await api(path, body === undefined ? {} : body);
    banner("");
  } catch (error) {
    ok = false;
    banner(error.message);
  }
  await refresh(true);
  return ok;
}

async function refresh(force) {
  if (!force && (Date.now() < busyUntil || dragging)) return;
  let state;
  try {
    state = await api("/api/state");
  } catch (error) {
    if (!$("app").hidden) banner(error.message);
    return;
  }
  $("demo-badge").hidden = !state.demo;
  chip($("ha-chip"), state.ha_error ? "Home Assistant: Fehler" : "Home Assistant", state.ha_error ? "bad" : "ok");
  const sp = state.spotify;
  chip($("sp-chip"), sp.connected ? "Spotify verbunden" : "Spotify nicht verbunden", sp.connected ? "ok" : "warn");
  banner(state.ha_error || sp.error || "");
  renderSpotify(sp);
  renderMedia(state.entities.filter((e) => e.domain === "media_player"));
  renderToggles($("light-list"), state.entities.filter((e) => e.domain === "light"), true);
  renderToggles($("other-list"), state.entities.filter((e) => e.domain === "switch" || e.domain === "fan"), false);
  renderBots(state.bots);
  renderDJ(state);
}

function slider(value, onChange, label) {
  const input = el("input", { type: "range", min: 0, max: 100, value: value ?? 0, "aria-label": label });
  input.addEventListener("change", () => onChange(Number(input.value)));
  return input;
}

function renderSpotify(sp) {
  const body = $("spotify-body");
  body.replaceChildren();
  if (!sp.configured) {
    body.append(el("p", { class: "empty" }, "Spotify ist nicht eingerichtet (SPOTIFY_CLIENT_ID und SPOTIFY_CLIENT_SECRET in der .env)."));
    return;
  }
  if (!sp.connected) {
    body.append(el("p", { class: "empty" }, "Verbinde dein Spotify-Premium-Konto einmalig."), el("a", { class: "primary link", href: "/spotify/login" }, "Spotify verbinden"));
    return;
  }
  const now = sp.now;
  body.append(
    el("div", { class: "now" },
      now && now.image ? el("img", { src: now.image, alt: "" }) : el("div", { class: "cover" }),
      el("div", {}, el("strong", {}, now ? now.title : "Nichts läuft"), el("span", {}, now ? `${now.artist}${now.device ? " · " + now.device : ""}` : "Sag dem Bot „Spiel Queen“")),
    ),
    el("div", { class: "controls" },
      el("button", { "aria-label": "Zurück", onclick: () => act("/api/spotify/previous") }, "⏮"),
      el("button", { "aria-label": now && now.playing ? "Pause" : "Wiedergabe", onclick: () => act(`/api/spotify/${now && now.playing ? "pause" : "play"}`) }, now && now.playing ? "⏸" : "▶"),
      el("button", { "aria-label": "Weiter", onclick: () => act("/api/spotify/next") }, "⏭"),
    ),
    el("div", { class: "row" }, el("span", {}, "Lautstärke"), el("span", {}, now && now.volume != null ? `${now.volume} %` : ""), slider(now ? now.volume : 0, (level) => act("/api/spotify/volume", { level }), "Spotify-Lautstärke")),
  );
  const devices = sp.devices || [];
  if (devices.length) {
    const select = el("select", { "aria-label": "Wiedergabegerät" }, ...devices.map((d) => el("option", { value: d.id, ...(d.active ? { selected: "" } : {}) }, d.name)));
    select.addEventListener("change", () => act("/api/spotify/transfer", { device_id: select.value }));
    body.append(select);
  }
}

function renderMedia(players) {
  const list = $("media-list");
  list.replaceChildren();
  if (!players.length) list.append(el("p", { class: "empty" }, "Keine Echo-Geräte gefunden. In Home Assistant die Integration „Alexa Media Player“ einrichten."));
  for (const p of players) {
    const playing = p.state === "playing";
    list.append(el("div", { class: "row" },
      el("div", {}, p.name, el("small", {}, [p.title, p.artist].filter(Boolean).join(" – ") || p.state)),
      el("button", { class: "switch", "aria-pressed": String(playing), "aria-label": `${p.name} ${playing ? "pausieren" : "abspielen"}`, onclick: () => act(`/api/media/${encodeURIComponent(p.id)}/${playing ? "pause" : "play"}`) }, playing ? "⏸" : "▶"),
      p.volume != null ? slider(p.volume, (level) => act(`/api/media/${encodeURIComponent(p.id)}/volume`, { level }), `${p.name} Lautstärke`) : null,
    ));
  }
}

function renderToggles(list, items, withBrightness) {
  list.replaceChildren();
  if (!items.length) list.append(el("p", { class: "empty" }, "Keine Geräte gefunden."));
  for (const item of items) {
    const on = item.state === "on";
    list.append(el("div", { class: "row" },
      el("div", {}, item.name),
      el("button", { class: "switch", "aria-pressed": String(on), "aria-label": `${item.name} ${on ? "ausschalten" : "einschalten"}`, onclick: () => act(`/api/entity/${encodeURIComponent(item.id)}/toggle`) }, on ? "An" : "Aus"),
      withBrightness && on && item.brightness != null ? slider(item.brightness, (level) => act(`/api/entity/${encodeURIComponent(item.id)}/brightness`, { level }), `${item.name} Helligkeit`) : null,
    ));
  }
}

function renderBots(bots) {
  const list = $("bot-list");
  list.replaceChildren(...bots.map((b) => el("li", {}, el("span", { class: `chip ${b.online ? "ok" : "bad"}` }, `${b.name}: ${b.online ? "online" : "offline"}`), b.url ? el("a", { href: b.url, target: "_blank", rel: "noreferrer" }, "öffnen") : null)));
}

// ---- DJ-Pult (layout inspired by djay Pro: two decks, mixer with crossfader in the middle, library below)
// Spotify plays ONE track at a time, so the two decks have roles: the LIVE deck shows what is playing, the other
// deck is where the next track is prepared (drag a track onto it). The crossfader fades over to that track and the
// decks swap roles, so "playing" always sits on the side the fader is on.
const fmt = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
let libraryPlaylist = null; // { uri, name, readable }
let libraryRequest = 0;
let waveSeed = "";
let waveBars = [];
let lastState = null;

const store = {
  get(key) { try { return sessionStorage.getItem(key); } catch (error) { return null; } },
  set(key, value) {
    try { if (value === null) sessionStorage.removeItem(key); else sessionStorage.setItem(key, value); }
    catch (error) { /* storage unavailable: decks just reset on reload */ }
  },
};
let liveDeck = store.get("sh-live-deck") === "b" ? "b" : "a";
let idleTrack = null; // track prepared on the idle deck: { uri, title, artist, image, duration_ms }
try { idleTrack = JSON.parse(store.get("sh-idle-track") || "null"); } catch (error) { idleTrack = null; }
const otherDeck = (letter) => (letter === "a" ? "b" : "a");

function saveDeckState() {
  store.set("sh-live-deck", liveDeck);
  store.set("sh-idle-track", idleTrack ? JSON.stringify(idleTrack) : null);
}
function setIdleTrack(track) {
  idleTrack = track;
  saveDeckState();
  if (lastState) renderDJ(lastState);
}
function setLiveDeck(letter) {
  liveDeck = letter;
  idleTrack = null; // the prepared track is playing now
  saveDeckState();
  if (lastState) renderDJ(lastState);
}

// Dropping on the idle deck prepares the track there; dropping on the live deck plays it right away.
async function dropOnDeck(letter, track) {
  if (letter === liveDeck) {
    await act("/api/spotify/play_uri", track.context_uri ? { uri: track.uri, context_uri: track.context_uri } : { uri: track.uri });
  } else {
    setIdleTrack({ uri: track.uri, title: track.title, artist: track.artist, image: track.image || "", duration_ms: track.duration_ms });
  }
}

function setupDeckDrop(node, letter) {
  const accepts = (event) => [...(event.dataTransfer?.types ?? [])].includes("application/x-dj-track");
  node.addEventListener("dragover", (event) => {
    if (!accepts(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    node.classList.add("drop-ok");
  });
  node.addEventListener("dragleave", (event) => { if (!node.contains(event.relatedTarget)) node.classList.remove("drop-ok"); });
  node.addEventListener("drop", (event) => {
    event.preventDefault();
    node.classList.remove("drop-ok");
    let track = null;
    try { track = JSON.parse(event.dataTransfer.getData("application/x-dj-track")); } catch (error) { return; }
    if (track && track.uri) dropOnDeck(letter, track);
  });
}

function fader(value, label, onChange) {
  const input = el("input", { type: "range", min: 0, max: 100, value: value ?? 0, class: "fader", orient: "vertical", "aria-label": label });
  input.addEventListener("change", () => onChange(Number(input.value)));
  return input;
}

async function loadPlaylists() {
  if (Date.now() - playlistsLoadedAt < 60000) return;
  playlistsLoadedAt = Date.now();
  try {
    playlists = (await api("/api/spotify/playlists")).playlists;
    renderPads();
    renderLibraryLists();
  } catch (error) {
    playlists = [];
  }
}

function renderPads() {
  // eight quick pads: readable (own) playlists come first; every playlist can be played as a whole
  $("dj-pads").replaceChildren(...playlists.slice(0, 8).map((p, index) =>
    el("button", { class: `pad pad-${index % 4}`, title: p.name, onclick: () => act("/api/spotify/play_uri", { uri: p.uri }) }, p.name)));
}

function renderLibraryLists() {
  const readable = playlists.filter((p) => p.readable);
  const foreign = playlists.filter((p) => !p.readable);
  const item = (p) => el("li", {}, el("button", {
    class: libraryPlaylist && libraryPlaylist.uri === p.uri ? "active" : "",
    "data-uri": p.uri,
    title: p.readable ? p.name : "Titel nicht abrufbar, nur als Ganzes spielbar",
    onclick: () => openPlaylist(p),
  }, `${p.readable ? "" : "🔒 "}${p.name}`));
  $("lib-lists").replaceChildren(
    ...readable.map(item),
    ...(foreign.length ? [el("li", { class: "lib-sep" }, "Playlists anderer")] : []),
    ...foreign.map(item),
  );
  if (!libraryPlaylist && (readable[0] || playlists[0])) openPlaylist(readable[0] || playlists[0]);
}

async function openPlaylist(playlist) {
  libraryPlaylist = playlist;
  const request = ++libraryRequest;
  for (const button of $("lib-lists").querySelectorAll("button")) button.classList.toggle("active", button.dataset.uri === playlist.uri);
  const box = $("lib-tracks");
  if (!playlist.readable) {
    box.replaceChildren(
      el("p", { class: "empty" }, "Spotify gibt die Titel von Playlists anderer Personen nicht für eigene Apps frei. Du kannst sie nur als Ganzes abspielen."),
      el("button", { class: "cue wide", onclick: () => act("/api/spotify/play_uri", { uri: playlist.uri }) }, "▶ Ganze Playlist abspielen"),
    );
    return;
  }
  box.replaceChildren(el("p", { class: "empty" }, "Lade Titel …"));
  try {
    const { tracks } = await api(`/api/spotify/playlists/${encodeURIComponent(playlist.uri.split(":")[2])}/tracks`);
    if (request !== libraryRequest) return;
    box.replaceChildren(...(tracks.length ? tracks.map((t, index) => {
      const track = { uri: t.uri, title: t.title, artist: t.artist, image: t.image || "", duration_ms: t.duration_ms, context_uri: playlist.uri };
      const row = el("div", { class: "track-row", draggable: "true", title: "Auf ein Deck ziehen" },
        el("button", { class: "track", title: "Jetzt auf dem laufenden Deck spielen", onclick: () => dropOnDeck(liveDeck, track) },
          el("span", { class: "n" }, String(index + 1)),
          el("span", { class: "t" }, el("strong", {}, t.title), el("small", {}, t.artist)),
          el("span", { class: "d" }, fmt(t.duration_ms)),
        ),
        el("button", { class: "load-deck a", title: "Auf Deck A", "aria-label": `${t.title} auf Deck A`, onclick: () => dropOnDeck("a", track) }, "→ A"),
        el("button", { class: "load-deck b", title: "Auf Deck B", "aria-label": `${t.title} auf Deck B`, onclick: () => dropOnDeck("b", track) }, "→ B"),
      );
      row.addEventListener("dragstart", (event) => {
        event.dataTransfer.setData("application/x-dj-track", JSON.stringify(track));
        event.dataTransfer.effectAllowed = "copy";
      });
      return row;
    }) : [el("p", { class: "empty" }, "Keine Titel gefunden.")]));
  } catch (error) {
    if (request === libraryRequest) box.replaceChildren(el("p", { class: "empty" }, error.message));
  }
}

// Decorative waveform: Spotify gives no audio data, so the bars are generated from the title.
function makeWave(seed) {
  let h = 2166136261;
  for (const ch of seed) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  const random = () => { h += 0x6d2b79f5; let t = h; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const bars = [];
  let phase = random() * 6;
  for (let i = 0; i < 160; i++) {
    phase += 0.25 + random() * 0.2;
    const envelope = 0.45 + 0.35 * Math.sin(i / 160 * Math.PI);
    bars.push(Math.min(1, Math.max(0.08, envelope * (0.55 + 0.45 * Math.abs(Math.sin(phase))) + random() * 0.18)));
  }
  return bars;
}

function drawWave(position) {
  const canvas = $("wave-live");
  if (!canvas) return;
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth, height = canvas.clientHeight;
  if (canvas.width !== Math.round(width * ratio)) { canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio); }
  const g = canvas.getContext("2d");
  g.setTransform(ratio, 0, 0, ratio, 0, 0);
  g.clearRect(0, 0, width, height);
  const duration = lastNow && lastNow.duration_ms ? lastNow.duration_ms : 1;
  const played = Math.min(1, position / duration);
  const step = width / waveBars.length;
  const color = liveDeck === "a" ? "#19d3ff" : "#ff4fb8";
  waveBars.forEach((value, i) => {
    const barHeight = value * height;
    g.fillStyle = i / waveBars.length <= played ? color : "#3a4678";
    g.fillRect(i * step + 1, (height - barHeight) / 2, Math.max(1, step - 2), barHeight);
  });
  g.fillStyle = "#fff";
  g.fillRect(Math.min(width - 2, played * width), 0, 2, height);
}

function currentPosition() {
  if (!lastNow) return 0;
  return lastNow.playing ? Math.min(lastNow.duration_ms, lastNow.progress_ms + (Date.now() - lastSync)) : lastNow.progress_ms;
}

function setupJog(jog) {
  let center = null, last = 0, turned = 0, base = 0;
  const angleOf = (event) => Math.atan2(event.clientY - center.y, event.clientX - center.x);
  jog.addEventListener("pointerdown", (event) => {
    if (!lastNow) return;
    const rect = jog.getBoundingClientRect();
    center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    last = angleOf(event);
    turned = 0;
    base = currentPosition();
    dragging = true;
    jog.setPointerCapture(event.pointerId);
    jog.classList.add("scratch");
  });
  jog.addEventListener("pointermove", (event) => {
    if (!center) return;
    const angle = angleOf(event);
    let delta = angle - last;
    if (delta > Math.PI) delta -= 2 * Math.PI;
    if (delta < -Math.PI) delta += 2 * Math.PI;
    turned += delta;
    last = angle;
    jog.style.setProperty("--turn", `${(turned * 180) / Math.PI}deg`);
    const label = $("dj-pos");
    if (label) label.textContent = fmt(Math.max(0, base + (turned / (2 * Math.PI)) * 10000));
  });
  const finish = () => {
    if (!center) return;
    center = null;
    jog.classList.remove("scratch");
    jog.style.removeProperty("--turn");
    const target = Math.max(0, Math.min(lastNow.duration_ms, base + (turned / (2 * Math.PI)) * 10000));
    if (Math.abs(turned) > 0.1) act("/api/spotify/seek", { position_ms: Math.round(target) });
    setTimeout(() => { dragging = false; }, 300);
  };
  jog.addEventListener("pointerup", finish);
  jog.addEventListener("pointercancel", finish);
}

const deckTag = (letter, extra) => el("div", { class: "deck-head" },
  el("span", { class: "tag" }, `DECK ${letter.toUpperCase()}`), extra);

function renderLiveDeck(letter, now) {
  const jog = el("div", { class: `jog${now && now.playing ? " spin" : ""}`, role: "img", "aria-label": "Plattenteller: ziehen zum Vor- und Zurückspulen" },
    now && now.image ? el("img", { src: now.image, alt: "" }) : el("div", { class: "label" }, letter.toUpperCase()));
  setupJog(jog);
  const wave = el("canvas", { id: "wave-live", class: "wave", role: "slider", "aria-label": "Position im Titel" });
  wave.addEventListener("click", (event) => {
    if (!now || !now.duration_ms) return;
    const rect = wave.getBoundingClientRect();
    act("/api/spotify/seek", { position_ms: Math.round(((event.clientX - rect.left) / rect.width) * now.duration_ms) });
  });
  return [
    deckTag(letter, el("span", { class: "dev" }, el("span", { class: "live-badge" }, "LIVE"), now && now.device ? ` ${now.device}` : " kein Gerät")),
    el("div", { class: "deck-main" }, jog, el("div", { class: "meta" }, el("strong", {}, now ? now.title : "Nichts läuft"), el("span", {}, now ? now.artist : "Titel hierher ziehen oder Playlist wählen"))),
    wave,
    el("div", { class: "times" }, el("span", { id: "dj-pos" }, fmt(currentPosition())), el("span", { id: "dj-rem" }, `-${fmt(now ? now.duration_ms - currentPosition() : 0)}`)),
    el("div", { class: "transport" },
      el("button", { "aria-label": "Zum Anfang", title: "Zum Anfang", onclick: () => act("/api/spotify/seek", { position_ms: 0 }) }, "⟲"),
      el("button", { class: "play", "aria-label": now && now.playing ? "Pause" : "Wiedergabe", onclick: () => act(`/api/spotify/${now && now.playing ? "pause" : "play"}`) }, now && now.playing ? "⏸" : "▶"),
      el("button", { "aria-label": "Vorheriger Titel", onclick: () => act("/api/spotify/previous") }, "⏮"),
    ),
  ];
}

function renderIdleDeck(letter, queue) {
  const loaded = idleTrack;
  const next = loaded || queue[0];
  return [
    deckTag(letter, el("span", { class: "dev" }, loaded ? "geladen" : "nächster Titel")),
    el("div", { class: "deck-main" },
      el("div", { class: "jog idle" }, next && next.image ? el("img", { src: next.image, alt: "" }) : el("div", { class: "label" }, letter.toUpperCase())),
      el("div", { class: "meta" },
        el("strong", {}, next ? next.title : `Deck ${letter.toUpperCase()} ist leer`),
        el("span", {}, next ? `${next.artist}${loaded && loaded.duration_ms ? " · " + fmt(loaded.duration_ms) : ""}` : "Titel aus der Bibliothek hierher ziehen"),
      ),
    ),
    loaded ? null : el("ol", { class: "queue" }, ...queue.slice(1, 4).map((q) => el("li", {}, el("span", {}, q.title), el("small", {}, q.artist)))),
    el("div", { class: "transport" },
      el("button", { class: "play", disabled: next ? null : "", "aria-label": loaded ? "Geladenen Titel jetzt spielen" : "Nächsten Titel jetzt spielen",
        onclick: async () => {
          const ok = loaded ? await act("/api/spotify/play_uri", { uri: loaded.uri }) : await act("/api/spotify/next");
          if (ok) setLiveDeck(otherDeck(liveDeck)); // that deck is playing now
        } }, "⏭ Jetzt spielen"),
      loaded ? el("button", { "aria-label": `Deck ${letter.toUpperCase()} leeren`, title: "Deck leeren", onclick: () => setIdleTrack(null) }, "✕") : null,
    ),
  ].filter(Boolean);
}

function renderDJ(state) {
  lastState = state;
  const sp = state.spotify;
  $("dj").hidden = !sp.connected;
  if (!sp.connected) return;
  loadPlaylists();
  lastNow = sp.now;
  lastSync = Date.now();
  const now = sp.now;
  const seed = now ? `${now.title}|${now.artist}` : "";
  if (seed !== waveSeed) { waveSeed = seed; waveBars = makeWave(seed || "leer"); }

  for (const letter of ["a", "b"]) {
    const deck = $(`deck-${letter}`);
    deck.classList.toggle("live", letter === liveDeck);
    deck.replaceChildren(...(letter === liveDeck ? renderLiveDeck(letter, now) : renderIdleDeck(letter, sp.queue || [])));
  }
  drawWave(currentPosition());

  // Mixer: one fader per speaker
  const channels = [];
  for (const d of sp.devices || []) {
    channels.push(el("div", { class: `channel${d.active ? " live" : ""}` },
      el("span", { class: "led", "aria-hidden": "true" }),
      fader(d.volume, `${d.name} Lautstärke`, (level) => act("/api/spotify/volume", { level, device_id: d.id })),
      el("strong", {}, d.name),
      el("small", {}, d.volume != null ? `${d.volume} %` : ""),
      el("button", { class: "cue", "aria-label": `Auf ${d.name} abspielen`, onclick: () => act("/api/spotify/transfer", { device_id: d.id }) }, d.active ? "LIVE" : "Abspielen"),
    ));
  }
  // An Echo that is also a Spotify device is one speaker: show it once (as the Spotify channel).
  const spotifyNames = new Set((sp.devices || []).map((d) => d.name.trim().toLowerCase()));
  for (const p of state.entities.filter((e) => e.domain === "media_player" && !spotifyNames.has(e.name.trim().toLowerCase()))) {
    const playing = p.state === "playing";
    channels.push(el("div", { class: `channel echo${playing ? " live" : ""}` },
      el("span", { class: "led", "aria-hidden": "true" }),
      fader(p.volume, `${p.name} Lautstärke`, (level) => act(`/api/media/${encodeURIComponent(p.id)}/volume`, { level })),
      el("strong", {}, p.name),
      el("small", {}, p.volume != null ? `${p.volume} % · Alexa` : "Alexa"),
      el("button", { class: "cue", "aria-label": `${p.name} ${playing ? "pausieren" : "abspielen"}`, onclick: () => act(`/api/media/${encodeURIComponent(p.id)}/${playing ? "pause" : "play"}`) }, playing ? "Pause" : "Play"),
    ));
  }
  $("dj-mixer").replaceChildren(...(channels.length ? channels : [el("p", { class: "empty" }, "Keine Geräte gefunden.")]));
  renderPads();
  syncCrossfader();
}

// The fader sits on the side of the live deck. Drag it to the other side and let go: fade out, change to the track
// prepared on the idle deck (or the next one in the queue), fade in, and the decks swap roles.
function syncCrossfader() {
  const slider = $("xfade");
  slider.value = liveDeck === "a" ? -100 : 100;
  slider.setAttribute("aria-label", `Crossfader: steht bei Deck ${liveDeck.toUpperCase()}. Zur anderen Seite ziehen und loslassen, um überzublenden`);
  const [left, right] = slider.parentElement.querySelectorAll("span");
  left.classList.toggle("live-side", liveDeck === "a");
  right.classList.toggle("live-side", liveDeck === "b");
}

function setupCrossfader() {
  const slider = $("xfade");
  const status = $("xfade-status");
  slider.addEventListener("change", async () => {
    const target = otherDeck(liveDeck);
    const reached = target === "b" ? Number(slider.value) >= 90 : Number(slider.value) <= -90;
    if (!reached) { syncCrossfader(); return; }
    slider.disabled = true;
    status.textContent = "Überblende …";
    busyUntil = Date.now() + 8000;
    const loaded = idleTrack;
    const volumeBefore = lastNow && lastNow.volume != null ? lastNow.volume : null;
    try {
      await api("/api/spotify/crossfade", { seconds: 3, ...(loaded ? { uri: loaded.uri } : {}) });
      setLiveDeck(target);
      status.textContent = "";
    } catch (error) {
      status.textContent = error.message;
      // If the fade was interrupted the speaker may still be turned down: put the volume back.
      if (volumeBefore !== null) await api("/api/spotify/volume", { level: volumeBefore }).catch(() => undefined);
    }
    slider.disabled = false;
    syncCrossfader();
    refresh(true);
  });
}

// keep time labels, waveform playhead and progress moving between server polls
setInterval(() => {
  if (!lastNow || dragging || $("dj").hidden) return;
  const position = currentPosition();
  const label = $("dj-pos");
  if (label) label.textContent = fmt(position);
  const remaining = $("dj-rem");
  if (remaining) remaining.textContent = `-${fmt(lastNow.duration_ms - position)}`;
  drawWave(position);
}, 500);

document.addEventListener("pointerdown", (event) => { if (event.target.matches?.("input[type=range]")) dragging = true; });
document.addEventListener("pointerup", () => { setTimeout(() => { dragging = false; }, 400); });
document.addEventListener("keydown", (event) => {
  if (event.target.matches?.("input:not([type=range]), select, textarea") || $("dj").hidden || $("app").hidden) return;
  if (event.code === "Space") { event.preventDefault(); act(`/api/spotify/${lastNow && lastNow.playing ? "pause" : "play"}`); }
  else if (event.code === "ArrowRight" && !event.target.matches?.("input")) act("/api/spotify/next");
  else if (event.code === "ArrowLeft" && !event.target.matches?.("input")) act("/api/spotify/previous");
});
setupDeckDrop($("deck-a"), "a");
setupDeckDrop($("deck-b"), "b");

// ---- chat
function addMessage(text, who) {
  const log = $("chat-log");
  log.append(el("div", { class: `msg ${who}` }, text));
  log.scrollTop = log.scrollHeight;
}

function speak(text) {
  if (!speakOn || !("speechSynthesis" in window)) return;
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text.replace(/[•\n]+/g, ". "));
  utterance.lang = "de-DE";
  speechSynthesis.speak(utterance);
}

async function send(text) {
  const message = text.trim();
  if (!message) return;
  $("chat-input").value = "";
  addMessage(message, "user");
  try {
    const data = await api("/api/chat", { message });
    addMessage(data.reply, "bot");
    speak(data.reply);
    if (data.changed) refresh(true);
  } catch (error) {
    addMessage(error.message, "bot");
  }
}

function setupChat() {
  addMessage("Hallo! Sag zum Beispiel „Licht im Wohnzimmer an“, „Alexa leiser“ oder „Spiel Queen“. „Hilfe“ zeigt alles.", "bot");
  $("suggestions").append(...SUGGESTIONS.map((s) => el("button", { type: "button", onclick: () => send(s) }, s)));
  $("chat-form").addEventListener("submit", (event) => { event.preventDefault(); send($("chat-input").value); });
  const speakButton = $("speak");
  const paintSpeak = () => { speakButton.textContent = speakOn ? "🔊" : "🔇"; speakButton.setAttribute("aria-pressed", String(speakOn)); };
  speakButton.addEventListener("click", () => { speakOn = !speakOn; localStorage.setItem("sh-speak", speakOn ? "on" : "off"); if (!speakOn) speechSynthesis.cancel(); paintSpeak(); });
  paintSpeak();

  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) return;
  const mic = $("mic");
  mic.hidden = false;
  let recognition = null;
  mic.addEventListener("click", () => {
    if (recognition) { recognition.stop(); return; }
    recognition = new Recognition();
    recognition.lang = "de-DE";
    recognition.interimResults = false;
    recognition.onresult = (event) => { const text = event.results[0][0].transcript; if (text) send(text); };
    recognition.onend = recognition.onerror = () => { recognition = null; mic.classList.remove("mic-on"); };
    mic.classList.add("mic-on");
    recognition.start();
  });
}

// ---- login
$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("login-error").textContent = "";
  try {
    await api("/api/login", { password: $("password").value });
    $("password").value = "";
    showApp();
  } catch (error) {
    $("login-error").textContent = error.message;
  }
});
$("change-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("change-error").textContent = "";
  if ($("pw-new").value !== $("pw-new2").value) {
    $("change-error").textContent = "Die beiden neuen Passwörter sind nicht gleich.";
    return;
  }
  try {
    await api("/api/change-password", { current_password: $("pw-old").value, new_password: $("pw-new").value });
    for (const id of ["pw-old", "pw-new", "pw-new2"]) $(id).value = "";
    showApp();
  } catch (error) {
    $("change-error").textContent = error.message;
  }
});
$("logout").addEventListener("click", async () => { await api("/api/logout", {}).catch(() => undefined); showLogin(); });

setupChat();
setupCrossfader();
api("/api/state").then(showApp).catch((error) => { if (!error.mustChange) showLogin(); });
