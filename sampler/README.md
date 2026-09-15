# Tenor spread sampler

The flip test could not price spreads, because Bitget publishes no historical orderbook.
That is the single largest risk to the product and the only way to close it is to start
collecting now, because orderbook history cannot be backfilled. This is that collector.

Zero dependencies. Node 20 or later for built in `fetch`.

```bash
node sample.mjs --selftest   # offline maths check, no network
node sample.mjs --once       # one cycle, then exit
node sample.mjs              # run forever
node summarize.mjs           # read what has been collected so far
```

Flags: `--interval 300000 --gap 70 --data ./data`. Environment equivalents:
`SAMPLE_INTERVAL_MS`, `REQUEST_GAP_MS`, `DATA_DIR`.

## What it collects

Every 5 minutes, for every tradeable ticker, both legs:

- rToken spot, for example `RNVDAUSDT`
- USDT perp, for example `NVDAUSDT`

Endpoint for both, one shape:

```
GET /api/v3/market/orderbook?category={SPOT|USDT-FUTURES}&symbol={SYMBOL}&limit=150
```

Requests are throttled to one per 70ms against a documented limit of 20 per second per IP.
At 97 tickers that is 194 requests and about 50 seconds per cycle, so the 5 minute cadence
has roughly 4 minutes of headroom.

## Depth, not top of book

A tight best bid and ask means nothing if it is only good for $100, and the whole cost gap
Tenor measures is 8bp. So each leg records what it actually costs to fill a real position:
the book is walked for **$2,000** and **$10,000**, on both sides, and the volume weighted
fill price is compared to the mid.

Per leg, per size:

| Field | Meaning |
|---|---|
| `buyBp` | cost of buying that size, in bp against the mid, walking the asks |
| `sellBp` | cost of selling that size, walking the bids |
| `roundTripBp` | `buyBp + sellBp`, the full execution cost of entering and exiting |
| `buyFilledUsd` / `sellFilledUsd` | what the book could actually absorb |
| `exhausted` | true when the book could not fill the size |

When the book cannot fill the size, `buyBp` is **null**, never a cheap looking number taken
from the part that did fill. What filled is still recorded, so thin books are measurable
rather than merely absent.

The headline derived field is `gapBp`, the rToken round trip minus the perp round trip at
each size. It is in the same units as the 8bp fee gap the flip test rested on, so the two
are directly comparable.

## Sessions

Each record carries a `session` label computed in America/New_York, because rToken depth is
expected to differ sharply outside US market hours and that difference is one of the things
this exists to measure.

`regular` 09:30 to 16:00, `premarket` 04:00 to 09:30, `afterhours` 16:00 to 20:00,
`overnight` otherwise on a weekday, `weekend` Saturday and Sunday.

Market holidays are **not** handled, so a holiday reads as `regular`. Worth correcting
before any finding is published.

## Empty books are data, not errors

Many rTokens quote nothing at all outside US market hours. The endpoint returns success
with zero levels. That means the route is untradeable rather than expensive, which is a
different and stronger finding, so it is recorded as `empty: true` and counted separately
from fetch failures in `status.json`.

## Universe

Resolved live each run and refreshed every 6 hours, reusing the flip test's logic from
`canary/flip-test.ts`: rToken detection, the crypto collision filter, and the same volume
floors, so the sampled set stays comparable to the scored set.

Two corrections the live API forced, both departures from the flip test:

1. **Commodities are excluded.** Perp instruments now carry `symbolType` reading `stock`,
   `commodity` or `crypto`. `CLUSDT` and `BZUSDT` are crude oil, not Colgate, and both
   carry `isRwa=YES`. A stock wrapper product has nothing to say about them.
2. **Some collisions are recovered.** `RIOUSDT`, `VALEUSDT` and `HPQUSDT` carry
   `isRwa=YES` with `symbolType=crypto`, which looks like a Bitget mislabel, but `isRwa`
   settles it and they are real stocks. `BCHUSDT`, `TUSDT` and `DASHUSDT` are `isRwa=NO`
   and stay excluded, which is what the flip test wanted.

Eight named thin tickers are sampled as a **control**, so depth on thin names can be
compared against the liquid set rather than assumed.

`universe.json` records the resolved set each refresh, including drift against the 88
tickers the flip test judged liquid.

### A volume field that does not mean what it looks like

For an rToken, `turnover24h` carries the underlying's global figure and runs into the
billions, so screening the rToken leg on it passes everything and the flip test's 50K spot
floor never actually bound. `platformTurnover24h` is Bitget's own book and is the number
that decides whether the rToken leg is tradeable.

Both are recorded per pair. The screen deliberately still uses the flip test's fields, so
the universe does not silently change mid study. Revisit once there is enough data to set
an honest floor.

## Output

`data/samples-YYYY-MM-DD.ndjson`, one JSON record per ticker per cycle. Roughly 97 records
per cycle, 28,000 a day, on the order of 20MB a day.

Also written: `data/status.json` after every cycle, and `data/universe.json` on every
universe refresh.

## Deploying

The sampler has to survive overnight and the weekend, and off hours rToken depth is the
case most worth measuring, so it belongs on a host rather than a laptop.

Railway, from inside `sampler/`:

```bash
railway login
railway init
railway up
```

`railway.json` sets the start command and `restartPolicyType: ALWAYS`.

**Attach a volume before trusting it.** Railway containers have an ephemeral filesystem, so
a redeploy or a restart loses everything collected. Mount a volume and point `DATA_DIR` at
it, for example `/data`. Without that the deployment quietly discards the one thing here
that cannot be recollected.
