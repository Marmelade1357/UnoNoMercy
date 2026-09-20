# Uno No Mercy – Online

Eine browserbasierte Online-Version von **Uno No Mercy** zum Spielen mit Freunden – jede:r auf dem eigenen Handy/Tablet/PC, ein gemeinsamer Server übernimmt Mischen, Regeln, Strafkarten und Punkte. Gleiche Bauweise wie Poker, Wizard, Monopoly & Co.: Räume mit 4-stelligem Code, Host, Bots, Wiederverbindung, alles im Speicher.

Regelwerk: 168 Karten, 2–10 Spieler (siehe [unonomercyrules.com/de](https://unonomercyrules.com/de/)).

## Funktionen

- **Alle No-Mercy-Karten** – Zahlen 0–9, Aussetzen, Richtungswechsel, +2, +4, Alle ablegen, Alle aussetzen sowie Wilder Richtungswechsel +4, Wild +6, Wild +10 und Farbroulette.
- **Ziehkarten stapeln** – auf eine Ziehkarte darf mit gleich hoher oder höherer gekontert werden, die Strafe wächst; wer nicht kontert, zieht alles.
- **Ziehen, bis es passt** – ohne passende Karte wird gezogen, bis eine spielbar ist.
- **7-0-Regel** (in der Lobby abschaltbar) – 7 tauscht die Hand mit einer Person deiner Wahl, 0 reicht alle Hände weiter.
- **Mercy-Regel** – ab 25 Karten scheidet man aus, die Karten gehen zurück in den Stapel.
- **UNO! rufen** (in der Lobby abschaltbar) – wer es vergisst, kann innerhalb weniger Sekunden erwischt werden (+2).
- **Punkte** – eine Runde oder bis 250 / 500 / 1000 Punkte (Zahlen = Nennwert, Farbaktionen 20, Joker 50, 250 pro Ausgeschiedenem).
- **Tisch mit Sitzen** wie bei Poker/Bluff, die **eigene Hand liegt unten** in einer Leiste (sortierbar, spielbare Karten sind hervorgehoben).
- **3D-Tisch** (Three.js, wie die 3D-Ansicht bei Monopoly): Holztisch mit Filz, Karten fliegen beim Legen/Ziehen/Tauschen, Richtungspfeile, Kamera frei drehbar, „Von oben“-Ansicht. Umschaltbar auf die 2D-Ansicht (Standard: 3D ab 600 px Fensterhöhe/-breite, sonst 2D).
- **Bots** füllen die Runde auf (Stapeln, Farbwahl, Tauschen, UNO rufen, andere erwischen).
- Wiederverbindung nach Verbindungsabbruch, getrennte Spieler werden von einem Bot vertreten, Host-Übergabe, „Überspringen“ nach 20 s.

## Dateien

| Datei | Inhalt |
|-------|--------|
| `src/engine.js` | Regeln (reine Spiellogik, vom Server und den Tests genutzt) |
| `src/bots.js` | Bot-KI |
| `server.js` | Express + Socket.IO, Räume, Lobby, Wiederverbindung |
| `public/` | Oberfläche (Lobby, Tisch, Hand), PWA-Icons |
| `src3d/table3d.src.js` | 3D-Tisch (Quelltext) → gebündelt nach `public/table3d.js` |

## Entwicklung

```bash
npm install
npm start          # http://localhost:3000
npm test           # Regeln, 72 Bot-Partien mit Invarianten-Check, Socket-Ablauf, Überspringen/Host
npm run build3d    # 3D-Bundle neu bauen (nur nötig, wenn src3d/ geändert wurde)
```

`public/table3d.js` ist bewusst eingecheckt (wie `board3d.js` bei Monopoly), damit der Docker-Build auf dem Pi kein Three.js/esbuild braucht.

## Deployment (Raspberry Pi, analog zu den anderen Spielen)

```bash
./deploy.sh
```

Der Container lauscht intern auf Port 3000 und wird laut `docker-compose.yml` nur auf `127.0.0.1:8100` veröffentlicht (8080/8081/8090–8099 sind bereits belegt) – ein bereits laufender Reverse Proxy auf dem Pi kann eine eigene Subdomain (z. B. `uno.oualid.de`) dorthin routen.

Sobald der Container läuft, ist das Spiel außerdem über den **Spielehub** unter `games.oualid.de/uno/` erreichbar (siehe `../Spielehub`) – `public/client.js` erkennt das `/uno`-Präfix selbstständig.
