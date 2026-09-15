# Route flip test

One question, before anything gets built:

> For a plain long stock bet on Bitget, does the cheapest wrapper ever actually change?

If the rToken wins every time, there is nothing to recommend and Route is a static chart.
If the perp wins every time, same problem in reverse. The product only exists if the answer
is contested at horizons people actually hold.

## Run it

Node 20 or later. No runtime dependencies.

```bash
npm install          # dev tooling only (tsx, typescript)
npm run selftest     # offline: checks the math and parsing, prints a sample GO report
npm run run          # live: hits Bitget's public API, no account or key needed
```

Flags: `--spot-fee 0.001 --perp-fee 0.0006 --lookback 120 --max 20`

Writes `flip-test-report.txt` and `flip-test-raw.json`. Exit code 0 for GO, 2 for NO-GO,
1 for an error.

## What it does

1. Pulls spot and USDT-futures instruments plus tickers, finds rTokens (`isReality`, falling
   back to an R-prefixed base coin), and keeps the tickers that also have a perp. That
   intersection is the product's real reach, so check the count.
2. Drops crypto collisions. BCH is both Banco de Chile and Bitcoin Cash, and `BCHUSDT` is the
   crypto perp, so pairing them compares a bank to a coin. If the perp instruments carry a
   stock marker it is used; otherwise any ticker that is also a spot crypto is dropped.
3. Flags perps under 250K and rTokens under 50K of 24h quote volume as too thin to be a real
   route. They are reported separately and kept out of the verdict, because a perp nobody
   trades is not cheaper, it is untradeable.
4. Pulls funding rate history per perp, reading each symbol's funding interval from the
   instrument rather than assuming eight hours.
5. For each ticker and each day, estimates forward funding from the trailing 7 days only,
   then computes the crossover: `(rToken round trip fee - perp round trip fee) / daily funding`.
   Below it the perp is cheaper, above it the rToken is.
6. Scores each horizon on how often the perp wins, how often the recommendation changes, and
   whether the trailing estimate picked the same route hindsight would have.

## Reading the verdict

**GO** needs all three: a quarter of tickers with a median crossover between 1 and 60 days,
at least one horizon where the perp wins on 15 to 85 percent of days, and at least one
recommendation change in the sample.

**NO-GO** on any of: every crossover under a day (use the rToken, always), funding near zero
(use the perp, always), or a recommendation that never moves.

The **shortlist** at the top of the report is the answer that matters: liquid tickers whose
recommendation actually moved. That is the product's universe, and everything outside it has a
static answer.

Read the per-ticker crossover column next. Three numbers land the whole question: if p25,
median and p75 sit on top of each other, the answer is static even if it happens to fall in
a plausible range.

## What it does not model

Spreads, because Bitget exposes no historical orderbook. Also dividends, Stock+, collateral
value, slippage, and the funding-cap changes in March and June. Volume is a snapshot taken at
run time, not measured across the funding window. Every one of those favours
the rToken, so a NO-GO here is decisive. A GO still needs the full cost model before you
trust a number in front of a user.
