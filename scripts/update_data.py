#!/usr/bin/env python3
"""Lädt EPC-Register (SDD Core, SDD B2B) und Bankleitzahlen-Listen (DE, PL)
und schreibt sie nach data/.

- Die Download-Links der EPC-Register werden auf der EPC-Seite gesucht,
  nicht fest verdrahtet.
- Jede Quelle wird einzeln geprüft (Mindestanzahl, kein starker Einbruch).
  Schlägt eine Quelle fehl, bleiben ihre alten Daten unverändert.
- Dateien werden nur geschrieben, wenn sich der aufbereitete Inhalt ändert.
- Exit-Code 0: alles ok; 1: mindestens eine Quelle fehlgeschlagen.

Nur Python-Standardbibliothek.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import os
import re
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path

EPC_PAGE = os.environ.get(
    "EPC_PAGE_URL",
    "https://www.europeanpaymentscouncil.eu/what-we-do/be-involved/"
    "register-participants/registers-participants-sepa-payment-schemes",
)
BBK_PAGE = os.environ.get(
    "BBK_PAGE_URL",
    "https://www.bundesbank.de/de/aufgaben/unbarer-zahlungsverkehr/"
    "serviceangebot/bankleitzahlen/download-bankleitzahlen-602592",
)
NBP_URL = os.environ.get("NBP_URL", "https://ewib.nbp.pl/plewibnra?dokNazwa=plewibnra.txt")

USER_AGENT = os.environ.get(
    "HTTP_USER_AGENT", "SEPA-Bankpruefung-Datenabruf/1.0 (GitHub Actions; taeglicher Abruf)"
)

BIC_RE = re.compile(r"^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$")

# Plausibilitätsgrenzen: weniger Einträge = Abruf vermutlich kaputt.
MIN_ROWS = {"sdd_core": 500, "sdd_b2b": 200, "blz_de": 1000, "blz_pl": 500}
# Neue Daten dürfen nicht um mehr als diesen Anteil schrumpfen.
MAX_SHRINK = 0.30


class SourceError(Exception):
    pass


# ---------------------------------------------------------------- Netzwerk

def fetch(url: str, timeout: int = 60) -> bytes:
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "text/html,text/csv,text/plain,application/octet-stream,*/*;q=0.8",
            "Accept-Language": "de,en;q=0.8",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = resp.read()
    except urllib.error.HTTPError as e:
        hint = ""
        if e.code in (403, 503):
            hint = " (vermutlich Bot-Schutz der Website – siehe README, Abschnitt 'Manuelle Aktualisierung')"
        raise SourceError(f"HTTP {e.code} beim Abruf von {url}{hint}") from e
    except Exception as e:  # noqa: BLE001
        raise SourceError(f"Abruf fehlgeschlagen: {url}: {e}") from e
    if not data:
        raise SourceError(f"Leere Antwort von {url}")
    return data


def decode(data: bytes, encodings=("utf-8-sig", "cp1252")) -> str:
    for enc in encodings:
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            continue
    return data.decode("latin-1")


# ---------------------------------------------------------------- Link-Suche

class LinkCollector(HTMLParser):
    """Sammelt <a>-Links samt Linktext und dem davor stehenden Seitentext."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.text_so_far: list[str] = []
        self.links: list[dict] = []
        self._cur: dict | None = None

    def handle_starttag(self, tag, attrs):
        if tag == "a":
            href = dict(attrs).get("href")
            if href:
                context = " ".join(self.text_so_far)[-400:]
                self._cur = {"href": href, "text": "", "context": context}

    def handle_endtag(self, tag):
        if tag == "a" and self._cur is not None:
            self.links.append(self._cur)
            self._cur = None

    def handle_data(self, data):
        d = " ".join(data.split())
        if not d:
            return
        if self._cur is not None:
            self._cur["text"] += " " + d
        self.text_so_far.append(d)
        if len(self.text_so_far) > 400:
            self.text_so_far = self.text_so_far[-200:]


SCHEME_PATTERNS = {
    # Reihenfolge = Vorrang bei gleicher Position (spezifisch vor allgemein)
    "sct_inst": re.compile(r"sct[\s_-]*inst|instant credit", re.I),
    "sdd_b2b": re.compile(r"\bb2b\b|business[\s-]+to[\s-]+business|sdd[\s_-]*b2b", re.I),
    "sdd_core": re.compile(r"sdd[\s_-]*core|direct debit core|\bcore\b", re.I),
    "sct": re.compile(r"\bsct\b|sepa credit transfer", re.I),
    "other": re.compile(r"verification of payee|\bvop\b|\bspl\b|request to pay|\bsrtp\b", re.I),
}


