import pytest
from fastapi.testclient import TestClient

from app.main import app, ha, spotify
from app import main as main_module


@pytest.fixture(autouse=True)
def fresh_login_counter():
    main_module._attempts.clear()
    yield
    main_module._attempts.clear()


@pytest.fixture
def client():
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def logged_in(client):
    assert client.post("/api/login", json={"password": "demo"}).status_code == 200
    return client


def test_requires_login(client):
    assert client.get("/api/state").status_code == 401
    assert client.post("/api/chat", json={"message": "hilfe"}).status_code == 401
    assert client.post("/api/entity/light.kueche/toggle").status_code == 401


def test_wrong_password(client):
    assert client.post("/api/login", json={"password": "falsch"}).status_code == 401


def test_state_has_devices_and_spotify(logged_in):
    data = logged_in.get("/api/state").json()
    domains = {e["domain"] for e in data["entities"]}
    assert {"light", "switch", "fan", "media_player"} <= domains
    assert data["spotify"]["connected"] and data["spotify"]["now"]["title"]
    assert data["bots"][0]["name"] == "Smarthome-Bot"


def test_toggle_and_brightness(logged_in):
    logged_in.post("/api/entity/light.schlafzimmer/on")
    state = {e["id"]: e for e in logged_in.get("/api/state").json()["entities"]}
    assert state["light.schlafzimmer"]["state"] == "on"
    logged_in.post("/api/entity/light.schlafzimmer/brightness", json={"level": 30})
    state = {e["id"]: e for e in logged_in.get("/api/state").json()["entities"]}
    assert state["light.schlafzimmer"]["brightness"] == 30


def test_unknown_entity_and_action_rejected(logged_in):
    assert logged_in.post("/api/entity/light.gibtsnicht/on").status_code == 404
    assert logged_in.post("/api/entity/light.kueche/explode").status_code == 404
    # only whitelisted domains are controllable
    assert logged_in.post("/api/entity/lock.haustuer/on").status_code == 404


def test_media_volume(logged_in):
    assert logged_in.post("/api/media/media_player.echo_kueche/volume", json={"level": 55}).status_code == 200
    state = {e["id"]: e for e in logged_in.get("/api/state").json()["entities"]}
    assert state["media_player.echo_kueche"]["volume"] == 55
    assert logged_in.post("/api/media/media_player.echo_kueche/volume", json={"level": 500}).status_code == 422


def test_spotify_actions(logged_in):
    spotify.log.clear()
    assert logged_in.post("/api/spotify/pause").status_code == 200
    assert logged_in.post("/api/spotify/volume", json={"level": 20}).status_code == 200
    assert logged_in.post("/api/spotify/transfer", json={"device_id": "d2"}).status_code == 200
    assert logged_in.post("/api/spotify/format_c").status_code == 404
    assert [entry[0] for entry in spotify.log][:2] == ["pause", "volume"]


def test_chat_controls_home(logged_in):
    reply = logged_in.post("/api/chat", json={"message": "Alle Lichter aus"}).json()
    assert reply["changed"] is True
    state = logged_in.get("/api/state").json()["entities"]
    assert all(e["state"] == "off" for e in state if e["domain"] == "light")


def test_cross_site_write_blocked(logged_in):
    response = logged_in.post("/api/chat", json={"message": "hilfe"}, headers={"Origin": "https://evil.example"})
    assert response.status_code == 403


def test_security_headers_and_index(client):
    response = client.get("/")
    assert response.status_code == 200 and "Smarthome" in response.text
    assert response.headers["x-frame-options"] == "DENY"

def test_login_lockout_after_failures(client):
    for _ in range(5):
        assert client.post("/api/login", json={"password": "falsch"}).status_code == 401
    assert client.post("/api/login", json={"password": "falsch"}).status_code == 429
    assert client.post("/api/login", json={"password": "demo"}).status_code == 429  # even the right one while locked

def test_dj_pult_endpoints(logged_in):
    playlists = logged_in.get("/api/spotify/playlists").json()["playlists"]
    assert len(playlists) >= 3 and playlists[0]["uri"].startswith("spotify:playlist:")
    spotify.log.clear()
    assert logged_in.post("/api/spotify/play_uri", json={"uri": playlists[0]["uri"], "device_id": "d2"}).status_code == 200
    assert spotify.log[-1] == ("play", playlists[0]["uri"], "playlist", "d2")
    assert logged_in.post("/api/spotify/seek", json={"position_ms": 90000}).status_code == 200
    assert spotify.log[-1] == ("seek", 90000)
    assert logged_in.post("/api/spotify/volume", json={"level": 12, "device_id": "d2"}).status_code == 200
    assert spotify.log[-1] == ("volume", 12, "d2")
    now = logged_in.get("/api/state").json()["spotify"]["now"]
    assert now["duration_ms"] > 0 and "progress_ms" in now


