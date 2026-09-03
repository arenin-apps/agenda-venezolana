// extract-from-url.js
// Se dispara manualmente desde GitHub Actions (botón "Run workflow"),
// pasando una URL cualquiera (ej. un newsletter de Mailchimp de la
// Embajada de Venezuela). A diferencia de script-extractor.js, no depende
// de una lista fija de fuentes: sirve para cualquier página con texto.
//
// Le pasamos a Gemini los títulos+fechas ya existentes en eventos.json
// para que descarte lo que ya está cargado y solo devuelva lo nuevo.
//
// CAMBIO (agosto 2026): mismo fix que script-extractor.js — se agrega
// "type" y "endDate" al schema para eventos de temporada (exposiciones
// largas), y se ajusta el filtro de ventana para no descartar una
// temporada cuya fecha de apertura ya pasó, mientras no haya cerrado.

const { GoogleGenerativeAI } = require("@google/generative-ai");
const {
  getDateWindow,
  isWithinWindow,
  isValidEvent,
  mentionsVenezuela,
  cleanHTML,
  stripMarkdownJson,
  readEventos,
  mergeAndSave
} = require("./events-utils");

const apiKey = process.env.GEMINI_API_KEY;
const targetUrl = process.env.NEWSLETTER_URL;

if (!apiKey) {
  console.error("❌ ERROR: El secreto GEMINI_API_KEY no está definido.");
  process.exit(1);
}
if (!targetUrl || !targetUrl.trim()) {
  console.error("❌ ERROR: No se recibió ninguna URL para procesar.");
  process.exit(1);
}

const genAI = new GoogleGenerativeAI(apiKey);
const { REFERENCE_DATE, MAX_DATE } = getDateWindow();

