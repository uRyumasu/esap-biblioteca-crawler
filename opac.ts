// A copy of the ESAP+ app's supabase/functions/biblioteca-opac/opac.ts (the
// app's repository is private): when the parser changes there, copy it here.
//
// Feature "biblioteca": reads one record of the Águeda libraries' public
// catalogue (Libware OPAC, opacagueda.lbwapp.eu) with its copies.
//
// Shared by the Edge Function next to it (Deno: a live refresh when someone
// opens a book) and by scripts/biblioteca/catalogo.mjs (Node: the nightly
// crawl), so the page is only parsed in one place. Plain TypeScript, no
// dependencies, only erasable syntax (Node runs it by stripping the types).
//
// The OPAC is an ASP.NET site: a session (cookie) must start ("Iniciar nova
// Sessão"), pick a catalogue (the network root, AGUEDA_GIB_CATALOGO, which
// holds every library of the Rede Concelhia) and pick the UNIMARC format once.
// After that, ShowRegHoldings.ascx&RegNo=<n> gives one record in UNIMARC plus
// the live copies table (library, shelf mark, barcode, state, due date). The
// OPAC never says who borrowed a copy.

export const OPAC = 'https://opacagueda.lbwapp.eu/opac/'
const PAGINA = `${OPAC}default.aspx?ContentAreaControl=`
const CATALOGO = 'sAGUEDA_GIB_CATALOGO'
const UNIMARC = 'C:\\OPAC\\VisualFormats\\formatUnimarc.xsl'
/** Where the OPAC keeps the covers (public files). */
export const CAPAS = 'https://opac.bibliopolis.info/OPAC/documentos/Agueda/'
/** Code of this school in the catalogue's 966 ^l. */
export const ESCOLA = 'ESAP'

export type Exemplar = {
  codigo_barras: string
  biblioteca_codigo: string | null
  biblioteca_nome: string | null
  cota: string | null
  volume: string | null
  tipo: string | null
  estatuto: string | null
  estado: string | null
  /** yyyy-mm-dd */
  devolucao_prevista: string | null
}

export type Obra = {
  regno: number
  titulo: string
  subtitulo: string | null
  autor: string | null
  autores: string | null
  editora: string | null
  local: string | null
  ano: number | null
  edicao: string | null
  isbn: string | null
  colecao: string | null
  assuntos: string[]
  cdu: string | null
  classe: number | null
  tipo: string
  lingua: string | null
  resumo: string | null
  capa: string | null
  /** 005, "yyyy-mm-ddThh:mm" (Lisbon time) */
  opac_alterado: string | null
  pesquisa: string
}

export type Registo = { obra: Obra; exemplares: Exemplar[] }

// ---------- text ----------

const ENTIDADES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

