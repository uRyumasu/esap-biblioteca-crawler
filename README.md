# esap-biblioteca-crawler

Reads the public catalogue of the Águeda libraries ([Libware OPAC](https://opacagueda.lbwapp.eu/opac/)) for the library of the ESAP+ app (Escola Secundária Adolfo Portela).

The app keeps a queue of record numbers to read. A GitHub Actions job in this repository (`.github/workflows/ler.yml`) takes the next numbers, reads them from the OPAC at one request per second, and sends back what it read. It lives in its own public repository because the OPAC doesn't answer the app's servers, and Actions minutes are free here.

- `opac.ts`: reads and parses one record (a copy of the app's parser).
- `ler.mjs`: the job (`node ler.mjs`, Node 24).

Repository secrets:
- `BIBLIOTECA_URL`: the app's Edge Function address.
- `BIBLIOTECA_CHAVE`: its key. It can only take and save records of the library's queue.
