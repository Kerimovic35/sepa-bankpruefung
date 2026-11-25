# SEPA Bankprüfung

Statische Website, die prüft, ob ein Konto per **SEPA-Lastschrift** (Core und/oder B2B) erreichbar ist. Grundlage sind die Teilnehmerregister des European Payments Council (EPC). Die Register werden täglich automatisch geladen.

- Läuft komplett im Browser: kein Server, kein Tracking, keine Cookies, keine externen Schriften oder Skripte.
- Hosting über GitHub Pages, Aktualisierung über eine GitHub Action.

## Funktionen

| Bereich | Inhalt |
|---|---|
| **Einzelprüfung** | IBAN + BIC eingeben, Ergebnis mit Bankname und Hinweisen |
| **Mehrfachprüfung** | Zeilen `Lieferant; IBAN; BIC` einfügen (Semikolon oder Tab, also direkt aus Excel). Ergebnis per Knopf in die Zwischenablage kopieren und in Excel einfügen, oder als CSV herunterladen |
| **Länderübersicht** | Anzahl der Registereinträge je Land für SDD Core und SDD B2B, mit Filter |
| **Datenstand & Hinweise** | Wann die Daten zuletzt geändert wurden, Anzahl der Einträge, Quellen, Download der CSV-Dateien |

### Mögliche Ergebnisse

| Ergebnis | Bedeutung |
|---|---|
| Core und B2B möglich | BIC (erste 8 Zeichen) steht in beiden Registern |
| nur Core | nur im Register SDD Core |
| nur B2B | nur im Register SDD B2B |
| nicht möglich | in keinem der beiden Register |
| BIC fehlt | kein BIC angegeben (oder formal ungültig) und auch nicht aus der Bankleitzahl ermittelbar |
| IBAN ungültig | Ländercode, Länge oder Prüfziffer (Modulo 97) falsch |

### So wird geprüft

1. **IBAN:** Bereinigung (Leerzeichen, Kleinbuchstaben), Ländercode bekannt, Länge passt zum Land (SWIFT IBAN Registry), Prüfziffer nach ISO 7064 Modulo 97.
2. **BIC:** Formalprüfung, danach Vergleich über die **ersten 8 Zeichen** (Bankcode, Land, Ort) mit den Registern. Die Filialkennung wird ignoriert, `COBADEFF`, `COBADEFFXXX` und `COBADEFF123` gelten also als dieselbe Bank.
3. **Deutschland und Polen:** Die Bankleitzahl wird aus der IBAN gelesen (Stelle 5–12) und in der Bundesbank- bzw. NBP-Liste nachgeschlagen.
   - Ohne BIC wird der BIC daraus ermittelt.
   - Weicht ein angegebener BIC davon ab, erscheint ein Hinweis. Geprüft wird trotzdem der angegebene BIC.
4. Zusätzliche Hinweise erscheinen, wenn das IBAN-Land nicht zum SEPA-Raum gehört oder wenn BIC-Land und IBAN-Land voneinander abweichen.

## Grenzen – bitte lesen

- **Teilnahme am Scheme ist nicht gleich Angebot.** Das EPC-Register zeigt nur, dass eine Bank am Verfahren teilnimmt und erreichbar ist. Ob sie SEPA-Lastschriften – vor allem **B2B** – für ein bestimmtes Konto oder für Firmenkunden tatsächlich anbietet, steht nicht im Register. Manche Banken nehmen formal an B2B teil, bieten es aber nicht für alle Kontoarten oder Kundengruppen an. Im Zweifel beim Lieferanten bzw. bei dessen Bank nachfragen.
- **Nur Euro-Konten.** SEPA-Lastschriften gibt es nur in Euro. In Ländern mit eigener Währung (z. B. PL, CZ, HU, SE, DK, RO, CH, GB) ist eine gültige IBAN oft ein Konto in Landeswährung. Ob es ein Euro-Konto ist, lässt sich aus der IBAN **nicht** ablesen.
- **B2B-Mandat:** Bei B2B muss der Zahlungspflichtige das Mandat zusätzlich bei seiner Bank bestätigen bzw. hinterlegen.
- **BIC-Ermittlung** gibt es nur für DE und PL. Für andere Länder muss der BIC angegeben werden.
- **Qualität der Daten:** Die Register können Lücken oder Verzögerungen haben. Die Prüfung ersetzt keine Bestätigung durch die Bank.
- Eine gültige Prüfziffer bedeutet nicht, dass das Konto existiert.

## Einrichtung

1. **Repository anlegen** und diesen Ordner pushen (Branch `main`). Für GitHub Pages im kostenlosen Tarif muss das Repository öffentlich sein. Es enthält nur öffentliche Registerdaten.
2. **Pages aktivieren:** *Settings → Pages → Build and deployment → Source: „GitHub Actions“*.
3. **Schreibrechte der Action:** *Settings → Actions → General → Workflow permissions → „Read and write permissions“*. Der Workflow fordert `contents: write` zwar selbst an, in manchen Organisationen ist das aber gesperrt.
4. **Erster Lauf:** *Actions → „Daten aktualisieren und Seite veröffentlichen“ → Run workflow*.
5. Die Seite ist danach unter `https://<benutzer>.github.io/<repository>/` erreichbar.

### Ablauf der Action (`.github/workflows/daten-und-seite.yml`)

