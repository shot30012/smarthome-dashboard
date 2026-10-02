"""Rule-based German smart-home bot (no language model, runs on any hardware).

`interpret()` turns a sentence into a Command using the current device lists;
`execute()` performs it against Home Assistant / Spotify and returns a reply.
Everything it can do is listed in HELP_TEXT; unknown sentences get a hint, never a guess.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

from .ha import HomeAssistantError
from .spotify import NotConnected, SpotifyError

_TABLE = str.maketrans({"ä": "a", "ö": "o", "ü": "u"})
STOPWORDS = {
    "mach", "mache", "machst", "schalte", "schalt", "schalten", "bitte", "das", "die", "der", "den", "dem", "des", "ein", "eine",
    "im", "in", "am", "auf", "an", "aus", "mal", "doch", "kannst", "du", "mir", "alle", "alles", "noch", "jetzt", "wieder",
    "zu", "von", "bei", "ueber", "uber", "fur", "fuer", "und", "mit", "hey", "ok", "okay", "alexa", "ist", "sind", "welche",
    "licht", "lichter", "lampe", "lampen", "leuchte", "leuchten", "steckdose", "steckdosen", "schalter", "ventilator", "ventilatoren",
    "heller", "dunkler", "prozent", "helligkeit", "einschalten", "ausschalten", "anmachen", "ausmachen", "anschalten", "ausschalten",
    "ausschalte", "anschalte", "einschalte", "mach's",
}
ON_WORDS = {"an", "ein", "einschalten", "anmachen", "anschalten", "anknipsen", "aktivieren", "einschalte", "anschalte", "starte"}
OFF_WORDS = {"aus", "ausschalten", "ausmachen", "abschalten", "deaktivieren", "ausschalte", "abschalte", "stopp"}
DOMAIN_WORDS = {
    "light": ("licht", "lichter", "lampe", "lampen", "leuchte", "leuchten", "beleuchtung"),
    "switch": ("steckdose", "steckdosen", "schalter"),
    "fan": ("ventilator", "ventilatoren", "luefter", "lufter"),
}

HELP_TEXT = (
    "Das kann ich:\n"
    "• Licht, Steckdosen, Ventilatoren: „Mach das Licht im Wohnzimmer an“, „Alle Lichter aus“, „Küche auf 50 Prozent“, „Heller“\n"
    "• Alexa/Echo: „Alexa leiser“, „Echo Küche Pause“, „Lautstärke Wohnzimmer auf 30“, „Sag Essen ist fertig auf Echo Küche“\n"
    "• Spotify: „Spiel Queen“, „Spiel Bohemian Rhapsody von Queen auf Echo Küche“, „Spiel Playlist Chill“, "
    "„Pause“, „Weiter“, „Nächstes Lied“, „Lauter“, „Was läuft?“\n"
    "• Status: „Welche Lichter sind an?“"
)


@dataclass
class Command:
    kind: str
    params: dict = field(default_factory=dict)


@dataclass
class Reply:
    text: str
    changed: bool = False


def fold(text: str) -> str:
    """Lowercase and drop umlaut dots without changing the length, so spans match the original."""
    return text.strip().lower().translate(_TABLE)


def cmp(text: str) -> str:
    """Matching form: umlauts and their ae/oe/ue spellings compare equal ("küche" == "kueche")."""
    return re.sub(r"(?<=[aou])e", "", fold(text))


def words(text: str) -> list[str]:
    return re.findall(r"[a-z0-9ßäöü]+", text)


def _tokens(folded: str) -> list[str]:
    return [w for w in words(cmp(folded)) if w not in STOPWORDS and not w.isdigit()]


def _matches(name: str, tokens: list[str]) -> bool:
    folded = cmp(name)
    return all(token in folded for token in tokens)


def match_entities(entities: list[dict], folded: str, domains: tuple[str, ...]) -> list[dict]:
    pool = [e for e in entities if e["domain"] in domains]
    tokens = _tokens(folded)
    if not tokens:
        return pool
    exact = [e for e in pool if " ".join(words(cmp(e["name"]))) == " ".join(tokens)]
    return exact or [e for e in pool if _matches(e["name"], tokens)]


def match_device(items: list[dict], folded: str) -> dict | None:
    """Find an Echo / Spotify device mentioned in the sentence."""
    folded_words = set(words(cmp(folded)))
    best, best_score = None, 0
    for item in items:
        name_words = [w for w in words(cmp(item["name"])) if w not in STOPWORDS]
        if not name_words:
            continue
        score = sum(1 for w in name_words if w in folded_words)
        if score == len(name_words) and score > best_score:
            best, best_score = item, score
    return best


def _number(folded: str) -> int | None:
    match = re.search(r"\b(\d{1,3})\s*(?:prozent|%)?", folded)
    return min(100, int(match.group(1))) if match else None


# ------------------------------------------------------------------ interpret

def interpret(text: str, entities: list[dict], devices: list[dict], spotify_ready: bool) -> Command:
    low = text.strip().lower()
    folded = fold(text)  # same length as `low`, used wherever the original text is sliced
    ws = words(cmp(text))
    wset = set(ws)
    if not ws:
        return Command("empty")
    if wset & {"hilfe"} or "was kannst du" in folded:
        return Command("help")

    media = [e for e in entities if e["domain"] == "media_player"]
    echo = match_device(media, folded)
    spot_device = match_device(devices, folded)
    wants_ha_media = bool(echo) or "alexa" in wset or "echo" in wset
    use_spotify = spotify_ready and ("spotify" in wset or not wants_ha_media or bool(spot_device and not echo))

    # speak through an Echo
    say = re.match(r"^(?:alexa\s+)?(?:sag|sage|sprich)\s+(.+)$", folded)
    if say:
        start = say.start(1)
        message = low[start:]
        target = None
        for marker in (" auf ", " im ", " in der ", " bei "):
            if marker in message:
                head, _, tail = message.partition(marker)
                device = match_device(media, fold(tail))
                if device:
                    message, target = head, device
                    break
        return Command("say", {"message": message.strip(), "entity": target})

    # Spotify: play something
    play = re.match(r"^(?:alexa\s+|bitte\s+)*(spiel|spiele|abspielen|starte|hoer|hore|hoere|leg)\b\s*(.*)$", folded)
    if play and (play.group(2).strip() not in ("", "weiter", "musik", "musik weiter", "ab")):
        start = play.start(2)
        rest = low[start:]
        rest_f = folded[start:]
        device = None
        for marker in (r"\bauf (?:dem |der |den )?", r"\bim ", r"\bin (?:der |dem )?", r"\bu(?:e)?ber (?:den |die |das )?", r"\bbei "):
            found = re.search(marker + r"(.+)$", rest_f)
            if found:
                candidate = match_device(devices, found.group(1)) or match_device(media, found.group(1))
                if candidate:
                    device = candidate
                    rest, rest_f = rest[: found.start()], rest_f[: found.start()]
                    break
        kind = "track"
        for word, k in (("playlist", "playlist"), ("album", "album"), ("kuenstler", "artist"), ("kunstler", "artist"), ("interpret", "artist")):
            if re.search(rf"\b{word}\b", rest_f):
                kind = k
                rest = re.sub(rf"\b{word}\b", "", rest, flags=re.I)
                rest_f = re.sub(rf"\b{word}\b", "", rest_f)
        artist = re.match(r"^(?:musik|lieder|songs|titel|das beste)\s+von\s+(.+)$", rest_f)
        if artist and kind == "track":
            kind, rest, rest_f = "artist", rest[artist.start(1):], rest_f[artist.start(1):]
        rest = re.sub(r"^(?:das lied|den song|das lied|den titel|musik|etwas von|was von)\s+", "", rest.strip(), flags=re.I)
        return Command("spotify_play", {"query": rest.strip(" ,.!?"), "kind": kind, "device": device})
    if play and wants_ha_media and echo:
        return Command("media", {"action": "play", "entities": [echo]})

    if wset & {"laeuft", "lauft"} and (wset & {"was", "welches", "welcher", "welche"}) or "now playing" in folded:
        return Command("now_playing")

    # volume
    set_volume = re.search(r"\b(?:lautstaerke|lautstarke|volume)\b.*?(\d{1,3})|\bauf (\d{1,3}) ?(?:prozent|%)\b.*\b(?:lautstaerke|lautstarke)\b", folded)
    louder, quieter = "lauter" in wset, "leiser" in wset
    if set_volume or louder or quieter:
        level = int(next(g for g in set_volume.groups() if g)) if set_volume else None
        volume_kind = "set" if level is not None else "up" if louder else "down"
        return Command("volume", {"mode": volume_kind, "level": level, "device": spot_device, "entity": echo, "spotify": use_spotify and not echo})

    # transport
    action = None
    if wset & {"pause", "pausiere", "pausieren"} or "halt an" in folded or ({"stopp", "stop"} & wset and not _domain_hint(wset)):
        action = "pause"
    elif wset & {"weiter", "fortsetzen", "fortfahren", "resume"} or play:
        action = "play"
    elif (any(w.startswith(("nachst", "naechst")) for w in ws) or wset & {"skip", "ueberspringen", "uberspringen", "next"}) and not _domain_hint(wset):
        action = "next"
    elif wset & {"zurueck", "zuruck", "vorheriges", "vorheriger", "previous"} or "letztes lied" in folded:
        action = "previous"
    if action:
        return Command("transport", {"action": action, "entity": echo, "device": spot_device, "spotify": use_spotify and not echo})

    # lights, plugs, fans
    hint = _domain_hint(wset)
    on = bool(wset & ON_WORDS) and not (wset & OFF_WORDS)
    off = bool(wset & OFF_WORDS)
    level = _number(folded) if re.search(r"prozent|%", folded) else None
    brighter, dimmer = "heller" in wset, "dunkler" in wset
    if hint or on or off or level is not None or brighter or dimmer:
        domains = (hint,) if hint else ("light", "switch", "fan")
        targets = match_entities(entities, folded, domains)
        # "Wohnzimmer auf 50 Prozent" / "Küche aus" without a device word: keep to lights first
        if not hint and len(targets) > 1:
            lights = [e for e in targets if e["domain"] == "light"]
            targets = lights or targets
        if re.search(r"\bwelche\b|\bist\b.*\b(?:an|aus)\b|\bsind\b", folded) and not re.search(r"\bmach|schalte", folded):
            return Command("status", {"domain": hint, "entities": targets})
        if level is not None and not (on or off):
            return Command("brightness", {"level": level, "entities": targets})
        if brighter or dimmer:
            return Command("brightness", {"delta": 20 if brighter else -20, "entities": targets})
        return Command("switch", {"state": "on" if on else "off", "entities": targets, "all": "alle" in wset or "alles" in wset, "level": level})

    return Command("unknown")


def _spotify_device_id(device: dict | None) -> str | None:
    # Home Assistant media players carry a "domain"; only Spotify devices can be targeted by id.
    return device["id"] if device and "domain" not in device else None


def _domain_hint(wset: set[str]) -> str | None:
    for domain, hints in DOMAIN_WORDS.items():
        if wset & set(hints):
            return domain
    return None


# ------------------------------------------------------------------ execute

def _name_list(entities: list[dict]) -> str:
    return ", ".join(e["name"] for e in entities)


def execute(command: Command, ha, spotify) -> Reply:
    try:
        return _execute(command, ha, spotify)
    except (HomeAssistantError, SpotifyError) as exc:
        return Reply(str(exc))


def _execute(command: Command, ha, spotify) -> Reply:
    kind, p = command.kind, command.params
    if kind == "empty":
        return Reply("Sag mir, was ich tun soll. „Hilfe“ zeigt, was ich kann.")
    if kind == "help":
        return Reply(HELP_TEXT)
    if kind == "unknown":
        return Reply("Das habe ich nicht verstanden. Sag „Hilfe“, dann zeige ich dir, was ich kann.")

    if kind == "switch":
        targets = p["entities"]
        if not targets:
            return Reply("Ich finde kein passendes Gerät. Sag zum Beispiel „Licht Wohnzimmer an“.")
        if len(targets) > 6 and not p["all"]:
            return Reply(f"Das sind {len(targets)} Geräte. Sag „alle … {('an' if p['state'] == 'on' else 'aus')}“ oder nenne das Gerät genauer.")
        bare = not p["all"] and len(targets) > 1 and len({t["domain"] for t in targets}) > 1
        if bare:
            return Reply(f"Welches meinst du? {_name_list(targets)}")
        service = "turn_on" if p["state"] == "on" else "turn_off"
        for entity in targets:
            ha.call(entity["domain"], service, {"entity_id": entity["id"]})
        word = "eingeschaltet" if p["state"] == "on" else "ausgeschaltet"
        return Reply(f"{_name_list(targets)} {'wurde' if len(targets) == 1 else 'wurden'} {word}.", changed=True)

    if kind == "brightness":
        targets = [e for e in p["entities"] if e["domain"] == "light"]
        if not targets:
            return Reply("Ich finde keine passende Lampe.")
        for entity in targets:
            level = p.get("level")
            if level is None:
                level = max(5, min(100, (entity.get("brightness") or 100) + p["delta"]))
            ha.call("light", "turn_on", {"entity_id": entity["id"], "brightness_pct": level})
        return Reply(f"Helligkeit von {_name_list(targets)} angepasst.", changed=True)

    if kind == "status":
        pool = p["entities"] or []
        on = [e for e in pool if e["state"] in ("on", "playing")]
        label = {"light": "Lichter", "switch": "Steckdosen", "fan": "Ventilatoren"}.get(p["domain"], "Geräte")
        return Reply(f"Eingeschaltet ({label}): {_name_list(on)}." if on else f"Keine {label} sind eingeschaltet.")

    if kind == "say":
        entity = p["entity"]
        if not entity:
            return Reply("Auf welchem Echo soll ich das sagen? Zum Beispiel: „Sag Essen ist fertig auf Echo Küche“.")
        slug = entity["id"].split(".", 1)[1]
        ha.call("notify", f"alexa_media_{slug}", {"message": p["message"], "data": {"type": "tts"}})
        return Reply(f"{entity['name']} sagt: „{p['message']}“.", changed=True)

    if kind == "media":
        for entity in p["entities"]:
            ha.call("media_player", "media_play" if p["action"] == "play" else "media_pause", {"entity_id": entity["id"]})
        return Reply("Wiedergabe gestartet.", changed=True)

    if kind == "now_playing":
        current = spotify.now_playing() if spotify and spotify.connected else None
        if not current:
            return Reply("Gerade läuft nichts auf Spotify.")
        state = "läuft" if current["playing"] else "ist pausiert"
        where = f" auf {current['device']}" if current.get("device") else ""
        return Reply(f"{current['title']} von {current['artist']} {state}{where}.")

    if kind == "spotify_play":
        if not spotify or not spotify.connected:
            return Reply("Spotify ist noch nicht verbunden. Klicke im Dashboard auf „Spotify verbinden“.")
        device = p["device"]
        if not p["query"]:
            spotify.play(device_id=_spotify_device_id(device))
            return Reply("Wiedergabe fortgesetzt.", changed=True)
        found = spotify.search(p["query"], p["kind"])
        if not found:
            return Reply(f"Dazu habe ich auf Spotify nichts gefunden: „{p['query']}“.")
        spotify.play(found["uri"], found["kind"], _spotify_device_id(device))
        who = f" von {found['artist']}" if found.get("artist") and found["kind"] != "artist" else ""
        where = f" auf {device['name']}" if device else ""
        return Reply(f"Ich spiele {found['name']}{who}{where}.", changed=True)

    if kind == "transport":
        if p["spotify"]:
            if not spotify or not spotify.connected:
                return Reply("Spotify ist noch nicht verbunden.")
            action = p["action"]
            if action == "pause":
                spotify.pause(); return Reply("Pausiert.", changed=True)
            if action == "next":
                spotify.next(); return Reply("Nächstes Lied.", changed=True)
            if action == "previous":
                spotify.previous(); return Reply("Zurück zum vorherigen Lied.", changed=True)
            spotify.play(device_id=_spotify_device_id(p["device"]))
            return Reply("Weiter geht's.", changed=True)
        entity = p["entity"]
        if not entity:
            return Reply("Welcher Echo? Nenne ihn zum Beispiel: „Echo Küche Pause“.")
        service = {"pause": "media_pause", "play": "media_play", "next": "media_next_track", "previous": "media_previous_track"}[p["action"]]
        ha.call("media_player", service, {"entity_id": entity["id"]})
        return Reply(f"{entity['name']}: {'pausiert' if p['action'] == 'pause' else 'ok'}.", changed=True)

    if kind == "volume":
        mode, level = p["mode"], p["level"]
        if p["entity"] or not p["spotify"]:
            entity = p["entity"]
            if not entity:
                return Reply("Welcher Echo? Nenne ihn zum Beispiel: „Echo Küche leiser“.")
            if mode == "set":
                ha.call("media_player", "volume_set", {"entity_id": entity["id"], "volume_level": level / 100})
            else:
                ha.call("media_player", "volume_up" if mode == "up" else "volume_down", {"entity_id": entity["id"]})
            return Reply(f"{entity['name']}: Lautstärke angepasst.", changed=True)
        if not spotify or not spotify.connected:
            return Reply("Spotify ist noch nicht verbunden.")
        current = spotify.now_playing()
        base = (current or {}).get("volume") or 40
        target = level if mode == "set" else base + (10 if mode == "up" else -10)
        device = p["device"]
        spotify.volume(target, _spotify_device_id(device))
        return Reply(f"Lautstärke: {max(0, min(100, target))} %.", changed=True)

    return Reply("Das habe ich nicht verstanden.")
