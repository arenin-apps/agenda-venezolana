// delete-event.js
//
// Elimina un evento de eventos.json. Se dispara desde GitHub Actions
// (workflow_dispatch) pidiendo el título del evento Y una confirmación
// explícita, para evitar borrados accidentales.

const fs = require('fs');
const path = require('path');

const EVENTOS_PATH = path.join(__dirname, 'eventos.json');
const CONFIRMACION_REQUERIDA = 'ELIMINAR';

function normalize(str) {
  return (str || '')
    .toString()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function readEventos() {
  const raw = fs.readFileSync(EVENTOS_PATH, 'utf-8');
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [];
}

function findEvent(list, titulo, venue) {
  const tituloNorm = normalize(titulo);
  const venueNorm = normalize(venue);

  let candidatos = list.filter(e => normalize(e.title) === tituloNorm);

  // Si hay más de un evento con ese título exacto (ej. Julio Le Parc
  // tiene un evento principal y un "Family Tour" aparte con nombre
  // distinto, pero por si hay coincidencias reales) y se especificó
  // venue, usalo para desambiguar.
  if (candidatos.length > 1 && venueNorm) {
    const porVenue = candidatos.filter(e => normalize(e.venue) === venueNorm);
    if (porVenue.length) candidatos = porVenue;
  }

  if (candidatos.length === 1) return candidatos[0];

  if (candidatos.length > 1) {
    throw new Error(
      `"${titulo}" coincide con ${candidatos.length} eventos. Especificá también el venue para desambiguar, o usá el título completo exacto. Coincidencias: ` +
      candidatos.map(e => `"${e.title}" en ${e.venue || 'sin venue'} (${e.date}${e.endDate ? ' - ' + e.endDate : ''})`).join(' | ')
    );
  }

  // Sin coincidencia exacta: probar coincidencia parcial.
  const parciales = list.filter(e => normalize(e.title).includes(tituloNorm));
  if (parciales.length === 1) return parciales[0];
  if (parciales.length > 1) {
    throw new Error(
      `"${titulo}" no coincide exacto con ningún evento, pero coincide parcialmente con ${parciales.length}. Usá el título completo exacto. Coincidencias: ` +
      parciales.map(e => `"${e.title}" en ${e.venue || 'sin venue'} (${e.date})`).join(' | ')
    );
  }

  return null;
}

function main() {
  const titulo = process.env.TITULO;
  const venue = process.env.VENUE;
  const confirmacion = process.env.CONFIRMACION;

  if (!titulo || !titulo.trim()) {
    throw new Error('Falta el título del evento a eliminar.');
  }
  if (confirmacion !== CONFIRMACION_REQUERIDA) {
    throw new Error(`Para eliminar, escribí exactamente "${CONFIRMACION_REQUERIDA}" en el campo de confirmación. No se eliminó nada.`);
  }

  const eventos = readEventos();
  const evento = findEvent(eventos, titulo, venue);

  if (!evento) {
    throw new Error(`No se encontró ningún evento que coincida con "${titulo}". Revisá el título exacto en eventos.json.`);
  }

  const restantes = eventos.filter(e => e !== evento);
  fs.writeFileSync(EVENTOS_PATH, JSON.stringify(restantes, null, 2) + '\n', 'utf-8');

  console.log(`Evento eliminado: "${evento.title}" — ${evento.venue || 'sin venue'} (${evento.date}${evento.endDate ? ' - ' + evento.endDate : ''})`);
  console.log(`Quedan ${restantes.length} eventos en el archivo.`);
}

main();
