// tv-streaming.js
//
// Busca en TMDB (The Movie Database) series, documentales y peliculas
// venezolanas, o con un vinculo claro con Venezuela, que se pueden ver HOY en
// el Reino Unido (streaming o TV gratuita), y las agrega a eventos.json con
// la categoria "TV y Streaming".
//
// La disponibilidad cambia todo el tiempo, asi que cada corrida BORRA las
// entradas anteriores de esta fuente y las genera de nuevo. Cada una dura
// DIAS_VIGENCIA dias ("endDate"): si el script deja de correr, caducan solas.
//
// Requiere el secreto TMDB_API_KEY (clave v3 o token v4 de lectura).
// Atribucion exigida por TMDB: "This product uses the TMDB API but is not
// endorsed or certified by TMDB."

const { readEventos, mergeAndSave, sleep } = require('./events-utils')

const API = 'https://api.themoviedb.org/3'
const SOURCE = 'TMDB (streaming Reino Unido)'
const REGION = 'GB'
const DIAS_VIGENCIA = 14
const MAX_POR_TIPO = 15
const MAX_TOTAL = 30
const TERMINOS_KEYWORD = ['venezuela', 'caracas', 'venezuelan', 'maracaibo', 'simón bolívar']

const KEY = (process.env.TMDB_API_KEY || '').trim()
if (!KEY) {
  console.log('Falta TMDB_API_KEY: se omite la busqueda de TV y streaming.')
  process.exit(0)
}

// Nunca se imprime la URL completa (puede llevar la clave).
async function tmdb(path, params) {
  const url = new URL(API + path)
  Object.entries(params || {}).forEach(([k, v]) => url.searchParams.set(k, v))
  const headers = { Accept: 'application/json' }
  if (KEY.startsWith('eyJ')) headers.Authorization = 'Bearer ' + KEY
  else url.searchParams.set('api_key', KEY)
  const res = await fetch(url, { headers })
  if (!res.ok) throw new Error('TMDB respondio ' + res.status + ' en ' + path)
  return res.json()
}

async function idsKeywords() {
  const ids = new Set()
  for (const term of TERMINOS_KEYWORD) {
    const data = await tmdb('/search/keyword', { query: term })
    const exacto = (data.results || []).find((k) => k.name.toLowerCase() === term)
    if (exacto) ids.add(exacto.id)
    await sleep(250)
  }
  return [...ids]
}

async function descubrir(tipo, extra) {
  const params = Object.assign({
    language: 'es-ES',
    watch_region: REGION,
    with_watch_monetization_types: 'flatrate|free|ads',
    sort_by: 'popularity.desc',
    page: 1,
  }, extra)
  const data = await tmdb('/discover/' + tipo, params)
  return (data.results || []).map((r) => Object.assign({}, r, { tipo }))
}

// TMDB lista variantes de la misma plataforma (planes con anuncios, canales
// dentro de Amazon, etc.). Se limpian para mostrar un nombre claro.
function limpiarPlataforma(nombre) {
  return String(nombre || '')
    .replace(/\s+Standard with Adverts?$/i, '')
    .replace(/\s+with Ads$/i, '')
    .replace(/\s+Standard$/i, '')
    .replace(/\s+(Amazon|Apple TV|Roku) Channel$/i, '')
    .trim()
}

const iso = (d) => d.toISOString().slice(0, 10)

async function main() {
  const keywords = await idsKeywords()
  const candidatos = new Map()

  for (const tipo of ['movie', 'tv']) {
    const porPais = await descubrir(tipo, { with_origin_country: 'VE', 'vote_count.gte': 10 })
    porPais.slice(0, MAX_POR_TIPO).forEach((r) => candidatos.set(tipo + r.id, r))
    if (keywords.length) {
      const porTema = await descubrir(tipo, { with_keywords: keywords.join('|'), 'vote_count.gte': 30 })
      porTema.slice(0, MAX_POR_TIPO).forEach((r) => {
        if (!candidatos.has(tipo + r.id)) candidatos.set(tipo + r.id, r)
      })
    }
    await sleep(250)
  }

  const ordenados = [...candidatos.values()]
    .sort((a, b) => (b.popularity || 0) - (a.popularity || 0))
    .slice(0, MAX_TOTAL)

  const hoy = new Date()
  const fin = new Date(hoy.getTime() + DIAS_VIGENCIA * 24 * 60 * 60 * 1000)
  const nuevos = []

  for (const r of ordenados) {
    const prov = await tmdb('/' + r.tipo + '/' + r.id + '/watch/providers')
    const gb = (prov.results || {})[REGION]
    if (!gb) continue
    const suscripcion = gb.flatrate || []
    const todas = suscripcion.concat(gb.free || [], gb.ads || [])
    const plataformas = [...new Set(todas.map((p) => limpiarPlataforma(p.provider_name)))].filter(Boolean)
    if (!plataformas.length) continue

    const titulo = r.title || r.name || r.original_title || r.original_name
    const anio = (r.release_date || r.first_air_date || '').slice(0, 4)
    const tipoTxt = r.tipo === 'tv' ? 'Serie' : 'Pelicula'
    const resumen = (r.overview || '').trim()
    const detalle = resumen
      ? resumen.slice(0, 280) + (resumen.length > 280 ? '...' : '')
      : 'Disponible en el Reino Unido.'

    nuevos.push({
      title: titulo,
      type: 'temporada',
      date: iso(hoy),
      endDate: iso(fin),
      dateLabel: 'Disponible ahora en ' + plataformas.join(', '),
      venue: plataformas.join(' / '),
      city: 'Reino Unido',
      region: 'Reino Unido',
      price: suscripcion.length ? 'Incluido en la suscripcion' : 'Gratis (con anuncios)',
      link: gb.link || 'https://www.themoviedb.org/' + r.tipo + '/' + r.id + '/watch?locale=GB',
      description: tipoTxt + (anio ? ' (' + anio + ')' : '') + '. ' + detalle,
      category: 'TV y Streaming',
      source: SOURCE,
    })
    await sleep(250)
  }

  const existentes = readEventos().filter((e) => e.source !== SOURCE)
  const resultado = mergeAndSave(existentes, nuevos)
  console.log('TV y streaming: ' + nuevos.length + ' titulos encontrados, ' + resultado.added + ' agregados (total ' + resultado.total + ').')
}

main().catch((err) => {
  console.error('Error:', err.message)
  process.exit(1)
})