def classify(text: str) -> str | None:
    """Liefert das Scheme, das im Text zuletzt erwähnt wird (bzw. None)."""
    best, best_pos = None, -1
    for scheme, pat in SCHEME_PATTERNS.items():
        positions = [m.start() for m in pat.finditer(text.replace("_", " "))]
        if positions and max(positions) > best_pos:
            best, best_pos = scheme, max(positions)
    return best


def is_csv_link(link: dict) -> bool:
    href = link["href"].lower()
    text = link["text"].lower()
    path = urllib.parse.urlparse(href).path
    return path.endswith(".csv") or "csv" in text or "format=csv" in href or "_format=csv" in href


def find_epc_csv_links(html: str, base_url: str) -> dict[str, str]:
    p = LinkCollector()
    p.feed(html)
    found: dict[str, list[str]] = {"sdd_core": [], "sdd_b2b": []}
    for link in p.links:
        if not is_csv_link(link):
            continue
        url = urllib.parse.urljoin(base_url, link["href"])
        # 1. URL selbst (z. B. .../sdd_core.csv), 2. Linktext, 3. Text davor
        path = urllib.parse.unquote(urllib.parse.urlparse(url).path)
        scheme = classify(path) or classify(link["text"]) or classify(link["context"])
        if scheme in found and url not in found[scheme]:
            found[scheme].append(url)
    result = {}
    for scheme, urls in found.items():
        if not urls:
            raise SourceError(
                f"Kein CSV-Link für {scheme} auf der EPC-Seite gefunden "
                f"({len(p.links)} Links geprüft). Hat sich die Seite geändert?"
            )
        if len(urls) > 1:
            raise SourceError(f"Mehrdeutige CSV-Links für {scheme}: {urls}")
        result[scheme] = urls[0]
    return result


# ---------------------------------------------------------------- EPC-CSV

def sniff_rows(text: str) -> list[list[str]]:
    sample = text[:20000]
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=";,\t|")
    except csv.Error:
        dialect = csv.excel
        dialect.delimiter = ";" if sample.count(";") > sample.count(",") else ","
    return [row for row in csv.reader(io.StringIO(text), dialect)]


def norm(s: str) -> str:
    return " ".join((s or "").replace("﻿", "").split())


def parse_epc_csv(data: bytes) -> list[list[str]]:
    """Gibt [[BIC, Name, Land], ...] zurück, sortiert und dedupliziert."""
    head = data[:500].lstrip().lower()
    if head.startswith(b"<!doctype") or head.startswith(b"<html"):
        raise SourceError("Statt CSV kam eine HTML-Seite zurück (Bot-Schutz oder Fehlerseite).")
    if data[:2] == b"PK":
        raise SourceError("Datei ist ein ZIP/XLSX statt CSV – Parser muss angepasst werden.")
    rows = sniff_rows(decode(data))
    if not rows:
        raise SourceError("CSV ist leer.")

    # Kopfzeile: erste Zeile mit einer Spalte, die 'BIC' enthält
    header_idx, bic_col, name_col, country_col = None, None, None, None
    for i, row in enumerate(rows[:30]):
        cells = [norm(c).lower() for c in row]
        bic_cols = [j for j, c in enumerate(cells) if re.search(r"\bbic\b|bic\s*code|swift", c)]
        if bic_cols:
            header_idx, bic_col = i, bic_cols[0]
            name_candidates = [j for j, c in enumerate(cells) if "name" in c or "participant" in c or "institution" in c]
            # bevorzugt "participant name"/"name", nicht "bic"
            name_candidates = [j for j in name_candidates if j != bic_col]
            name_col = name_candidates[0] if name_candidates else None
            country = [j for j, c in enumerate(cells) if "country" in c or c in ("land", "ctry")]
            country_col = country[0] if country else None
            break

    if header_idx is None:
        # Keine Kopfzeile: Spalte mit den meisten BIC-Treffern nehmen
        counts: dict[int, int] = {}
        for row in rows[:200]:
            for j, c in enumerate(row):
                if BIC_RE.match(norm(c).upper()):
                    counts[j] = counts.get(j, 0) + 1
        if not counts:
            raise SourceError("Keine BIC-Spalte in der CSV erkannt.")
        bic_col = max(counts, key=counts.get)
        header_idx = -1

    out: dict[str, list[str]] = {}
    for row in rows[header_idx + 1:]:
        if bic_col >= len(row):
            continue
        bic = norm(row[bic_col]).upper().replace(" ", "")
        if len(bic) == 8:
            bic += "XXX"
        if not BIC_RE.match(bic):
            continue
        name = norm(row[name_col]) if name_col is not None and name_col < len(row) else ""
        country = norm(row[country_col]) if country_col is not None and country_col < len(row) else ""
        # Ländercode: zweistellig aus Spalte, sonst aus BIC (Stelle 5–6)
        cc = country.upper() if re.fullmatch(r"[A-Za-z]{2}", country) else bic[4:6]
        if bic not in out:
            out[bic] = [bic, name, cc]
    return sorted(out.values())


