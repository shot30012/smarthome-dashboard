# Smarthome-Dashboard

Ein Dashboard mit Chatbot für dein Zuhause: Lichter, Steckdosen, Ventilatoren, **Alexa/Echo**
(über Home Assistant) und **Spotify Premium**. Der Bot versteht deutsche Sätze und läuft **ohne KI-Modell**,
also auch auf schwacher Hardware.

## Was der Bot versteht

| Bereich | Beispiele |
|---|---|
| Licht, Steckdose, Ventilator | „Mach das Licht im Wohnzimmer an“, „Alle Lichter aus“, „Schlafzimmer auf 40 Prozent“, „Küche heller“, „Schalte die Kaffeemaschine ein“ |
| Alexa / Echo | „Alexa leiser“, „Echo Küche Pause“, „Lautstärke Echo Wohnzimmer auf 30“, „Sag Essen ist fertig auf Echo Küche“ |
| Spotify | „Spiel Queen“, „Spiel Bohemian Rhapsody von Queen auf Echo Küche“, „Spiel Playlist Chill“, „Pause“, „Weiter“, „Nächstes Lied“, „Lauter“, „Was läuft?“ |
| Status | „Welche Lichter sind an?“ |

Mikrofon-Taste und Vorlesen gibt es im Browser (Chrome/Edge/Safari). Was der Bot nicht versteht, führt er nicht aus.

## Ausprobieren (Demo, ohne Geräte)

    python -m venv .venv
    .venv\Scripts\pip install -r requirements.txt
    set DEMO=true
    set COOKIE_SECURE=false
    .venv\Scripts\python -m uvicorn app.main:app --port 8765

Dann `http://127.0.0.1:8765` öffnen, Passwort **demo**.

## Echt einrichten

1. **Home Assistant** mit der Integration **Alexa Media Player** (HACS). Sie macht deine Echos zu `media_player`-Geräten
   (Lautstärke, Pause, „Sag …“ über `notify.alexa_media_<gerät>`). Dein Licht und deine Steckdosen sind dort schon Geräte.
   Token erzeugen: Home Assistant → Profil → Sicherheit → *Langlebige Zugriffstokens*.
2. **Spotify:** auf https://developer.spotify.com/dashboard eine App anlegen, als Redirect-URI
   `http://127.0.0.1:8765/spotify/callback` eintragen, Client-ID und Secret in die `.env`. Im Dashboard einmal
   **„Spotify verbinden“** klicken. Steuern geht nur mit **Premium**. Deine Echo-Geräte tauchen in Spotify als
   Wiedergabegeräte auf („Spiel Queen auf Echo Küche“).
3. `.env` aus `.env.example` anlegen, Passwort-Hash mit `python -m app.hashpw` erzeugen.
4. Starten: `python -m uvicorn app.main:app --host 127.0.0.1 --port 8765`.

Auf einem Server (HTTPS, DuckDNS, Port 57443) siehe **DEPLOY.md**.

## Sicherheit

- Login mit Passwort (Argon2), Sperre nach 5 Fehlversuchen für 15 Minuten, Cookie `HttpOnly` + `SameSite=Strict`.
- Der Bot darf nur Licht, Steckdosen, Ventilatoren und Medienplayer schalten, keine Schlösser, Alarmanlagen oder Garagentore.
- Tokens stehen nur in der `.env` (nicht im Git) und in `data/spotify_token.json`.
- **Nicht ungeschützt ins Internet stellen.** Am besten nur im Heimnetz oder über Tailscale erreichbar machen,
  bei Zugriff von außen mit HTTPS (z. B. Caddy davor).

## Tests

    pip install -r requirements-dev.txt
    python -m pytest