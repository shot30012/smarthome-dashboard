from __future__ import annotations

import secrets
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
import jwt
from fastapi import Cookie, Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pwdlib import PasswordHash
from pydantic import BaseModel, Field

from . import bot
from .config import get_settings
from .ha import DOMAINS, FakeHomeAssistant, HomeAssistant, HomeAssistantError
from .spotify import FakeSpotify, NotConnected, Spotify, SpotifyError

settings = get_settings()
hasher = PasswordHash.recommended()
STATIC = Path(__file__).parent / "static"
COOKIE = "sh_session"
SESSION_SECRET = settings.session_secret or secrets.token_urlsafe(32)  # empty: sessions end on restart

ha = FakeHomeAssistant() if settings.demo else HomeAssistant(settings.ha_url, settings.ha_token)
spotify = FakeSpotify() if settings.demo else Spotify(
    settings.spotify_client_id, settings.spotify_client_secret, settings.spotify_redirect_uri, settings.data_dir
)

app = FastAPI(title="Smarthome Dashboard", version="0.1.0")

_attempts: dict[str, list[float]] = {}
_lock = threading.Lock()


def check_password(password: str) -> bool:
    if settings.dashboard_password_hash:
        return hasher.verify(password, settings.dashboard_password_hash)
    return settings.demo and password == "demo"  # demo mode only


LOGIN_LIMIT, LOGIN_WINDOW = 5, 900


def login_blocked(key: str) -> bool:
    cutoff = time.monotonic() - LOGIN_WINDOW
    with _lock:
        return len([stamp for stamp in _attempts.get(key, []) if stamp > cutoff]) >= LOGIN_LIMIT


def login_failed(key: str) -> None:
    now = time.monotonic()
    with _lock:
        _attempts[key] = [stamp for stamp in _attempts.get(key, []) if stamp > now - LOGIN_WINDOW] + [now]


def login_succeeded(key: str) -> None:
    with _lock:
        _attempts.pop(key, None)


def make_token() -> str:
    expires = datetime.now(timezone.utc) + timedelta(hours=settings.session_hours)
    return jwt.encode({"exp": expires, "sub": "owner"}, SESSION_SECRET, algorithm="HS256")


def require_login(token: str | None = Cookie(default=None, alias=COOKIE)) -> None:
    try:
        jwt.decode(token or "", SESSION_SECRET, algorithms=["HS256"])
    except jwt.PyJWTError:
        raise HTTPException(401, "Bitte melde dich an.")


@app.middleware("http")
async def same_origin_writes(request: Request, call_next):
    if request.method in {"POST", "PUT", "DELETE", "PATCH"}:
        origin = request.headers.get("origin")
        if origin and origin.split("://", 1)[-1] != request.headers.get("host"):
            return Response("Unzulässige Herkunft", status_code=403)
        if request.headers.get("sec-fetch-site", "same-origin") not in {"same-origin", "none"}:
            return Response("Unzulässige Herkunft", status_code=403)
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-store"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Permissions-Policy"] = "camera=(), microphone=(self), geolocation=()"
    return response


class LoginBody(BaseModel):
    password: str = Field(min_length=1, max_length=200)


class ChatBody(BaseModel):
    message: str = Field(min_length=1, max_length=300)


class LevelBody(BaseModel):
    level: int = Field(ge=0, le=100)


class SpotifyBody(BaseModel):
    level: int | None = Field(default=None, ge=0, le=100)
    position_ms: int | None = Field(default=None, ge=0, le=36_000_000)
    uri: str | None = Field(default=None, pattern=r"^spotify:(track|album|artist|playlist):[A-Za-z0-9]{1,40}$")
    device_id: str | None = Field(default=None, min_length=1, max_length=200)


@app.get("/health")
def health():
    return {"status": "ok", "demo": settings.demo}


@app.post("/api/login")
def login(body: LoginBody, request: Request, response: Response):
    key = f"login:{request.client.host if request.client else '?'}"
    if login_blocked(key):
        raise HTTPException(429, "Zu viele Versuche. Bitte warte ein paar Minuten.")
    if not check_password(body.password):
        login_failed(key)
        raise HTTPException(401, "Passwort ist falsch.")
    login_succeeded(key)
    response.set_cookie(COOKIE, make_token(), httponly=True, samesite="strict", secure=settings.cookie_secure, max_age=settings.session_hours * 3600)
    return {"ok": True}


@app.post("/api/logout")
def logout(response: Response):
    response.delete_cookie(COOKIE)
    return {"ok": True}


# ---- other chatbots: simple health pings, cached for 30 s
_bot_cache: tuple[float, list[dict]] | None = None


def chatbot_status() -> list[dict]:
    global _bot_cache
    if _bot_cache and time.monotonic() - _bot_cache[0] < 30:
        return _bot_cache[1]
    result = [{"name": "Smarthome-Bot", "online": True, "note": "eingebaut, fragt dich Licht, Alexa und Spotify"}]
    for entry in filter(None, (part.strip() for part in settings.chatbots.split(","))):
        name, _, url = entry.partition("|")
        online = False
        if url:
            try:
                online = httpx.get(url, timeout=3.0).status_code < 400
            except httpx.HTTPError:
                online = False
        result.append({"name": name.strip(), "online": online, "url": url.removesuffix("/health") or None})
    _bot_cache = (time.monotonic(), result)
    return result


