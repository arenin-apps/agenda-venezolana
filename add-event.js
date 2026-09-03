// add-event.js
//
// Agrega un evento manualmente a eventos.json. Pensado para casos donde
// script-extractor.js / extract-from-url.js no encuentran suficiente
// texto en la página para que Gemini lo identifique solo, pero vos ya
// leíste la página y confirmaste que el evento tiene relación real con
// Venezuela.
//
// Se dispara desde GitHub Actions (workflow_dispatch) con todos los
// campos como inputs — ver .github/workflows/add-event.yml

const {
  isValidEvent,
  mentionsVenezuela,
  readEventos,
  mergeAndSave
} = require('./events-utils');

function formatDateLabelUnico(dateStr) {
  try {
    return new Date(dateStr + 'T00:00:00').toLocaleDateString('es-AR', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
    }).toUpperCase();
  } catch (e) {
    return dateStr;
  }
}

function formatDateLabelTemporada(endDateStr) {
  try {
    const d = new Date(endDateStr + 'T00:00:00').toLocaleDateString('es-AR', {
      day: 'numeric', month: 'long', year: 'numeric'
    });
    return `Hasta el ${d}`;
  } catch (e) {
    return `Hasta el ${endDateStr}`;
  }
}

function main() {
  const title = process.env.TITULO;
  const category = process.env.CATEGORIA;
  const fechaDesde = process.env.FECHA_DESDE;
  const fechaHasta = process.env.FECHA_HASTA;
  const venue = process.env.VENUE;
  const city = process.env.CITY;
  const region = process.env.REGION;
  const price = process.env.PRICE;
  const link = process.env.LINK;
  const description = process.env.DESCRIPCION;
  const source = process.env.SOURCE;

  if (!title || !title.trim()) throw new Error('Falta el título del evento.');
  if (!fechaDesde || !fechaDesde.trim()) throw new Error('Falta la fecha de inicio (Desde). Formato: YYYY-MM-DD.');
  if (isNaN(new Date(fechaDesde.trim()).getTime())) throw new Error(`La fecha "${fechaDesde}" no es válida. Usá el formato YYYY-MM-DD (ej. 2026-09-20).`);
  if (!link || !link.trim()) throw new Error('Falta el link del evento.');
  if (!description || !description.trim()) throw new Error('Falta la descripción del evento.');
  if (!source || !source.trim()) throw new Error('Falta el nombre de la fuente (source) — de qué sitio sale esta info.');

  if (fechaHasta && fechaHasta.trim() && isNaN(new Date(fechaHasta.trim()).getTime())) {
    throw new Error(`La fecha de fin "${fechaHasta}" no es válida. Usá el formato YYYY-MM-DD, o dejala vacía si el evento es de un solo día.`);
  }

  // Es "temporada" (rango de fechas) solo si se completó fecha_hasta Y
  // es distinta de fecha_desde. Si son iguales o fecha_hasta está
  // vacía, es un evento de un solo día.
  const esTemporada = !!(fechaHasta && fechaHasta.trim() && fechaHasta.trim() !== fechaDesde.trim());

  if (esTemporada && new Date(fechaHasta.trim()) < new Date(fechaDesde.trim())) {
    throw new Error('La fecha de fin (Hasta) no puede ser anterior a la fecha de inicio (Desde).');
  }

  const evento = {
    title: title.trim(),
    type: esTemporada ? 'temporada' : 'unico',
    date: fechaDesde.trim(),
    endDate: esTemporada ? fechaHasta.trim() : null,
    dateLabel: esTemporada
      ? formatDateLabelTemporada(fechaHasta.trim())
      : formatDateLabelUnico(fechaDesde.trim()),
    venue: venue && venue.trim() ? venue.trim() : null,
    city: city && city.trim() ? city.trim() : null,
    region: region && region.trim() ? region.trim() : null,
    price: price && price.trim() ? price.trim() : 'Consultar web',
    link: link.trim(),
    description: description.trim(),
    category: category && category.trim() ? category.trim() : 'Comunidad',
    source: source.trim()
  };

  if (!isValidEvent(evento)) {
    throw new Error('El evento no pasó la validación básica (revisá título y fecha).');
  }

  // Mismo filtro que usan los extractores automáticos: la relación con
  // Venezuela tiene que estar escrita explícitamente en el título o la
  // descripción, no alcanza con que vos "sepas" que está relacionado.
  if (!mentionsVenezuela(evento)) {
    throw new Error(
      'La descripción y el título no mencionan la palabra "Venezuela"/"venezolano" en ningún lado. ' +
      'Agregá al texto de la descripción por qué este evento tiene relación con Venezuela ' +
      '(mismo criterio que usa el scraper automático) y volvé a correr el workflow.'
    );
  }

  const existing = readEventos();
  const result = mergeAndSave(existing, [evento]);

  if (result.added === 0) {
    console.log(`⚠️ No se agregó nada nuevo — ya existe un evento equivalente ("${evento.title}" en "${evento.venue || 'sin venue'}"${esTemporada ? '' : ` el ${evento.date}`}).`);
    if (result.seasonUpdated > 0) {
      console.log('Se completó la fecha de cierre (endDate) del evento existente en vez de crear uno nuevo.');
    }
  } else {
    console.log(`✅ Evento agregado: ${evento.title}`);
    console.log(JSON.stringify(evento, null, 2));
  }
  console.log(`Total de eventos en eventos.json: ${result.total}`);
}

main();