# ---------------------------------------------------------------- Bankleitzahlen

def find_bbk_csv_link(html: str, base_url: str) -> str:
    p = LinkCollector()
    p.feed(html)
    cands = []
    for link in p.links:
        path = urllib.parse.urlparse(link["href"]).path.lower()
        if path.endswith(".csv") and "blz" in path:
            cands.append(urllib.parse.urljoin(base_url, link["href"]))
    aktuell = [u for u in cands if "aktuell" in u.lower()]
    if aktuell:
        return aktuell[0]
    raise SourceError(f"Kein aktueller BLZ-CSV-Link auf der Bundesbank-Seite gefunden ({cands}).")


def parse_bbk_csv(data: bytes) -> list[list[str]]:
    text = decode(data, ("utf-8-sig", "cp1252", "latin-1"))
    rows = list(csv.reader(io.StringIO(text), delimiter=";"))
    if not rows or "bankleitzahl" not in rows[0][0].lower():
        raise SourceError("Unerwartetes Format der Bundesbank-CSV (Kopfzeile).")
    head = [c.strip().lower() for c in rows[0]]
    i_blz, i_merk, i_name, i_bic = head.index("bankleitzahl"), head.index("merkmal"), head.index("bezeichnung"), head.index("bic")
    out: dict[str, tuple[int, list[str]]] = {}
    for r in rows[1:]:
        if len(r) <= i_bic:
            continue
        blz, bic, name = r[i_blz].strip(), r[i_bic].strip().upper(), norm(r[i_name])
        if not re.fullmatch(r"\d{8}", blz) or not BIC_RE.match(bic):
            continue
        prio = 0 if r[i_merk].strip() == "1" else 1  # Merkmal 1 = BLZ-führend
        if blz not in out or prio < out[blz][0]:
            out[blz] = (prio, [blz, bic, name])
    return [v[1] for _, v in sorted(out.items())]


def parse_nbp_txt(data: bytes) -> list[list[str]]:
    text = decode(data, ("utf-8-sig", "cp852"))
    out: dict[str, list[str]] = {}
    for line in text.splitlines():
        f = [x.strip() for x in line.split("\t")]
        if len(f) < 5:
            continue
        code = next((x for x in f if re.fullmatch(r"\d{8}", x)), None)
        bics = [x.upper() for x in f if BIC_RE.match(x.upper()) and x.upper()[4:6] == "PL"]
        if not code or not bics:
            continue
        bic = bics[0]
        if len(bic) == 8:
            bic += "XXX"
        if code not in out:
            out[code] = [code, bic, norm(f[1])]
    return [out[k] for k in sorted(out)]


# ---------------------------------------------------------------- Schreiben

def rows_to_csv(header: list[str], rows: list[list[str]]) -> bytes:
    buf = io.StringIO()
    w = csv.writer(buf, delimiter=";", lineterminator="\n")
    w.writerow(header)
    w.writerows(rows)
    return buf.getvalue().encode("utf-8")


def count_rows(path: Path) -> int:
    if not path.exists():
        return 0
    return max(0, sum(1 for _ in path.open(encoding="utf-8")) - 1)


