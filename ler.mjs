// Reads the public catalogue of the Águeda libraries (Libware OPAC) for the
// ESAP+ app's library.
//
// The app's database (Supabase) keeps a queue of record numbers to read: every
// night the school's books, new records and a seventh of the rest of the
// network; on school days the school's lent copies. The OPAC doesn't answer
// Supabase's servers, so this job does the reading: it asks the app's Edge
// Function for the next numbers ({ lote: 'pegar' }), reads them here, one
// request a second, and sends back what it read ({ lote: 'guardar' }). It stops
// when the queue is empty, after LIMITE_MINUTOS, or when the OPAC stops
// answering (the queue keeps what's left for the next run).
//
// Env: BIBLIOTECA_URL (the Edge Function's address), BIBLIOTECA_CHAVE (its key:
// it can only take and save records of this queue), LIMITE_MINUTOS (330).
//
//   node ler.mjs

import { Sessao } from './opac.ts'

const URL_FUNCAO = process.env.BIBLIOTECA_URL
const CHAVE = process.env.BIBLIOTECA_CHAVE
const LIMITE_MS = Number(process.env.LIMITE_MINUTOS ?? 330) * 60_000
const UA = 'ESAP+ biblioteca (+https://esap.ryumasu.dev)'
// records per batch (a batch holds the queue for 150 s at most between saves)
const POR_LOTE = 50
// saved every so many, so the app's status page moves
const GUARDAR_CADA = 20
// the OPAC failed this many times in a row: stop, and let it rest
const FALHAS_SEGUIDAS = 5
const PAUSA_MINUTOS = 15

const log = (...a) => console.log(...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

if (!URL_FUNCAO || !CHAVE) {
  console.error('BIBLIOTECA_URL and BIBLIOTECA_CHAVE must be set (repository secrets)')
  process.exit(1)
}

/** One call to the app's Edge Function, tried 4 times. */
async function funcao(body) {
  for (let tentativa = 1; ; tentativa++) {
    try {
      const res = await fetch(URL_FUNCAO, {
        method: 'POST',
        headers: { Authorization: `Bearer ${CHAVE}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      })
      const json = await res.json().catch(() => ({}))
      if (res.ok) return json
      // a wrong key won't get better
      if (res.status === 401) throw Object.assign(new Error('the key was refused (BIBLIOTECA_CHAVE)'), { fatal: true })
      throw new Error(`${res.status} ${json.error ?? ''}`)
    } catch (e) {
      if (e.fatal || tentativa >= 4) throw e
      log(`  app: ${e.message}, trying again`)
      await sleep(tentativa * 10_000)
    }
  }
}

const inicio = Date.now()
const sessao = new Sessao({ userAgent: UA, intervaloMs: 1000, timeoutMs: 20_000 })
const conta = { lidos: 0, inexistentes: 0, erros: 0 }
let vazias = 0
let parado = false

while (Date.now() - inicio < LIMITE_MS && !parado) {
  const { numeros = [] } = await funcao({ lote: 'pegar', quantos: POR_LOTE })
  if (!numeros.length) {
    // the queue is empty, or a batch of an earlier run still holds it: look again a few times
    if (++vazias > 6) break
    await sleep(30_000)
    continue
  }
  vazias = 0

  let dados = []
  let vazios = []
  let erros = []
  const guardar = async (extra = {}) => {
    await funcao({ lote: 'guardar', dados, vazios, erros, ...extra })
    dados = []
    vazios = []
    erros = []
  }

  let seguidas = 0
  let i = 0
  for (; i < numeros.length; i++) {
    if (Date.now() - inicio > LIMITE_MS) break
    const regno = numeros[i]
    try {
      const r = await sessao.registo(regno)
      seguidas = 0
      if (r) {
        dados.push(r)
        conta.lidos++
      } else {
        vazios.push(regno)
        conta.inexistentes++
      }
    } catch (e) {
      seguidas++
      conta.erros++
      erros.push(regno)
      log(`  ${regno}: ${e.message}`)
      if (seguidas >= FALHAS_SEGUIDAS) {
        parado = true
        break
      }
      await sleep(3000)
    }
    if (dados.length + vazios.length + erros.length >= GUARDAR_CADA) await guardar()
  }
  // the OPAC isn't answering: don't call "gone" what it didn't show; it rests
  const soltar = numeros.slice(parado ? i + 1 : i)
  if (parado) {
    soltar.push(...vazios)
    vazios = []
  }
  await guardar({ soltar, fim: true, pausa_minutos: parado ? PAUSA_MINUTOS : 0 })

  const min = (Date.now() - inicio) / 60_000
  log(`${min.toFixed(0)} min: ${conta.lidos} read, ${conta.inexistentes} with no record, ${conta.erros} errors`)
}

log(`done: ${JSON.stringify(conta)}, ${sessao.pedidos} requests${parado ? ' — the OPAC stopped answering' : ''}`)
// the OPAC refused this run from the start: fail, so it shows (the next run tries again)
if (parado && conta.lidos === 0) process.exit(1)
