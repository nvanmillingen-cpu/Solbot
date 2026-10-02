# CLAUDE.md: Solbot

Context voor Claude bij het werken aan deze repository. Gebruikersdocumentatie staat in `README.md` (Nederlands).

## Project in het kort

Geautomatiseerde tradingbot voor **pump.fun-tokens op Solana**, met een lokaal webdashboard. Uitgangspunten van de eigenaar:

- Zo min mogelijk **betaalde diensten**: alleen gratis bronnen (PumpPortal, Solana RPC, DexScreener, Jupiter lite-API). Een gratis Helius-RPC wordt aangeraden.
- **Paper mode staat standaard aan.** Live trading kan alleen met `LIVE_TRADING_ENABLED=true` en `PRIVATE_KEY` in `.env`, en wisselen kan alleen als de bot gestopt is.
- **Veiligheid gaat vóór winst.** Bij twijfel of onbekende data: niet kopen (fail-closed).
- UI, logberichten, README en commentaar in de code zijn in het **Nederlands**. Communiceer ook met de gebruiker in het Nederlands.

## Gebruiker en omgeving

- De eigenaar gebruikt **Windows** en is geen ontwikkelaar. Geef stap-voor-stap-instructies met kant-en-klare commando's.
- Hij heeft de code als **ZIP** gedownload en heeft **geen Git** geïnstalleerd. Updaten gaat via een nieuwe ZIP, waarbij `.env` en `data/` worden meegenomen. Zie de vorige uitleg in de README of de chat.
- In PowerShell is het uitvoeren van scripts geblokkeerd: gebruik **`npm.cmd`** in plaats van `npm`, of `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.
- De ontwikkelbranch is `claude/new-session-6l7qs4`. Er is nog geen pull request.
- **Zet nooit sleutels in git.** `.env` staat in `.gitignore`. De gebruiker heeft eerder een Helius-sleutel in de chat geplakt, die inmiddels vervangen is.

## Commando's

```bash
npm install          # dependencies
npm run build        # dashboard bouwen (web/dist)
npm start            # bot + dashboard op http://127.0.0.1:3000 (tsx, geen compile-stap)
npm run dev          # server met watch + Vite dev-server (5173, proxy naar 3000)
npm test             # vitest (server/test)
npm run typecheck    # tsc --noEmit
```

Vereist **Node ≥ 22.13**: de bot gebruikt de ingebouwde `node:sqlite`, zonder native build. De waarschuwing `ExperimentalWarning: SQLite` is onschuldig.

Voor een test-run zonder je eigen database aan te raken, gebruik je een aparte DB, logmap en poort:
```bash
DB_PATH=.scratch/x.db LOG_DIR=.scratch/logs PORT=3111 npx tsx server/src/index.ts
curl -X PUT localhost:3111/api/settings -H 'content-type: application/json' -d '{...}'   # gedeeltelijke update
curl -X POST localhost:3111/api/bot/start
```
`.scratch/` staat in `.gitignore`. Zet scratch-scripts daar (en niet in `/tmp`), zodat ze de `node_modules` van het project kunnen vinden.

## Architectuur

```
server/src/
  index.ts              koppelt alles; maakt de executors (paper / live)
  config.ts, settings.ts  .env-config; zod-schema met defaults, opgeslagen in SQLite (tabel settings)
  db.ts                 schema + migraties (ALTER TABLE ... ADD COLUMN als de kolom ontbreekt)
  feed/pumpportal.ts    websocket: nieuwe tokens, migraties, trades (alleen met API-sleutel)
  feed/rpcLogs.ts       fallback: decodeert het pump.fun CreateEvent uit logsSubscribe
  market/bondingCurve.ts  PDA, decoderen van de curve, prijs- en quote-wiskunde
  market/dexscreener.ts, jupiter.ts, solPrice.ts   HTTP-clients met RateLimiter en backoff
  core/tracker.ts       volgt tokens, pollt curve (RPC) en DexScreener, activeert de fallback-feed
  core/metrics.ts       volume / prijsverandering / mcap / holders / onCurve / mayhem (pure functie)
  core/filters.ts       pure filterengine (onbekend = niet voldoen)
  core/safety.ts        checks vóór aankoop (zie hieronder)
  core/exits.ts         pure exit-regels: SL → TRAIL → TP → TIME
  core/positions.ts     posities in SQLite, monitor (poll + accountSubscribe), verkoop + failsafe
  core/bot.ts           orchestrator: evaluatie elke 2 s, risicolimieten, cooldowns, kopen
  core/stats.ts         statistieken en P&L-reeksen
  executor/             paper.ts, live.ts (Jupiter + PumpPortal-builders), txSender.ts
  api/server.ts         Fastify REST + /ws (state elke seconde)
