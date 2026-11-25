import {
  pruefe, formatiereIban, baueRegister, baueBlz, zerlegeEingabe, alsTsv, ERGEBNIS,
} from "./pruefung.js";

const $ = (s) => document.querySelector(s);
const daten = { core: null, b2b: null, blz: {}, coreListe: [], b2bListe: [], meta: null };
let letzteErgebnisse = [];

const KLASSE = {
  [ERGEBNIS.BEIDE]: "gut",
  [ERGEBNIS.CORE]: "teil",
  [ERGEBNIS.B2B]: "teil",
  [ERGEBNIS.KEINE]: "schlecht",
  [ERGEBNIS.BIC_FEHLT]: "neutral",
  [ERGEBNIS.IBAN_UNGUELTIG]: "schlecht",
};

const landName = (() => {
  let dn = null;
  try { dn = new Intl.DisplayNames(["de"], { type: "region" }); } catch { /* alt */ }
  return (cc) => { try { return dn?.of(cc) || cc; } catch { return cc; } };
})();

const datum = (iso) => iso
  ? new Date(iso).toLocaleString("de-DE", { dateStyle: "medium", timeStyle: "short" })
  : "–";

function el(tag, attrs = {}, ...kinder) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v; else if (v !== undefined && v !== null) e.setAttribute(k, v);
  }
  for (const k of kinder.flat(Infinity)) if (k !== null && k !== undefined) e.append(k);
  return e;
}

// ---------------------------------------------------------------- Laden

async function ladeText(pfad) {
  const r = await fetch(pfad, { cache: "no-cache" });
  if (!r.ok) throw new Error(`${pfad}: HTTP ${r.status}`);
  return r.text();
}

async function ladeDaten() {
  const fehler = [];
  const [meta, core, b2b, de, pl] = await Promise.allSettled([
    ladeText("data/meta.json").then(JSON.parse),
    ladeText("data/sdd_core.csv"),
    ladeText("data/sdd_b2b.csv"),
    ladeText("data/blz_de.csv"),
    ladeText("data/blz_pl.csv"),
  ]);
  if (meta.status === "fulfilled") daten.meta = meta.value;
  if (core.status === "fulfilled") ({ map: daten.core, eintraege: daten.coreListe } = baueRegister(core.value));
  else fehler.push("Register SDD Core");
  if (b2b.status === "fulfilled") ({ map: daten.b2b, eintraege: daten.b2bListe } = baueRegister(b2b.value));
  else fehler.push("Register SDD B2B");
  if (de.status === "fulfilled") daten.blz.DE = baueBlz(de.value);
  if (pl.status === "fulfilled") daten.blz.PL = baueBlz(pl.value);

  if (fehler.length) {
    const m = $("#ladefehler");
    m.hidden = false;
    m.textContent = `Nicht verfügbar: ${fehler.join(", ")}. Ergebnisse zur Lastschriftfähigkeit sind deshalb unvollständig. Siehe „Datenstand & Hinweise“.`;
  }
  zeigeStand();
  zeigeLaender();
}

// ---------------------------------------------------------------- Datenstand

function zeigeStand() {
  const q = daten.meta?.quellen || {};
  const epc = [q.sdd_core?.geaendert_am, q.sdd_b2b?.geaendert_am].filter(Boolean).sort();
  $("#stand-kurz").textContent = epc.length
    ? `EPC-Register Stand: ${datum(epc[epc.length - 1])} · SDD Core ${daten.coreListe.length.toLocaleString("de-DE")} · SDD B2B ${daten.b2bListe.length.toLocaleString("de-DE")} Einträge`
    : "EPC-Register noch nicht geladen";

  const zeilen = ["sdd_core", "sdd_b2b", "blz_de", "blz_pl"].map((k) => {
    const e = q[k];
    const namen = { sdd_core: "EPC-Register SDD Core", sdd_b2b: "EPC-Register SDD B2B", blz_de: "Bankleitzahlen Deutschland (Bundesbank)", blz_pl: "Bankleitzahlen Polen (NBP)" };
    if (!e) return el("tr", {}, el("td", {}, namen[k]), el("td", { colspan: 3 }, "keine Daten"));
    const quelle = /^https?:/.test(e.quelle) ? el("a", { href: e.quelle, rel: "noreferrer noopener" }, "Quelle") : e.quelle;
    return el("tr", {},
      el("td", {}, namen[k]),
      el("td", { class: "zahl" }, e.eintraege.toLocaleString("de-DE")),
      el("td", {}, datum(e.geaendert_am)),
      el("td", {}, quelle, " · ", el("a", { href: `data/${e.datei}`, download: "" }, "CSV")));
  });
  $("#out-daten").replaceChildren(
    el("p", { class: "leise" }, "„Geändert am“ ist der Zeitpunkt, an dem der tägliche Abruf zuletzt einen geänderten Inhalt gefunden hat. Unveränderte Daten werden nicht neu gespeichert."),
    el("div", { class: "scroll" }, el("table", {},
      el("thead", {}, el("tr", {}, el("th", {}, "Datei"), el("th", { class: "zahl" }, "Einträge"), el("th", {}, "Geändert am"), el("th", {}, "Download"))),
      el("tbody", {}, zeilen))));
}

