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
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.detail || "Das hat nicht geklappt.");
  return data;
}

function showLogin() {
  clearInterval(pollTimer);
  $("app").hidden = true;
  $("login").hidden = false;
  $("password").focus();
}

function showApp() {
  $("login").hidden = true;
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

async function act(path, body) {
  busyUntil = Date.now() + 1500;
  try {
    await api(path, body === undefined ? {} : body);
    banner("");
  } catch (error) {
    banner(error.message);
  }
  await refresh(true);
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
    body.append(el("p", { class: "empty" }, "Verbinde dein Spotify-Premium-Konto einmalig."), el("a", { class: "primary", href: "/spotify/login", style: "display:inline-grid;place-items:center;text-decoration:none" }, "Spotify verbinden"));
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
const fmt = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
let libraryPlaylist = null; // { uri, name }
let libraryRequest = 0;
let waveSeed = "";
let waveBars = [];

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
  $("dj-pads").replaceChildren(...playlists.map((p, index) =>
    el("button", { class: `pad pad-${index % 4}`, title: p.name, onclick: () => act("/api/spotify/play_uri", { uri: p.uri }) }, p.name)));
}

function renderLibraryLists() {
  const lists = $("lib-lists");
  lists.replaceChildren(...playlists.map((p) => {
    const button = el("button", { class: libraryPlaylist && libraryPlaylist.uri === p.uri ? "active" : "", onclick: () => openPlaylist(p) }, p.name);
    return el("li", {}, button);
  }));
  if (!libraryPlaylist && playlists.length) openPlaylist(playlists[0]);
}

async function openPlaylist(playlist) {
  libraryPlaylist = playlist;
  const request = ++libraryRequest;
  for (const button of $("lib-lists").querySelectorAll("button")) button.classList.toggle("active", button.textContent === playlist.name);
  const box = $("lib-tracks");
  box.replaceChildren(el("p", { class: "empty" }, "Lade Titel …"));
  try {
    const { tracks } = await api(`/api/spotify/playlists/${encodeURIComponent(playlist.uri.split(":")[2])}/tracks`);
    if (request !== libraryRequest) return;
    box.replaceChildren(...(tracks.length ? tracks.map((t, index) =>
      el("button", { class: "track", onclick: () => act("/api/spotify/play_uri", { uri: t.uri, context_uri: playlist.uri }) },
        el("span", { class: "n" }, String(index + 1)),
        el("span", { class: "t" }, el("strong", {}, t.title), el("small", {}, t.artist)),
        el("span", { class: "d" }, fmt(t.duration_ms)),
      )) : [el("p", { class: "empty" }, "Keine Titel gefunden.")]));
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
  const canvas = $("wave-a");
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
  waveBars.forEach((value, i) => {
    const barHeight = value * height;
    g.fillStyle = i / waveBars.length <= played ? "#19d3ff" : "#3a4678";
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
  let center = null, startAngle = 0, turned = 0, last = 0, base = 0;
  const angleOf = (event) => Math.atan2(event.clientY - center.y, event.clientX - center.x);
  jog.addEventListener("pointerdown", (event) => {
    if (!lastNow) return;
    const rect = jog.getBoundingClientRect();
    center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    startAngle = last = angleOf(event);
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

function renderDJ(state) {
  const sp = state.spotify;
  $("dj").hidden = !sp.connected;
  if (!sp.connected) return;
  loadPlaylists();
  lastNow = sp.now;
  lastSync = Date.now();
  const now = sp.now;
  const seed = now ? `${now.title}|${now.artist}` : "";
  if (seed !== waveSeed) { waveSeed = seed; waveBars = makeWave(seed || "leer"); }

  // Deck A: what is playing
  const jog = el("div", { class: `jog${now && now.playing ? " spin" : ""}`, role: "img", "aria-label": "Plattenteller: ziehen zum Vor- und Zurückspulen" },
    now && now.image ? el("img", { src: now.image, alt: "" }) : el("div", { class: "label" }, "A"));
  setupJog(jog);
  const wave = el("canvas", { id: "wave-a", class: "wave", role: "slider", "aria-label": "Position im Titel" });
  wave.addEventListener("click", (event) => {
    if (!now || !now.duration_ms) return;
    const rect = wave.getBoundingClientRect();
    act("/api/spotify/seek", { position_ms: Math.round(((event.clientX - rect.left) / rect.width) * now.duration_ms) });
  });
  $("deck-a").replaceChildren(
    el("div", { class: "deck-head" }, el("span", { class: "tag" }, "DECK A"), el("span", { class: "dev" }, now && now.device ? now.device : "kein Gerät")),
    el("div", { class: "deck-main" }, jog, el("div", { class: "meta" }, el("strong", {}, now ? now.title : "Nichts läuft"), el("span", {}, now ? now.artist : "Wähle unten eine Playlist"))),
    wave,
    el("div", { class: "times" }, el("span", { id: "dj-pos" }, fmt(currentPosition())), el("span", { id: "dj-rem" }, `-${fmt(now ? now.duration_ms - currentPosition() : 0)}`)),
    el("div", { class: "transport" },
      el("button", { "aria-label": "Zum Anfang", title: "Zum Anfang", onclick: () => act("/api/spotify/seek", { position_ms: 0 }) }, "⟲"),
      el("button", { class: "play", "aria-label": now && now.playing ? "Pause" : "Wiedergabe", onclick: () => act(`/api/spotify/${now && now.playing ? "pause" : "play"}`) }, now && now.playing ? "⏸" : "▶"),
      el("button", { "aria-label": "Vorheriger Titel", onclick: () => act("/api/spotify/previous") }, "⏮"),
    ),
  );
  drawWave(currentPosition());

  // Deck B: what is next
  const queue = sp.queue || [];
  const next = queue[0];
  $("deck-b").replaceChildren(
    el("div", { class: "deck-head" }, el("span", { class: "tag b" }, "DECK B"), el("span", { class: "dev" }, "nächster Titel")),
    el("div", { class: "deck-main" },
      el("div", { class: "jog idle" }, next && next.image ? el("img", { src: next.image, alt: "" }) : el("div", { class: "label" }, "B")),
      el("div", { class: "meta" }, el("strong", {}, next ? next.title : "Warteschlange leer"), el("span", {}, next ? next.artist : "Titel in der Bibliothek anklicken")),
    ),
    el("ol", { class: "queue" }, ...queue.slice(1, 4).map((q) => el("li", {}, el("span", {}, q.title), el("small", {}, q.artist)))),
    el("div", { class: "transport" },
      el("button", { class: "play b", disabled: next ? null : "", "aria-label": "Nächsten Titel jetzt spielen", onclick: () => act("/api/spotify/next") }, "⏭ Jetzt spielen"),
    ),
  );

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
}

// Crossfader: drag to B and release = fade out, skip to the next track, fade back in.
function setupCrossfader() {
  const slider = $("xfade");
  const status = $("xfade-status");
  slider.addEventListener("change", async () => {
    const reachedB = Number(slider.value) >= 90;
    slider.disabled = true;
    if (reachedB) {
      status.textContent = "Überblende …";
      busyUntil = Date.now() + 8000;
      try { await api("/api/spotify/crossfade", { seconds: 3 }); status.textContent = ""; }
      catch (error) { status.textContent = error.message; }
    }
    slider.value = -100;
    slider.disabled = false;
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
$("logout").addEventListener("click", async () => { await api("/api/logout", {}).catch(() => undefined); showLogin(); });

setupChat();
setupCrossfader();
api("/api/state").then(showApp).catch(showLogin);
