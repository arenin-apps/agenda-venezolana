// events-utils.js
// Funciones compartidas entre script-extractor.js (scraper diario) y
// extract-from-url.js (extractor manual). Un solo lugar para arreglar
// bugs de fechas o deduplicación en vez de tener que tocar dos archivos.

const fs = require("fs");
const path = require("path");

const EVENTOS_PATH = path.join(__dirname, "eventos.json");
const SOURCES_PATH = path.join(__dirname, "sources.json");

// --- Ventana de fechas válida (hoy a 6 meses) -------------------------
// Se calcula en cada ejecución, nunca hardcodeada.
function getDateWindow() {
  const today = new Date();
  const sixMonthsOut = new Date(today);
  sixMonthsOut.setMonth(sixMonthsOut.getMonth() + 6);
  const toISODate = (d) => d.toISOString().split("T")[0];
  return {
    REFERENCE_DATE: toISODate(today),
    MAX_DATE: toISODate(sixMonthsOut)
  };
}

function isWithinWindow(dateStr, referenceDate, maxDate) {
  if (!dateStr || typeof dateStr !== "string") return false;
  const eventDate = new Date(dateStr);
  if (isNaN(eventDate.getTime())) return false;
  const start = new Date(referenceDate);
  const end = new Date(maxDate);
  return eventDate >= start && eventDate <= end;
}

function isValidEvent(evt) {
  return (
    evt &&
    typeof evt.title === "string" &&
    evt.title.trim().length > 0 &&
    typeof evt.date === "string" &&
    !isNaN(new Date(evt.date).getTime())
  );
}

// FIX (agosto 2026): confiar solo en las instrucciones del prompt no
// alcanza — el modelo a veces igual incluye eventos sin relación real
// con Argentina, justificándolos con términos genéricos como
// "sudamericano" o "latinoamericano" en vez de nombrar Argentina
// específicamente (ej. una exhibición de Frida Kahlo, o un "Summer
// Show" colectivo con un artista brasileño). Este filtro es un
// respaldo determinístico en el CÓDIGO, no en el prompt: exige que la
// palabra "argentin" (argentina/argentino/argentinos/Argentine)
// aparezca literalmente en el título o la descripción del evento. Si
// no aparece, se descarta sin importar qué haya decidido el modelo.
//
// Fuentes comunitarias (Anglo Argentine Society, APARU) están
// exceptuadas porque sus eventos son válidos por definición aunque el
// texto puntual de cada actividad no repita la palabra "Argentina".
const FUENTES_EXCEPTUADAS = ["anglo argentine society", "aparu"];

function mentionsArgentina(evt) {
  const source = normalizeText(evt.source);
  if (FUENTES_EXCEPTUADAS.some((f) => source.includes(f))) return true;

  const text = normalizeText(`${evt.title || ""} ${evt.description || ""}`);
  return /argentin/.test(text);
}

