"""Spotify Web API client (authorization-code flow) plus an in-memory fake."""
from __future__ import annotations

import json
import logging
import os
import time
import urllib.parse
from pathlib import Path

import httpx

AUTH_URL = "https://accounts.spotify.com/authorize"
TOKEN_URL = "https://accounts.spotify.com/api/token"
API = "https://api.spotify.com/v1"
SCOPES = "user-read-playback-state user-modify-playback-state user-read-currently-playing playlist-read-private"


LOGGER = logging.getLogger("dashboard.spotify")


class SpotifyError(RuntimeError):
    pass


class NotConnected(SpotifyError):
    pass


def _error_text(response: httpx.Response) -> str:
    try:
        error = response.json().get("error")
        if isinstance(error, dict):
            return str(error.get("message", ""))[:200]
        return str(error or "")[:200]
    except ValueError:
        return ""


def track_summary(item: dict | None) -> dict | None:
    if not item:
        return None
    artists = ", ".join(a.get("name", "") for a in item.get("artists") or [])
    images = (item.get("album") or {}).get("images") or []
    return {"title": item.get("name", ""), "artist": artists, "image": images[-1]["url"] if images else ""}


class Spotify:
    def __init__(self, client_id: str, client_secret: str, redirect_uri: str, data_dir: str, client: httpx.Client | None = None):
        self.client_id, self.client_secret, self.redirect_uri = client_id, client_secret, redirect_uri
        self.token_file = Path(data_dir) / "spotify_token.json"
        self.client = client or httpx.Client(timeout=10.0)
        self._access: tuple[str, float] | None = None

    # ---- OAuth
    @property
    def configured(self) -> bool:
        return bool(self.client_id and self.client_secret)

    @property
    def connected(self) -> bool:
        return self._refresh_token() is not None

    def authorize_url(self, state: str) -> str:
        query = urllib.parse.urlencode({
            "client_id": self.client_id, "response_type": "code", "redirect_uri": self.redirect_uri,
            "scope": SCOPES, "state": state,
        })
        return f"{AUTH_URL}?{query}"

    def _refresh_token(self) -> str | None:
        try:
            return json.loads(self.token_file.read_text("utf-8")).get("refresh_token")
        except (OSError, ValueError):
            return None

    def _store_refresh_token(self, token: str) -> None:
        self.token_file.parent.mkdir(parents=True, exist_ok=True)
        self.token_file.write_text(json.dumps({"refresh_token": token}), "utf-8")
        try:
            os.chmod(self.token_file, 0o600)
        except OSError:
            pass

    def _token_request(self, data: dict) -> dict:
        try:
            response = self.client.post(TOKEN_URL, data=data, auth=(self.client_id, self.client_secret))
        except httpx.HTTPError as exc:
            raise SpotifyError("Spotify ist nicht erreichbar.") from exc
        if response.status_code >= 400:
            raise SpotifyError("Spotify hat die Anmeldung abgelehnt. Bitte neu verbinden.")
        return response.json()

    def exchange_code(self, code: str) -> None:
        payload = self._token_request({"grant_type": "authorization_code", "code": code, "redirect_uri": self.redirect_uri})
        self._store_refresh_token(payload["refresh_token"])
        self._access = (payload["access_token"], time.time() + payload.get("expires_in", 3600) - 60)

    def _access_token(self) -> str:
        if self._access and self._access[1] > time.time():
            return self._access[0]
        refresh = self._refresh_token()
        if not refresh:
            raise NotConnected("Spotify ist noch nicht verbunden.")
        payload = self._token_request({"grant_type": "refresh_token", "refresh_token": refresh})
        if payload.get("refresh_token"):
            self._store_refresh_token(payload["refresh_token"])
        self._access = (payload["access_token"], time.time() + payload.get("expires_in", 3600) - 60)
        return self._access[0]

    # ---- API
    def _api(self, method: str, path: str, **kwargs):
        try:
            response = self.client.request(method, f"{API}{path}", headers={"Authorization": f"Bearer {self._access_token()}"}, **kwargs)
        except httpx.HTTPError as exc:
            raise SpotifyError("Spotify ist nicht erreichbar.") from exc
        if response.status_code == 204 or (response.status_code == 202):
            return None
        if response.status_code >= 400:
            # Spotify's own explanation goes to the server log (never the tokens), so a failure can be understood later.
            LOGGER.warning("Spotify %s %s -> %s %s", method, path, response.status_code, _error_text(response))
        is_playlist = path.startswith("/playlists/")
        if response.status_code == 401:
            self._access = None
            raise SpotifyError("Spotify-Sitzung abgelaufen. Bitte neu verbinden.")
        if response.status_code == 403:
            if is_playlist:
                raise SpotifyError("Spotify gibt die Titel dieser Playlist nicht frei (gilt zum Beispiel für von Spotify erstellte Playlists und Playlists anderer Personen). Wähle eine eigene Playlist.")
            raise SpotifyError("Spotify erlaubt das nicht. Für die Steuerung ist Spotify Premium nötig.")
        if response.status_code == 404:
            if is_playlist:
                raise SpotifyError("Diese Playlist wurde nicht gefunden.")
            raise SpotifyError("Kein aktives Spotify-Gerät. Öffne Spotify auf einem Gerät oder wähle ein Gerät aus.")
        if response.status_code == 429:
            raise SpotifyError("Spotify bremst gerade. Versuch es gleich noch einmal.")
        if response.status_code >= 400:
            raise SpotifyError(f"Spotify meldet einen Fehler (HTTP {response.status_code}).")
        return response.json() if response.content else None

    def now_playing(self) -> dict | None:
        data = self._api("GET", "/me/player")
        if not data or not data.get("item"):
            return None
        summary = track_summary(data["item"]) or {}
        device = data.get("device") or {}
        return {
            **summary, "playing": bool(data.get("is_playing")), "device": device.get("name", ""), "volume": device.get("volume_percent"),
            "progress_ms": data.get("progress_ms") or 0, "duration_ms": data["item"].get("duration_ms") or 0,
        }

    def devices(self) -> list[dict]:
        data = self._api("GET", "/me/player/devices") or {}
        return [{"id": d["id"], "name": d["name"], "active": d.get("is_active", False), "volume": d.get("volume_percent")} for d in data.get("devices", [])]

    def playlists(self) -> list[dict]:
        data = self._api("GET", "/me/playlists", params={"limit": 12}) or {}
        result = []
        for item in data.get("items") or []:
            if not item:
                continue
            images = item.get("images") or []
            result.append({"uri": item["uri"], "name": item.get("name", ""), "image": images[-1]["url"] if images else ""})
        return result

    def seek(self, position_ms: int) -> None:
        self._api("PUT", "/me/player/seek", params={"position_ms": max(0, position_ms)})

    def queue(self) -> list[dict]:
        data = self._api("GET", "/me/player/queue") or {}
        result = []
        for item in (data.get("queue") or [])[:8]:
            summary = track_summary(item) or {}
            result.append({**summary, "uri": item.get("uri", ""), "duration_ms": item.get("duration_ms") or 0})
        return result

    def playlist_tracks(self, playlist_id: str) -> list[dict]:
        data = self._api("GET", f"/playlists/{playlist_id}/tracks", params={"limit": 50, "fields": "items(track(uri,name,duration_ms,artists(name),album(images)))"}) or {}
        result = []
        for entry in data.get("items") or []:
            item = (entry or {}).get("track")
            if not item or not item.get("uri", "").startswith("spotify:track:"):
                continue
            summary = track_summary(item) or {}
            result.append({**summary, "uri": item["uri"], "duration_ms": item.get("duration_ms") or 0})
        return result

    def play_in_context(self, context_uri: str, track_uri: str, device_id: str | None = None) -> None:
        params = {"device_id": device_id} if device_id else None
        self._api("PUT", "/me/player/play", params=params, json={"context_uri": context_uri, "offset": {"uri": track_uri}})

    def search(self, query: str, kind: str = "track") -> dict | None:
        data = self._api("GET", "/search", params={"q": query, "type": kind, "limit": 1}) or {}
        items = (data.get(f"{kind}s") or {}).get("items") or []
        if not items:
            return None
        item = items[0]
        return {"uri": item["uri"], "name": item["name"], "kind": kind, "artist": ", ".join(a["name"] for a in item.get("artists") or [])}

    def play(self, uri: str | None = None, kind: str = "track", device_id: str | None = None) -> None:
        params = {"device_id": device_id} if device_id else None
        body: dict = {}
        if uri:
            body = {"uris": [uri]} if kind == "track" else {"context_uri": uri}
        self._api("PUT", "/me/player/play", params=params, json=body or None)

    def pause(self) -> None:
        self._api("PUT", "/me/player/pause")

    def next(self) -> None:
        self._api("POST", "/me/player/next")

    def previous(self) -> None:
        self._api("POST", "/me/player/previous")

    def volume(self, percent: int, device_id: str | None = None) -> None:
        params = {"volume_percent": max(0, min(100, percent))}
        if device_id:
            params["device_id"] = device_id
        self._api("PUT", "/me/player/volume", params=params)

    def transfer(self, device_id: str) -> None:
        self._api("PUT", "/me/player", json={"device_ids": [device_id], "play": True})


