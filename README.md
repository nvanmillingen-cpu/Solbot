# Solbot: pump.fun tradingbot met dashboard

Geautomatiseerde tradingbot voor pump.fun-tokens op Solana, met een lokaal webdashboard voor bediening en statistieken. De bot gebruikt alleen gratis databronnen en zet standaard **paper mode** aan: gesimuleerde trades op live prijzen.

> ⚠️ **Memecoin-trading is extreem risicovol.** Rugpulls, snipers, bundels en hoge slippage zijn normaal. De meeste nieuwe tokens gaan naar nul. Gebruik een **aparte wallet** met alleen geld dat je kunt missen. Deze software komt zonder enige garantie.

---

## Inhoud

1. [Wat de bot doet](#wat-de-bot-doet)
2. [Installatie](#installatie)
3. [Gebruik](#gebruik)
4. [Van paper naar live](#van-paper-naar-live)
5. [Instellingen](#instellingen)
6. [Databronnen en hun beperkingen](#databronnen-en-hun-beperkingen)
7. [Aankoop en verkoop (executors)](#aankoop-en-verkoop-executors)
8. [Veiligheid](#veiligheid)
9. [Projectstructuur](#projectstructuur)
10. [Testen en ontwikkelen](#testen-en-ontwikkelen)
11. [Problemen oplossen](#problemen-oplossen)

---

## Wat de bot doet

1. **Ontdekken**: elk nieuw pump.fun-token komt binnen via de gratis websocket van PumpPortal. Migraties (graduated tokens) komen via dezelfde websocket.
2. **Volgen**: per token houdt de bot prijs, market cap, volume (totaal en laatste 10 minuten), leeftijd en eventueel holders bij. Dat gaat via de on-chain bonding curve en DexScreener.
3. **Filteren**: elke 2 seconden toetst de bot alle gevolgde tokens aan je filters. Die stel je in via het dashboard en ze gelden direct.
4. **Veiligheidscheck**: vóór een aankoop controleert de bot de mint- en freeze-authority. Ook moet een verkoop-quote slagen (honeypot-check) en mag het round-trip-verlies niet te hoog zijn.
5. **Kopen**: in paper mode tegen een echte Jupiter-quote. In live mode via Jupiter, met PumpPortal als fallback (of andersom).
6. **Bewaken**: open posities worden elke paar seconden geprijsd. Raakt de prijs één exit-regel (stop-loss, take-profit, max. houdtijd of trailing stop), dan verkoopt de bot. Mislukt de verkoop, dan probeert een failsafe het opnieuw met oplopende slippage.
7. **Rapporteren**: alles komt in SQLite (`data/solbot.db`) en in een logbestand (`logs/`). Het dashboard toont P&L-grafieken, statistieken, open posities, de tradehistorie en de gevolgde tokens.

## Installatie

### Vereisten

- **Node.js 22.13 of nieuwer** (aanbevolen: Node 24 LTS). Downloaden kan via https://nodejs.org. De bot gebruikt de ingebouwde SQLite van Node, dus er is geen compiler of build-tool nodig.
- Een terminal (PowerShell, Terminal of bash).

### Stappen

```bash
# 1. Code ophalen
git clone https://github.com/nvanmillingen-cpu/Solbot.git
cd Solbot

# 2. Dependencies installeren
npm install

# 3. Configuratie aanmaken
cp .env.example .env        # Windows: copy .env.example .env

# 4. Dashboard bouwen
npm run build

# 5. Starten
npm start
```

Open daarna **http://localhost:3000** in je browser.

Voor paper mode hoef je in `.env` niets in te vullen. De publieke RPC werkt, al is een gratis Helius- of QuickNode-RPC sneller en betrouwbaarder (zie [RPC](#rpc)).

## Gebruik

- **Start / Stop**: start of stop het kopen. *Stop* stopt alleen nieuwe aankopen. Open posities blijven bewaakt door de exit-regels.
- **Sell all**: noodknop. Stopt de bot en verkoopt alle open posities direct.
- **Paper mode-schakelaar**: wisselen kan alleen als de bot gestopt is (zie hieronder).
- **Tabblad Overzicht**: statistieken, P&L-grafiek (24 uur, 7 dagen, all-time), open posities met live P&L en de tradehistorie met de reden van verkoop.
- **Tabblad Instellingen**: alle filters, exit-regels, risico- en uitvoeringsinstellingen. Klik op **Toepassen** om op te slaan. Wijzigingen gelden direct, zonder herstart.
- **Tabblad Kandidaten**: de gevolgde tokens met hun metingen en per filter of ze voldoen. Handig om je filters af te stellen.
- **Tabblad Log**: de laatste logregels. Het volledige logbestand staat in `logs/solbot-JJJJ-MM-DD.log`.

Statistieken en grafieken tonen standaard de huidige modus (paper of live). In de tradehistorie kun je wisselen.

**Statistieken resetten**: klik in de tradehistorie op **Reset statistieken**. Dit geldt voor de modus die daar geselecteerd is (paper, live of alles). Gesloten trades worden gearchiveerd, niet verwijderd: ze tellen niet meer mee in statistieken en grafieken, maar staan nog in de database. Instellingen en open posities blijven ongewijzigd. Het logbestand leegmaken reset de statistieken niet: die staan in `data/solbot.db`.

## Van paper naar live

1. **Draai eerst een tijd in paper mode** en kijk of je filters en exit-regels zinnig presteren. Paper-fills gebruiken echte Jupiter-quotes (inclusief fees en price impact), maar in werkelijkheid ben je trager en zijn er meer kapers op de kust. Live presteert vrijwel altijd slechter dan paper.
2. Maak in Phantom een **nieuw, apart account** aan en zet er een klein bedrag op, bijvoorbeeld 0,1 SOL.
3. Exporteer de private key: Phantom → Instellingen → Beheer accounts → kies het account → *Privésleutel tonen*. Zet die in `.env`:
   ```env
   PRIVATE_KEY=<base58-sleutel>
   LIVE_TRADING_ENABLED=true
   RPC_URL=https://mainnet.helius-rpc.com/?api-key=<jouw-gratis-sleutel>
   ```
4. Herstart de bot (`Ctrl+C`, daarna `npm start`).
5. Zet in het dashboard **SOL per trade** laag, bijvoorbeeld 0,01 SOL, en **max. gelijktijdige posities** op 1.
6. Zet de schakelaar *Paper mode* uit, bevestig, en klik op **Start**.

`.env` staat in `.gitignore` en wordt nooit gecommit. Deel dit bestand met niemand.

## Instellingen

Alle instellingen staan in de database (tabel `settings`) en zijn via het dashboard te wijzigen. Elk filter en elke exit-regel kan aan of uit.

### Filters (kopen)

Een token wordt alleen gekocht als het aan **alle** ingeschakelde filters voldoet. Data die (nog) onbekend is telt als *niet voldoen*.

| Filter | Betekenis |
|---|---|
| Top % (prijsstijging) | Minimale (en optioneel maximale) prijsstijging in % binnen het venster (standaard 10 min). Is het token jonger dan het venster, dan telt de stijging sinds lancering. Met een **maximum** sla je late pumps over (bijvoorbeeld max. 150%). 0 = geen maximum. |
| Volume totaal | Minimaal totaalvolume in USD. |
| Volume laatste 10 min | Minimaal volume in USD over de laatste 10 minuten. |
| Market cap min/max | Market cap in USD (prijs × 1 miljard supply × SOL/USD). Max 0 = geen maximum. |
| Graduated | *Nee*: alleen tokens op de bonding curve. Dit wordt **on-chain gecontroleerd**: het pump.fun-curve-account moet bestaan en nog niet voltooid zijn, ook vlak vóór de aankoop nog een keer. *Ja*: alleen tokens die gemigreerd zijn naar PumpSwap. *Maakt niet uit*: beide. |
| Mayhem mode overslaan | Slaat pump.fun-tokens in "mayhem mode" over (2 miljard supply, een AI-agent handelt mee). Standaard aan: in tests gaven deze tokens de grootste verliezen (−76% en −92%). |
| Minimale / maximale leeftijd | Minuten sinds het token werd aangemaakt (bij gemigreerde tokens: sinds de bot het zag). |
| Minimaal aantal holders | Zie [beperkingen](#holders). |

### Exit-regels

| Regel | Betekenis |
|---|---|
| Stop-loss | Verkoop als de P&L ≤ −X%. |
| Take-profit | Verkoop als de P&L ≥ +X%. |
| Max. houdtijd | Verkoop na X minuten, ongeacht de prijs. |
| Trailing stop | Verkoop als de prijs X% onder de hoogste prijs sinds aankoop zakt. De trailing stop wordt pas **actief** zodra de winst de activatiedrempel haalt (standaard 20%). Zo raakt normale ruis vlak na de koop hem niet meer, en eindigt een trail-exit na activatie boven de instapprijs. Activatie 0 = direct vanaf aankoop. |

De P&L wordt berekend ten opzichte van de **effectieve instapprijs**, inclusief fees en slippage. Bij meerdere treffers tegelijk geldt de volgorde SL → trailing → TP → tijd.

### Risico

- **SOL per trade**: bedrag per aankoop.
- **Max. gelijktijdige posities**: hoeveel posities er maximaal tegelijk open mogen staan.
- **Dagelijks verliesmaximum** (optioneel): stopt met kopen als het gerealiseerde verlies vandaag (lokale tijd, per modus) dit bedrag bereikt.
- **Minimale SOL-reserve**: SOL die altijd in de wallet moet blijven voor fees.
- **Geen dubbele aankopen**: een token dat ooit gekocht is (in welke modus dan ook) wordt nooit opnieuw gekocht.

## Databronnen en hun beperkingen

Er wordt geen betaalde dienst gebruikt. Alle bronnen zijn gratis, maar wel onofficieel of gelimiteerd. Daarom zitten er overal caching, rate limiting, backoff en fallbacks in.

| Bron | Gebruikt voor | Beperkingen |
|---|---|---|
| **PumpPortal websocket** (`wss://pumpportal.fun/api/data`) | Nieuwe tokens, migraties | Gratis voor nieuwe tokens en migraties. **Per-token trades (`subscribeTokenTrade`) vereisen sinds kort een API-sleutel** van een wallet met ≥ 0,02 SOL bij PumpPortal. Zonder sleutel schat de bot het volume zelf (zie hieronder). Verbreekt soms de verbinding: de bot verbindt automatisch opnieuw met backoff. **Valt PumpPortal 60 seconden stil, dan schakelt de bot automatisch over op de RPC-fallbackfeed** (zie hieronder). |
| **Solana RPC: programmalogs** (`logsSubscribe` op het pump.fun-programma) | Fallback voor nieuwe tokens | Gratis. De bot decodeert het pump.fun `CreateEvent` (mint, naam, maker, eerste aankoop) rechtstreeks uit de logs. Werkt ook op de publieke RPC, maar levert veel dataverkeer. In het dashboard staat dan "+ RPC-fallback" achter de feedstatus. |
| **Solana RPC**: bonding-curve-account | Exacte prijs, market cap, liquiditeit en status (graduated) van tokens op de curve | Dit is de meest betrouwbare bron. De publieke RPC (`api.mainnet-beta.solana.com`) is streng gelimiteerd. Bij honderden gevolgde tokens raad ik een gratis Helius- of QuickNode-sleutel aan. Er worden max. 100 accounts per call opgehaald. |
| **DexScreener API** (`/tokens/v1/solana/...`) | Volume (5m/1u/24u), prijsverandering, liquiditeit en prijs van graduated tokens | Gratis, 300 requests/min (de bot gebruikt max. 200/min, 30 tokens per call). **Indexeert brand-nieuwe tokens pas na wat handel**, vaak na enkele minuten. Geeft geen 10-minutenvolume: de bot berekent dat uit het verschil tussen 24u-volume-snapshots. |
| **Jupiter** (`lite-api.jup.ag`) | Quotes (paper-fills, honeypot-check), swaps (live), prijzen van graduated tokens en de SOL/USD-prijs | Gratis zonder sleutel, maar met een lage limiet (de bot blijft onder 50/min). Jupiter verwijst gebruikers steeds meer naar `api.jup.ag` met een gratis sleutel (portal.jup.ag). Vul in dat geval `JUPITER_API_URL` en `JUPITER_API_KEY` in. |
| pump.fun frontend-API | (niet gebruikt) | Bij het bouwen bleek deze onofficiële API veranderd: de oude endpoints geven 404/530. Hij is daarom niet als bron ingebouwd. |

### Hoe het volume bepaald wordt

- **Met PumpPortal API-sleutel**: exact, op basis van alle trades sinds de lancering.
- **Zonder sleutel**: het **maximum** van twee schattingen.
  1. *Curve-schatting*: de som van de absolute veranderingen in de SOL-reserves van de bonding curve tussen polls, plus de eerste aankoop van de maker. Dit is een **ondergrens**: een koop en een verkoop binnen één poll heffen elkaar op.
  2. *DexScreener*: het 24-uursvolume. Het 10-minutenvolume komt uit het verschil met een snapshot van ~10 minuten geleden, met als fallback 2× het 5-minutenvolume.

In het tabblad *Kandidaten* zie je per token welke bron gebruikt is.

### Holders

- **Met PumpPortal API-sleutel**: het aantal wallets met een positief saldo, berekend uit de trades.
- **Zonder sleutel**: via RPC `getTokenLargestAccounts`. **De publieke Solana-RPC blokkeert deze call meestal (fout 429)**: dan is het aantal holders onbekend en keurt het filter alles af. Daarom staat het holders-filter standaard uit. Zet het alleen aan met een eigen RPC (Helius/QuickNode) of een PumpPortal-sleutel. Ook dan geeft de RPC **maximaal 20 accounts**, dus de bot kan alleen "minstens N holders" vaststellen voor N ≤ 19. Een minimum van 20 of hoger haalt een token zonder sleutel nooit. Deze check gebeurt alleen voor tokens die al aan alle andere filters voldoen, om RPC-calls te sparen.

### Overige beperkingen

- **Leeftijd van gemigreerde tokens**: de bot kent alleen het moment van migratie, niet het aanmaakmoment.
- **Market cap** gaat uit van de pump.fun-supply van 1 miljard tokens, of 2 miljard bij mayhem mode (uit het curve-account gelezen).
- **Mint-adressen eindigen niet altijd op `pump`.** pump.fun maakt niet altijd een "vanity"-adres. De bot controleert daarom on-chain of er een pump.fun bonding curve bij het token hoort; de naam van het adres zegt niets.
- De bot volgt alleen tokens die tijdens het draaien zijn aangemaakt of gemigreerd. Oudere tokens worden niet ontdekt.

## Aankoop en verkoop (executors)

De uitvoering is een uitwisselbare **executor-laag** (`server/src/executor/`):

| Executor | Wanneer | Details |
|---|---|---|
| `PaperExecutor` | Paper mode | Vult tegen een **echte Jupiter-quote** (inclusief alle fees, slippage en price impact) plus de priority fee. Fallback: bonding-curve-wiskunde, daarna de laatste prijs. |
| `JupiterBuilder` | Live (standaard) | **Jupiter routeert ook tokens op de pump.fun bonding curve** (route-label "Pump.fun"), dus één executor dekt zowel bonding curve als graduated (PumpSwap/Raydium). Geen extra fee. |
| `PumpPortalBuilder` | Live (fallback of als voorkeur) | PumpPortal local-transaction API: PumpPortal bouwt de transactie en de bot tekent lokaal (je sleutel verlaat je computer niet). **PumpPortal rekent 0,5% fee per trade.** `pool: auto` kiest zelf curve of PumpSwap. |

De directe pump.fun-instructie is bewust niet zelf geïmplementeerd. Het pump.fun-programma verandert regelmatig (fee-accounts, creator-vaults, Token-2022), en Jupiter en PumpPortal houden dat bij.

**Live-transacties** worden lokaal getekend en verstuurd via jouw RPC. Tot ze bevestigd zijn, verstuurt de bot ze elke 2 seconden opnieuw. Daarna leest de bot de **werkelijke** SOL- en tokenbedragen uit de transactie. Slippage en priority fee stel je in via het dashboard.

**Retries**: een mislukte transactie wordt herhaald tot *Max. herhalingen*, eerst via de andere executor. Vóór elke herhaling controleert de bot de wallet, zodat een transactie die toch landde niet dubbel wordt uitgevoerd.

**Realtime bewaking**: voor open posities op de bonding curve abonneert de bot zich via de RPC-websocket op het curve-account (`accountSubscribe`, gratis). Elke trade op het token wordt daardoor direct tegen de exit-regels gehouden. Daarnaast is er een poll elke seconde, en voor graduated tokens elke 3 seconden via Jupiter/DexScreener. Let op: een dump in één transactie (bijvoorbeeld de maker die alles verkoopt) kan geen enkele stop-loss voorkomen. De eerstvolgende prijs is dan al veel lager.

**Slippage zichtbaar**: per trade slaat de bot de on-chain marktprijs bij aankoop op, en de prijs waarop de exit-regel triggerde. In de tradehistorie zie je in de kolom *Slippage exit* hoeveel de werkelijke verkoop daarvan afweek. Wijkt een fill meer dan 15% af, dan komt er een waarschuwing in de log.

**Paper-fills** voor tokens op de bonding curve worden berekend met zowel de Jupiter-quote als de exacte pump.fun-curvewiskunde op een verse on-chain stand. De **ongunstigste** van de twee telt, zodat paper mode niet te optimistisch is.

**Sell-failsafe**: mislukt een verkoop helemaal, dan blijft de positie open met de getriggerde exit-reden. De monitor probeert het opnieuw met oplopende wachttijd (5 s tot 60 s) en elke keer +5% slippage (max. 50%), ook als de prijs intussen herstelt. In het dashboard zie je dan "verkoop mislukt (n×)".

## Veiligheid

- **Paper mode staat standaard aan.** Live kan alleen als `LIVE_TRADING_ENABLED=true` in `.env` staat **en** er een geldige `PRIVATE_KEY` is. Wisselen kan alleen met de bot gestopt, en het dashboard vraagt om bevestiging.
- Na een herstart staat de bot altijd **gestopt**. Open posities worden wel meteen weer bewaakt.
- **Checks vóór aankoop** (instelbaar):
  - Mint- en freeze-authority moeten ingetrokken zijn. Gevaarlijke Token-2022-extensies (permanent delegate, transfer hook, non-transferable, pausable, transfer fee) leiden tot afkeuring.
  - **Verkoop-quote**: de bot vraagt een koop-quote en daarna een verkoop-quote voor dezelfde tokens. Mislukt de verkoop-quote, of is het round-trip-verlies groter dan het maximum, dan koopt de bot niet (honeypot- en liquiditeitscheck).
  - Minimale liquiditeit voor graduated tokens.
  - **Max. bezit van de maker** (standaard 5%): de bot leest de huidige tokenbalans van de maker uit. Heeft die nog een grote zak, dan is het dump-risico hoog. Dit werkt ook op de publieke RPC.
  - **Max. bezit top-10 holders** (standaard 35%, zonder bonding curve of pool): vangt snipers en bundels. **Vereist een eigen RPC** (Helius of QuickNode, gratis tier). De publieke Solana-RPC en andere gratis publieke endpoints weigeren `getTokenLargestAccounts`.
    - Bij een tijdelijke fout (429) probeert de bot het tot 3 keer.
    - Lukt het niet, dan **koopt de bot niet** (instelling *Niet kopen als top-10 onbekend is*, standaard aan).
    - Bij het opstarten test de bot of de RPC deze data levert. Staat in de log "RPC ondersteunt de top-10-holdercheck", dan is het goed. Werkt het niet, dan staat er een rode melding in het dashboard.
  - **Prijscontrole vlak vóór aankoop**: de bot haalt de curve opnieuw on-chain op. Hij koopt niet als de prijs sinds de filterevaluatie meer dan 25% veranderde, of als de koop-quote meer dan 10% afwijkt van de on-chain prijs (bescherming tegen foute fills).
- Afgekeurde tokens krijgen een cooldown. Bij authority-problemen worden ze permanent overgeslagen.
- Het dashboard luistert standaard alleen op `127.0.0.1` en heeft **geen login**. Stel `HOST` niet open naar internet.
- Alles wordt gelogd naar `logs/` (debugniveau in het bestand).

## Projectstructuur

```
server/src/
  index.ts              opstarten en koppelen van alle onderdelen
  config.ts             .env-configuratie
  settings.ts           instellingen-schema (zod) + opslag in SQLite
  db.ts                 SQLite-schema (node:sqlite)
  logger.ts             pino → bestand + console + dashboard
  wallet.ts             keypair laden, balansen
  feed/pumpportal.ts    websocket: nieuwe tokens, migraties, (trades)
  market/
    bondingCurve.ts     PDA, decoderen, prijs- en quote-wiskunde
    dexscreener.ts      DexScreener-client met rate limiting
    jupiter.ts          quotes, swaps, prijzen
    solPrice.ts         SOL/USD met cache en fallback
  core/
    tracker.ts          volgt tokens, pollt curve en DexScreener
    metrics.ts          berekent volume, prijsverandering, mcap, holders
    filters.ts          pure filterengine
    safety.ts           checks vóór aankoop
    exits.ts            pure exit-regels
    positions.ts        posities, prijsmonitor, verkoop + failsafe
    bot.ts              orchestrator: evalueren, risicolimieten, kopen
    stats.ts            statistieken en P&L-reeksen
  executor/             paper, Jupiter, PumpPortal, tx versturen/bevestigen
  api/server.ts         REST + websocket voor het dashboard
server/test/            unit tests (vitest)
web/                    React + Vite + Recharts dashboard
```

### API

| Methode | Pad | Doel |
|---|---|---|
| GET | `/api/state` | status, wallet, open posities, statistieken |
| GET/PUT | `/api/settings` | instellingen lezen/bijwerken (gedeeltelijke updates mogen) |
| POST | `/api/bot/start`, `/api/bot/stop` | bot starten/stoppen |
| POST | `/api/positions/sell-all` | noodknop |
| POST | `/api/positions/:id/sell` | één positie handmatig verkopen |
| GET | `/api/trades?mode=paper\|live\|all` | tradehistorie |
| GET | `/api/stats?range=24h\|7d\|all&mode=` | statistieken |
| GET | `/api/pnl?range=24h\|7d\|all&mode=` | cumulatieve P&L-reeks |
| GET | `/api/candidates` | gevolgde tokens + filterresultaten |
| WS | `/ws` | live state elke seconde |

## Testen en ontwikkelen

```bash
npm test            # unit tests: filters, exit-regels, curve-wiskunde, metrics, statistieken, instellingen
npm run typecheck   # TypeScript-controle
npm run dev         # server met auto-reload + Vite dev-server op http://localhost:5173
```

## Problemen oplossen

| Probleem | Oplossing |
|---|---|
| `ExperimentalWarning: SQLite is an experimental feature` | Onschuldig. Node meldt dit voor de ingebouwde SQLite. |
| `curve-poll mislukt (RPC)` of 429-fouten | De publieke RPC is overbelast. Neem een gratis Helius- of QuickNode-sleutel, of verlaag *Max. gevolgde tokens* en verhoog het poll-interval. |
| Geen kandidaten | Kijk in het tabblad *Kandidaten* welke filters falen. Vlak na het opstarten is er nog weinig data: DexScreener heeft een paar minuten nodig. |
| `rate limit geraakt` (Jupiter) | Gebruik een gratis Jupiter-sleutel (portal.jup.ag) met `JUPITER_API_URL=https://api.jup.ag`. |
| Paper mode-schakelaar grijs | Stop eerst de bot. Voor live: zet `LIVE_TRADING_ENABLED=true` en `PRIVATE_KEY` in `.env` en herstart. |
| Verkoop blijft mislukken | Kijk in de log naar de fout. De failsafe blijft het proberen. Controleer of de wallet genoeg SOL heeft voor fees. |

### RPC

Gratis opties: [Helius](https://helius.dev) (gratis tier met API-sleutel) en [QuickNode](https://quicknode.com). Zet de URL in `RPC_URL`. Een snelle RPC helpt vooral in live mode: transacties worden sneller verstuurd en bevestigd.

---

**Controleer regelmatig de actuele API-voorwaarden van PumpPortal, Jupiter en DexScreener.** Die veranderen vaak. Tijdens het bouwen van deze bot werd PumpPortal's trade-stream bijvoorbeeld betaald, en verdween de oude pump.fun frontend-API.
