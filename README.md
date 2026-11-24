# esap-biblioteca-crawler

Reads the public catalogue of the Águeda libraries ([Libware OPAC](https://opacagueda.lbwapp.eu/opac/)) for the library of the ESAP+ app (Escola Secundária Adolfo Portela).

The app keeps a queue of record numbers to read. A GitHub Actions job in this repository (`.github/workflows/ler.yml`) takes the next numbers, reads them from the OPAC at one request per second, and sends back what it read. It lives in its own public repository because the OPAC doesn't answer the app's servers, and Actions minutes are free here.

- `opac.ts`: reads and parses one record (a copy of the app's parser).
- `ler.mjs`: the job (`node ler.mjs`, Node 24).

Repository secrets:
- `BIBLIOTECA_URL`: the app's Edge Function address.
- `BIBLIOTECA_CHAVE`: its key. It can only take and save records of the library's queue.

## The app's other data

The other scheduled jobs of the app also run here, for the same reason (free Actions minutes). **Their code is not in this repository**: each workflow checks out the private app repository with `ESAP_PLUS_TOKEN` and runs its scripts there. Only the workflow files are public.

| Workflow | What it does |
|---|---|
| `cantina.yml` | the canteen menu (every morning) |
| `noticias.yml` | the school site's news (every morning) |
| `escola.yml` | the class directors (Mondays) |
| `horario.yml` | the timetables: a PR in the app repository when a PDF changes (school mornings), then the changes for each class once it's merged |
| `exames.yml` | the national exams calendar: a PR when it changes (Mondays) |
| `criterios.yml` | the assessment criteria: a PR when they change (Mondays) |
| `avisos.yml` | push reminders: lost and found, library loans, tomorrow's tests |

Each one adds a row to Administração → Estado dos dados in the app.

More repository secrets for these:
- `ESAP_PLUS_TOKEN`: a fine-grained token for `uRyumasu/esap-plus` only, with Contents and Pull requests: read and write.
- `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_ID`, `SUPABASE_STAGING_PROJECT_ID`: the same as in the app repository.

None of these workflows runs on pull requests, so code from a fork never sees the secrets.
