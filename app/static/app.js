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

// ---- DJ-Pult
const fmt = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

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
  } catch (error) {
    playlists = [];
  }
}

function renderPads() {
  const pads = $("dj-pads");
  pads.replaceChildren(...playlists.map((p, index) =>
    el("button", { class: `pad pad-${index % 4}`, title: p.name, onclick: () => act("/api/spotify/play_uri", { uri: p.uri }) }, p.name)));
}

function renderDJ(state) {
  const sp = state.spotify;
  const dj = $("dj");
  dj.hidden = !sp.connected;
  if (!sp.connected) return;
  loadPlaylists();
  lastNow = sp.now;
  lastSync = Date.now();
  const now = sp.now;
  const deck = $("dj-deck");
  deck.replaceChildren(
    el("div", { class: "now" },
      now && now.image ? el("img", { src: now.image, alt: "" }) : el("div", { class: "cover" }),
      el("div", {}, el("strong", { id: "dj-title-now" }, now ? now.title : "Nichts läuft"), el("span", {}, now ? now.artist : "Wähle unten eine Playlist")),
    ),
    el("div", { class: "progress" },
      el("span", { id: "dj-pos" }, fmt(now ? now.progress_ms : 0)),
      el("input", { type: "range", id: "dj-seek", min: 0, max: now && now.duration_ms ? now.duration_ms : 1, value: now ? now.progress_ms : 0, "aria-label": "Position im Titel" }),
      el("span", {}, fmt(now ? now.duration_ms : 0)),
    ),
    el("div", { class: "controls" },
      el("button", { "aria-label": "Zurück", onclick: () => act("/api/spotify/previous") }, "⏮"),
      el("button", { class: "big", "aria-label": now && now.playing ? "Pause" : "Wiedergabe", onclick: () => act(`/api/spotify/${now && now.playing ? "pause" : "play"}`) }, now && now.playing ? "⏸" : "▶"),
      el("button", { "aria-label": "Weiter", onclick: () => act("/api/spotify/next") }, "⏭"),
    ),
  );
  $("dj-seek").addEventListener("change", (event) => act("/api/spotify/seek", { position_ms: Number(event.target.value) }));

  const mixer = $("dj-mixer");
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
  for (const p of state.entities.filter((e) => e.domain === "media_player")) {
    const playing = p.state === "playing";
    channels.push(el("div", { class: `channel echo${playing ? " live" : ""}` },
      el("span", { class: "led", "aria-hidden": "true" }),
      fader(p.volume, `${p.name} Lautstärke`, (level) => act(`/api/media/${encodeURIComponent(p.id)}/volume`, { level })),
      el("strong", {}, p.name),
      el("small", {}, p.volume != null ? `${p.volume} % · Alexa` : "Alexa"),
      el("button", { class: "cue", "aria-label": `${p.name} ${playing ? "pausieren" : "abspielen"}`, onclick: () => act(`/api/media/${encodeURIComponent(p.id)}/${playing ? "pause" : "play"}`) }, playing ? "Pause" : "Play"),
    ));
  }
  mixer.replaceChildren(...(channels.length ? channels : [el("p", { class: "empty" }, "Keine Geräte gefunden.")]));
  renderPads();
}

// move the progress bar between server polls
setInterval(() => {
  if (!lastNow || !lastNow.playing || dragging || $("dj").hidden) return;
  const position = Math.min(lastNow.duration_ms, lastNow.progress_ms + (Date.now() - lastSync));
  const seek = $("dj-seek");
  if (seek) seek.value = position;
  const label = $("dj-pos");
  if (label) label.textContent = fmt(position);
}, 1000);

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
api("/api/state").then(showApp).catch(showLogin);
