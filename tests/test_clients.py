"""The real HTTP clients, driven by httpx.MockTransport (no network)."""
import json

import httpx
import pytest

from app.ha import HomeAssistant, HomeAssistantError, normalise_state
from app.spotify import NotConnected, Spotify, SpotifyError


def ha_with(handler):
    return HomeAssistant("http://ha.local:8123/", "TOKEN", httpx.Client(transport=httpx.MockTransport(handler)))


def test_ha_entities_filtered_and_normalised():
    def handler(request):
        assert request.headers["authorization"] == "Bearer TOKEN"
        return httpx.Response(200, json=[
            {"entity_id": "light.sofa", "state": "on", "attributes": {"friendly_name": "Sofa", "brightness": 128}},
            {"entity_id": "media_player.echo_dot", "state": "playing", "attributes": {"friendly_name": "Echo Dot", "volume_level": 0.35, "media_title": "Song"}},
            {"entity_id": "sensor.temperatur", "state": "21", "attributes": {}},
            {"entity_id": "lock.haustuer", "state": "locked", "attributes": {}},
        ])

    entities = ha_with(handler).entities()
    assert [e["id"] for e in entities] == ["light.sofa", "media_player.echo_dot"]
    assert entities[0]["brightness"] == 50
    assert entities[1]["volume"] == 35 and entities[1]["title"] == "Song"


def test_ha_call_posts_service():
    seen = {}

    def handler(request):
        seen["url"] = str(request.url)
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json=[])

    ha_with(handler).call("light", "turn_on", {"entity_id": "light.sofa"})
    assert seen["url"] == "http://ha.local:8123/api/services/light/turn_on"
    assert seen["body"] == {"entity_id": "light.sofa"}


@pytest.mark.parametrize("status, text", [(401, "Token"), (404, "kennt"), (500, "Fehler")])
def test_ha_errors_are_german_messages(status, text):
    with pytest.raises(HomeAssistantError, match=text):
        ha_with(lambda request: httpx.Response(status)).entities()


def test_ha_unreachable():
    def handler(request):
        raise httpx.ConnectError("down")

    with pytest.raises(HomeAssistantError, match="nicht erreichbar"):
        ha_with(handler).entities()


def test_normalise_ignores_other_domains():
    assert normalise_state({"entity_id": "sensor.x", "state": "1"}) is None


def spotify_with(handler, tmp_path, refresh="REFRESH"):
    client = Spotify("id", "secret", "http://127.0.0.1:8765/spotify/callback", str(tmp_path), httpx.Client(transport=httpx.MockTransport(handler)))
    if refresh:
        client._store_refresh_token(refresh)
    return client


def test_spotify_not_connected_without_token(tmp_path):
    client = spotify_with(lambda request: httpx.Response(500), tmp_path, refresh=None)
    assert not client.connected
    with pytest.raises(NotConnected):
        client.now_playing()


def test_spotify_refreshes_token_once_and_plays(tmp_path):
    calls = []

    def handler(request):
        calls.append((request.method, request.url.path, dict(request.url.params)))
        if request.url.host == "accounts.spotify.com":
            return httpx.Response(200, json={"access_token": "ACCESS", "expires_in": 3600})
        assert request.headers["authorization"] == "Bearer ACCESS"
        return httpx.Response(204)

    client = spotify_with(handler, tmp_path)
    client.pause()
    client.play("spotify:track:1", "track", "dev1")
    token_calls = [c for c in calls if c[1] == "/api/token"]
    assert len(token_calls) == 1
    assert ("PUT", "/v1/me/player/play", {"device_id": "dev1"}) in calls


def test_spotify_play_body_track_vs_context(tmp_path):
    bodies = []

    def handler(request):
        if request.url.host == "accounts.spotify.com":
            return httpx.Response(200, json={"access_token": "A", "expires_in": 3600})
        bodies.append(json.loads(request.content) if request.content else None)
        return httpx.Response(204)

    client = spotify_with(handler, tmp_path)
    client.play("spotify:track:1", "track")
    client.play("spotify:playlist:2", "playlist")
    client.play()
    assert bodies == [{"uris": ["spotify:track:1"]}, {"context_uri": "spotify:playlist:2"}, None]


@pytest.mark.parametrize("status, text", [(403, "Premium"), (404, "Gerät"), (429, "bremst")])
def test_spotify_error_messages(tmp_path, status, text):
    def handler(request):
        if request.url.host == "accounts.spotify.com":
            return httpx.Response(200, json={"access_token": "A", "expires_in": 3600})
        return httpx.Response(status)

    with pytest.raises(SpotifyError, match=text):
        spotify_with(handler, tmp_path).pause()


def test_spotify_search_and_now_playing(tmp_path):
    def handler(request):
        if request.url.host == "accounts.spotify.com":
            return httpx.Response(200, json={"access_token": "A", "expires_in": 3600})
        if request.url.path == "/v1/search":
            return httpx.Response(200, json={"tracks": {"items": [{"uri": "spotify:track:9", "name": "Song", "artists": [{"name": "Band"}]}]}})
        return httpx.Response(200, json={"is_playing": True, "device": {"name": "Echo", "volume_percent": 30},
                                         "item": {"name": "Song", "artists": [{"name": "Band"}], "album": {"images": [{"url": "http://img"}]}}})

    client = spotify_with(handler, tmp_path)
    assert client.search("song band")["uri"] == "spotify:track:9"
    now = client.now_playing()
    assert (now["title"], now["artist"], now["device"], now["volume"], now["playing"]) == ("Song", "Band", "Echo", 30, True)


def test_spotify_authorize_url_and_exchange(tmp_path):
    def handler(request):
        assert b"authorization_code" in request.content
        return httpx.Response(200, json={"access_token": "A", "refresh_token": "NEWREFRESH", "expires_in": 3600})

    client = spotify_with(handler, tmp_path, refresh=None)
    url = client.authorize_url("state123")
    assert "client_id=id" in url and "state=state123" in url and "user-modify-playback-state" in url
    client.exchange_code("code")
    assert client.connected
    assert json.loads((tmp_path / "spotify_token.json").read_text())["refresh_token"] == "NEWREFRESH"


def test_spotify_playlists_seek_and_progress(tmp_path):
    calls = []

    def handler(request):
        if request.url.host == "accounts.spotify.com":
            return httpx.Response(200, json={"access_token": "A", "expires_in": 3600})
        calls.append((request.method, request.url.path, dict(request.url.params)))
        if request.url.path == "/v1/me/playlists":
            return httpx.Response(200, json={"items": [{"uri": "spotify:playlist:1", "name": "Chill", "images": [{"url": "http://i"}]}, None]})
        if request.url.path == "/v1/me/player":
            return httpx.Response(200, json={"is_playing": True, "progress_ms": 5000, "device": {"name": "Echo"}, "item": {"name": "S", "duration_ms": 200000, "artists": [], "album": {}}})
        return httpx.Response(204)

    client = spotify_with(handler, tmp_path)
    assert client.playlists() == [{"uri": "spotify:playlist:1", "name": "Chill", "image": "http://i"}]
    client.seek(-3)
    assert ("PUT", "/v1/me/player/seek", {"position_ms": "0"}) in calls
    now = client.now_playing()
    assert now["progress_ms"] == 5000 and now["duration_ms"] == 200000