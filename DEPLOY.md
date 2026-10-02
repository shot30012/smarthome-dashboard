# Auf den Server bringen (dashboarddy.duckdns.org)

Der Stack besteht aus drei Containern: **app** (das Dashboard), **caddy** (HTTPS, holt das Zertifikat selbst) und
**duckdns** (hält den Namen auf deine öffentliche IP). Er braucht eigene Ports 80/443 und gehört deshalb auf einen
**eigenen Container oder Rechner**, nicht auf CT 111, wo Dayline schon 80/443 belegt.

## Voraussetzungen

1. Ein Linux-Container oder -Rechner mit Docker und Docker Compose im selben Heimnetz wie Home Assistant
   (Proxmox: Debian-12-Container, 1 GB RAM, 4 GB Platte, „Nesting“ und „keyctl“ an).
2. Der DuckDNS-Name `dashboarddy` gehört dir (duckdns.org, Token notieren).
3. Im Router die Ports **80 und 443** (TCP, 443 auch UDP) auf diesen Container weiterleiten.
4. Spotify-Entwickler-App: als **Redirect-URI** `https://dashboarddy.duckdns.org/spotify/callback` eintragen.

## Einspielen

Auf dem Server (Ordner z. B. `/opt/dashboard`):

    # Dateien dorthin kopieren (Ordnerinhalt dieses Repos, ohne .git, .venv, data, .env)
    cd /opt/dashboard
    cp .env.example .env
    nano .env          # Werte siehe unten, die Datei bleibt auf dem Server
    chmod 600 .env
    docker compose up -d --build
    docker compose ps
    docker compose logs app --tail 30

## Werte in der `.env` (Produktion)

    DEMO=false
    DASHBOARD_DOMAIN=dashboarddy.duckdns.org
    DUCKDNS_SUBDOMAIN=dashboarddy
    DUCKDNS_TOKEN=<dein DuckDNS-Token>
    COOKIE_SECURE=true
    DASHBOARD_PASSWORD_HASH='<Ausgabe von: docker compose run --rm app python -m app.hashpw>'
    SESSION_SECRET=<langer Zufallswert>
    HA_URL=http://<IP-deines-Home-Assistant>:8123
    HA_TOKEN=<langlebiger Zugriffstoken>
    SPOTIFY_CLIENT_ID=<...>
    SPOTIFY_CLIENT_SECRET=<...>
    SPOTIFY_REDIRECT_URI=https://dashboarddy.duckdns.org/spotify/callback
    CHATBOTS=Dayline-Assistent|https://dayline.duckdns.org/health

## Prüfen

1. `curl -sI https://dashboarddy.duckdns.org/health` antwortet mit `200`.
2. Im Browser anmelden. Oben müssen „Home Assistant“ und nach „Spotify verbinden“ auch „Spotify verbunden“ grün sein.
3. Im Chat „Welche Lichter sind an?“ fragen.

## Sicherheit

Das Dashboard schaltet Dinge in deinem Zuhause. Wenn es aus dem Internet erreichbar ist:

- Nimm ein **langes Passwort** (mindestens 16 Zeichen). Nach 5 Fehlversuchen sperrt der Login 15 Minuten.
- Der Bot darf nur Licht, Steckdosen, Ventilatoren und Medienplayer schalten, keine Schlösser, Alarmanlagen oder Garagentore.
- Wer es lieber nicht öffentlich hat: Tailscale auf dem Container installieren und die Weiterleitung im Router weglassen.
  Dann ist es nur über Tailscale erreichbar (ohne HTTPS-Zertifikat von Caddy, also mit `COOKIE_SECURE=false` und
  `http://<tailscale-name>:8765`, dafür den `ports`-Eintrag in der Compose-Datei ergänzen).

## Aktualisieren und Zurückrollen

    docker compose up -d --build          # neue Version
    docker compose logs app --tail 30

Das Spotify-Token liegt im Volume `dashboard_data` und überlebt Updates. Sicherung: `docker run --rm -v dashboard_data:/d -v $PWD:/b alpine tar czf /b/dashboard-data.tgz -C /d .`
