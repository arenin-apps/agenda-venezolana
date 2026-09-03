// script-extractor.js
// Corre una vez al día vía GitHub Actions. Rastrea las fuentes conocidas,
// le pide a Gemini que extraiga eventos venezolanos, y los agrega a
// eventos.json (sin duplicar los que ya estaban).
//
// CAMBIO (agosto 2026): se agrega soporte real para eventos de
// "temporada" (exposiciones/muestras largas). Antes, el prompt ya le
// pedía al modelo usar "date" como fecha de apertura para este tipo de
// eventos, pero el schema del JSON no tenía campo "endDate" donde poner
// la fecha de cierre — por eso el modelo terminaba devolviendo la
// "próxima sesión disponible" cada día, y el evento se duplicaba en
// eventos.json una vez por cada corrida del scraper.

const { GoogleGenerativeAI } = require("@google/generative-ai");
const {
  getDateWindow,
  isWithinWindow,
  isValidEvent,
  mentionsVenezuela,
  cleanHTML,
  stripMarkdownJson,
  readEventos,
  mergeAndSave,
  readSources,
  sleep
} = require("./events-utils");

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error("❌ ERROR: El secreto GEMINI_API_KEY no está definido.");
  process.exit(1);
}
const genAI = new GoogleGenerativeAI(apiKey);
const { REFERENCE_DATE, MAX_DATE } = getDateWindow();

// Pausa entre fuentes: el nivel gratuito de Gemini permite 5 solicitudes
// por minuto. Con 13s de espera quedamos dentro del límite.
const DELAY_BETWEEN_REQUESTS_MS = 13000;

// FIX: la lista de fuentes ahora vive en sources.json, no acá. Así se
// puede agregar/quitar fuentes sin tocar código (ver add-source.js).
const sources = readSources();

