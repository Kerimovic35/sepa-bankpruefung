import { test } from "node:test";
import assert from "node:assert/strict";
import { pruefeIban, pruefe, ERGEBNIS, baueRegister, baueBlz, zerlegeEingabe, alsTsv } from "../assets/pruefung.js";

const core = baueRegister("bic;name;land\nCOBADEFFXXX;Commerzbank;DE\nPSSTFRPPXXX;La Banque Postale;FR\nBPKOPLPW;PKO BP;PL\n");
const b2b = baueRegister("bic;name;land\nCOBADEFF;Commerzbank;DE\nDEUTDEFF500;Deutsche Bank;DE\n");
const daten = {
  core: core.map, b2b: b2b.map,
  blz: { DE: baueBlz("bankleitzahl;bic;name\n37040044;COBADEFFXXX;Commerzbank\n"), PL: baueBlz("n;bic;name\n10901014;WBKPPLPPXXX;Santander\n") },
};

test("IBAN-Prüfung", () => {
  assert.equal(pruefeIban("DE89 3704 0044 0532 0130 00").gueltig, true);
  assert.equal(pruefeIban("de89370400440532013000").gueltig, true);
  assert.equal(pruefeIban("DE88 3704 0044 0532 0130 00").gueltig, false);
  assert.equal(pruefeIban("DE89 3704 0044 0532 0130 0").gueltig, false);
  assert.equal(pruefeIban("FR14 2004 1010 0505 0001 3M02 606").gueltig, true);
  assert.equal(pruefeIban("PL61 1090 1014 0000 0712 1981 2874").gueltig, true);
  assert.equal(pruefeIban("NO93 8601 1117 947").gueltig, true);
  assert.equal(pruefeIban("XX00 1234").gueltig, false);
});

test("Ergebnisse", () => {
  assert.equal(pruefe("DE89370400440532013000", "COBADEFF123", daten).ergebnis, ERGEBNIS.BEIDE);
  assert.equal(pruefe("FR1420041010050500013M02606", "PSSTFRPP", daten).ergebnis, ERGEBNIS.CORE);
  assert.equal(pruefe("DE89370400440532013000", "DEUTDEFFXXX", daten).ergebnis, ERGEBNIS.B2B);
  assert.equal(pruefe("DE89370400440532013000", "ABCDDEFFXXX", daten).ergebnis, ERGEBNIS.KEINE);
  assert.equal(pruefe("FR1420041010050500013M02606", "", daten).ergebnis, ERGEBNIS.BIC_FEHLT);
  assert.equal(pruefe("DE88370400440532013000", "COBADEFF", daten).ergebnis, ERGEBNIS.IBAN_UNGUELTIG);
});

test("BIC aus Bankleitzahl", () => {
  const r = pruefe("DE89370400440532013000", "", daten);
  assert.equal(r.bic, "COBADEFFXXX");
  assert.equal(r.ergebnis, ERGEBNIS.BEIDE);
  const p = pruefe("PL61109010140000071219812874", "", daten);
  assert.equal(p.bic, "WBKPPLPPXXX");
  assert.equal(p.ergebnis, ERGEBNIS.KEINE);
  // abweichender BIC → Hinweis
  assert.ok(pruefe("DE89370400440532013000", "DEUTDEFF", daten).hinweise.some((h) => h.includes("BIC prüfen")));
});

test("Mehrfacheingabe", () => {
  const z = zerlegeEingabe("Lieferant;IBAN;BIC\nA GmbH; DE89 3704 0044 0532 0130 00; COBADEFF\nB\tFR1420041010050500013M02606\t\nDE89370400440532013000;COBADEFF\n\n");
  assert.deepEqual(z, [
    { lieferant: "A GmbH", iban: "DE89 3704 0044 0532 0130 00", bic: "COBADEFF" },
    { lieferant: "B", iban: "FR1420041010050500013M02606", bic: "" },
    { lieferant: "", iban: "DE89370400440532013000", bic: "COBADEFF" },
  ]);
  assert.equal(alsTsv(["a", "b"], [["x\ty", "z"]]), "a\tb\r\nx y\tz");
});
