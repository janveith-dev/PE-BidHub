# Bid Hub

Plattform für Presales, Sales und Bid Management bei der public edge GmbH:

- **Wissensbasis (Presales):** Produktdokumentation, Konzeptbausteine, Konfigurationen, Preislisten, Zertifikate und alles weitere für Ausschreibungen hochladen – mit Kategorie, Hersteller, Schlagwörtern, „gültig bis" und Versionierung.
- **Sales-Chat:** Fragen per Text oder Sprache. Antworten stützen sich ausschließlich auf die Wissensbasis, nennen ihre Quellen (anklickbar) und kennzeichnen abgelaufene Dokumente. Der Sprachmodus führt einen vollständigen Dialog: zuhören → Whisper → Antwort → ElevenLabs liest vor → wieder zuhören.
- **Bid-Studio (Bid Management):** Kundenvorgabe hochladen oder einfügen (z. B. „so fordert der Kunde das Servicekonzept"). KI-Agenten mit verschiedenen Rollen analysieren die Vorgabe, schlagen eine Gliederung vor, recherchieren in der Wissensbasis und im Web, schreiben die Kapitel, prüfen sie unabhängig und überarbeiten gezielt. Ergebnis: Editor in der Oberfläche und DOCX-Export mit Firmenvorlage.

> **Stand ehrlich vorweg:** Alles, was ohne externe Dienste prüfbar ist, ist getestet (siehe [Verifikationsstand](#verifikationsstand)). Die Aufrufe an die Anthropic-API und an ElevenLabs wurden **nie gegen die echten Dienste** ausgeführt – dafür gab es keine Schlüssel. Sie sind gegen die dokumentierte API gebaut und mit Test-Doubles geprüft. Der erste echte Lauf gehört in Ihre Abnahme.

## Inhalt

- [Schnellstart](#schnellstart)
- [Architektur](#architektur)
- [Konfiguration](#konfiguration)
- [Bedienung nach Rolle](#bedienung-nach-rolle)
- [So arbeiten die Agenten](#so-arbeiten-die-agenten)
- [Betrieb mit Docker Compose](#betrieb-mit-docker-compose)
- [Tests](#tests)
- [Verifikationsstand](#verifikationsstand)
- [Einschränkungen und Sicherheit](#einschränkungen-und-sicherheit)

## Schnellstart

Voraussetzungen: Node.js ≥ 22, pnpm 10.

```bash
pnpm install
cp .env.example .env     # optional: ANTHROPIC_API_KEY und ELEVENLABS_API_KEY eintragen
pnpm seed                # Demodaten: 7 Beispieldokumente + eine Beispiel-Ausschreibung
pnpm dev                 # API auf :3000, Oberfläche auf http://localhost:5173
```

Ohne weitere Konfiguration läuft die Plattform mit einer eingebetteten Datenbank (PGlite unter `./data`) und lexikalischen Hash-Embeddings. Funktionen, für die etwas fehlt, melden das in der Oberfläche (`GET /api/capabilities`):

| Fehlt …                      | Folge                                                                      |
| ---------------------------- | -------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`          | Chat und Agenten sind aus; Upload, Suche und manuelles Bearbeiten laufen   |
| ML-Dienst (`ML_SERVICE_URL`) | keine Spracherkennung, keine OCR; Suche nutzt Hash-Embeddings statt Modell |
| `ELEVENLABS_API_KEY`         | keine Sprachausgabe; Spracheingabe und Text funktionieren                  |

Die **Demodaten sind frei erfunden** und im Text als „DEMO-DATEN" gekennzeichnet – sie ersetzen keine echten Datenblätter, Preise oder Zertifikate. Sie enthalten absichtlich ein abgelaufenes Datenblatt und eine bald ablaufende Preisliste, damit die Gültigkeitsmarkierung sichtbar ist.

## Architektur

```
apps/web        React 19 + Vite: Wissensbasis, Chat mit Sprachdialog, Bid-Studio
apps/api        Fastify 5: REST + NDJSON-Streaming, Ingest, Suche, Chat, Agenten-Pipeline, DOCX-Export
packages/shared Zod-Schemas und Typen, von API und Web geteilt
services/ml     Python/FastAPI: Whisper (Spracherkennung), Embeddings, OCR – alles lokal
demo-data       erfundene Beispielinhalte für `pnpm seed`
e2e             Browsertest (Playwright) gegen einen Testserver
```

**Datenhaltung.** PostgreSQL mit `pgvector` (Betrieb) bzw. PGlite (Entwicklung und Tests) hinter einer gemeinsamen `Db`-Schnittstelle, SQL-Migrationen in `apps/api/src/db/migrations`. Originaldateien liegen im Datenverzeichnis, Texte, Chunks, Vektoren und Bid-Daten in der Datenbank.

**Suche.** Hybrid aus Volltext (Postgres `tsvector`, Deutsch + Englisch, Präfixsuche ab vier Zeichen) und Vektorsuche (`paraphrase-multilingual-MiniLM-L12-v2`, 384 Dimensionen), vereint per Reciprocal Rank Fusion; höchstens drei Treffer je Dokument. Jeder Chunk merkt sich sein Embedding-Modell; bei einem Modellwechsel erkennt die API das und bietet `POST /api/admin/reindex` an.

**Ingest.** PDF (mit OCR-Rückfall für Scans), DOCX, XLSX (Kopfzeile wird je Chunk wiederholt), PPTX, Text/CSV/Konfigurationsdateien (UTF-8, UTF-16 und Windows-1252 werden erkannt), Bilder per OCR. Chunking folgt dem Überschriftenpfad, Duplikate werden per SHA-256 erkannt. Ein neues Dokument derselben Familie wird als neue Version geführt; nur die aktuelle Version ist durchsuchbar.

**Claude-Anbindung.** Hinter einer `Llm`-Schnittstelle (`AnthropicLlm` im Betrieb, `FakeLlm` in Tests). Streaming, Tool-Schleife, Zod-Prüfung aller Tool-Eingaben, strukturierte Ausgaben, Websuche mit Sperrliste. Modelle je Rolle sind konfigurierbar.

## Konfiguration

Alle Werte stehen in `.env.example`. Die wichtigsten:

| Variable                                                           | Bedeutung                                                                              | Standard                        |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------- | ------------------------------- |
| `ANTHROPIC_API_KEY`                                                | Schlüssel für Chat und Agenten                                                         | –                               |
| `MODEL_CHAT`, `MODEL_RESEARCH`, `MODEL_EDITOR`                     | Modell für Chat, Rechercheur, Lektor                                                   | `claude-sonnet-5-5`             |
| `MODEL_ANALYST`, `MODEL_WRITER`, `MODEL_REVIEWER`                  | Modell für Analyst, Autoren, Prüfer                                                    | `claude-opus-5-5`               |
| `LLM_REFUSAL_FALLBACK`                                             | serverseitiger Fallback der Claude-API bei Sicherheitsablehnungen; `0` schaltet ihn ab | an                              |
| `WEB_BLOCKED_DOMAINS`                                              | Domains, die die Websuche nie liefern darf (kommagetrennt), z. B. Wettbewerber         | leer                            |
| `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`, `ELEVENLABS_MODEL_ID` | Sprachausgabe                                                                          | Modell `eleven_multilingual_v2` |
| `ML_SERVICE_URL`                                                   | Adresse des ML-Dienstes                                                                | –                               |
| `WHISPER_MODEL`                                                    | `small` (schnell) oder `large-v3-turbo` (genauer, langsamer)                           | `small`                         |
| `DATABASE_URL`                                                     | `postgresql://…`; ohne Angabe PGlite unter `DATA_DIR`                                  | PGlite                          |
| `DATA_DIR`                                                         | Ablage für Originaldateien und PGlite                                                  | `./data`                        |
| `COMPANY_NAME`                                                     | Absender auf dem Deckblatt                                                             | `public edge GmbH`              |

> **Sprachausgabe:** Die voreingestellte `ELEVENLABS_VOICE_ID` ist ein Platzhalter. Bitte in Ihrem ElevenLabs-Konto eine deutschsprachige Stimme wählen und die ID eintragen.

## Bedienung nach Rolle

Es gibt bewusst **keinen Login**. Oben in der Oberfläche schaltet man zwischen **Presales**, **Sales** und **Bid Management** um; die Rolle steuert nur, was die Oberfläche zeigt, und wird als `X-Role` im Protokoll vermerkt. Sie ist **kein Zugriffsschutz** (siehe unten).

**Presales** pflegt die Wissensbasis: Dateien hochladen (bis zu zehn auf einmal), Kategorie, Hersteller, Schlagwörter und „gültig bis" setzen; beim Hochladen lässt sich eine bestehende Unterlage ersetzen (es entsteht eine neue Version). Einzelne Versionen lassen sich löschen. Abgelaufene und bald ablaufende Dokumente sind markiert.

**Sales** landet im Chat. Fragen per Tastatur oder per Mikrofon-Taste; im Sprachdialog erkennt die Oberfläche selbst, wann man fertig gesprochen hat, liest die Antwort vor und hört danach wieder zu. Während die Antwort vorgelesen wird, ist das Mikrofon pausiert. Quellenmarken `[Q1]` öffnen das Dokument.

**Bid Management** arbeitet im Bid-Studio:

1. Ausschreibung anlegen, Kundenvorgabe hochladen oder einfügen, Dokument anlegen (Titel, Sprache DE/EN, Websuche erlaubt ja/nein). Das Wortlimit legt man je Kapitel in der Gliederung fest.
2. **Analyse starten** – der Analyst zieht Anforderungen mit Zitat aus der Vorgabe und entwirft die Gliederung.
3. **Gliederung prüfen und freigeben** – Kapitel umbenennen, verschieben, Autorenrolle ändern, Anforderungen zuordnen. Die Freigabe wird serverseitig erzwungen: Bleiben Muss-Anforderungen ohne Kapitel, lehnt die API ab (409), es sei denn, man bestätigt ausdrücklich.
4. **Autoren schreiben** die Kapitel (je Rolle: Lösungsarchitekt, Service Manager, Projektleiter, Security).
5. **Prüfen** – unabhängiger Prüfer, Abdeckungsmatrix, Befunde; jeder Befund lässt sich mit „Gezielt beheben lassen" vom Lektor bearbeiten.
6. **Editor und Versionen:** Jedes Kapitel ist von Hand bearbeitbar; jede Fassung wird mit Autor gespeichert und lässt sich wiederherstellen.
7. **Export als DOCX** – mit der eingebauten Standardvorlage oder einer hochgeladenen Firmenvorlage (`.docx`/`.dotx`).

**Firmenvorlage:** Platzhalter `{{TITEL}}`, `{{KUNDE}}`, `{{AUSSCHREIBUNG}}`, `{{DATUM}}`, `{{AUTOR}}` werden ersetzt (auch wenn Word sie auf mehrere Textläufe verteilt hat). Ein eigener Absatz mit `{{INHALT}}` markiert die Stelle für den Inhalt; Formatvorlagen für Überschriften, Listen und Tabellen werden aus der Vorlage übernommen. Offene Punkte (`[OFFEN: …]`) werden gelb markiert und der Export meldet ihre Zahl im Header `x-open-points`.

## So arbeiten die Agenten

```
Kundenvorgabe ──► Analyst ──► Gliederung ──► FREIGABE (Mensch)
                                                  │
                    Rechercheur ◄─────────────────┘
        (Wissensbasis + Websuche, nur belegte Fakten)
                         │
                    Autor je Rolle ──► Prüfer (unabhängig) ──► Lektor (gezielt)
```

- **Analyst** (Opus): Anforderungen (`R-001 …`) mit wörtlichem Zitat, Kapitelgliederung (`S-01 …`). Die Kennungen vergibt der Server; ein Zitat gilt nur als belegt (`quoteVerified`), wenn es tatsächlich in der Vorgabe steht.
- **Rechercheur** (Sonnet): sucht mit `search_knowledge`, ergänzt per Websuche (jede Fundstelle mit Link; gesperrte Domains werden nie geliefert) und hält Fakten über `record_fact` fest. Ein Fakt wird nur übernommen, wenn sein Zitat im Fundstück bzw. auf der Webseite steht. Was nicht gefunden wird, meldet er als Lücke.
- **Autor** (Opus, je Rolle): schreibt ein Kapitel nur aus den belegten Fakten (`[F1]`-Marken). Fehlt etwas, steht dort `[OFFEN: …]` statt einer Erfindung. Unbekannte Marken werden entfernt, zu lange Kapitel automatisch gekürzt.
- **Prüfer** (Opus): sieht den Text unabhängig vom Autor. Abdeckungsmatrix je Anforderung, Befunde (nicht belegte Behauptungen, Widersprüche, Stil, …) und feste Prüfungen ohne KI: Länge, offene Punkte, Quellenmarken, Gültigkeit der Quellen.
- **Lektor** (Sonnet): überarbeitet gezielt entlang der Befunde oder poliert den Stil; ein Wächter verwirft Änderungen, die Zahlen oder Quellenmarken verändern.

Jeder Schritt landet im Ereignisprotokoll (`agent_events`) mit Verbrauch; die Oberfläche zeigt es als Aktivitätsprotokoll. Wird die API mitten in einem Lauf neu gestartet, setzt sie das Dokument beim Start auf den letzten stabilen Zustand zurück und zeigt „Der Lauf wurde durch einen Neustart des Servers unterbrochen. Bitte erneut starten." – bereits geschriebene Kapitel bleiben erhalten, ein automatisches Fortsetzen gibt es nicht. Je Dokument läuft höchstens ein Job.

## Betrieb mit Docker Compose

```bash
cp .env.example .env     # POSTGRES_PASSWORD ändern, Schlüssel eintragen
docker compose up -d --build
docker compose exec api node --import tsx src/scripts/seed.ts   # optional: Demodaten
```

Die Oberfläche ist danach unter `http://localhost:8080` (`WEB_PORT`) erreichbar. Dienste: `db` (pgvector/pgvector:pg17), `ml` (Whisper, Embeddings, OCR), `api`, `web` (nginx, leitet `/api` weiter, ohne Pufferung für das Streaming). Daten liegen in den Volumes `db-data`, `ml-models`, `api-data`. Beim ersten Start lädt der ML-Dienst die Modelle herunter (einige hundert MB bis rund 2 GB, je nach Whisper-Modell) – das dauert.

**Whisper-Modell:** `small` ist auf einer CPU schnell genug für einen Dialog (ca. 2 s je Frage auf 4 Kernen gemessen). `large-v3-turbo` erkannte in unserem Vergleich genauer (7,8 % statt 11 % Wortfehler), ist aber etwa viermal so langsam – sinnvoll mit GPU oder viel CPU. Die Messung nutzte **synthetische Stimmen** (8 Sätze); mit echten Stimmen, Dialekt und Raumklang kann das Bild anders aussehen. Bitte mit eigenen Aufnahmen gegenprüfen, bevor Sie sich festlegen.

Der Browser erlaubt das Mikrofon nur über `https://` oder `http://localhost`. Für den Zugriff von anderen Rechnern gehört ein TLS-terminierender Reverse Proxy vor den `web`-Dienst.

## Tests

```bash
pnpm lint && pnpm format:check && pnpm typecheck
pnpm test                    # 132 Tests auf PGlite (kein Docker nötig)
TEST_DATABASE_URL=postgres://bid:bid_test@127.0.0.1:5432/bid_test pnpm test   # dieselben Tests auf echtem Postgres
pnpm build
```

Mit `TEST_DATABASE_URL` bekommt jede Testdatei ein eigenes Schema; die Datenbank muss `pgvector` anbieten.

**Browsertest** (Playwright/Chromium, 18 Schritte durch alle drei Rollen inkl. DOCX-Export und schmalem Fenster):

```bash
CHROMIUM_PATH=/pfad/zu/chromium pnpm e2e
# optional, mit echter Spracherkennung und Sprachdialog:
ML_SERVICE_URL=http://127.0.0.1:8100 E2E_MIC_WAV=/pfad/zur/aufnahme.wav E2E_MIC_EXPECT="Priorität" pnpm e2e
```

Der Testserver (`e2e/smoke-server.mts`) nutzt die echte API und Datenbankschicht, ersetzt aber Claude und ElevenLabs durch skriptierte Antworten. Der Test prüft also die Verdrahtung der Oberfläche, **nicht** die Qualität echter Modellantworten. Screenshots landen in `e2e/shots` (oder `E2E_SHOTS`).

## Verifikationsstand

**Geprüft (automatisiert):** Lint, Format, Typen, 132 Tests (Datenbankschicht, Chunking, Ingest, Suche, Chat-Streaming, Anthropic-Adapter gegen einen simulierten Client, Bid-Pipeline inkl. Freigabetor/Wiederanlauf/Versionen, DOCX-Export und Vorlagen, Sprach-Logik im Browser), identisch auf PGlite und Postgres 17 mit pgvector; 18 Browserschritte inkl. Sprachdialog mit echtem Whisper und DOCX-Export. Erzeugte DOCX-Dateien wurden zusätzlich mit python-docx und LibreOffice geöffnet.

**Nicht geprüft:**

- **Echte Claude-Aufrufe.** Weder Qualität der Texte noch Kosten, Laufzeiten oder Ratenlimits sind gemessen. Prompts und Prüfregeln sind der erste Ort zum Nachschärfen. Die Modellnamen stehen in der Konfiguration.
- **Echte ElevenLabs-Aufrufe** (Stimme, Latenz, Kosten).
- **Docker-Images:** In der Entwicklungsumgebung ließ sich Docker nicht bauen. Die Dockerfiles und `docker-compose.yml` sind sorgfältig geprüft, aber nie gebaut worden – rechnen Sie mit Kleinigkeiten beim ersten `docker compose up --build`.
- **Spracherkennung mit echten Stimmen** (nur synthetische Stimme und eine Testaufnahme).
- **Last und Parallelität:** Größenordnung war ein Team, keine Hunderte gleichzeitiger Nutzer.
- **Suchqualität auf Ihren echten Dokumenten.** Bekannte Schwäche: Synonyme wie „Serverräume" ↔ „Rechenzentrum" findet die Suche nur teilweise. Den Agenten ist in den Werkzeugbeschreibungen aufgetragen, mit Varianten mehrfach zu suchen; die Vektorsuche gleicht einen Teil aus.

## Einschränkungen und Sicherheit

- **Kein Login, kein Zugriffsschutz.** Wer die URL erreicht, kann alles lesen und ändern; die Rolle ist nur eine Bedienhilfe. Vor produktivem Einsatz Zugriff über Netzwerk/VPN/Reverse-Proxy mit Authentifizierung (z. B. SSO) absichern oder echten Login ergänzen.
- **Vertraulichkeit:** Für Chat und Agenten werden Textausschnitte (Treffer der Wissensbasis, Kundenvorgabe) an die **Anthropic-API** gesendet, für Sprachausgabe die vorzulesenden Antworten an **ElevenLabs**. Whisper, Embeddings und OCR laufen lokal. Prüfen Sie vorab, ob Preislisten, Kundendaten und Vertragsunterlagen so verarbeitet werden dürfen (Auftragsverarbeitung, Vertraulichkeitsvereinbarungen der Kunden).
- **Websuche:** Frei, aber jede Fundstelle wird mit Link ausgewiesen; Wettbewerber-Domains über `WEB_BLOCKED_DOMAINS` sperren. Webinhalte sind nicht geprüft – der Prüfer und der Mensch bleiben die Kontrollinstanz.
- **KI-Texte sind Entwürfe.** Die Pipeline erzwingt Belege und markiert Lücken, ersetzt aber nicht die fachliche und rechtliche Prüfung vor Abgabe eines Angebots. Preise, Termine und Zusagen immer gegenprüfen.
- **Abgelaufene Dokumente** bleiben auffindbar (mit Kennzeichnung), damit man sie bewusst ersetzen kann; Chat und Prüfer weisen darauf hin, sperren sie aber nicht.
- **Dateigrößen:** Uploads bis 100 MB je Datei, höchstens zehn Dateien je Vorgang (nginx: 110 MB). Große Scans brauchen für OCR spürbar Zeit.