function buildPrompt(sourceName, sourceUrl, cleanText) {
  return `
    Analiza el siguiente texto extraído de la web de ${sourceName}.
    Identifica TODOS los eventos, exhibiciones, conciertos, transmisiones,
    partidos de la selección de fútbol o béisbol de Venezuela, obras de
    teatro o proyecciones de películas relacionados con Venezuela, incluyendo:
    - Artistas o eventos venezolanos.
    - Artistas de otra nacionalidad pero con un vínculo cultural específico y documentado con Venezuela (ej. colaboraciones directas, banda o elenco mixto con integrantes venezolanos).

    CRITERIO DE RELEVANCIA — MUY IMPORTANTE:
    La conexión con Venezuela tiene que ser ESPECÍFICA y VERIFICABLE en el propio texto: un artista o evento explícitamente venezolano, o con un vínculo concreto y nombrado (nacionalidad, residencia, colaboración directa, banda/elenco venezolano, etc.).
    NO alcanza con que algo sea "latinoamericano", "hispano", "de habla hispana" o "internacional" en términos generales. Un artista mexicano, chileno, peruano, argentino, brasileño, etc. NO califica solo por pertenecer a esa categoría amplia — necesita un vínculo específico y nombrado con Venezuela, no con la región en general.
    Ejemplo de lo que NO hay que incluir: una exhibición de Frida Kahlo (mexicana, sin vínculo venezolano) no califica aunque el texto la describa como "arte latinoamericano" o esté en la misma página que eventos venezolanos.
    Si tenés dudas sobre si el vínculo es lo bastante específico, EXCLUÍ el evento — es preferible perder un evento dudoso que ensuciar la agenda con eventos sin relación real.
    También excluí exhibiciones colectivas o "shows" genéricos de una galería (ej. "Summer Show", muestras grupales anuales sin curaduría temática) salvo que el texto mencione explícitamente algún artista o pieza con conexión venezolana específica dentro de esa muestra.

    Reglas estrictas:
    1. El evento debe ocurrir estrictamente entre el ${REFERENCE_DATE} (hoy) y el ${MAX_DATE} (dentro de 6 meses), CON UNA EXCEPCIÓN: los eventos de tipo "temporada" (ver regla 2) son válidos aunque su fecha de apertura ("date") sea anterior a hoy, siempre que su fecha de cierre ("endDate") no haya pasado todavía. Descarta todo evento puntual pasado o posterior a la ventana.

    2. Distinguí dos tipos de evento:
       - "unico": un evento de un día u horario específico (concierto, charla, función de teatro, proyección, partido).
       - "temporada": una exhibición, muestra o instalación que permanece abierta durante varias semanas o meses (por ejemplo, una muestra de arte en un museo). Esto INCLUYE el caso en que la fuente solo te muestra un calendario de "próximas fechas de entrada/sesión para reservar" pero el evento real es la misma exhibición continua — en ese caso seguí siendo "temporada", nunca tomes la próxima fecha de sesión como si fuera un evento puntual nuevo.

       Para "temporada": el campo "date" debe ser SIEMPRE la fecha de INICIO/apertura original de la muestra (nunca una fecha intermedia ni la próxima sesión disponible), y el campo "endDate" la fecha de cierre, en formato YYYY-MM-DD. Si no encontrás la fecha de cierre exacta, dejá "endDate" en null pero igual marcá "type": "temporada".
       Para "unico": "endDate" siempre va en null.

       IMPORTANTE: esto NO aplica a una gira con fechas en distintas ciudades o venues (ej. un artista tocando en Brighton el día 1, Manchester el día 2 y Edimburgo el día 3) — cada ciudad/venue/fecha de una gira es un evento "unico" SEPARADO, con su propio objeto en el arreglo. Nunca combines varias fechas de una gira en un solo evento, y nunca las marques como "temporada".

    3. El evento debe tomar lugar físicamente en el Reino Unido (Inglaterra, Escocia, Gales o Irlanda del Norte), O ser una transmisión/streaming accesible desde el Reino Unido (TV, radio, plataforma online, partido retransmitido). Descartá eventos presenciales que ocurran fuera del Reino Unido, aunque sean de relevancia cultural venezolana (ej. una exposición en Caracas, un recital en Bogotá, una muestra en España) — esta agenda es específicamente para la comunidad venezolana que vive en el Reino Unido, no para noticias culturales venezolanas en general.
    4. El texto incluye links junto al nombre de cada elemento en formato "texto [URL]". Para el campo "link", usá el URL específico de la página de ESE evento (el que aparece junto a su título o su botón de "más info"/"tickets"). Solo si no encontrás ningún link específico para ese evento, usá ${sourceUrl} como respaldo.
    5. Usá la categoría "Workshops" para talleres, laboratorios, cursos o entrenamientos donde la gente participa activamente para aprender o practicar una habilidad con un facilitador (ej. talleres de improvisación vocal, clases regulares, entrenamientos para líderes de grupo). Usá "Comunidad" para encuentros sociales/culturales sin ese componente de aprendizaje activo (ferias, comidas, celebraciones).
    6. Devuelve únicamente un arreglo JSON puro (sin texto adicional) con esta forma:
    [
      {
        "title": "Nombre específico del evento",
        "type": "unico" o "temporada",
        "date": "YYYY-MM-DD",
        "endDate": "YYYY-MM-DD o null",
        "dateLabel": "DÍA, DD DE MES YYYY - HH:MM (ej. SÁBADO, 20 DE JUNIO 2026), o para temporada: 'Hasta el DD de MES de YYYY'",
        "venue": "Nombre del recinto",
        "city": "Ciudad",
        "region": "Región",
        "price": "Precio estimado o 'Entrada Libre'",
        "link": "URL del evento o en su defecto ${sourceUrl}",
        "description": "Breve descripción y su relación con Venezuela",
        "category": "Música / Teatro / Deportes / Artes Plásticas / Cine / Comunidad / Workshops",
        "source": "${sourceName}"
      }
    ]
    Si no hay eventos que cumplan los criterios, devuelve [].

    Texto a analizar:
    ${cleanText}
  `;
}

