"use strict";

const $ = (id) => document.getElementById(id);
const SUGGESTIONS = ["Licht im Wohnzimmer an", "Alle Lichter aus", "Spiel Queen", "Pause", "Lauter", "Was läuft?", "Hilfe"];
let pollTimer = null;
let speakOn = localStorage.getItem("sh-speak") === "on";
let busyUntil = 0; // pause polling briefly after a user action so sliders don't jump back

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
  if (!force && Date.now() < busyUntil) return;
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