export function texto(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTIDADES[n.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ')
    .trim()
}

/** Lower case, no accents: what search compares (the app does the same to the query). */
export function normalizar(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim()
}

const limpo = (s: string | undefined | null): string | null => {
  // ISBD punctuation the cataloguers leave at the ends: "Porto :", "trad. ;"
  const t = (s ?? '').replace(/^[\s:;,/.=-]+|[\s:;,/=]+$/g, '').trim()
  return t || null
}

// ---------- UNIMARC ----------

type Campo = { tag: string; ind: string; sub: [string, string][] }

/** The fields of the record (the `<td class="Results">` rows of the UNIMARC view). */
export function campos(html: string): Campo[] {
  const out: Campo[] = []
  for (const m of html.matchAll(/<td class="Results">([\s\S]*?)<\/td>/g)) {
    const t = texto(m[1])
    const f = /^(\d{3})\s*(.*)$/.exec(t)
    if (!f) continue
    const [, tag, resto] = f
    const i = resto.indexOf('^')
    const ind = (i < 0 ? '' : resto.slice(0, i)).trim()
    const sub: [string, string][] = []
    if (i >= 0) {
      for (const p of resto.slice(i + 1).split('^')) {
        if (!p) continue
        // "<Os >cinco": UNIMARC's "ignore when sorting" marks
        const v = p.slice(1).replace(/<([^<>]*)>/g, '$1').trim()
        if (v) sub.push([p[0], v])
      }
    } else if (resto.trim()) sub.push(['', resto.trim()])
    out.push({ tag, ind, sub })
  }
  return out
}

const sub = (c: Campo | undefined, code: string) => c?.sub.find(([k]) => k === code)?.[1]
const subs = (c: Campo, code: string) => c.sub.filter(([k]) => k === code).map(([, v]) => v)

function nome(c: Campo): string | null {
  // personal names: ^a surname ^b forename ("Castelo Branco", "Camilo")
  const a = limpo(sub(c, 'a'))
  const b = limpo(sub(c, 'b'))
  if (!a) return null
  return b ? `${b} ${a}` : a
}

/** Leader position 6 (type of record) and 7 (level) → our document type. */
function tipoDe(leader: string, tabela: string | null): string {
  const t = tabela?.toLowerCase() ?? ''
  if (/dvd|v[ií]deo|filme/.test(t)) return 'video'
  if (/cd|[áa]udio|disco/.test(t)) return 'audio'
  if (/peri[óo]dic|revista|jornal/.test(t)) return 'periodico'
  const m = /^\d{5}(.)(.)(.)/.exec(leader.replace(/^Leader\s*/, ''))
  if (!m) return 'livro'
  const [, , tipo, nivel] = m
  if (nivel === 's') return 'periodico'
  if (tipo === 'g') return 'video'
  if (tipo === 'i' || tipo === 'j') return 'audio'
  if (tipo === 'a' || tipo === 'b') return 'livro'
  return 'outro'
}

/**
 * The cover: 856 ^u is "locateMedia.aspx?cod=20180925165306&ext=jpg", which
 * only redirects to a public file (any site can show it, no session).
 */
export function urlCapa(u: string | undefined): string | null {
  const m = /cod=(\d{6,20})&(?:amp;)?ext=([a-z]{3,4})/i.exec(u ?? '')
  return m ? `${CAPAS}${m[1]}.${m[2].toLowerCase()}` : null
}

// ---------- copies table ----------

const COLUNAS: [RegExp, keyof Exemplar | 'biblioteca'][] = [
  [/^biblioteca/i, 'biblioteca'],
  [/^cota/i, 'cota'],
  [/^volume/i, 'volume'],
  [/^tipo/i, 'tipo'],
  [/^c[óo]digo/i, 'codigo_barras'],
  [/^estatuto/i, 'estatuto'],
  [/^estado/i, 'estado'],
  [/^data/i, 'devolucao_prevista'],
]

/** "21-11-2026", "21/11/2026", "2026-11-21" → "2026-11-21". */
export function data(s: string | null | undefined): string | null {
  if (!s) return null
  let m = /(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/.exec(s)
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`
  m = /(\d{4})-(\d{2})-(\d{2})/.exec(s)
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null
}

type Linha = Partial<Record<keyof Exemplar | 'biblioteca', string>>

function tabelaExemplares(html: string): Linha[] {
  const t = /<table[^>]*id="[^"]*dgRegHoldings"[^>]*>([\s\S]*?)<\/table>/.exec(html)
  if (!t) return []
  const cab = [...t[1].matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((m) => {
    const h = texto(m[1])
    return COLUNAS.find(([re]) => re.test(h))?.[1] ?? null
  })
  const corpo = /<tbody>([\s\S]*)<\/tbody>/.exec(t[1])?.[1] ?? ''
  const linhas: Linha[] = []
  for (const tr of corpo.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const tds = [...tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => texto(m[1]))
    const l: Linha = {}
    tds.forEach((v, i) => {
      const k = cab[i]
      if (k && v) l[k] = v
    })
    if (l.codigo_barras || l.biblioteca) linhas.push(l)
  }
  return linhas
}

// ---------- one record ----------

export type Estado = 'ok' | 'sem-registo' | 'sem-sessao'

/** What a page is: a record, the catalogue chooser (no such record, or the session was lost)… */
export function estadoPagina(html: string): Estado {
  if (/htmlRegContent"[^>]*>\s*<(table|div)/.test(html)) return 'ok'
  if (/tvCatalogs|ChooseDatabase|btNewSession/.test(html)) return 'sem-sessao'
  return 'sem-registo'
}

export function parseRegisto(regno: number, html: string): Registo | null {
  if (estadoPagina(html) !== 'ok') return null
  const leader = texto(/class="SubTitle2">\s*(Leader[^<]*)</.exec(html)?.[1] ?? '')
  const cs = campos(html)
  const um = (tag: string) => cs.find((c) => c.tag === tag)
  const todos = (...tags: string[]) => cs.filter((c) => tags.includes(c.tag))

  const c200 = um('200')
  const titulo = limpo(c200 ? subs(c200, 'a').join(' ; ') : null)
  if (!titulo) return null
  const subtitulo = limpo(c200 ? subs(c200, 'e').join(' : ') : null)

  const pessoas = todos('700', '701', '702').map(nome)
  const entidades = todos('710', '711', '712').map((c) => limpo(sub(c, 'a')))
  const principal = nome(um('700') as Campo) ?? limpo(sub(um('710'), 'a')) ?? limpo(sub(c200, 'f'))
  const autores = [...new Set([...pessoas, ...entidades].filter((x): x is string => !!x))]

  const c210 = um('210') ?? um('214')
  const ano = /(\d{4})/.exec(sub(c210, 'd') ?? '')?.[1]
  const c225 = um('225')
  const colecao = limpo(
    [sub(c225, 'a'), sub(c225, 'v')].filter(Boolean).join(' ; ') || null,
  )
  const assuntos = [
    ...new Set(
      todos('600', '601', '602', '605', '606', '607', '608')
        .map((c) => limpo(c.sub.filter(([k]) => /[axyz]/.test(k)).map(([, v]) => v).join(' -- ')))
        .filter((x): x is string => !!x),
    ),
  ]
  const cdu = limpo(sub(um('675'), 'a'))
  const classe = cdu && /^\d/.test(cdu) ? Number(cdu[0]) : null
  const alterado = /^(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?/.exec(texto(um('005')?.sub[0]?.[1] ?? ''))
  const capa = urlCapa(sub(um('856'), 'u'))

  // copies: 966 (^a barcode, ^l library code, ^s shelf mark) + the live table
  const linhas = tabelaExemplares(html)
  const porCodigo = new Map(linhas.filter((l) => l.codigo_barras).map((l) => [l.codigo_barras as string, l]))
  const exemplares: Exemplar[] = []
  const vistos = new Set<string>()
  const de = (codigo: string, l: Linha | undefined, lib: string | null, cota: string | null): Exemplar => ({
    codigo_barras: codigo,
    biblioteca_codigo: lib,
    biblioteca_nome: l?.biblioteca ?? null,
    cota: limpo(l?.cota) ?? cota,
    volume: limpo(l?.volume),
    tipo: limpo(l?.tipo),
    estatuto: limpo(l?.estatuto),
    estado: limpo(l?.estado),
    devolucao_prevista: data(l?.devolucao_prevista),
  })
  for (const c of todos('966')) {
    const codigo = limpo(sub(c, 'a'))
    if (!codigo || vistos.has(codigo)) continue
    vistos.add(codigo)
    exemplares.push(de(codigo, porCodigo.get(codigo), limpo(sub(c, 'l')), limpo(sub(c, 's'))))
  }
  // in the table but not in 966: learn the library's code from its name
  const codigoDe = new Map(exemplares.filter((e) => e.biblioteca_nome).map((e) => [e.biblioteca_nome, e.biblioteca_codigo]))
  for (const l of linhas) {
    const codigo = l.codigo_barras
    if (!codigo || vistos.has(codigo)) continue
    vistos.add(codigo)
    const lib = codigoDe.get(l.biblioteca ?? null) ?? (/adolfo portela/i.test(l.biblioteca ?? '') ? ESCOLA : null)
    exemplares.push(de(codigo, l, lib, null))
  }

  const tipo = tipoDe(leader, exemplares.find((e) => e.tipo)?.tipo ?? null)
  const isbn = limpo(sub(um('010'), 'a')) ?? limpo(sub(um('011'), 'a'))
  const obra: Obra = {
    regno,
    titulo,
    subtitulo,
    autor: principal,
    autores: autores.join('; ') || null,
    editora: limpo(sub(c210, 'c')),
    local: limpo(sub(c210, 'a')),
    ano: ano ? Number(ano) : null,
    edicao: limpo(sub(um('205'), 'a')),
    isbn,
    colecao,
    assuntos,
    cdu,
    classe,
    tipo,
    lingua: limpo(sub(um('101'), 'a')),
    resumo: limpo(sub(um('330'), 'a')),
    capa,
    opac_alterado: alterado ? `${alterado[1]}-${alterado[2]}-${alterado[3]}T${alterado[4] ?? '00'}:${alterado[5] ?? '00'}` : null,
    pesquisa: '',
  }
  obra.pesquisa = normalizar(
    [titulo, subtitulo, ...autores, principal, isbn?.replace(/-/g, ''), isbn, colecao, ...assuntos, obra.editora, ...exemplares.map((e) => e.cota)]
      .filter(Boolean)
      .join(' '),
  )
  return { obra, exemplares }
}

// ---------- session ----------

const ocultos = (html: string) => {
  const f: Record<string, string> = {}
  for (const n of ['__VIEWSTATE', '__VIEWSTATEGENERATOR', '__EVENTVALIDATION']) {
    const m = new RegExp(`id="${n}" value="([^"]*)"`).exec(html)
    if (m) f[n] = m[1].replace(/&amp;/g, '&')
  }
  return f
}