// Reemplaza el filtro de ventana simple: un evento de temporada es
// válido si su fecha de cierre (endDate) todavía no pasó, sin importar
// si su fecha de apertura (date) quedó antes de hoy o su endDate está
// mucho más allá de los 6 meses de ventana normal.
function passesWindow(event) {
  if (event.type === "temporada") {
    if (!event.endDate) {
      // Sin fecha de cierre conocida: la dejamos pasar igual, es mejor
      // mostrarla sin fecha de cierre que perderla del todo.
      return true;
    }
    return event.endDate >= REFERENCE_DATE;
  }
  return isWithinWindow(event.date, REFERENCE_DATE, MAX_DATE);
}

async function scrapeAndParse() {
  if (sources.length === 0) {
    console.error("❌ ERROR: sources.json está vacío o no se pudo leer. Nada para rastrear.");
    process.exit(1);
  }
  console.log(`🚀 Iniciando extracción automatizada.`);
  console.log(`📚 ${sources.length} fuentes cargadas desde sources.json`);
  console.log(`📅 Ventana válida: ${REFERENCE_DATE} a ${MAX_DATE}`);
  console.log(`⏱️ Pausa de ${DELAY_BETWEEN_REQUESTS_MS / 1000}s entre fuentes (límite gratuito de Gemini).`);

  // FIX: gemini-3.5-flash tiene una cuota gratuita muy chica (20/día).
  // gemini-3.5-flash-lite es igual de apto para extraer datos
  // estructurados y tiene una cuota diaria gratuita mucho mayor.
  const model = genAI.getGenerativeModel({ model: "gemini-3.5-flash-lite" });
  let allNewEvents = [];
  let isFirstSource = true;

  for (const src of sources) {
    if (!isFirstSource) await sleep(DELAY_BETWEEN_REQUESTS_MS);
    isFirstSource = false;

    console.log(`🔍 Rastreando: ${src.name}${src.useRenderProxy ? ' (vía proxy de renderizado)' : ''}...`);
    try {
      const fetchUrl = src.useRenderProxy ? `https://r.jina.ai/${src.url}` : src.url;
      const response = await fetch(fetchUrl, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" }
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const rawHtml = await response.text();
      const cleanText = cleanHTML(rawHtml, fetchUrl).substring(0, 15000);

      const aiResponse = await model.generateContent(buildPrompt(src.name, src.url, cleanText));
      const jsonCleaned = stripMarkdownJson(aiResponse.response.text());

      if (jsonCleaned && jsonCleaned !== "[]") {
        const events = JSON.parse(jsonCleaned);
        if (Array.isArray(events)) {
          const withinWindow = events.filter(isValidEvent).filter(mentionsVenezuela).filter(passesWindow);
          const descartadosPorRelevancia = events.filter(isValidEvent).filter((e) => !mentionsVenezuela(e));
          if (descartadosPorRelevancia.length > 0) {
            console.log(`🚫 Descartados por no mencionar Venezuela explícitamente: ${descartadosPorRelevancia.map(e => e.title).join(', ')}`);
          }
          const temporadas = withinWindow.filter((e) => e.type === "temporada").length;
          console.log(`✅ ${src.name}: ${events.length} recibidos, ${withinWindow.length} dentro de ventana (${temporadas} de temporada).`);
          allNewEvents = [...allNewEvents, ...withinWindow];
        }
      } else {
        console.log(`ℹ️ Sin eventos venezolanos vigentes en ${src.name}.`);
      }
    } catch (err) {
      console.error(`❌ Error en ${src.name}: ${err.message}`);
    }
  }

  const existingEvents = readEventos();
  const result = mergeAndSave(existingEvents, allNewEvents);
  console.log(`🎉 eventos.json actualizado. Total: ${result.total}, nuevos agregados hoy: ${result.added}.`);
}

scrapeAndParse();
