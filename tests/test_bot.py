import pytest

from app.bot import execute, interpret
from app.ha import FakeHomeAssistant
from app.spotify import FakeSpotify


@pytest.fixture
def world():
    return FakeHomeAssistant(), FakeSpotify()


def say(world, text, spotify=True):
    ha, spotify_client = world
    command = interpret(text, ha.entities(), spotify_client.devices(), spotify_ready=spotify)
    return command, execute(command, ha, spotify_client)


def state(ha, entity_id):
    return next(e for e in ha.entities() if e["id"] == entity_id)


def test_light_on_by_room(world):
    ha, _ = world
    _, reply = say(world, "Mach das Licht im Schlafzimmer an")
    assert state(ha, "light.schlafzimmer")["state"] == "on"
    assert reply.changed and "Schlafzimmer" in reply.text


def test_light_room_with_two_lights_switches_both(world):
    ha, _ = world
    say(world, "Schalte das Licht im Wohnzimmer aus")
    assert state(ha, "light.wohnzimmer_decke")["state"] == "off"
    assert state(ha, "light.wohnzimmer_stehlampe")["state"] == "off"


def test_umlaut_spelling_both_ways(world):
    ha, _ = world
    say(world, "Licht in der Küche aus")
    assert state(ha, "light.kueche")["state"] == "off"
    say(world, "Licht in der Kueche an")
    assert state(ha, "light.kueche")["state"] == "on"


def test_all_lights_off(world):
    ha, _ = world
    say(world, "Alle Lichter aus")
    assert all(e["state"] == "off" for e in ha.entities() if e["domain"] == "light")


def test_plug_by_name(world):
    ha, _ = world
    say(world, "Schalte die Kaffeemaschine ein")
    assert state(ha, "switch.kaffeemaschine")["state"] == "on"


def test_fan(world):
    ha, _ = world
    say(world, "Ventilator im Schlafzimmer an")
    assert state(ha, "fan.schlafzimmer_ventilator")["state"] == "on"


def test_brightness_percent_and_relative(world):
    ha, _ = world
    say(world, "Licht Schlafzimmer auf 40 Prozent")
    assert state(ha, "light.schlafzimmer")["brightness"] == 40
    say(world, "Schlafzimmer heller")
    assert state(ha, "light.schlafzimmer")["brightness"] == 60
    say(world, "Schlafzimmer dunkler")
    assert state(ha, "light.schlafzimmer")["brightness"] == 40


def test_unknown_device_is_reported_not_guessed(world):
    ha, _ = world
    before = ha.entities()
    _, reply = say(world, "Mach das Licht im Keller an")
    assert "kein passendes" in reply.text.lower()
    assert ha.entities() == before


def test_status(world):
    _, reply = say(world, "Welche Lichter sind an?")
    assert "Wohnzimmer Decke" in reply.text and "Küche" in reply.text


def test_alexa_volume_up_down_set(world):
    ha, _ = world
    say(world, "Alexa Echo Küche lauter", spotify=False)
    assert state(ha, "media_player.echo_kueche")["volume"] == 45
    say(world, "Echo Wohnzimmer leiser", spotify=False)
    assert state(ha, "media_player.echo_wohnzimmer")["volume"] == 10
    say(world, "Lautstärke Echo Küche auf 30", spotify=False)
    assert state(ha, "media_player.echo_kueche")["volume"] == 30


def test_alexa_pause_and_play(world):
    ha, _ = world
    say(world, "Echo Küche Pause", spotify=False)
    assert state(ha, "media_player.echo_kueche")["state"] == "paused"
    say(world, "Echo Küche weiter", spotify=False)
    assert state(ha, "media_player.echo_kueche")["state"] == "playing"


def test_alexa_without_device_asks(world):
    ha, _ = world
    _, reply = say(world, "Alexa leiser", spotify=False)
    assert "Welcher Echo" in reply.text and not reply.changed


def test_say_through_echo(world):
    ha, _ = world
    _, reply = say(world, "Sag Essen ist fertig auf Echo Küche")
    assert ha.log[-1] == ("notify", "alexa_media_echo_kueche", {"message": "essen ist fertig", "data": {"type": "tts"}})
    assert reply.changed


def test_spotify_play_artist_and_track(world):
    _, spotify = world
    say(world, "Spiel Bohemian Rhapsody von Queen")
    assert spotify.log[0] == ("search", "bohemian rhapsody von queen", "track")
    assert spotify.log[1][0] == "play"
    spotify.log.clear()
    say(world, "Spiel Musik von Queen")
    assert spotify.log[0] == ("search", "queen", "artist")


def test_spotify_playlist_on_device(world):
    _, spotify = world
    _, reply = say(world, "Spiel Playlist Chill auf Echo Wohnzimmer")
    assert spotify.log[0] == ("search", "chill", "playlist")
    assert spotify.log[1] == ("play", "spotify:playlist:demo", "playlist", "d2")
    assert "Echo Wohnzimmer" in reply.text


def test_spotify_nothing_found(world):
    _, reply = say(world, "Spiel nichtsda")
    assert "nichts gefunden" in reply.text


def test_spotify_controls(world):
    _, spotify = world
    say(world, "Pause")
    say(world, "Nächstes Lied")
    say(world, "Zurück")
    say(world, "Weiter")
    assert [entry[0] for entry in spotify.log] == ["pause", "next", "previous", "play"]


def test_spotify_volume(world):
    _, spotify = world
    say(world, "Lauter")
    say(world, "Lautstärke auf 15")
    assert spotify.log[0] == ("volume", 45, None)
    assert spotify.log[1] == ("volume", 15, None)


def test_now_playing(world):
    _, reply = say(world, "Was läuft gerade?")
    assert "Bohemian Rhapsody" in reply.text and "Queen" in reply.text


def test_spotify_not_connected(world):
    _, spotify = world
    spotify.connected = False
    _, reply = say(world, "Spiel Queen")
    assert "nicht verbunden" in reply.text


def test_errors_become_replies(world):
    ha, _ = world
    from app.ha import HomeAssistantError

    def boom(*args, **kwargs):
        raise HomeAssistantError("Home Assistant ist nicht erreichbar.")

    ha.call = boom
    _, reply = say(world, "Licht Schlafzimmer an")
    assert "nicht erreichbar" in reply.text


def test_help_and_unknown(world):
    assert "Das kann ich" in say(world, "Hilfe")[1].text
    assert "nicht verstanden" in say(world, "Wie wird das Wetter")[1].text
    assert "Sag mir" in say(world, "   ")[1].text
