// tv-gemini.js
//
// Red de seguridad semanal: le pregunta a Gemini (con busqueda de Google) que
// se emite en la TV del Reino Unido en los proximos 7 dias con vinculo con
// Venezuela (ITV, Channel 4, Channel 5, Sky, partidos de la seleccion, etc.)
// y lo agrega a eventos.json con la categoria "TV y Streaming".
//
// Reglas de seguridad (para no inventar nada):
// - Solo se aceptan emisiones con fecha, hora y canal explicitos.
// - La fecha tiene que caer en los proximos 8 dias.
// - El titulo o la descripcion tienen que nombrar algo venezolano.
// - Si la consulta falla o no devuelve JSON valido, no se toca eventos.json.
//
// Corre una vez por semana (lunes) en las ejecuciones programadas, y siempre
// que se lance a mano. Cada corrida reemplaza las entradas anteriores de esta
// fuente.

const { readEventos, mergeAndSave } = require('./events-utils')

const SOURCE = 'Busqueda semanal de TV (Gemini + Google)'
// La busqueda de Google (grounding) tiene cupo gratuito en Gemini 2.5, no en 3.x.
const MODELOS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite']
const DIAS = 8

const CLAVES = /venezuel(a|an|ans)\b|venezolan[oa]s?\b|caracas|maracaibo|angel falls|simón bolívar|simon bolivar|vinotinto/i

const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic']
const DIAS_SEM = ['dom', 'lun', 'mar', 'mie', 'jue', 'vie', 'sab']

function ymdLondres(d) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
}

function etiqueta(fecha, hora) {
  const [y, m, d] = fecha.split('-').map(Number)
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay()
  return DIAS_SEM[dow] + ' ' + d + ' ' + MESES[m - 1] + ', ' + hora + ' (hora UK)'
}

function debeCorrer() {
  if (process.env.GITHUB_EVENT_NAME === 'schedule') {
    const lunes = new Date().getUTCDay() === 1
    if (!lunes) console.log('Busqueda Gemini de TV: solo corre los lunes en la ejecucion programada, se omite hoy.')
    return lunes
  }
  return true
}

function buildPrompt(hoy, hasta) {
  return [
    'Today is ' + hoy + '. Use Google Search to find TV programmes that will be broadcast in the United Kingdom',
    'between ' + hoy + ' and ' + hasta + ' (inclusive) and that are clearly related to Venezuela.',
    '',
    'Include: documentaries, series episodes, films, travel/food shows about Venezuela or Venezuelan people,',
    'and live sport involving the Venezuela national team (football, baseball, etc.) on UK channels',
    '(BBC, ITV, Channel 4, Channel 5, Sky, TNT Sports, Premier Sports, Viaplay, etc.).',
    'Do NOT include streaming-only catalogue titles without a scheduled broadcast time, and do NOT include',
    'anything you cannot confirm with an explicit date, start time and channel from a TV guide or official source.',
    'If you are not sure, leave it out. An empty list is a perfectly good answer.',
    '',
    'Reply with ONLY a JSON array (no markdown, no commentary). Each item:',
    '{"title": "programme title", "date": "YYYY-MM-DD (UK date)", "time": "HH:MM (UK time, 24h)",',
    ' "channel": "channel name", "description": "one sentence in Spanish saying what it is and why it relates to Venezuela",',
    ' "url": "https page of the guide or official source where this broadcast is listed"}',
  ].join('\n')
}

async function consultar(modelo, apiKey, prompt) {
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + modelo + ':generateContent'
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      tools: [{ google_search: {} }],
      generationConfig: { temperature: 0 },
    }),
    signal: AbortSignal.timeout(120000),
  })
  if (!res.ok) {
    const cuerpo = (await res.text()).replace(/\s+/g, ' ').slice(0, 1500)
    throw new Error('HTTP ' + res.status + ' con ' + modelo + ': ' + cuerpo)
  }
  const data = await res.json()
  const partes = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || []
  return partes.map((p) => p.text || '').join('\n')
}

function extraerJson(texto) {
  const limpio = texto.replace(/\x60{3}(json)?/gi, '')
  const ini = limpio.indexOf('[')
  const fin = limpio.lastIndexOf(']')
  if (ini === -1 || fin <= ini) return null
  try {
    const arr = JSON.parse(limpio.slice(ini, fin + 1))
    return Array.isArray(arr) ? arr : null
  } catch (e) {
    return null
  }
}

async function main() {
  if (!debeCorrer()) return
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) {
    console.log('Busqueda Gemini de TV: falta GEMINI_API_KEY, se omite.')
    return
  }

  const ahora = new Date()
  const hoy = ymdLondres(ahora)
  const hasta = ymdLondres(new Date(ahora.getTime() + DIAS * 86400000))
  const prompt = buildPrompt(hoy, hasta)

  let texto = null
  for (const modelo of MODELOS) {
    try {
      texto = await consultar(modelo, apiKey, prompt)
      console.log('Busqueda Gemini de TV: respuesta recibida de ' + modelo + '.')
      break
    } catch (err) {
      console.error('Busqueda Gemini de TV: fallo ' + err.message)
    }
  }
  if (texto === null) return

  const items = extraerJson(texto)
  if (!items) {
    console.error('Busqueda Gemini de TV: la respuesta no era un JSON valido, no se toca eventos.json.')
    return
  }

  const vistos = new Set()
  const nuevos = []
  for (const it of items) {
    const titulo = String(it.title || '').trim()
    const fecha = String(it.date || '').trim()
    const hora = String(it.time || '').trim()
    const canal = String(it.channel || '').trim()
    const desc = String(it.description || '').trim()
    if (!titulo || !canal) continue
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha) || !/^\d{2}:\d{2}$/.test(hora)) continue
    if (fecha < hoy || fecha > hasta) continue
    if (!CLAVES.test(titulo + ' ' + desc)) continue
    const clave = (titulo + '|' + fecha + '|' + hora + '|' + canal).toLowerCase()
    if (vistos.has(clave)) continue
    vistos.add(clave)
    const link = /^https:\/\//.test(String(it.url || '')) ? it.url : 'https://www.google.com/search?q=' + encodeURIComponent(titulo + ' ' + canal + ' TV')
    nuevos.push({
      title: titulo,
      type: 'unico',
      date: fecha,
      endDate: null,
      dateLabel: etiqueta(fecha, hora),
      venue: canal,
      city: 'Reino Unido',
      region: 'Reino Unido',
      price: 'Ver canal',
      link,
      description: desc ? (desc.length > 260 ? desc.slice(0, 260) + '...' : desc) : 'Programa de TV con vinculo con Venezuela.',
      category: 'TV y Streaming',
      source: SOURCE,
    })
  }

  const existentes = readEventos().filter((e) => e.source !== SOURCE)
  const resultado = mergeAndSave(existentes, nuevos)
  console.log('Busqueda Gemini de TV: ' + items.length + ' sugeridos, ' + nuevos.length + ' validados, ' + resultado.added + ' agregados (total ' + resultado.total + ').')
}

main().catch((err) => {
  console.error('Error en la busqueda Gemini de TV (se ignora para no frenar el resto):', err.message)
})