@pytest.mark.parametrize("uri", ["http://evil.example", "spotify:playlist:../../x", "spotify:user:abc", "spotify:track:" + "a" * 60])
def test_play_uri_rejects_bad_uris(logged_in, uri):
    assert logged_in.post("/api/spotify/play_uri", json={"uri": uri}).status_code == 422


def test_seek_rejects_negative(logged_in):
    assert logged_in.post("/api/spotify/seek", json={"position_ms": -5}).status_code == 422

@pytest.mark.parametrize("path, expected", [("/static/app.js", "text/javascript"), ("/static/style.css", "text/css")])
def test_static_files_have_correct_mime_type(client, path, expected):
    # Regression: on Windows .js was served as text/plain and blocked by "nosniff", leaving a blank page.
    assert client.get(path).headers["content-type"].startswith(expected)

def test_state_has_queue(logged_in):
    queue = logged_in.get("/api/state").json()["spotify"]["queue"]
    assert queue and {"title", "artist", "uri"} <= queue[0].keys()


def test_playlist_tracks_and_play_in_context(logged_in):
    tracks = logged_in.get("/api/spotify/playlists/chill/tracks").json()["tracks"]
    assert len(tracks) >= 3 and tracks[0]["uri"].startswith("spotify:track:")
    spotify.log.clear()
    response = logged_in.post("/api/spotify/play_uri", json={"uri": tracks[1]["uri"], "context_uri": "spotify:playlist:chill"})
    assert response.status_code == 200
    assert spotify.log[0] == ("play_in_context", "spotify:playlist:chill", tracks[1]["uri"], None)


@pytest.mark.parametrize("playlist_id", ["../etc", "a b", "x" * 41])
def test_playlist_tracks_rejects_bad_ids(logged_in, playlist_id):
    assert logged_in.get(f"/api/spotify/playlists/{playlist_id}/tracks").status_code in (404, 422)


def test_context_uri_must_be_playlist_or_album(logged_in):
    assert logged_in.post("/api/spotify/play_uri", json={"uri": "spotify:track:abc", "context_uri": "spotify:user:me"}).status_code == 422


def test_crossfade_fades_down_skips_and_fades_up(logged_in, monkeypatch):
    monkeypatch.setattr(main_module.time, "sleep", lambda seconds: None)
    spotify.log.clear()
    assert logged_in.post("/api/spotify/crossfade", json={"seconds": 2}).status_code == 200
    kinds = [entry[0] for entry in spotify.log]
    assert kinds.count("next") == 1
    skip = kinds.index("next")
    down = [entry[1] for entry in spotify.log[:skip] if entry[0] == "volume"]
    up = [entry[1] for entry in spotify.log[skip:] if entry[0] == "volume"]
    assert down[-1] == 0 and down == sorted(down, reverse=True)
    assert up[0] == 0 and up == sorted(up) and up[-1] == down[0]  # back to the starting volume


def test_crossfade_rejects_parallel_run_and_bad_seconds(logged_in):
    assert logged_in.post("/api/spotify/crossfade", json={"seconds": 99}).status_code == 422
    assert main_module._crossfade_lock.acquire(blocking=False)
    try:
        assert logged_in.post("/api/spotify/crossfade").status_code == 409
    finally:
        main_module._crossfade_lock.release()

def test_crossfade_plays_the_track_loaded_on_deck_b(logged_in, monkeypatch):
    monkeypatch.setattr(main_module.time, "sleep", lambda seconds: None)
    spotify.log.clear()
    uri = "spotify:track:chill3"
    assert logged_in.post("/api/spotify/crossfade", json={"seconds": 2, "uri": uri}).status_code == 200
    kinds = [entry[0] for entry in spotify.log]
    assert "next" not in kinds, "the loaded track is played instead of the queue's next one"
    play = next(entry for entry in spotify.log if entry[0] == "play")
    assert play == ("play", uri, "track", None)
    skip = kinds.index("play")
    down = [entry[1] for entry in spotify.log[:skip] if entry[0] == "volume"]
    up = [entry[1] for entry in spotify.log[skip:] if entry[0] == "volume"]
    assert down[-1] == 0 and up[0] == 0 and up[-1] == down[0]


def test_deck_b_only_accepts_single_tracks(logged_in):
    for uri in ("spotify:playlist:chill", "spotify:album:abc"):
        assert logged_in.post("/api/spotify/crossfade", json={"uri": uri}).status_code == 400
    assert logged_in.post("/api/spotify/crossfade", json={"uri": "https://evil.example"}).status_code == 422