web/src/                React + Vite + Recharts dashboard (één pagina, tabs)
```

**Stroom:** feed → tracker (metrics) → filters → `preBuyChecks` → executor.buy → `PositionManager.record` → monitor → `evaluateExit` → `sell` (bij een mislukte verkoop: `pending_exit` en een nieuwe poging met backoff en oplopende slippage).

## Volgorde van de checks vóór aankoop (`core/safety.ts`)

1. **Curve opnieuw on-chain lezen.** Bij "alleen bonding" moet de curve bestaan en niet `complete` zijn. Mayhem wordt afgekeurd. Een prijsbeweging van meer dan `maxPriceMoveBeforeBuyPct` sinds de evaluatie leidt tot afkeuring.
2. Minimale liquiditeit (alleen voor graduated tokens).
3. Mint ophalen: mint- en freeze-authority moeten ingetrokken zijn, en er mogen geen gevaarlijke Token-2022-extensies zijn (deze afkeuring is permanent).
4. Bezit van de maker: het ATA van de creator wordt direct gelezen.
5. **Top-10-holders**: `getTokenLargestAccounts`, zonder het curve-ATA. Bij een fout tot 3 pogingen, daarna **fail-closed** als `requireData` aan staat.
6. Round-trip-quote via Jupiter (honeypot-check) plus **quote-afwijking** ten opzichte van de on-chain prijs (`maxQuoteDeviationPct`).

## Lessen uit het testen (niet opnieuw uitzoeken)

- **PumpPortal `subscribeTokenTrade` vereist een API-sleutel** (wallet met ≥ 0,02 SOL). Nieuwe tokens en migraties zijn gratis. PumpPortal kan ook volledig stilvallen of een IP-adres blokkeren. Daarom schakelt `RpcLogFeed` na 60 s stilte automatisch in.
- De **oude pump.fun frontend-API** (`frontend-api(-v3).pump.fun/coins/...`) bestaat niet meer (404/530). Gebruik hem niet.
- **Jupiter routeert de pump.fun bonding curve** (route-label "Pump.fun"). Eén executor dekt dus zowel de curve als graduated tokens. PumpPortal `trade-local` is de fallback (0,5% fee).
- **DexScreener** indexeert brand-nieuwe tokens pas na enige handel. Er is geen 10-minutenvolume: dat wordt afgeleid uit het verschil tussen h24-snapshots.
- **De publieke Solana-RPC weigert `getTokenLargestAccounts`** (429 "Too many requests for a specific RPC call"), en ook andere gratis publieke endpoints doen dat. Je hebt een eigen RPC nodig (Helius of QuickNode).
- **Helius weigert `getTokenLargestAccounts` voor tokens met miljoenen holders** ("Too many accounts requested"). Dat betekent dat de methode **wel** ondersteund wordt. De opstarttest (USDC) behandelt dit als OK.
- web3.js herhaalt verzoeken bij een 429 automatisch, en dat kost tientallen seconden. Gebruik voor top-10 een `Connection` met `disableRetryOnRateLimit: true` (dat regelt `noRetry()` in `safety.ts`).
- `getParsedTokenAccountsByOwner` geeft op de publieke RPC soms `INTERNAL_ERROR`. Het bezit van de maker wordt daarom via het berekende ATA gelezen, met `getAccountInfo` en het bedrag op offset 64.
- **Layout van het curve-account**: 8 bytes discriminator, daarna 5× u64 (vTok, vSol, realTok, realSol, totalSupply), `complete` op byte 48, **creator op 49–80** en **is_mayhem_mode op byte 81**. Accounts zijn 125 of 151 bytes.
- **Mayhem mode**: de mint-supply is 2B (de curve meldt 1B), dus de mcap moet ×2. In tests gaven deze tokens de grootste verliezen. Ze worden standaard overgeslagen.
- **Mint-adressen eindigen niet altijd op `pump`.** Dat zijn toch echte pump.fun-tokens. Controleer altijd on-chain of het curve-account bestaat.
- De standaard lanceringsprijs van de curve is 30 SOL / 1,073 mld tokens ≈ 2,796e-8 SOL per token.
- De on-chain curveprijs en de Jupiter-quote kwamen in tests overeen (ratio 0,99, het verschil is de fee). Paper-fills nemen toch de **ongunstigste** van de twee, omdat de gebruiker trades zag met een onverklaarbare afwijking van 8,7× (BANDS) en een slippage van −68% bij de exit (SINS).
- Een trailing stop die direct vanaf de entry werkt, wordt door ruis geraakt. Daarom is er `activatePct` (standaard 20%).
- **Een dump in één transactie kan geen enkele stop-loss voorkomen.** `accountSubscribe` op de curve helpt alleen bij geleidelijke dalingen.

## Conventies

- Pure logica (filters, exits, metrics, stats, curve-wiskunde) houden we puur en dekken we met tests. Netwerk-afhankelijke code wordt getest met nagebootste `Connection`-objecten (`as never`) en `vi.mock` voor Jupiter (zie `server/test/safety.test.ts` en `paper.test.ts`).
- Echte mainnet-logs als fixture: `server/test/fixtures/pump-create-logs.json`.
- Nieuwe instelling: voeg die toe in het zod-schema (`settings.ts`) met een default, toon hem in `web/src/components/SettingsPanel.tsx` en documenteer hem in de README. Bestaande opgeslagen settings worden automatisch aangevuld via `.prefault({})` en de defaults.
- Nieuwe DB-kolom: voeg hem toe aan `SCHEMA` **en** aan de migratie in `openDb`.
- "Reset statistieken" archiveert gesloten trades (`status = 'archived'`) in plaats van ze te verwijderen. Zo blijft `everBought` (de regel tegen dubbele aankopen) werken.
- Log met pino als `logger.info({ ...velden }, 'nederlands bericht')`. Velden verschijnen ook in het dashboard-log.
- Controleer vóór een commit: `npm run typecheck`, `npm test` en `npm run build`. Voor gedragsveranderingen ook een korte paper-run op live data (zie hierboven). Rapporteer resultaten eerlijk, inclusief verliezen en kleine steekproeven.
- Geen modelnamen of -id's in commits of code.

## Standaardinstellingen (afgestemd met de gebruiker)

- **Filters:** bonding curve only, mayhem uit, leeftijd 2–30 min, mcap $10k–$60k, stijging ≥ 25% in 10 min (geen maximum), volume ≥ $8k totaal en ≥ $4k in 10 min, holders-filter uit.
- **Exits:** SL 20%, TP 50%, trailing 15% (actief vanaf +20%), max. houdtijd 15 min.
- **Risico:** 0,05 SOL per trade, max. 3 posities, dagelijks verliesmaximum 0,3 SOL.
- **Veiligheid:** maker ≤ 5%, top-10 ≤ 35% (verplicht), round-trip ≤ 10%, quote-afwijking ≤ 10%, prijsbeweging ≤ 25%.

De gebruiker stelt filterdrempels (zoals vol10m) zelf bij. Wijzig die niet ongevraagd.
