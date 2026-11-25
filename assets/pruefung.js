// Prüflogik ohne DOM – auch unter Node testbar.

// IBAN-Längen laut SWIFT IBAN Registry
export const IBAN_LAENGE = {
  AD: 24, AE: 23, AL: 28, AT: 20, AZ: 28, BA: 20, BE: 16, BG: 22, BH: 22, BI: 27, BR: 29, BY: 28,
  CH: 21, CR: 22, CY: 28, CZ: 24, DE: 22, DJ: 27, DK: 18, DO: 28, EE: 20, EG: 29, ES: 24, FI: 18,
  FK: 18, FO: 18, FR: 27, GB: 22, GE: 22, GI: 23, GL: 18, GR: 27, GT: 28, HN: 28, HR: 21, HU: 28,
  IE: 22, IL: 23, IQ: 23, IS: 26, IT: 27, JO: 30, KW: 30, KZ: 20, LB: 28, LC: 32, LI: 21, LT: 20,
  LU: 20, LV: 21, LY: 25, MC: 27, MD: 24, ME: 22, MK: 19, MN: 20, MR: 27, MT: 31, MU: 30, NI: 28,
  NL: 18, NO: 15, OM: 23, PK: 24, PL: 28, PS: 29, PT: 25, QA: 29, RO: 24, RS: 22, RU: 33, SA: 24,
  SC: 31, SD: 18, SE: 24, SI: 19, SK: 24, SM: 27, SO: 23, ST: 25, SV: 28, TL: 23, TN: 24, TR: 26,
  UA: 29, VA: 22, VG: 24, XK: 20, YE: 30,
};

// Länder/Gebiete im SEPA-Raum (IBAN-Ländercodes)
export const SEPA_LAENDER = new Set((
  "AT BE BG CY CZ DE DK EE ES FI FR GR HR HU IE IT LT LU LV MT NL PL PT RO SE SI SK " +
  "IS LI NO CH GB MC SM VA AD AL ME MD MK RS GI"
).split(" "));

export const ERGEBNIS = {
  BEIDE: "Core und B2B möglich",
  CORE: "nur Core",
  B2B: "nur B2B",
  KEINE: "nicht möglich",
  BIC_FEHLT: "BIC fehlt",
  IBAN_UNGUELTIG: "IBAN ungültig",
};

// Gebiete, deren BIC-Ländercode vom IBAN-Ländercode abweicht
const GEBIETE = {
  FR: ["GF", "GP", "MQ", "RE", "PF", "TF", "YT", "NC", "BL", "MF", "PM", "WF"],
  GB: ["GG", "JE", "IM"],
  FI: ["AX"],
};

const BIC_RE = /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/;

export function bereinige(s) {
  return String(s ?? "").toUpperCase().replace(/[\s \-.]/g, "");
}

export function formatiereIban(iban) {
  return bereinige(iban).replace(/(.{4})(?=.)/g, "$1 ");
}

/** Modulo-97-Prüfung nach ISO 13616 / ISO 7064. */
export function mod97(iban) {
  const umgestellt = iban.slice(4) + iban.slice(0, 4);
  let rest = 0;
  for (const ch of umgestellt) {
    const code = ch.charCodeAt(0);
    const wert = code >= 65 ? String(code - 55) : ch; // A=10 … Z=35
    for (const ziffer of wert) rest = (rest * 10 + Number(ziffer)) % 97;
  }
  return rest;
}

/** Liefert { gueltig, iban, land, fehler }. */
export function pruefeIban(eingabe) {
  const iban = bereinige(eingabe);
  const land = iban.slice(0, 2);
  if (!iban) return { gueltig: false, iban, land, fehler: "IBAN fehlt" };
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]+$/.test(iban))
    return { gueltig: false, iban, land, fehler: "Unzulässige Zeichen oder falscher Aufbau" };
  const soll = IBAN_LAENGE[land];
  if (!soll) return { gueltig: false, iban, land, fehler: `Unbekannter Ländercode ${land}` };
  if (iban.length !== soll)
    return { gueltig: false, iban, land, fehler: `Länge ${iban.length} statt ${soll} Zeichen für ${land}` };
  if (mod97(iban) !== 1) return { gueltig: false, iban, land, fehler: "Prüfziffer falsch (Modulo 97)" };
  return { gueltig: true, iban, land, fehler: null };
}

export function pruefeBicFormat(bic) {
  return BIC_RE.test(bic);
}

/** Bankcode aus der IBAN (nur DE und PL unterstützt). */
export function bankcodeAusIban(iban) {
  if (iban.startsWith("DE")) return { land: "DE", code: iban.slice(4, 12) };
  if (iban.startsWith("PL")) return { land: "PL", code: iban.slice(4, 12) };
  return null;
}

/**
 * Prüft eine Bankverbindung gegen die Register.
 * daten = { core: Map<BIC8, eintrag>, b2b: Map<BIC8, eintrag>, blz: { DE: Map, PL: Map } }
 * Ein Register darf fehlen (null) – dann gibt es einen Hinweis.
 */
