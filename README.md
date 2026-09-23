# Tenor

**Bitget sells three ways to own the same US stock. They do not cost the same, and which is
cheapest changes with your size, the hour, and how long you hold.**

Tenor prices all three from live order books and tells you which one to use, in dollars.

Live: **https://tenor-desk.vercel.app**

---

## The problem

Hold NVDA on Bitget and you have three choices: a tokenized stock (`RNVDAUSDT`), a perpetual
future (`NVDAUSDT`), or Stock+. Every comparison you can find online compares headline fees.
None of them measures what it actually costs to get in and back out at your size, at the hour
you are trading, which is where most of the difference lives.

So we measured it.

## What we found

Continuous order book sampling on both legs of every tradeable ticker, every five minutes,
since 15 September. **146 tickers, 198,072 snapshots, 2,080 cycles** so far.

**Bitget publishes depth for fewer than half of these.** Of 146 tokenized stocks watched,
**77 returned no order book depth on any check** in eight days of sampling every five minutes.
They are live markets: all 77 show a best bid and ask on Bitget's ticker, 58 traded on
Bitget in the 24 hours we checked, and every one we spot-checked moved with the share price.
But with no published depth, nobody can know what a trade of any size will cost before
placing it. That includes Netflix, McDonald's, Exxon and SOXL.

**Size matters more than the fee schedule.** Coca-Cola's tokenized book costs 14bp to round
trip at $500 and 118bp at $50,000, more than eight times as much. A top-of-book spread would
have understated a $50,000 order by more than half.

**The hour matters, but not the way you would guess.** US market hours are cheapest for
**71% of tickers**, and for the deepest third it is 85%. The exceptions are real but tiny: when
something beats US hours it saves about a basis point, while trading at the wrong hour when
US hours wins costs a median of 13bp and up to 61bp. ABNB is $1.95 in US hours and $13.09
overnight, on $2,000. The asymmetry is the finding, not the exceptions.

**Depth is published all day or not at all.** No token with published depth in US hours loses
it overnight; the hour changes the cost, not whether it can be priced. The single exception
in eight days was MSFT, whose depth disappeared from Bitget's feed for two hours on the
morning of 21 September and then came back.

**Fees are measured, not assumed.** The spot rate comes from a real fill on a real account
(3.95bp, against the 10bp published rate), the perpetual rate from four NVDA fills that agree
to six decimal places (6.00bp, no discount). Spot and perpetual tiers are independent on
Bitget and neither is derivable from the other. Order numbers are in
[`engine/fees.ts`](engine/fees.ts) if you want to check.

## Track record

Every recommendation is written down the moment it is made, before the answer is knowable.
**38,496 logged so far.** Scored against the continuous sampling:

| If you acted | Checks | Typical miss on $2,000 | Still within $1.00 |
|---|---|---|---|
| 5 minutes later | 47,701 | $0.26 | 78.7% |
| 1 hour later | 46,952 | $0.40 | 71.2% |
| 4 hours later | 45,577 | $0.50 | 66.7% |

Median error is about zero at every lag, so the quotes are not biased, they simply age.
Replayed on later prices, 90% of recommendations still hold an hour later and 87% after four.
The calls that turned out wrong are listed in the app rather than hidden, and the 30 day
funding projections are **not scored**, because none has finished running.

## How it works

Four gates, answered in order. The first two decide, the last two adjust.

1. **Can it be priced at all?** Bitget publishes no depth for about half its tokenized
   stocks. Where it does not, the page says so rather than guessing or calling the market dead.
2. **At your size?** The book is walked for the requested amount. A route that cannot absorb
   your order is not an expensive option, it is not an option.
3. **At this hour?** Session medians from the sampled history, with a cheaper session named
   when one exists and the saving is worth acting on.
4. **For how long?** Only when execution is close enough that funding can decide it.

For large orders it also searches every split between the two wrappers, walking both live books
for each part's share, and recommends a split only when it saves at least a basis point and a
dollar. On live books, $100,000 of KO costs $980 through the perpetual alone and $854 split 78%
perpetual and 22% tokenized; at $2,000 no split helps, and the page says so.

Alongside the price it shows the share itself: its real price against the token's, and the next
dividend and earnings report, from Bitget's market data service. Future dates are projected from
each company's own past dates and labelled as projected.

The cost engine is **deterministic**. No model touches any number a user sees. An LLM reads
your sentence into the form fields and nothing else, which is stated on the page.

### Data sources

All public Bitget endpoints, no account required to run this:

- `v3/market/orderbook` for both legs, 150 levels, every five minutes
- `v3/market/history-fund-rate` for funding
- `v3/market/instruments` and `tickers` for the universe and volume screen
- Bitget's market data service (`bitget-mcp-server`) for share prices, dividends and earnings
  dates, one of the Agent Hub Skills
- Fees derived from five real fills, recorded with their order numbers

## Layout

| Directory | What it is |
|---|---|
| `engine/` | The cost engine. Deterministic, dependency free, 210 offline tests. |
| `sampler/` | Continuous order book sampler. Zero dependencies, plain `.mjs`. |
| `app/` | Vite + React front end. Static, calls Bitget directly from the browser. |
| `api/` | Two serverless functions: intent parsing, so the model key never reaches the browser, and share data from Bitget's market data service. |
| `ops/` | Backup, outlook builder, receipts scorer, session analysis. |
| `canary/` | The kill test that decided whether to build this at all. |

## Running it

Node 20 or later. The engine and sampler have **no dependencies** and no build step.

```bash
node engine/selftest.ts          # 210 tests, offline, no network
node engine/demo.ts              # price five tickers against live books
node sampler/sample.mjs --once   # one sampling cycle
node ops/receipts.mjs            # score the prediction log

cd app && npm install && npm run dev
```

The collectors run continuously in one container against a persistent volume
(`Dockerfile`, `ops/run-all.mjs`). Order book history cannot be backfilled, which is why
collection had to start before the product did.

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

The sampled history is days, not years. The app says so on every screen that uses it.

Whether Bitget passes dividends on through the tokenized stock or the perpetual, and whether
either can be used as collateral, is **unconfirmed**, so the app surfaces those as unknowns
rather than guessing.

---

Built for the Bitget AI Base Camp Hackathon S2, AI Trading Desk track.