// ---------------------------------------------------------------- Einzelprüfung

function badge(ergebnis) {
  return el("span", { class: `badge ${KLASSE[ergebnis]}` }, ergebnis);
}

function zeigeEinzel(r) {
  const ja = (b) => el("span", { class: b ? "ja" : "nein" }, b ? "ja" : "nein");
  const zeilen = [
    ["IBAN", r.ibanGueltig ? formatiereIban(r.iban) : r.iban || "–"],
    ["BIC geprüft", r.bic || "–"],
    ["Bank", r.bank || "–"],
  ];
  if (r.ibanGueltig && r.bic) zeilen.push(["SDD Core", ja(r.core)], ["SDD B2B", ja(r.b2b)]);
  $("#out-einzel").replaceChildren(el("div", { class: "karte ergebnis" },
    badge(r.ergebnis),
    el("dl", {}, zeilen.map(([k, v]) => [el("dt", {}, k), el("dd", {}, v)])),
    r.hinweise.length ? el("ul", { class: "hinweise" }, r.hinweise.map((h) => el("li", {}, h))) : null));
}

$("#form-einzel").addEventListener("submit", (ev) => {
  ev.preventDefault();
  zeigeEinzel(pruefe($("#in-iban").value, $("#in-bic").value, daten));
});

// ---------------------------------------------------------------- Mehrfachprüfung

const KOPF = ["Lieferant", "IBAN", "BIC (Eingabe)", "BIC (geprüft)", "Ergebnis", "SDD Core", "SDD B2B", "Bank", "Hinweise"];

function ergebnisZeilen() {
  return letzteErgebnisse.map(({ lieferant, r }) => [
    lieferant,
    r.ibanGueltig ? formatiereIban(r.iban) : r.iban,
    r.bicEingabe,
    r.bic,
    r.ergebnis,
    r.bic && r.ibanGueltig ? (r.core ? "ja" : "nein") : "",
    r.bic && r.ibanGueltig ? (r.b2b ? "ja" : "nein") : "",
    r.bank,
    r.hinweise.join(" | "),
  ]);
}

$("#btn-mehrfach").addEventListener("click", () => {
  const eingaben = zerlegeEingabe($("#in-mehrfach").value);
  letzteErgebnisse = eingaben.map((e) => ({ lieferant: e.lieferant, r: pruefe(e.iban, e.bic, daten) }));
  $("#btn-kopieren").disabled = $("#btn-csv").disabled = letzteErgebnisse.length === 0;
  $("#kopier-info").textContent = "";

  if (!letzteErgebnisse.length) {
    $("#out-mehrfach").replaceChildren(el("p", { class: "leise" }, "Keine Zeilen erkannt."));
    return;
  }
  const zaehler = new Map();
  for (const { r } of letzteErgebnisse) zaehler.set(r.ergebnis, (zaehler.get(r.ergebnis) || 0) + 1);
  const summe = el("p", { class: "summe" },
    [...zaehler].map(([k, n]) => el("span", {}, badge(k), ` ${n}`)));

  const zeilen = ergebnisZeilen().map((z, i) => el("tr", {},
    el("td", {}, z[0]), el("td", { class: "mono" }, z[1]), el("td", { class: "mono" }, z[3] || z[2]),
    el("td", {}, badge(letzteErgebnisse[i].r.ergebnis)), el("td", {}, z[7]), el("td", { class: "klein" }, z[8])));
  $("#out-mehrfach").replaceChildren(summe, el("div", { class: "scroll" }, el("table", {},
    el("thead", {}, el("tr", {}, ["Lieferant", "IBAN", "BIC", "Ergebnis", "Bank", "Hinweise"].map((h) => el("th", {}, h)))),
    el("tbody", {}, zeilen))));
});