export function pruefe(ibanEingabe, bicEingabe, daten) {
  const hinweise = [];
  const ib = pruefeIban(ibanEingabe);
  let bic = bereinige(bicEingabe);
  const res = { iban: ib.iban, ibanGueltig: ib.gueltig, bicEingabe: bic, bic: "", bank: "", core: false, b2b: false, hinweise };

  if (!ib.gueltig) {
    hinweise.push(ib.fehler);
    return { ...res, ergebnis: ERGEBNIS.IBAN_UNGUELTIG };
  }
  if (!SEPA_LAENDER.has(ib.land)) hinweise.push(`${ib.land} gehört nicht zum SEPA-Raum`);

  // BIC aus Bankleitzahl (DE/PL) zur Kontrolle bzw. als Ersatz
  let bicAusBlz = null;
  const bc = bankcodeAusIban(ib.iban);
  if (bc && daten.blz?.[bc.land]) {
    const treffer = daten.blz[bc.land].get(bc.code);
    if (treffer) bicAusBlz = treffer;
    else hinweise.push(`Bankcode ${bc.code} nicht in der ${bc.land === "DE" ? "Bundesbank" : "NBP"}-Liste`);
  }

  if (bic && !pruefeBicFormat(bic)) {
    hinweise.push(`BIC „${bic}“ ist formal ungültig`);
    bic = "";
  }
  if (!bic && bicAusBlz) {
    bic = bicAusBlz.bic;
    hinweise.push(`BIC aus Bankcode ermittelt (${bicAusBlz.bic})`);
  } else if (bic && bicAusBlz && bic.slice(0, 8) !== bicAusBlz.bic.slice(0, 8)) {
    hinweise.push(`Laut Bankcode gehört die IBAN zu ${bicAusBlz.bic} (${bicAusBlz.name}) – BIC prüfen`);
  }
  if (!bic) return { ...res, ergebnis: ERGEBNIS.BIC_FEHLT };

  res.bic = bic;
  const bic8 = bic.slice(0, 8);
  const bicLand = bic.slice(4, 6);
  if (bicLand !== ib.land && !(GEBIETE[ib.land] || []).includes(bicLand))
    hinweise.push(`Land im BIC (${bic.slice(4, 6)}) weicht vom IBAN-Land (${ib.land}) ab`);

  const c = daten.core?.get(bic8);
  const b = daten.b2b?.get(bic8);
  if (!daten.core) hinweise.push("Register SDD Core nicht geladen");
  if (!daten.b2b) hinweise.push("Register SDD B2B nicht geladen");
  res.core = !!c;
  res.b2b = !!b;
  res.bank = (c || b)?.name || bicAusBlz?.name || "";

  const ergebnis = c && b ? ERGEBNIS.BEIDE : c ? ERGEBNIS.CORE : b ? ERGEBNIS.B2B : ERGEBNIS.KEINE;
  return { ...res, ergebnis };
}

// ---------------------------------------------------------------- CSV laden

/** Einfacher CSV-Parser (Trennzeichen ;, Anführungszeichen möglich). */
export function parseCsv(text, trenner = ";") {
  const zeilen = [];
  let zeile = [], feld = "", inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuote) {
      if (ch === '"') {
        if (text[i + 1] === '"') { feld += '"'; i++; } else inQuote = false;
      } else feld += ch;
    } else if (ch === '"') inQuote = true;
    else if (ch === trenner) { zeile.push(feld); feld = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      zeile.push(feld); feld = "";
      if (zeile.some((f) => f !== "")) zeilen.push(zeile);
      zeile = [];
    } else feld += ch;
  }
  zeile.push(feld);
  if (zeile.some((f) => f !== "")) zeilen.push(zeile);
  return zeilen;
}

/** Register-CSV (bic;name;land) → Map<BIC8, {bic, name, land, anzahl}> und Zeilenliste. */
export function baueRegister(text) {
  const zeilen = parseCsv(text).slice(1);
  const map = new Map();
  const eintraege = [];
  for (const [bic, name, land] of zeilen) {
    if (!bic) continue;
    const e = { bic, name, land: land || bic.slice(4, 6) };
    eintraege.push(e);
    const k = bic.slice(0, 8);
    if (!map.has(k)) map.set(k, e);
  }
  return { map, eintraege };
}

/** BLZ-CSV (code;bic;name) → Map<code, {bic, name}>. */
export function baueBlz(text) {
  const map = new Map();
  for (const [code, bic, name] of parseCsv(text).slice(1)) if (code && bic) map.set(code, { bic, name });
  return map;
}

// ---------------------------------------------------------------- Mehrfachprüfung

/** Zerlegt eingefügten Text in {lieferant, iban, bic}. Trenner: ; oder Tab. */
export function zerlegeEingabe(text) {
  const out = [];
  for (const rohzeile of String(text).split(/\r?\n/)) {
    if (!rohzeile.trim()) continue;
    const teile = rohzeile.split(rohzeile.includes("\t") ? "\t" : ";").map((s) => s.trim());
    if (out.length === 0 && /iban/i.test(rohzeile) && !/\d{6}/.test(rohzeile)) continue; // Kopfzeile
    if (teile.length === 1) out.push({ lieferant: "", iban: teile[0], bic: "" });
    else if (teile.length === 2 && /^[A-Z]{2}\d{2}[A-Z0-9]{10,}$/.test(bereinige(teile[0])))
      out.push({ lieferant: "", iban: teile[0], bic: teile[1] });
    else out.push({ lieferant: teile[0], iban: teile[1] ?? "", bic: teile[2] ?? "" });
  }
  return out;
}

/** Tabulator-getrennter Text für Excel (Werte ohne Tabs/Zeilenumbrüche). */
export function alsTsv(kopf, zeilen) {
  const sauber = (v) => String(v ?? "").replace(/[\t\r\n]+/g, " ");
  return [kopf, ...zeilen].map((z) => z.map(sauber).join("\t")).join("\r\n");
}