function buildPrompt(url, cleanText, existingTitlesAndDates) {
  const hostname = new URL(url).hostname.replace(/^www\./, "");
  return `
    Analiza el siguiente texto extraído de: ${url}
    Puede ser un newsletter, boletín, o cualquier página con menciones de
    eventos. Identifica TODOS los eventos, exhibiciones, conciertos,
    charlas o actividades relacionados con Venezuela, incluyendo:
    - Artistas o eventos venezolanos, o de la comunidad venezolana en el Reino Unido.
    - Artistas de otra nacionalidad pero con un vínculo cultural específico y documentado con Venezuela (ej. colaboraciones directas, banda o elenco mixto con integrantes venezolanos).

    CRITERIO DE RELEVANCIA — MUY IMPORTANTE:
    La conexión con Venezuela tiene que ser ESPECÍFICA y VERIFICABLE en el propio texto: un artista o evento explícitamente venezolano, o con un vínculo concreto y nombrado (nacionalidad, residencia, colaboración directa, banda/elenco venezolano, etc.).
    NO alcanza con que algo sea "latinoamericano", "hispano", "de habla hispana" o "internacional" en términos generales. Un artista mexicano, chileno, peruano, argentino, brasileño, etc. NO califica solo por pertenecer a esa categoría amplia — necesita un vínculo específico y nombrado con Venezuela, no con la región en general.
    Ejemplo de lo que NO hay que incluir: una exhibición de Frida Kahlo (mexicana, sin vínculo venezolano) no califica aunque el texto la describa como "arte latinoamericano".
    Si tenés dudas sobre si el vínculo es lo bastante específico, EXCLUÍ el evento — es preferible perder un evento dudoso que ensuciar la agenda con eventos sin relación real.
    También excluí exhibiciones colectivas o "shows" genéricos de una galería salvo que el texto mencione explícitamente algún artista o pieza con conexión venezolana específica dentro de esa muestra.

    Reglas estrictas:
    1. El evento debe ocurrir estrictamente entre el ${REFERENCE_DATE} (hoy) y el ${MAX_DATE} (dentro de 6 meses), CON UNA EXCEPCIÓN: los eventos de tipo "temporada" (ver regla 2) son válidos aunque su fecha de apertura ("date") sea anterior a hoy, siempre que su fecha de cierre ("endDate") no haya pasado todavía. Descarta todo evento puntual pasado o posterior a la ventana.

    2. Distinguí dos tipos de evento:
       - "unico": un evento de un día u horario específico (concierto, charla, función de teatro, proyección, partido).
       - "temporada": una exhibición, muestra o instalación que permanece abierta durante varias semanas o meses. Esto INCLUYE el caso en que el texto solo mencione un calendario de "próximas fechas de entrada/sesión para reservar" pero el evento real sea la misma exhibición continua — en ese caso seguí siendo "temporada", nunca tomes la próxima fecha de sesión como si fuera un evento puntual nuevo.

       Para "temporada": el campo "date" debe ser SIEMPRE la fecha de INICIO/apertura original de la muestra (nunca una fecha intermedia ni la próxima sesión disponible), y el campo "endDate" la fecha de cierre, en formato YYYY-MM-DD. Si no encontrás la fecha de cierre exacta, dejá "endDate" en null pero igual marcá "type": "temporada".
       Para "unico": "endDate" siempre va en null.

       IMPORTANTE: esto NO aplica a una gira con fechas en distintas ciudades o venues (ej. un artista tocando en Brighton el día 1, Manchester el día 2 y Edimburgo el día 3) — cada ciudad/venue/fecha de una gira es un evento "unico" SEPARADO, con su propio objeto en el arreglo. Nunca combines varias fechas de una gira en un solo evento, y nunca las marques como "temporada".

    3. NO incluyas ningún evento que ya esté en esta lista de eventos existentes (compará por título y fecha aproximada, incluso si está redactado un poco distinto — para eventos de temporada, compará por título aunque la fecha no coincida exacto, ya que la apertura pudo haberse guardado con otra fecha extraída en una corrida anterior):
       ${JSON.stringify(existingTitlesAndDates)}
    4. El evento debe tomar lugar físicamente en el Reino Unido (Inglaterra, Escocia, Gales o Irlanda del Norte), O ser una transmisión/streaming accesible desde el Reino Unido. Descartá eventos presenciales fuera del Reino Unido, aunque sean de relevancia cultural venezolana (ej. una exposición en Caracas o en otro país de Europa) — esta agenda es para la comunidad venezolana que vive en el Reino Unido, no para noticias culturales venezolanas en general.
    5. Si el texto no menciona ningún evento relacionado con Venezuela que ocurra en el Reino Unido, o todos ya existen, devuelve un arreglo vacío [].
    6. El texto incluye links junto al nombre de cada elemento en formato "texto [URL]". Para el campo "link", usá el URL específico de la página de ESE evento. Solo si no encontrás ninguno, usá ${url} como respaldo.
    7. Para el campo "source", usá el nombre real del sitio, medio o entidad al que pertenece esta página (ej. si es el newsletter de una organización, usá el nombre de esa organización; si es un diario, el nombre del diario). Buscá ese nombre en el propio texto (títulos, logos, pie de página). Si no lo encontrás en el texto, usá "${hostname}" como respaldo. NUNCA uses un texto genérico como "Extracción manual" o similar — la gente que ve la agenda necesita saber de qué sitio viene la información.
    8. Usá la categoría "Workshops" para talleres, laboratorios, cursos o entrenamientos donde la gente participa activamente para aprender o practicar una habilidad con un facilitador (ej. talleres de improvisación vocal, clases regulares, entrenamientos para líderes de grupo). Usá "Comunidad" para encuentros sociales/culturales sin ese componente de aprendizaje activo.
    9. Devuelve únicamente un arreglo JSON puro (sin texto adicional) con esta forma:
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
        "link": "URL del evento específico si se menciona, o en su defecto ${url}",
        "description": "Breve descripción y su relación con Venezuela",
        "category": "Música / Teatro / Deportes / Artes Plásticas / Cine / Comunidad / Workshops",
        "source": "Nombre real del sitio (ver regla 6)"
      }
    ]

    Texto a analizar:
    ${cleanText}
  `;
}

// Mismo criterio que script-extractor.js: un evento de temporada es
// válido si su fecha de cierre todavía no pasó, sin importar si su
// fecha de apertura quedó antes de hoy.
function passesWindow(event) {
  if (event.type === "temporada") {
    if (!event.endDate) return true;
    return event.endDate >= REFERENCE_DATE;
  }
  return isWithinWindow(event.date, REFERENCE_DATE, MAX_DATE);
}