/** A Google Books cover link, over https and without the page-curl effect. */
export const capaGoogle = (u: string | null | undefined): string | null =>
  u ? u.replace(/^http:/, 'https:').replace(/&edge=curl/, '') : null

export type Opcoes = {
  userAgent?: string
  timeoutMs?: number
  /** At least this long between two requests (be gentle with the municipality's server). */
  intervaloMs?: number
}

/** One OPAC session (cookie jar + the page it's on). Not for parallel use. */
export class Sessao {
  private cookies = new Map<string, string>()
  private pronta = false
  /** No record was read since the session opened: a miss now means the number doesn't exist. */
  private acabadaDeAbrir = false
  private ultimo = 0
  /** Requests made (for the logs). */
  pedidos = 0
  private opcoes: Opcoes
  constructor(opcoes: Opcoes = {}) {
    this.opcoes = opcoes
  }

  private async pedido(url: string, form?: Record<string, string>): Promise<string> {
    let atual = url
    let corpo: string | undefined = form ? new URLSearchParams(form).toString() : undefined
    for (let saltos = 0; saltos < 6; saltos++) {
      const espera = this.ultimo + (this.opcoes.intervaloMs ?? 0) - Date.now()
      if (espera > 0) await new Promise((r) => setTimeout(r, espera))
      this.ultimo = Date.now()
      this.pedidos++
      const headers: Record<string, string> = { 'User-Agent': this.opcoes.userAgent ?? 'ESAP+ biblioteca' }
      if (this.cookies.size) headers.Cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ')
      if (corpo !== undefined) headers['Content-Type'] = 'application/x-www-form-urlencoded'
      const res = await fetch(atual, {
        method: corpo !== undefined ? 'POST' : 'GET',
        headers,
        body: corpo,
        redirect: 'manual',
        signal: AbortSignal.timeout(this.opcoes.timeoutMs ?? 30_000),
      })
      for (const c of res.headers.getSetCookie?.() ?? []) {
        const [par] = c.split(';')
        const i = par.indexOf('=')
        if (i > 0) this.cookies.set(par.slice(0, i).trim(), par.slice(i + 1).trim())
      }
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        await res.body?.cancel()
        atual = new URL(res.headers.get('location') as string, atual).toString()
        corpo = undefined
        continue
      }
      if (!res.ok) throw new Error(`OPAC ${res.status} em ${atual}`)
      return await res.text()
    }
    throw new Error('OPAC: demasiados redirecionamentos')
  }

  /** New session → the network catalogue → UNIMARC. */
  async abrir(): Promise<void> {
    this.cookies.clear()
    this.pronta = false
    const inicio = await this.pedido(`${PAGINA}palavra.ascx`)
    let pagina = inicio
    if (/btNewSession/.test(inicio)) {
      pagina = await this.pedido(`${PAGINA}NewSession.ascx`, {
        ...ocultos(inicio),
        'ctl13$ctl00$btNewSession': 'Iniciar nova Sessão',
      })
    }
    if (!/tvCatalogs/.test(pagina)) throw new Error('OPAC: não apareceu a escolha de catálogo')
    await this.pedido(`${PAGINA}ChooseDatabase.ascx`, {
      ...ocultos(pagina),
      __EVENTTARGET: 'ctl13$ctl00$tvCatalogs',
      __EVENTARGUMENT: CATALOGO,
    })
    // any record will do to switch the format (it sticks for the session)
    const url = `${PAGINA}ShowRegHoldings.ascx&RegNo=1`
    const reg = await this.pedido(url)
    if (estadoPagina(reg) !== 'ok') throw new Error('OPAC: o catálogo da rede não abriu')
    const fmt = await this.pedido(url, {
      ...ocultos(reg),
      __EVENTTARGET: 'ctl13$ctl00$ddlTopFormats',
      __EVENTARGUMENT: '',
      'ctl13$ctl00$ddlTopFormats': UNIMARC,
    })
    if (!/class="SubTitle2">\s*Leader/.test(fmt)) throw new Error('OPAC: o formato UNIMARC não pegou')
    this.pronta = true
    this.acabadaDeAbrir = true
  }

  /**
   * The page of one record, or null if the catalogue has no such number.
   * A missing number sends the session back to the catalogue chooser (so
   * does an expired session): on an old session it's tried once more on a
   * fresh one; on a fresh session the number really doesn't exist.
   */
  async pagina(regno: number): Promise<string | null> {
    if (!this.pronta) await this.abrir()
    const url = `${PAGINA}ShowRegHoldings.ascx&RegNo=${regno}`
    let html = await this.pedido(url)
    if (estadoPagina(html) !== 'ok' && !this.acabadaDeAbrir) {
      await this.abrir()
      html = await this.pedido(url)
    }
    this.acabadaDeAbrir = false
    if (estadoPagina(html) === 'ok') return html
    this.pronta = false
    return null
  }

  async registo(regno: number): Promise<Registo | null> {
    const html = await this.pagina(regno)
    return html ? parseRegisto(regno, html) : null
  }
}
