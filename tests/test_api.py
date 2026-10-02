import pytest
from fastapi.testclient import TestClient

from app.main import app, ha, spotify


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