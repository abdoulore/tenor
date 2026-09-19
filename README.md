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
since 15 September. **133 tickers, 99,637 snapshots, 1,101 cycles** so far.

**Half of these markets do not exist.** Of 133 tokenized stocks watched, **65 have never
quoted a price** in any session. Not a wide spread, no market at all. That includes Netflix,
McDonald's, Lilly, Exxon, GE, Uber and Boeing. Bitget lists them. Nobody trades them.

**Size matters more than the fee schedule.** Coca-Cola's tokenized book costs 22bp to round
trip at $500 and 116bp at $50,000. Quoting a top-of-book spread would have understated a
$50,000 order by more than half.

**The hour matters, but not the way you would guess.** US market hours are cheapest for
**78% of tickers**, and for the deepest third it is 84%. The exceptions are real but tiny: when
something beats US hours it saves about a basis point, while trading at the wrong hour when
US hours wins costs a median of 14bp and up to 108bp. ABNB is $1.91 in US hours and $23.61
overnight, on $2,000. The asymmetry is the finding, not the exceptions.

**Fees are measured, not assumed.** The spot rate comes from a real fill on a real account
(3.95bp, against the 10bp published rate), the perpetual rate from four NVDA fills that agree
to six decimal places (6.00bp, no discount). Spot and perpetual tiers are independent on
Bitget and neither is derivable from the other. Order numbers are in
[`engine/fees.ts`](engine/fees.ts) if you want to check.

## Track record

Every recommendation is written down the moment it is made, before the answer is knowable.
**13,728 logged so far.** Scored against the continuous sampling:

| If you acted | Checks | Typical miss on $2,000 | Still within $1.00 |
|---|---|---|---|
| 5 minutes later | 17,372 | $0.18 | 84.8% |
| 1 hour later | 16,712 | $0.29 | 78.2% |
| 4 hours later | 15,236 | $0.39 | 73.6% |

Median error is about zero at every lag, so the quotes are not biased, they simply age.
The calls that turned out wrong are listed in the app rather than hidden, and the 30 day
funding projections are **not scored**, because none has finished running.

## How it works

Four gates, answered in order. The first two decide, the last two adjust.

1. **Can you trade it at all?** An empty book means untradeable, not expensive.
2. **At your size?** The book is walked for the requested amount. A route that cannot absorb
   your order is not an expensive option, it is not an option.
3. **At this hour?** Session medians from the sampled history, with a cheaper session named
   when one exists and the saving is worth acting on.
4. **For how long?** Only when execution is close enough that funding can decide it.

The cost engine is **deterministic**. No model touches any number a user sees. An LLM reads
your sentence into the form fields and nothing else, which is stated on the page.

### Data sources

All public Bitget endpoints, no account required to run this:

- `v3/market/orderbook` for both legs, 150 levels, every five minutes
- `v3/market/history-fund-rate` for funding
- `v3/market/instruments` and `tickers` for the universe and volume screen
- Fees derived from five real fills, recorded with their order numbers

## Layout

| Directory | What it is |
|---|---|
| `engine/` | The cost engine. Deterministic, dependency free, 175 offline tests. |
| `sampler/` | Continuous order book sampler. Zero dependencies, plain `.mjs`. |
| `app/` | Vite + React front end. Static, calls Bitget directly from the browser. |
| `api/` | One serverless function, so the model key never reaches the browser. |
| `ops/` | Backup, outlook builder, receipts scorer, session analysis. |
| `canary/` | The kill test that decided whether to build this at all. |

## Running it

Node 20 or later. The engine and sampler have **no dependencies** and no build step.

```bash
node engine/selftest.ts          # 175 tests, offline, no network
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

Dividend and collateral treatment for tokenized stocks on Bitget are **unconfirmed**, so the
app surfaces that as an unknown rather than guessing.

---

Built for the Bitget AI Base Camp Hackathon S2, AI Trading Desk track.
