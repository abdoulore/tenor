# Tenor

**Bitget sells three ways to own the same US stock. They do not cost the same, and which is
cheapest changes with your size, the hour, and how long you hold.**

Tenor prices all three from what Bitget actually fills at, and tells you which one to use, in
dollars.

Live: **https://tenor-desk.vercel.app**

---

## The problem

Hold NVDA on Bitget and you have three choices: a tokenized stock (`RNVDAUSDT`), a perpetual
future (`NVDAUSDT`), or Stock+. Every comparison you can find online compares headline fees.
None of them measures what it actually costs to get in and back out at your size, at the hour
you are trading, which is where most of the difference lives.

So we measured it.

## What we found

Every tokenized stock Bitget lists with a matching perpetual, **148 names**, sampled every five
minutes since 15 September: **203,330 snapshots** of the order book, the quote, and the
perpetual.

**A tokenized stock fills at Bitget's quote, not its order book.** Bitget publishes two prices
for a tokenized stock: the order book, and the ticker's best bid and ask. They often disagree;
on 23 September the rNVDA book sat 0.7% away from the ticker for over half an hour. We placed
live market orders to find out which one fills. Bitget routed all four through StockRoute, and
all four filled within 1.5bp of the ticker's quote. On rNVDA the buy filled 5.35bp better than
the book's ask; on rBA the book was empty. Order numbers, fills, and the quote and book
readings either side of each fill are in [`engine/evidence.ts`](engine/evidence.ts) and on the
app's track record page.

**Pricing the right one changes the answer.** On a $2,000 round trip, counting trading costs
only, the order book makes the perpetual look cheaper in 53% of comparisons. Priced from the
quote, it is 1%. The book overstates the tokenized stock's cost by a median 11.2bp. Tenor
prices the tokenized stock from the quote, and the perpetual from its order book, which is what
futures trade against.

**Every listed name can be priced.** Bitget publishes no order book depth for about half its
tokenized stocks, but every one has a quote, and the quote is what fills.

**The quote shows how much is on offer.** The median name shows about $4,700 at its best price,
and 70% can take a $2,000 round trip at the quote. Larger orders are split: as much as the quote
covers goes to the tokenized stock, the rest to the perpetual.

**Fees are measured, not assumed.** The spot rate comes from real fills on a live account
(3.95bp on rGOOGL and 4.00bp on each of the four test orders, paid in BGB, against the 10bp
published rate), the perpetual rate from four NVDA fills that agree to six decimal places
(6.00bp, no discount). Spot and perpetual tiers are independent on Bitget and neither is
derivable from the other. Order numbers are in [`engine/fees.ts`](engine/fees.ts).

## Track record

Every recommendation is written down the moment it is made, before the answer is knowable, and
scored against the continuous sampling. The record covers every call made with the tokenized
stock priced from its quote, since 23 September; **720 so far**, growing by about 290 an hour.

| If you acted | Checks | Typical miss on $2,000 | Still within $1.00 |
|---|---|---|---|
| 5 minutes later | 1,035 | $0.18 | 84.6% |
| 1 hour later | 627 | $0.17 | 82.6% |

Median error is about zero at every lag, so the quotes are not biased. Replayed on prices an
hour later, 100% of recommendations still hold. Funding forecasts run 30 days and are scored
as they complete. The live figures are on the app's track record page.

## How it works

Four gates, answered in order. The first two decide, the last two adjust.

1. **Can it be priced at all?** Is there a two sided price to trade at: Bitget's quote for the
   tokenized stock, the order book for the perpetual.
2. **At your size?** The quote or the book is walked for the requested amount. A route that
   cannot absorb your order is not an expensive option, it is not an option.
3. **At this hour?** Session medians from the sampled history (the tokenized stock's from its
   quote, recorded since 23 September), with a cheaper session named
   when one exists and the saving is worth acting on.
4. **For how long?** Only when execution is close enough that funding can decide it.

For large orders it also searches every split between the two wrappers, pricing each part's
share from the quote and the book, and recommends a split only when it saves at least a basis
point and a dollar. On 23 September, for $100,000 of KO held three months, it put $14,000 through the tokenized
stock and $86,000 through the perpetual, saving $163 against the perpetual alone. At $2,000 of
NVDA no split helps.

Alongside the price it shows the share itself: its real price against the token's, and the next
dividend and earnings report, from Bitget's market data service. Future dates are projected from
each company's own past dates and labelled as projected.

The cost engine is **deterministic**. No model works out any number a user sees. Claude
Sonnet 5 does two things: reads a sentence into the form fields, and explains each result in
two or three sentences and answers questions about it. For the explanation, the engine writes a
fact sheet of every figure on the page, and the model may only use figures from it. The page
then checks every number in the answer against the sheet. An answer with a figure the engine
did not produce is sent back once with that figure named, and withheld if it fails again. In
testing, asked what the two fees add up to, the model wrote a total the engine had never
computed; the check caught it and the retry answered without it. A question that needs a new
figure, such as "what if I held three months", comes back as a request to price again, and the
engine prices it.

### Data sources

All public Bitget endpoints, no account required to run this:

- `v3/market/orderbook`, 150 levels, every five minutes: the perpetual's prices, and the
  tokenized stock's book kept alongside its quote as a comparison
- `v3/market/history-fund-rate` for funding
- `v3/market/instruments` and `tickers` for the universe and volume screen
- Bitget's market data service (`bitget-mcp-server`) for share prices, dividends and earnings
  dates, one of the Agent Hub Skills
- `v3/market/tickers` for each tokenized stock's quote: best bid and ask with their sizes,
  every five minutes, which is what its orders fill at
- Fees derived from nine real fills on a live account

## Layout

| Directory | What it is |
|---|---|
| `engine/` | The cost engine. Deterministic, dependency free, 240 offline tests. |
| `sampler/` | Continuous order book and quote sampler. Zero dependencies, plain `.mjs`. |
| `app/` | Vite + React front end. Static, calls Bitget directly from the browser. |
| `api/` | Three serverless functions: intent parsing and questions about a result, so the model key never reaches the browser, and share data from Bitget's market data service. |
| `ops/` | Backup, outlook builder, receipts scorer, session analysis. |
| `canary/` | The kill test that decided whether to build this at all. |

## Running it

Node 20 or later. The engine and sampler have **no dependencies** and no build step.

```bash
node engine/selftest.ts          # 240 tests, offline, no network
node engine/demo.ts              # price five tickers against live prices
node sampler/sample.mjs --once   # one sampling cycle
node ops/receipts.mjs            # score the prediction log

cd app && npm install && npm run dev
```

The collectors run continuously in one container against a persistent volume
(`Dockerfile`, `ops/run-all.mjs`).

## Deliberately out of scope

**Options.** Not economically equivalent to holding, so comparing them on cost would need a
strategy equivalence layer rather than another column.

**CFDs.** They price financing as an asymmetric swap rate rather than funding, and their
indices overlap SPY, QQQ and DIA. Different instrument, different comparison.

**Stock+ execution.** Bitget publishes no reachable order book for it, so its fee is shown and
its execution cost is not. It is excluded from the ranking rather than competing on a total
that omits the expensive half.

## What this does not do

It does not predict prices, propose a strategy, or have a Sharpe ratio. It measures what
trading costs and which wrapper is cheapest. Those are different jobs.

Dividend treatment and collateral use for each wrapper follow Bitget's terms, so the app flags
them for the user to check rather than assuming either way.

---

Built for the Bitget AI Base Camp Hackathon S2, AI Trading Desk track.
