# Auf den Server bringen (https://dashboarddy.duckdns.org:57443)

Der Stack besteht aus drei Containern: **app** (das Dashboard), **caddy** (HTTPS) und **duckdns** (hält den Namen auf
deine öffentliche IP). Er gehört auf einen **eigenen Container oder Rechner**, nicht zu Dayline.

## Öffentlicher Port 57443 statt 80/443

Im Router zeigen 80/443 schon auf Dayline (CT 111), die bleiben dort. Das Dashboard hört deshalb auf **57443**:

- Adresse: `https://dashboarddy.duckdns.org:57443`
- Weil die Zertifikatsprüfung über 80/443 hier nicht möglich ist, holt Caddy das Zertifikat per **DuckDNS DNS-01**.
  Dafür sorgen `Dockerfile.caddy` (Caddy mit DuckDNS-Plugin), `Caddyfile.dns` und `docker-compose.override.yml`.
  Compose lädt die Override-Datei automatisch. Brauchst du stattdessen die normalen Ports 80/443: die
  Override-Datei löschen, dann gilt das normale `Caddyfile` mit Zertifikat über HTTP (und `Dockerfile.caddy` entfällt).

## Voraussetzungen

1. Linux-Container oder -Rechner mit Docker und Docker Compose **2.24 oder neuer**, im selben Netz wie Home Assistant
   (Proxmox: Debian-12-Container, 1 GB RAM, 8 GB Platte, „Nesting“ und „keyctl“ an, feste IP).
2. Der DuckDNS-Name `dashboarddy` gehört dir (duckdns.org, Token notieren).
3. Im Router **Port 57443 (TCP und UDP)** auf die IP des Containers, Zielport ebenfalls 57443, weiterleiten.
4. Spotify-Entwickler-App: als **Redirect-URI** `https://dashboarddy.duckdns.org:57443/spotify/callback` eintragen
   (mit Port!).

## Einspielen

Auf dem Server (Ordner z. B. `/opt/dashboard`):

    cd /opt/dashboard
    cp .env.example .env
    nano .env          # Werte siehe unten, die Datei bleibt auf dem Server
    chmod 600 .env
    docker compose run --rm app python -m app.hashpw     # Passwort-Hash erzeugen, in die .env kopieren
    docker compose up -d --build
    docker compose ps
    docker compose logs app caddy --tail 30

Das erste Zertifikat kann ein bis zwei Minuten dauern. Ist `DUCKDNS_TOKEN` falsch, wiederholt Caddy die Anfrage
und meldet das im Log (`docker compose logs caddy`).

## Werte in der `.env` (Produktion)

    DEMO=false
    DASHBOARD_DOMAIN=dashboarddy.duckdns.org
    DUCKDNS_SUBDOMAIN=dashboarddy
    DUCKDNS_TOKEN=<dein DuckDNS-Token>
    COOKIE_SECURE=true
    DASHBOARD_PASSWORD_HASH='<Ausgabe von app.hashpw>'
    SESSION_SECRET=<langer Zufallswert>
    HA_URL=http://<IP-deines-Home-Assistant>:8123
    HA_TOKEN=<langlebiger Zugriffstoken>
    SPOTIFY_CLIENT_ID=<...>
    SPOTIFY_CLIENT_SECRET=<...>
    SPOTIFY_REDIRECT_URI=https://dashboarddy.duckdns.org:57443/spotify/callback
    CHATBOTS=Dayline-Assistent|https://dayline.duckdns.org/health

## Einmalpasswort

Das Passwort aus der `.env` (`DASHBOARD_PASSWORD_HASH`) ist ein **Einmalpasswort**. Beim ersten Login zeigt das
Dashboard nur den Bildschirm „Neues Passwort“ (mindestens 12 Zeichen); alles andere ist gesperrt, bis ein eigenes
Passwort gesetzt ist. Das neue Passwort wird als Hash in `data/password.json` im Volume `dashboard_data` gespeichert
und gilt ab dann statt des Passworts aus der `.env`. Mit der Änderung enden alle anderen Sitzungen.

- **Passwort vergessen:** `data/password.json` löschen
  (`docker compose exec app rm /srv/dashboard/data/password.json`). Dann gilt wieder das Einmalpasswort aus der
  `.env`, und beim nächsten Login muss ein neues gewählt werden.
- **Einmalpasswort neu setzen:** Neuen Hash mit `docker compose run --rm app python -m app.hashpw` erzeugen, in die
  `.env` eintragen und `data/password.json` löschen.
- Im Demo-Modus (`DEMO=true`) gibt es das nicht.

## Prüfen

1. `curl -sI https://dashboarddy.duckdns.org:57443/health` antwortet mit `200`.
2. Im Browser `https://dashboarddy.duckdns.org:57443` öffnen und anmelden. Oben müssen „Home Assistant“ und nach
   „Spotify verbinden“ auch „Spotify verbunden“ grün sein.
3. Im Chat „Welche Lichter sind an?“ fragen.

## Sicherheit

Das Dashboard schaltet Dinge in deinem Zuhause und ist aus dem Internet erreichbar:

- Nimm ein **langes Passwort** (mindestens 16 Zeichen). Nach 5 Fehlversuchen sperrt der Login 15 Minuten.
- Der Bot darf nur Licht, Steckdosen, Ventilatoren und Medienplayer schalten, keine Schlösser, Alarmanlagen oder Garagentore.
- Die `.env` enthält alle Zugangsdaten (`chmod 600`, nie ins Git).
- Wer es nicht öffentlich haben will: die Portweiterleitung im Router weglassen und nur über Tailscale gehen.

## Aktualisieren und Zurückrollen

    git pull        # oder neue Dateien hinüberkopieren
    docker compose up -d --build
    docker compose logs app --tail 30

Das Spotify-Token liegt im Volume `dashboard_data` und überlebt Updates. Sicherung:
`docker run --rm -v dashboard_data:/d -v $PWD:/b alpine tar czf /b/dashboard-data.tgz -C /d .`
Zurückrollen: die vorige Version holen und erneut `docker compose up -d --build`.