- **Auslöser:** täglich um 05:23 UTC (cron), manuell (*Run workflow*) und bei jedem Push auf `main`.
- **Tests:** Zuerst laufen die Tests des Abrufskripts und der Prüflogik.
- **Abruf:** `scripts/update_data.py` öffnet die [EPC-Seite](https://www.europeanpaymentscouncil.eu/what-we-do/be-involved/register-participants/registers-participants-sepa-payment-schemes) und **sucht dort die CSV-Links** für SDD Core und SDD B2B. Die Links sind nicht fest verdrahtet. Zugeordnet wird über die Link-Adresse, den Linktext oder die Überschrift vor dem Link. Fehlt ein Link oder ist er mehrdeutig, schlägt der Abruf fehl.
- **Bankleitzahlen:** Die Bundesbank-CSV wird ebenfalls auf der Download-Seite gesucht. Die NBP-Liste (`plewibnra.txt`) kommt von ewib.nbp.pl.
- **Aufbereitung:** Alle Quellen werden in ein einheitliches Format gebracht: UTF-8, Semikolon, sortiert, ohne Dubletten.
- **Plausibilitätsprüfung:** Jede Quelle muss eine Mindestzahl an Einträgen haben (Core 500, B2B 200, DE 1000, PL 500). Außerdem darf sie gegenüber dem letzten Stand um höchstens 30 % schrumpfen. Kommt statt CSV eine HTML-Seite zurück (Bot-Schutz, Fehlerseite), wird sie verworfen.
- **Nur bei Änderung:** Dateien werden nur geschrieben, wenn sich der aufbereitete Inhalt ändert. Dann committet die Action nach `data/` und veröffentlicht die Seite neu. Ohne Änderung gibt es keinen Commit und kein Deployment.
- **Fehler:** Eine fehlgeschlagene Quelle behält ihre alten Daten. Die Action endet trotzdem **rot** mit einer Fehlermeldung (`::error::`). GitHub schickt dann standardmäßig eine E-Mail an den Repository-Inhaber. Andere Quellen, die erfolgreich geladen wurden, werden trotzdem gespeichert.

### Dateien in `data/`

| Datei | Spalten | Quelle |
|---|---|---|
| `sdd_core.csv` | `bic;name;land` | EPC-Register SDD Core |
| `sdd_b2b.csv` | `bic;name;land` | EPC-Register SDD B2B |
| `blz_de.csv` | `bankleitzahl;bic;name` | Deutsche Bundesbank, Bankleitzahlendatei. Pro BLZ wird der BLZ-führende Eintrag (Merkmal 1) bevorzugt |
| `blz_pl.csv` | `numer_rozliczeniowy;bic;name` | Narodowy Bank Polski, EWIB (8-stellige Abrechnungsnummer = Stelle 5–12 der PL-IBAN) |
| `meta.json` | Quelle, Anzahl, SHA-256, Zeitpunkt der letzten Änderung | – |

## Wichtig: Bot-Schutz der EPC-Website

Die EPC-Website steht hinter einem Cloudflare-Bot-Schutz. Bei Tests beim Aufbau dieses Projekts lieferte sie automatisierten Abrufen eine Prüfseite („Just a moment…“, HTTP 403) statt des Inhalts. Je nach Einstellung des EPC kann das auch die Server von GitHub Actions treffen. Die Action schlägt dann sichtbar fehl, die alten Daten bleiben erhalten. Das Skript versucht **nicht**, den Bot-Schutz zu umgehen.

### Manuelle Aktualisierung (falls der automatische Abruf blockiert wird)

1. Die EPC-Seite im Browser öffnen und die CSV-Dateien für SDD Core und SDD B2B herunterladen.
2. Lokal aufbereiten:
   ```bash
   python3 scripts/update_data.py --from-raw sdd_core ~/Downloads/<core-datei>.csv \
                                  --from-raw sdd_b2b  ~/Downloads/<b2b-datei>.csv
   ```
3. `data/` committen und pushen. Der Push löst das Deployment aus.

Bankleitzahlen allein aktualisieren: `python3 scripts/update_data.py --only blz_de blz_pl`.

Die Quell-URLs lassen sich über die Umgebungsvariablen `EPC_PAGE_URL`, `BBK_PAGE_URL` und `NBP_URL` ändern.

## Lokal ausprobieren

Wegen `fetch()` und ES-Modulen funktioniert die Seite nicht per Doppelklick (`file://`). Stattdessen:

```bash
python3 -m http.server 8000
# → http://localhost:8000
```

Tests:

```bash
python3 -m unittest discover -s tests -p "test_*.py"   # Abruf und Parser
node --test tests/pruefung.test.mjs                     # IBAN-/BIC-Prüflogik
```

## Aufbau

```
index.html               Seite
assets/pruefung.js       Prüflogik (IBAN, BIC, Register) – ohne DOM, testbar
assets/app.js            Oberfläche
assets/style.css
scripts/update_data.py   Abruf, Link-Suche, Aufbereitung (nur Python-Standardbibliothek)
tests/                   Tests und Testdaten
data/                    automatisch gepflegte Daten
```

## Datenschutz

Eingaben (IBAN, BIC, Lieferantennamen) verlassen den Browser nicht. Die Seite lädt nur eigene Dateien. Das erzwingt eine Content-Security-Policy (`default-src 'self'`). Es gibt kein Tracking, keine Cookies und keinen lokalen Speicher. Hinweis: GitHub Pages protokolliert als Hoster technisch bedingt Zugriffe (z. B. IP-Adressen). Darauf hat die Seite keinen Einfluss.

## Quellen und Nutzungsbedingungen

- European Payments Council – Register of Participants in the SEPA Payment Schemes
- Deutsche Bundesbank – Bankleitzahlendateien
- Narodowy Bank Polski – Elektroniczny Wykaz Instytucji Bankowych (EWIB)

Bitte die Nutzungsbedingungen der Quellen beachten. Die Daten werden unverändert inhaltlich, nur im Format vereinheitlicht, weitergegeben.
