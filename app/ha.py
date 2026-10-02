"""Home Assistant client (REST API) plus an in-memory fake for demo mode and tests."""
from __future__ import annotations

import httpx

DOMAINS = ("light", "switch", "fan", "media_player")


class HomeAssistantError(RuntimeError):
    pass


def normalise_state(raw: dict) -> dict | None:
    entity_id = raw.get("entity_id", "")
    domain = entity_id.split(".", 1)[0]
    if domain not in DOMAINS:
        return None
    attrs = raw.get("attributes") or {}
    name = attrs.get("friendly_name") or entity_id
    entity = {"id": entity_id, "domain": domain, "name": name, "state": raw.get("state", "unknown")}
    if domain == "light" and attrs.get("brightness") is not None:
        entity["brightness"] = round(int(attrs["brightness"]) / 255 * 100)
    if domain == "media_player":
        volume = attrs.get("volume_level")
        entity["volume"] = None if volume is None else round(float(volume) * 100)
        entity["title"] = attrs.get("media_title") or ""
        entity["artist"] = attrs.get("media_artist") or ""
    return entity


class HomeAssistant:
    def __init__(self, base_url: str, token: str, client: httpx.Client | None = None):
        self.base_url = base_url.rstrip("/")
        self.client = client or httpx.Client(timeout=10.0)
        self.headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}

    def _request(self, method: str, path: str, **kwargs):
        try:
            response = self.client.request(method, f"{self.base_url}{path}", headers=self.headers, **kwargs)
        except httpx.HTTPError as exc:
            raise HomeAssistantError("Home Assistant ist nicht erreichbar.") from exc
        if response.status_code == 401:
            raise HomeAssistantError("Home Assistant lehnt den Token ab (HA_TOKEN prüfen).")
        if response.status_code == 404:
            raise HomeAssistantError("Home Assistant kennt diese Funktion oder dieses Gerät nicht.")
        if response.status_code >= 400:
            raise HomeAssistantError(f"Home Assistant meldet einen Fehler (HTTP {response.status_code}).")
        return response.json()

    def entities(self) -> list[dict]:
        found = (normalise_state(item) for item in self._request("GET", "/api/states"))
        return sorted((e for e in found if e), key=lambda e: (e["domain"], e["name"].casefold()))

    def call(self, domain: str, service: str, data: dict | None = None) -> None:
        self._request("POST", f"/api/services/{domain}/{service}", json=data or {})


class FakeHomeAssistant:
    """Small in-memory home for demo mode and tests."""

    def __init__(self):
        self.log: list[tuple[str, str, dict]] = []
        self._entities = {
            "light.wohnzimmer_decke": {"id": "light.wohnzimmer_decke", "domain": "light", "name": "Wohnzimmer Decke", "state": "on", "brightness": 80},
            "light.wohnzimmer_stehlampe": {"id": "light.wohnzimmer_stehlampe", "domain": "light", "name": "Wohnzimmer Stehlampe", "state": "off", "brightness": 100},
            "light.schlafzimmer": {"id": "light.schlafzimmer", "domain": "light", "name": "Schlafzimmer", "state": "off", "brightness": 100},
            "light.kueche": {"id": "light.kueche", "domain": "light", "name": "Küche", "state": "on", "brightness": 100},
            "switch.kaffeemaschine": {"id": "switch.kaffeemaschine", "domain": "switch", "name": "Kaffeemaschine", "state": "off"},
            "fan.schlafzimmer_ventilator": {"id": "fan.schlafzimmer_ventilator", "domain": "fan", "name": "Ventilator Schlafzimmer", "state": "off"},
            "media_player.echo_kueche": {"id": "media_player.echo_kueche", "domain": "media_player", "name": "Echo Küche", "state": "playing", "volume": 35, "title": "Radio Bayern 3", "artist": ""},
            "media_player.echo_wohnzimmer": {"id": "media_player.echo_wohnzimmer", "domain": "media_player", "name": "Echo Wohnzimmer", "state": "idle", "volume": 20, "title": "", "artist": ""},
        }

    def entities(self) -> list[dict]:
        return sorted((dict(e) for e in self._entities.values()), key=lambda e: (e["domain"], e["name"].casefold()))

    def call(self, domain: str, service: str, data: dict | None = None) -> None:
        data = data or {}
        self.log.append((domain, service, data))
        ids = data.get("entity_id") or []
        ids = [ids] if isinstance(ids, str) else ids
        for entity_id in ids:
            entity = self._entities.get(entity_id)
            if not entity:
                raise HomeAssistantError("Home Assistant kennt dieses Gerät nicht.")
            if service == "turn_on":
                entity["state"] = "on"
                if "brightness_pct" in data:
                    entity["brightness"] = data["brightness_pct"]
            elif service == "turn_off":
                entity["state"] = "off"
            elif service == "toggle":
                entity["state"] = "off" if entity["state"] == "on" else "on"
            elif service == "media_pause":
                entity["state"] = "paused"
            elif service == "media_play":
                entity["state"] = "playing"
            elif service == "volume_set":
                entity["volume"] = round(data["volume_level"] * 100)
            elif service == "volume_up":
                entity["volume"] = min(100, (entity.get("volume") or 0) + 10)
            elif service == "volume_down":
                entity["volume"] = max(0, (entity.get("volume") or 0) - 10)