$("#btn-kopieren").addEventListener("click", async () => {
  const tsv = alsTsv(KOPF, ergebnisZeilen());
  try {
    await navigator.clipboard.writeText(tsv);
    $("#kopier-info").textContent = `${letzteErgebnisse.length} Zeilen kopiert – in Excel mit Strg+V einfügen.`;
  } catch {
    // Fallback ohne Clipboard-API
    const ta = el("textarea", { class: "versteckt" });
    ta.value = tsv;
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    $("#kopier-info").textContent = ok ? "Kopiert – in Excel mit Strg+V einfügen." : "Kopieren nicht möglich – bitte CSV herunterladen.";
  }
});

$("#btn-csv").addEventListener("click", () => {
  const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const csv = "﻿" + [KOPF, ...ergebnisZeilen()].map((z) => z.map(q).join(";")).join("\r\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const a = el("a", { href: url, download: `sepa-pruefung-${new Date().toISOString().slice(0, 10)}.csv` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

// ---------------------------------------------------------------- Länderübersicht

function zeigeLaender() {
  const zaehle = (liste) => liste.reduce((m, e) => m.set(e.land, (m.get(e.land) || 0) + 1), new Map());
  const core = zaehle(daten.coreListe), b2b = zaehle(daten.b2bListe);
  const laender = [...new Set([...core.keys(), ...b2b.keys()])]
    .map((cc) => ({ cc, name: landName(cc), core: core.get(cc) || 0, b2b: b2b.get(cc) || 0 }))
    .sort((a, b) => b.core - a.core || b.b2b - a.b2b || a.name.localeCompare(b.name, "de"));

  const render = () => {
    const f = $("#in-land").value.trim().toLowerCase();
    const sicht = laender.filter((l) => !f || l.cc.toLowerCase() === f || l.name.toLowerCase().includes(f));
    if (!laender.length) {
      $("#out-laender").replaceChildren(el("p", { class: "leise" }, "Keine Registerdaten vorhanden."));
      return;
    }
    const n = (x) => x.toLocaleString("de-DE");
    $("#out-laender").replaceChildren(el("div", { class: "scroll" }, el("table", {},
      el("thead", {}, el("tr", {}, el("th", {}, "Land"), el("th", {}, "Code"), el("th", { class: "zahl" }, "SDD Core"), el("th", { class: "zahl" }, "SDD B2B"))),
      el("tbody", {}, sicht.map((l) => el("tr", {},
        el("td", {}, l.name), el("td", { class: "mono" }, l.cc), el("td", { class: "zahl" }, n(l.core)), el("td", { class: "zahl" }, n(l.b2b))))),
      el("tfoot", {}, el("tr", {}, el("td", {}, "Summe"), el("td", {}, `${sicht.length} Länder`),
        el("td", { class: "zahl" }, n(sicht.reduce((s, l) => s + l.core, 0))),
        el("td", { class: "zahl" }, n(sicht.reduce((s, l) => s + l.b2b, 0))))))));
  };
  $("#in-land").oninput = render;
  render();
}

// ---------------------------------------------------------------- Tabs

const tabs = [...document.querySelectorAll('[role="tab"]')];
function aktiviere(tab, fokus = false) {
  for (const t of tabs) {
    const an = t === tab;
    t.setAttribute("aria-selected", String(an));
    t.tabIndex = an ? 0 : -1;
    document.getElementById(t.getAttribute("aria-controls")).hidden = !an;
  }
  if (fokus) tab.focus();
  history.replaceState(null, "", `#${tab.id.slice(4)}`);
}
tabs.forEach((t, i) => {
  t.addEventListener("click", () => aktiviere(t));
  t.addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight") aktiviere(tabs[(i + 1) % tabs.length], true);
    if (e.key === "ArrowLeft") aktiviere(tabs[(i - 1 + tabs.length) % tabs.length], true);
  });
});
const start = tabs.find((t) => `#${t.id.slice(4)}` === location.hash);
aktiviere(start || tabs[0]);

ladeDaten();