@app.get("/api/state", dependencies=[Depends(require_login)])
def state():
    payload: dict = {"demo": settings.demo, "entities": [], "ha_error": None, "spotify": {"configured": spotify.configured, "connected": False}, "bots": chatbot_status()}
    try:
        payload["entities"] = ha.entities()
    except HomeAssistantError as exc:
        payload["ha_error"] = str(exc)
    if spotify.configured and spotify.connected:
        try:
            payload["spotify"] = {"configured": True, "connected": True, "now": spotify.now_playing(), "devices": spotify.devices()}
        except SpotifyError as exc:
            payload["spotify"] = {"configured": True, "connected": True, "now": None, "devices": [], "error": str(exc)}
    return payload


def known_entity(entity_id: str, domains: tuple[str, ...] = DOMAINS) -> dict:
    try:
        entities = ha.entities()
    except HomeAssistantError as exc:
        raise HTTPException(502, str(exc))
    for entity in entities:
        if entity["id"] == entity_id and entity["domain"] in domains:
            return entity
    raise HTTPException(404, "Gerät nicht gefunden.")


def run(action):
    try:
        return action()
    except NotConnected as exc:
        raise HTTPException(409, str(exc))
    except (HomeAssistantError, SpotifyError) as exc:
        raise HTTPException(502, str(exc))


@app.post("/api/entity/{entity_id}/{action}", dependencies=[Depends(require_login)])
def entity_action(entity_id: str, action: str, body: LevelBody | None = None):
    if action not in {"on", "off", "toggle", "brightness"}:
        raise HTTPException(404, "Unbekannte Aktion.")
    entity = known_entity(entity_id, ("light", "switch", "fan"))
    if action == "brightness":
        if entity["domain"] != "light" or body is None:
            raise HTTPException(400, "Helligkeit gibt es nur für Lampen.")
        run(lambda: ha.call("light", "turn_on", {"entity_id": entity_id, "brightness_pct": max(1, body.level)}))
    else:
        service = {"on": "turn_on", "off": "turn_off", "toggle": "toggle"}[action]
        run(lambda: ha.call(entity["domain"], service, {"entity_id": entity_id}))
    return {"ok": True}


@app.post("/api/media/{entity_id}/{action}", dependencies=[Depends(require_login)])
def media_action(entity_id: str, action: str, body: LevelBody | None = None):
    services = {"play": "media_play", "pause": "media_pause", "next": "media_next_track", "previous": "media_previous_track", "volume_up": "volume_up", "volume_down": "volume_down", "volume": "volume_set"}
    if action not in services:
        raise HTTPException(404, "Unbekannte Aktion.")
    known_entity(entity_id, ("media_player",))
    data: dict = {"entity_id": entity_id}
    if action == "volume":
        if body is None:
            raise HTTPException(400, "Lautstärke fehlt.")
        data["volume_level"] = body.level / 100
    run(lambda: ha.call("media_player", services[action], data))
    return {"ok": True}


@app.post("/api/spotify/{action}", dependencies=[Depends(require_login)])
def spotify_action(action: str, body: SpotifyBody | None = None):
    body = body or SpotifyBody()
    def do():
        if action == "pause":
            spotify.pause()
        elif action == "play":
            spotify.play()
        elif action == "next":
            spotify.next()
        elif action == "previous":
            spotify.previous()
        elif action == "volume" and body.level is not None:
            spotify.volume(body.level, body.device_id)
        elif action == "seek" and body.position_ms is not None:
            spotify.seek(body.position_ms)
        elif action == "play_uri" and body.uri is not None:
            kind = body.uri.split(":")[1]
            spotify.play(body.uri, kind, body.device_id)
        elif action == "transfer" and body.device_id is not None:
            spotify.transfer(body.device_id)
        else:
            raise HTTPException(404, "Unbekannte Aktion.")

    run(do)
    return {"ok": True}


@app.get("/api/spotify/playlists", dependencies=[Depends(require_login)])
def spotify_playlists():
    if not (spotify.configured and spotify.connected):
        return {"playlists": []}
    return {"playlists": run(spotify.playlists)}


@app.post("/api/chat", dependencies=[Depends(require_login)])
def chat(body: ChatBody):
    try:
        entities = ha.entities()
    except HomeAssistantError:
        entities = []
    devices: list[dict] = []
    ready = spotify.configured and spotify.connected
    if ready:
        try:
            devices = spotify.devices()
        except SpotifyError:
            devices = []
    command = bot.interpret(body.message, entities, devices, spotify_ready=ready)
    reply = bot.execute(command, ha, spotify)
    return {"reply": reply.text, "changed": reply.changed}


# ---- Spotify OAuth (one-time connect from the dashboard)
@app.get("/spotify/login", dependencies=[Depends(require_login)])
def spotify_login():
    if not spotify.configured:
        raise HTTPException(409, "SPOTIFY_CLIENT_ID und SPOTIFY_CLIENT_SECRET fehlen in der .env.")
    state_value = secrets.token_urlsafe(16)
    redirect = RedirectResponse(spotify.authorize_url(state_value))
    redirect.set_cookie("sh_oauth_state", state_value, httponly=True, samesite="lax", secure=settings.cookie_secure, max_age=600)
    return redirect


@app.get("/spotify/callback", dependencies=[Depends(require_login)])
def spotify_callback(code: str = "", state: str = "", error: str = "", oauth_state: str | None = Cookie(default=None, alias="sh_oauth_state")):
    if error or not code or not oauth_state or not secrets.compare_digest(state, oauth_state):
        raise HTTPException(400, "Spotify-Anmeldung abgebrochen oder ungültig.")
    run(lambda: spotify.exchange_code(code))
    response = RedirectResponse("/")
    response.delete_cookie("sh_oauth_state")
    return response


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html")


app.mount("/static", StaticFiles(directory=STATIC), name="static")