// --- Limpieza de HTML crudo a texto plano ------------------------------
// FIX: antes esta función borraba TODAS las etiquetas, incluyendo los
// <a href="..."> — así Gemini nunca veía los links de cada evento y
// terminaba usando siempre el link genérico de la fuente como respaldo.
// Ahora los links se conservan como "texto [URL]" antes de limpiar el
// resto, y las URLs relativas (ej. "/events/la-konga-in-london") se
// resuelven a absolutas usando la URL de la página como base.
function cleanHTML(html, baseUrl) {
  const withLinksPreserved = html.replace(
    /<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (match, href, innerText) => {
      const text = innerText.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
      if (!text || href.startsWith("javascript:") || href.startsWith("#")) return text;
      let absoluteUrl = href;
      if (baseUrl) {
        try {
          absoluteUrl = new URL(href, baseUrl).href;
        } catch (e) {
          // Si la URL no se puede resolver, dejamos el href tal cual.
        }
      }
      return `${text} [${absoluteUrl}]`;
    }
  );

  return withLinksPreserved
    .replace(/<script[^>]*>([\s\S]*?)<\/script>/gi, "")
    .replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, "")
    .replace(/<svg[^>]*>([\s\S]*?)<\/svg>/gi, "")
    .replace(/<head[^>]*>([\s\S]*?)<\/head>/gi, "")
    .replace(/<\/?[^>]+(>|$)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// --- Limpieza segura de bloques de código markdown en respuestas de IA
function stripMarkdownJson(text) {
  let cleaned = text.trim();
  if (cleaned.startsWith("```json")) cleaned = cleaned.substring(7);
  else if (cleaned.startsWith("```")) cleaned = cleaned.substring(3);
  if (cleaned.endsWith("```")) cleaned = cleaned.substring(0, cleaned.length - 3);
  return cleaned.trim();
}

// --- Lectura / escritura de eventos.json --------------------------------
function readEventos() {
  try {
    const raw = fs.readFileSync(EVENTOS_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.log("ℹ️ No se pudo leer eventos.json existente, se empieza de cero.");
    return [];
  }
}

// FIX: antes se comparaba por título+fecha EXACTOS. Un evento de varios
// días (como una exhibición) podía quedar guardado 2-3 veces si Gemini
// devolvía el título con redacción levemente distinta, o una fecha
// distinta dentro del rango de la muestra, en cada corrida. Ahora se
// normaliza el título (sin tildes, mayúsculas ni puntuación) y se
// combina con el venue — así variantes del mismo evento se reconocen
// como duplicados sin importar la fecha exacta extraída.
function normalizeText(str) {
  return (str || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // saca tildes
    .replace(/[^\w\s]/g, "") // saca puntuación
    .replace(/\s+/g, " ")
    .trim();
}

// Compara dos textos ignorando el orden de las palabras — para casos
// como "Institute of Contemporary Arts (ICA)" vs "ICA (Institute of
// Contemporary Arts)": mismas palabras, orden distinto, texto igual en
// la práctica.
function sameWordsIgnoringOrder(a, b) {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  return na.split(" ").sort().join(" ") === nb.split(" ").sort().join(" ");
}

// FIX (septiembre 2026): el esquema anterior armaba UNA sola clave por
// evento (venue+fecha, o temporada:venue+título) y comparaba por
// igualdad exacta de esa clave. Eso se rompía en dos casos reales:
//   1. El venue viene con las mismas palabras pero en otro orden entre
//      una corrida y otra (ej. "Institute of Contemporary Arts (ICA)"
//      vs "ICA (Institute of Contemporary Arts)") — normalizeText no
//      reordena palabras, así que "Institute of Contemporary Arts ICA"
//      y "ICA Institute of Contemporary Arts" quedaban como venues
//      distintos y el evento se duplicaba.
//   2. Gemini extrae el venue equivocado en una de las dos corridas
//      (ej. "No Te Va Gustar" en "O2 Shepherd's Bush Empire" un día y
//      en "Dingwalls" al día siguiente) — venue+fecha nunca iba a
//      matchear ahí, porque el venue en sí está mal en una de las dos.
//
// Ahora, en vez de una clave única, se escanea comparando por MÚLTIPLES
// señales: alcanza con que coincida el venue (sin importar el orden de
// palabras) O el título, siempre que la fecha sea la misma. Cualquiera
// de las dos señales sola ya es suficiente evidencia de que es el mismo
// evento — así se cubren ambos casos de arriba sin perder precisión en
// los casos que ya funcionaban bien.
function findDuplicate(existing, candidate) {
  const candTitle = candidate.title;
  const candVenue = candidate.venue;

  if (candidate.type === "temporada") {
    return existing.find((e) => {
      if (e.type !== "temporada") return false;
      if (!sameWordsIgnoringOrder(e.title, candTitle)) return false;
      // Si ambos tienen venue cargado, tiene que matchear también; si a
      // alguno le falta, con el título coincidiendo alcanza.
      if (e.venue && candVenue) return sameWordsIgnoringOrder(e.venue, candVenue);
      return true;
    });
  }

  return existing.find((e) => {
    if (e.type === "temporada") return false;
    if (e.date !== candidate.date) return false;
    const venueMatch = e.venue && candVenue && sameWordsIgnoringOrder(e.venue, candVenue);
    const titleMatch = sameWordsIgnoringOrder(e.title, candTitle);
    return venueMatch || titleMatch;
  });
}

// Combina eventos existentes con nuevos, descarta duplicados y ordena
// cronológicamente antes de guardar.
//
// Para eventos de temporada que ya existen: no se agrega una copia
// nueva, pero si el registro existente no tenía "endDate" todavía y la
// nueva extracción sí la trae, se completa — sin pisar la fecha de
// apertura original ("date") que ya estaba guardada.
function mergeAndSave(existingEvents, newEvents) {
  const result = existingEvents.filter(isValidEvent);
  let addedCount = 0;
  let seasonUpdatedCount = 0;

  newEvents.forEach((evt) => {
    if (!isValidEvent(evt)) return;

    const dup = findDuplicate(result, evt);

    if (!dup) {
      result.push(evt);
      addedCount++;
      return;
    }

    if (evt.type === "temporada") {
      if (!dup.endDate && evt.endDate) {
        // Completamos endDate, pero conservamos todo lo demás del
        // registro existente (sobre todo "date", la apertura original).
        dup.endDate = evt.endDate;
        seasonUpdatedCount++;
      }
    }
    // Si no es temporada, es un duplicado: se ignora.
  });

  result.sort((a, b) => new Date(a.date) - new Date(b.date));
  fs.writeFileSync(EVENTOS_PATH, JSON.stringify(result, null, 2), "utf-8");
  return { total: result.length, added: addedCount, seasonUpdated: seasonUpdatedCount };
}

// Pausa entre solicitudes para respetar el límite de 5/minuto del nivel
// gratuito de Gemini.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- Lectura de sources.json (la lista de fuentes a scrapear) ----------
function readSources() {
  try {
    const raw = fs.readFileSync(SOURCES_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error("❌ ERROR: No se pudo leer sources.json:", err.message);
    return [];
  }
}

module.exports = {
  getDateWindow,
  isWithinWindow,
  isValidEvent,
  mentionsArgentina,
  cleanHTML,
  stripMarkdownJson,
  readEventos,
  mergeAndSave,
  readSources,
  sleep,
  EVENTOS_PATH,
  SOURCES_PATH
};
