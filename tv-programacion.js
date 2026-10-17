// tv-programacion.js
//
// Lee las guias de TV del Reino Unido (BBC e ITV) para los proximos 7 dias y
// agrega a eventos.json los programas con un vinculo claro con Venezuela, con
// la categoria "TV y Streaming" (emisiones con dia y hora).
//
// - BBC: la guia trae titulo, descripcion y horario (datos estructurados).
// - ITV: la guia trae solo titulo y horario, asi que se detecta menos.
// - Channel 4 y Channel 5: pendientes (no ofrecen guia por dia legible).
//
// Cada corrida BORRA las entradas anteriores de esta fuente y las genera de
// nuevo, asi los programas que ya pasaron salen solos. Si una guia falla, se
// avisa en el log pero el proceso no se rompe.

const { readEventos, mergeAndSave, sleep } = require('./events-utils')

const SOURCE = 'Guia de TV (BBC e ITV)'
const DIAS = 7
const UA = 'Mozilla/5.0 (compatible; ARenINBot/1.0; +https://arenin.uk)'

// Solo palabras que indican un vinculo claro con Venezuela. No se incluye
// "tango" suelto (aparece cada semana en programas de baile) ni apellidos.
const CLAVES = /venezuel(a|an|ans)\b|venezolan[oa]s?\b|caracas|maracaibo|angel falls|simón bolívar|simon bolivar|vinotinto/i

const BBC = [
  { name: 'BBC One', id: 'p00fzl6p' },
  { name: 'BBC Two', id: 'p00fzl97' },
  { name: 'BBC Three', id: 'p00fzl95' },
  { name: 'BBC Four', id: 'p00fzl6b' },
  { name: 'BBC News', id: 'p00fzl6g' },
  { name: 'BBC Scotland', id: 'p06kvypx' },
]

function diasProximos() {
  const dias = []
  for (let i = 0; i < DIAS; i++) {
    dias.push(new Date(Date.now() + i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10))
  }
  return dias
}

// Fecha y hora en Londres, con la etiqueta en el estilo de la agenda.
function enLondres(fechaIso) {
  const d = new Date(fechaIso)
  if (isNaN(d.getTime())) return null
  const p = {}
  new Intl.DateTimeFormat('es-ES', {
    timeZone: 'Europe/London', weekday: 'long', day: 'numeric', month: 'long',
    year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d).forEach((x) => { p[x.type] = x.value })
  const fecha = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(d)
  const hora = p.hour + ':' + p.minute
  const etiqueta = (p.weekday + ', ' + p.day + ' de ' + p.month + ' ' + p.year + ' - ' + hora).toUpperCase()
  return { fecha, hora, etiqueta }
}

async function pedir(url) {
  // Tiempo maximo por pagina: si una guia no responde, se salta (no cuelga el proceso).
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-GB,en;q=0.9' },
    signal: AbortSignal.timeout(20000),
  })
  if (!res.ok) throw new Error('HTTP ' + res.status)
  return res.text()
}

async function leerBBC(dias) {
  const out = []
  for (const canal of BBC) {
    for (const dia of dias) {
      try {
        const html = await pedir('https://www.bbc.co.uk/schedules/' + canal.id + '/' + dia.replace(/-/g, '/'))
        const bloques = html.match(/<script type="application\/ld\+json">[\s\S]*?<\/script>/g) || []
        for (const b of bloques) {
          let j
          try { j = JSON.parse(b.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '')) } catch (e) { continue }
          const g = j['@graph']
          if (!Array.isArray(g)) continue
          for (const e of g) {
            if (e['@type'] !== 'TVEpisode') continue
            const serie = e.partOfSeries || {}
            const pub = e.publication || {}
            const texto = [e.name, e.description, serie.name, serie.description].join(' ')
            if (!CLAVES.test(texto)) continue
            out.push({
              canal: canal.name, inicio: pub.startDate, serie: serie.name || '',
              episodio: e.name || '', descripcion: e.description || serie.description || '',
              link: e.url || serie.url || '',
            })
          }
        }
      } catch (err) {
        console.warn('BBC ' + canal.name + ' ' + dia + ': ' + err.message)
      }
      await sleep(600)
    }
  }
  return out
}

async function leerITV(dias) {
  const out = []
  let fallos = 0
  for (const dia of dias) {
    // ITV bloquea las consultas desde los servidores de GitHub: si falla dos
    // veces seguidas se omite el resto de la semana en vez de esperar cada dia.
    if (fallos >= 2) {
      console.warn('ITV: se omiten los dias restantes por fallos repetidos.')
      break
    }
    try {
      const html = await pedir('https://www.itv.com/watch/tv-guide/' + dia)
      const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)
      if (!m) continue
      const guia = (((JSON.parse(m[1]).props || {}).pageProps || {}).tvGuideData) || {}
      for (const canal of Object.keys(guia)) {
        const programas = guia[canal]
        if (!Array.isArray(programas)) continue
        for (const p of programas) {
          if (!CLAVES.test(p.title || '')) continue
          out.push({
            canal, inicio: p.start, serie: p.title, episodio: '', descripcion: '',
            link: 'https://www.itv.com/watch/tv-guide/' + dia,
          })
        }
      }
      fallos = 0
    } catch (err) {
      fallos++
      console.warn('ITV ' + dia + ': ' + err.message)
    }
    await sleep(600)
  }
  return out
}

async function main() {
  const dias = diasProximos()
  const crudos = (await leerBBC(dias)).concat(await leerITV(dias))

  const vistos = new Set()
  const nuevos = []
  for (const r of crudos) {
    const t = enLondres(r.inicio)
    if (!t) continue
    const episodioUtil = r.episodio && r.episodio !== r.serie && !/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(r.episodio)
    const titulo = episodioUtil ? r.serie + ': ' + r.episodio : r.serie
    const clave = titulo + '|' + t.fecha + '|' + t.hora + '|' + r.canal
    if (vistos.has(clave)) continue
    vistos.add(clave)
    const desc = (r.descripcion || '').trim()
    nuevos.push({
      title: titulo,
      type: 'unico',
      date: t.fecha,
      endDate: null,
      dateLabel: t.etiqueta,
      venue: r.canal,
      city: 'Reino Unido',
      region: 'Reino Unido',
      price: 'Gratis (TV)',
      link: r.link,
      description: desc ? desc.slice(0, 260) + (desc.length > 260 ? '...' : '') : 'Programa de TV con vinculo con Venezuela.',
      category: 'TV y Streaming',
      source: SOURCE,
    })
  }

  const existentes = readEventos().filter((e) => e.source !== SOURCE)
  const resultado = mergeAndSave(existentes, nuevos)
  console.log('Guias de TV: ' + nuevos.length + ' programas con vinculo con Venezuela, ' + resultado.added + ' agregados (total ' + resultado.total + ').')
}

main().catch((err) => {
  console.error('Error en las guias de TV (se ignora para no frenar el resto):', err.message)
})
