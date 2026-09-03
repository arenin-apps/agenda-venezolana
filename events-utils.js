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

// Mismo criterio determinístico que la agenda argentina (ver su
// historial): confiar solo en las instrucciones del prompt no alcanza,
// el modelo a veces incluye eventos sin relación real con Venezuela
// justificándolos con términos genéricos ("sudamericano",
// "latinoamericano"). Este filtro exige que la palabra "venezuela" o
// "venezolan" (venezolano/venezolana/venezolanos) aparezca
// literalmente en el título o la descripción del evento.
//
// Todavía no hay fuentes comunitarias venezolanas cargadas como
// excepción — si en el futuro se agrega una organización 100%
// comunitaria (equivalente a Anglo Argentine Society/APARU para la
// agenda argentina), sumala acá.
const FUENTES_EXCEPTUADAS = [];

function mentionsVenezuela(evt) {
  const source = normalizeText(evt.source);
  if (FUENTES_EXCEPTUADAS.some((f) => source.includes(f))) return true;

  const text = normalizeText(`${evt.title || ""} ${evt.description || ""}`);
  return /venezuela|venezolan/.test(text);
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

// FIX 2: el título puede venir redactado de formas MUY distintas para el
// mismo evento puntual (ej. "ENG VS VEN" vs "England vs Venezuela (ENG vs
// VEN)" vs "England vs Venezuela" — mismo partido, mismo venue, misma
// fecha exacta). Para eventos de una sola fecha, venue+fecha es una señal
// mucho más confiable que el título. Si no hay venue, usamos título+fecha
// como respaldo.
//
// FIX 3 (agosto 2026): para eventos de tipo "temporada" (exposiciones
// largas), la fecha extraída puede variar día a día si la fuente muestra
// un calendario de "próximas sesiones" en vez de una sola fecha de
// apertura — eso hacía que venue+fecha generara una clave distinta cada
// vez y el evento se duplicara sin parar (ej. "Julio Le Parc" en Tate
// Modern). Para "temporada" ignoramos la fecha por completo: la clave es
// solo venue+título (o título solo, si no hay venue), así el mismo
// evento siempre matchea sin importar qué fecha haya traído el scraper
// ese día.
function eventKey(evt) {
  const venue = normalizeText(evt.venue);
  const title = normalizeText(evt.title);

  if (evt.type === "temporada") {
    return venue ? `season:${venue}_${title}` : `season-title:${title}`;
  }

  if (venue) {
    return `venue:${venue}_${evt.date}`;
  }
  return `title:${title}_${evt.date}`;
}

// Combina eventos existentes con nuevos, descarta duplicados y ordena
// cronológicamente antes de guardar.
//
// FIX (agosto 2026): para eventos de temporada que ya existen, no se
// agrega una copia nueva (gracias a eventKey ignorando la fecha), pero
// además: si el registro existente no tenía "endDate" todavía y la
// nueva extracción sí la trae, se completa — sin pisar la fecha de
// apertura original ("date") que ya estaba guardada.
function mergeAndSave(existingEvents, newEvents) {
  const map = new Map();
  existingEvents.forEach((evt) => {
    if (isValidEvent(evt)) map.set(eventKey(evt), evt);
  });

  let addedCount = 0;
  let seasonUpdatedCount = 0;

  newEvents.forEach((evt) => {
    if (!isValidEvent(evt)) return;
    const key = eventKey(evt);

    if (!map.has(key)) {
      map.set(key, evt);
      addedCount++;
      return;
    }

    // Ya existe un evento con esta clave.
    if (evt.type === "temporada") {
      const existing = map.get(key);
      if (!existing.endDate && evt.endDate) {
        // Completamos endDate, pero conservamos todo lo demás del
        // registro existente (sobre todo "date", la apertura original).
        map.set(key, { ...existing, endDate: evt.endDate });
        seasonUpdatedCount++;
      }
    }
    // Si no es temporada, es un duplicado puntual exacto: se ignora,
    // igual que antes.
  });

  const merged = Array.from(map.values());
  merged.sort((a, b) => new Date(a.date) - new Date(b.date));
  fs.writeFileSync(EVENTOS_PATH, JSON.stringify(merged, null, 2), "utf-8");
  return { total: merged.length, added: addedCount, seasonUpdated: seasonUpdatedCount };
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
  mentionsVenezuela,
  cleanHTML,
  stripMarkdownJson,
  readEventos,
  mergeAndSave,
  readSources,
  sleep,
  EVENTOS_PATH,
  SOURCES_PATH
};
