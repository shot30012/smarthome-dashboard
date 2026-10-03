"""The password from the .env is a one-time password: it must be replaced after the first login."""
import json

import pytest
from fastapi.testclient import TestClient

from app import main as main_module
from app.main import app, hasher

ONE_TIME = "einmal-passwort-123"
NEW = "mein-neues-passwort-456"


@pytest.fixture(autouse=True)
def real_password_mode(monkeypatch, tmp_path):
    """Production-like settings: not demo, hash from the .env, empty data folder."""
    monkeypatch.setattr(main_module.settings, "demo", False)
    monkeypatch.setattr(main_module.settings, "dashboard_password_hash", hasher.hash(ONE_TIME))
    monkeypatch.setattr(main_module.settings, "data_dir", str(tmp_path))
    main_module._attempts.clear()
    yield
    main_module._attempts.clear()


def new_client():
    return TestClient(app)


def login(client, password=ONE_TIME):
    return client.post("/api/login", json={"password": password})


def test_first_login_works_but_only_the_password_change_is_allowed():
    with new_client() as client:
        response = login(client)
        assert response.status_code == 200
        assert response.json()["must_change_password"] is True

        assert client.get("/api/session").json() == {"ok": True, "must_change_password": True}
        for call in (
            lambda: client.get("/api/state"),
            lambda: client.post("/api/chat", json={"message": "hilfe"}),
            lambda: client.post("/api/entity/light.kueche/toggle"),
            lambda: client.post("/api/spotify/pause"),
            lambda: client.get("/api/spotify/playlists"),
        ):
            blocked = call()
            assert blocked.status_code == 403
            assert blocked.headers["x-must-change-password"] == "1"


def test_changing_the_password_unlocks_everything():
    with new_client() as client:
        login(client)
        changed = client.post("/api/change-password", json={"current_password": ONE_TIME, "new_password": NEW})
        assert changed.status_code == 200
        assert client.get("/api/session").json()["must_change_password"] is False
        assert client.get("/api/state").status_code == 200


def test_old_password_stops_working_and_new_one_does():
    with new_client() as client:
        login(client)
        client.post("/api/change-password", json={"current_password": ONE_TIME, "new_password": NEW})
    with new_client() as other:
        assert login(other, ONE_TIME).status_code == 401
        main_module._attempts.clear()
        response = login(other, NEW)
        assert response.status_code == 200
        assert response.json()["must_change_password"] is False
        assert other.get("/api/state").status_code == 200


def test_password_change_ends_all_other_sessions():
    with new_client() as laptop, new_client() as phone:
        login(laptop)
        login(phone)
        laptop.post("/api/change-password", json={"current_password": ONE_TIME, "new_password": NEW})
        assert laptop.get("/api/state").status_code == 200
        assert phone.get("/api/session").status_code == 401  # token carries the old version


def test_validation_of_the_change():
    with new_client() as client:
        login(client)
        wrong = client.post("/api/change-password", json={"current_password": "falsch", "new_password": NEW})
        assert wrong.status_code == 400, "400 (not 401): a typo must not look like an expired session"
        assert "aktuelle Passwort" in wrong.json()["detail"]
        short = client.post("/api/change-password", json={"current_password": ONE_TIME, "new_password": "kurz"})
        assert short.status_code == 422
        same = client.post("/api/change-password", json={"current_password": ONE_TIME, "new_password": ONE_TIME})
        assert same.status_code == 400
        assert "unterscheiden" in same.json()["detail"]
        # still locked: nothing was changed
        assert client.get("/api/state").status_code == 403


def test_wrong_current_password_is_rate_limited():
    with new_client() as client:
        login(client)
        for _ in range(5):
            assert client.post("/api/change-password", json={"current_password": "falsch", "new_password": NEW}).status_code == 400
        assert client.post("/api/change-password", json={"current_password": ONE_TIME, "new_password": NEW}).status_code == 429


def test_change_requires_login():
    with new_client() as client:
        assert client.post("/api/change-password", json={"current_password": ONE_TIME, "new_password": NEW}).status_code == 401
        assert client.get("/api/session").status_code == 401


def test_new_hash_is_stored_hashed_and_survives_a_restart(tmp_path):
    with new_client() as client:
        login(client)
        client.post("/api/change-password", json={"current_password": ONE_TIME, "new_password": NEW})
    stored = json.loads((tmp_path / "password.json").read_text("utf-8"))
    assert stored["version"] == 1
    assert NEW not in json.dumps(stored), "only the hash is stored"
    assert stored["hash"].startswith("$argon2")
    assert not list(tmp_path.glob("*.tmp")), "no temporary file left behind"
    # a "restart" reads the same state again
    assert main_module.password_state() == (stored["hash"], 1)
    assert main_module.must_change_password() is False


def test_deleting_the_file_brings_the_one_time_password_back(tmp_path):
    with new_client() as client:
        login(client)
        client.post("/api/change-password", json={"current_password": ONE_TIME, "new_password": NEW})
    (tmp_path / "password.json").unlink()
    main_module._attempts.clear()
    with new_client() as client:
        response = login(client, ONE_TIME)
        assert response.status_code == 200
        assert response.json()["must_change_password"] is True


def test_corrupt_password_file_falls_back_to_the_env_password(tmp_path):
    (tmp_path / "password.json").write_text("{kaputt", "utf-8")
    assert main_module.password_state()[1] == 0
    (tmp_path / "password.json").write_text(json.dumps({"hash": "x", "version": 0}), "utf-8")
    assert main_module.password_state()[1] == 0, "version 0 is not a valid changed password"
    with new_client() as client:
        assert login(client).status_code == 200


def test_demo_mode_is_not_forced_to_change(monkeypatch):
    monkeypatch.setattr(main_module.settings, "demo", True)
    monkeypatch.setattr(main_module.settings, "dashboard_password_hash", "")
    with new_client() as client:
        assert login(client, "demo").json()["must_change_password"] is False
        assert client.get("/api/state").status_code == 200
        assert client.post("/api/change-password", json={"current_password": "demo", "new_password": NEW}).status_code == 403