def check_plausible(key: str, rows: list, target: Path):
    n = len(rows)
    if n < MIN_ROWS[key]:
        raise SourceError(f"Nur {n} Einträge (erwartet mindestens {MIN_ROWS[key]}).")
    old = count_rows(target)
    if old and n < old * (1 - MAX_SHRINK):
        raise SourceError(
            f"Einträge von {old} auf {n} gefallen (> {int(MAX_SHRINK*100)} %) – Abruf vermutlich unvollständig."
        )


FILES = {
    "sdd_core": ("sdd_core.csv", ["bic", "name", "land"], "EPC-Register SDD Core"),
    "sdd_b2b": ("sdd_b2b.csv", ["bic", "name", "land"], "EPC-Register SDD B2B"),
    "blz_de": ("blz_de.csv", ["bankleitzahl", "bic", "name"], "Bundesbank Bankleitzahlen"),
    "blz_pl": ("blz_pl.csv", ["numer_rozliczeniowy", "bic", "name"], "NBP Numery rozliczeniowe"),
}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", default=str(Path(__file__).resolve().parent.parent / "data"))
    ap.add_argument("--only", nargs="*", choices=["epc", "blz_de", "blz_pl"], default=["epc", "blz_de", "blz_pl"])
    ap.add_argument("--from-raw", nargs=2, action="append", metavar=("SCHEME", "DATEI"),
                    help="Lokale Datei statt Download verwenden, z. B. --from-raw sdd_core export.csv")
    args = ap.parse_args()

    data_dir = Path(args.data_dir)
    data_dir.mkdir(parents=True, exist_ok=True)
    meta_path = data_dir / "meta.json"
    meta = json.loads(meta_path.read_text(encoding="utf-8")) if meta_path.exists() else {}
    meta.setdefault("quellen", {})
    now = datetime.now(timezone.utc).replace(microsecond=0).isoformat()

    results: dict[str, tuple[list[list[str]], str]] = {}  # key -> (rows, source_url)
    errors: dict[str, str] = {}
    local = {k: v for k, v in (args.from_raw or [])}

    if local:
        for key, path in local.items():
            if key not in ("sdd_core", "sdd_b2b"):
                errors[key] = "--from-raw unterstützt nur sdd_core und sdd_b2b"
                continue
            try:
                results[key] = (parse_epc_csv(Path(path).read_bytes()), f"manuell: {Path(path).name}")
            except (SourceError, OSError) as e:
                errors[key] = str(e)
    else:
        if "epc" in args.only:
            try:
                html = decode(fetch(EPC_PAGE))
                links = find_epc_csv_links(html, EPC_PAGE)
                for key, url in links.items():
                    try:
                        results[key] = (parse_epc_csv(fetch(url)), url)
                    except SourceError as e:
                        errors[key] = str(e)
            except SourceError as e:
                errors["sdd_core"] = errors["sdd_b2b"] = str(e)
        if "blz_de" in args.only:
            try:
                url = find_bbk_csv_link(decode(fetch(BBK_PAGE)), BBK_PAGE)
                results["blz_de"] = (parse_bbk_csv(fetch(url)), url)
            except SourceError as e:
                errors["blz_de"] = str(e)
        if "blz_pl" in args.only:
            try:
                results["blz_pl"] = (parse_nbp_txt(fetch(NBP_URL)), NBP_URL)
            except SourceError as e:
                errors["blz_pl"] = str(e)

    changed = []
    for key, (rows, url) in results.items():
        fname, header, label = FILES[key]
        target = data_dir / fname
        try:
            check_plausible(key, rows, target)
        except SourceError as e:
            errors[key] = str(e)
            continue
        content = rows_to_csv(header, rows)
        digest = hashlib.sha256(content).hexdigest()
        if target.exists() and target.read_bytes() == content:
            print(f"✓ {label}: unverändert ({len(rows)} Einträge)")
            continue
        tmp = target.with_suffix(".tmp")
        tmp.write_bytes(content)
        tmp.replace(target)  # atomar
        meta["quellen"][key] = {
            "bezeichnung": label,
            "datei": fname,
            "quelle": url,
            "eintraege": len(rows),
            "sha256": digest,
            "geaendert_am": now,
        }
        changed.append(key)
        print(f"✎ {label}: aktualisiert ({len(rows)} Einträge) von {url}")

    if changed:
        meta["zuletzt_geaendert"] = now
        meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    for key, msg in errors.items():
        label = FILES.get(key, (None, None, key))[2]
        print(f"::error title={label}::{msg} – alte Daten bleiben bestehen.")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