async function extractFromUrl() {
  console.log(`🚀 Procesando URL: ${targetUrl}`);
  console.log(`📅 Ventana válida: ${REFERENCE_DATE} a ${MAX_DATE}`);

  const existingEvents = readEventos();
  const existingTitlesAndDates = existingEvents.map((e) => ({ title: e.title, date: e.date }));
  console.log(`📋 Comparando contra ${existingTitlesAndDates.length} eventos ya guardados.`);

  try {
    const response = await fetch(targetUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} al descargar la URL`);

    const rawHtml = await response.text();
    console.log(`📄 HTML crudo descargado: ${rawHtml.length} caracteres.`);

    // Los newsletters de Mailchimp suelen tener mucho HTML de plantilla
    // antes del contenido real, así que usamos un límite más generoso.
    const CHAR_LIMIT = 40000;
    let cleanText = cleanHTML(rawHtml, targetUrl).substring(0, CHAR_LIMIT);
    console.log(`🧹 Texto limpio: ${cleanText.length} caracteres (límite: ${CHAR_LIMIT}).`);

    // FIX (agosto 2026): muchos sitios de venta de entradas (ej.
    // enterticket.es) son aplicaciones de una sola página (SPA) que
    // arman el contenido con JavaScript DESPUÉS de cargar — el fetch
    // normal solo trae un HTML casi vacío (metadatos, sin texto real),
    // y antes esto simplemente fallaba en silencio. Ahora, si el texto
    // limpio es sospechosamente corto, reintentamos automáticamente a
    // través de un proxy de renderizado (mismo servicio que ya usás
    // para fuentes con "useRenderProxy": true en sources.json), que sí
    // ejecuta el JavaScript antes de devolver el HTML.
    if (cleanText.length < 400) {
      console.log(`⚠️ El texto limpio es muy corto — probablemente la página requiere JavaScript. Reintentando con proxy de renderizado...`);
      try {
        const proxyResponse = await fetch(`https://r.jina.ai/${targetUrl}`, {
          headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" }
        });
        if (proxyResponse.ok) {
          const proxyHtml = await proxyResponse.text();
          const proxyCleanText = cleanHTML(proxyHtml, targetUrl).substring(0, CHAR_LIMIT);
          console.log(`🧹 Texto limpio vía proxy: ${proxyCleanText.length} caracteres.`);
          if (proxyCleanText.length > cleanText.length) {
            cleanText = proxyCleanText;
          }
        } else {
          console.log(`⚠️ El proxy de renderizado tampoco pudo acceder (HTTP ${proxyResponse.status}).`);
        }
      } catch (proxyErr) {
        console.log(`⚠️ Error usando el proxy de renderizado: ${proxyErr.message}`);
      }
    }

    if (cleanText.length < 200) {
      console.log(`⚠️ El texto limpio sigue siendo muy corto tras el reintento — es probable que la página no tenga contenido de texto accesible de ninguna forma (todo en imágenes, requiere login, o bloquea bots).`);
    }

    const model = genAI.getGenerativeModel({ model: "gemini-3.5-flash-lite" });
    const aiResponse = await model.generateContent(buildPrompt(targetUrl, cleanText, existingTitlesAndDates));
    const jsonCleaned = stripMarkdownJson(aiResponse.response.text());

    if (!jsonCleaned || jsonCleaned === "[]") {
      console.log("ℹ️ No se encontraron eventos nuevos (o ya estaban todos cargados).");
      return;
    }

    const events = JSON.parse(jsonCleaned);
    if (!Array.isArray(events)) {
      console.error("⚠️ La respuesta de Gemini no fue un arreglo JSON válido.");
      return;
    }

    const withinWindow = events.filter(isValidEvent).filter(mentionsVenezuela).filter(passesWindow);
    const descartadosPorRelevancia = events.filter(isValidEvent).filter((e) => !mentionsVenezuela(e));
    if (descartadosPorRelevancia.length > 0) {
      console.log(`🚫 Descartados por no mencionar Venezuela explícitamente: ${descartadosPorRelevancia.map(e => e.title).join(', ')}`);
    }
    console.log(`✅ ${events.length} eventos recibidos, ${withinWindow.length} dentro de la ventana válida.`);

    const result = mergeAndSave(existingEvents, withinWindow);
    console.log(`🎉 eventos.json actualizado. Total: ${result.total}, nuevos agregados: ${result.added}.`);
    if (result.seasonUpdated > 0) {
      console.log(`📅 Eventos de temporada con fecha de cierre completada: ${result.seasonUpdated}`);
    }
  } catch (err) {
    console.error(`❌ Error al procesar la URL: ${err.message}`);
    process.exit(1);
  }
}

extractFromUrl();