class FakeSpotify:
    """Demo/test double with the same surface as Spotify."""

    configured = True
    connected = True

    def __init__(self):
        self.log: list[tuple] = []
        self._devices = [
            {"id": "d1", "name": "Echo Küche", "active": True, "volume": 35},
            {"id": "d2", "name": "Echo Wohnzimmer", "active": False, "volume": 20},
            {"id": "d3", "name": "Dominiks Handy", "active": False, "volume": 50},
        ]
        self._queue = [
            {"title": "Don't Stop Me Now", "artist": "Queen", "image": "", "uri": "spotify:track:q1", "duration_ms": 209000},
            {"title": "Under Pressure", "artist": "Queen & David Bowie", "image": "", "uri": "spotify:track:q2", "duration_ms": 248000},
            {"title": "Another One Bites the Dust", "artist": "Queen", "image": "", "uri": "spotify:track:q3", "duration_ms": 215000},
        ]
        self._playing = {
            "title": "Bohemian Rhapsody", "artist": "Queen", "image": "", "playing": True, "device": "Echo Küche", "volume": 35,
            "progress_ms": 61000, "duration_ms": 354000,
        }

    def now_playing(self):
        return dict(self._playing) if self._playing else None

    def devices(self):
        return [dict(d) for d in self._devices]

    def search(self, query, kind="track"):
        self.log.append(("search", query, kind))
        if "nichtsda" in query.casefold():
            return None
        return {"uri": f"spotify:{kind}:demo", "name": query.title(), "kind": kind, "artist": "Demo-Künstler"}

    def play(self, uri=None, kind="track", device_id=None):
        self.log.append(("play", uri, kind, device_id))
        device = next((d for d in self._devices if d["id"] == device_id), None) or next(d for d in self._devices if d["active"])
        for item in self._devices:
            item["active"] = item is device
        title = (uri or "").split(":")[-1].title() if uri else self._playing["title"] if self._playing else "Demo"
        self._playing = {**(self._playing or {"artist": "Demo-Künstler", "image": ""}), "title": title or "Demo", "playing": True, "device": device["name"], "volume": device["volume"]}

    def pause(self):
        self.log.append(("pause",))
        if self._playing:
            self._playing["playing"] = False

    def next(self):
        self.log.append(("next",))
        if self._queue and self._playing:
            upcoming = self._queue.pop(0)
            self._queue.append({**self._playing, "uri": "spotify:track:recycled", "duration_ms": 200000})
            self._playing.update({"title": upcoming["title"], "artist": upcoming["artist"], "progress_ms": 0, "duration_ms": upcoming.get("duration_ms", 200000)})

    def previous(self):
        self.log.append(("previous",))

    def volume(self, percent, device_id=None):
        self.log.append(("volume", percent, device_id))
        level = max(0, min(100, percent))
        for device in self._devices:
            if (device["id"] == device_id) if device_id else device["active"]:
                device["volume"] = level
                if self._playing and device["name"] == self._playing["device"]:
                    self._playing["volume"] = level

    def queue(self):
        return [dict(item) for item in self._queue]

    def playlist_tracks(self, playlist_id):
        return [
            {"uri": f"spotify:track:{playlist_id}{n}", "title": f"{playlist_id.title()} Track {n}", "artist": "Demo-Künstler", "image": "", "duration_ms": 180000 + n * 7000}
            for n in range(1, 7)
        ]

    def play_in_context(self, context_uri, track_uri, device_id=None):
        self.log.append(("play_in_context", context_uri, track_uri, device_id))
        self.play(track_uri, "track", device_id)

    def playlists(self):
        return [{"uri": f"spotify:playlist:{key}", "name": name, "image": ""} for key, name in (("chill", "Chill Vibes"), ("party", "Party Hits"), ("focus", "Deep Focus"), ("rock", "Rock Klassiker"))]

    def seek(self, position_ms):
        self.log.append(("seek", position_ms))
        if self._playing:
            self._playing["progress_ms"] = max(0, position_ms)

    def transfer(self, device_id):
        self.log.append(("transfer", device_id))
        self.play(None, "track", device_id)
