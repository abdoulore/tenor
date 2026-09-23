/**
 * Monitor: positions you already hold, and whether to move them.
 *
 * Positions are entered by hand. Bitget's Agent Hub does not cover stock spot and Stock+ has
 * no reachable API, so there is no honest way to read a real portfolio. Saying so is better
 * than pretending to sync.
 *
 * Stored in the browser only. Nothing here is sent anywhere.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { analysePosition, daysRemaining, type Position, type SwitchAnalysis } from "../../engine/monitor.ts";
import { fetchBook, fetchFunding, fetchQuote, resolvePair } from "../../engine/bitget.ts";
import type { Book } from "../../engine/types.ts";
import type { Settlement } from "../../engine/funding.ts";
import type { TickerGroups } from "./IntentControls.tsx";
import { Combobox } from "./Combobox.tsx";

const STORE_KEY = "tenor.positions.v1";

const VERDICT: Record<string, { title: string; tone: string }> = {
  switch: { title: "Worth moving", tone: "act" },
  stay: { title: "Stay put", tone: "ok" },
  not_worth_it: { title: "Not worth moving", tone: "ok" },
  stuck: { title: "Cannot be priced", tone: "muted" },
  unknown: { title: "Cannot tell", tone: "muted" },
};

const ROUTE_WORD: Record<string, string> = {
  rtoken: "tokenized stock",
  perp: "perpetual",
  stockplus: "Stock+",
};

function load(): Position[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // A corrupt or blocked store must not take the page down.
    return [];
  }
}

function save(positions: Position[]): void {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(positions)); } catch { /* private mode */ }
}

export function Monitor({ groups }: { groups: TickerGroups }) {
  const [positions, setPositions] = useState<Position[]>(() => load());
  const [analyses, setAnalyses] = useState<Record<string, SwitchAnalysis>>({});
  const [checking, setChecking] = useState(false);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const today = new Date().toISOString().slice(0, 10);
  const [form, setForm] = useState({
    ticker: "",
    route: "perp" as Position["route"],
    direction: "long" as Position["direction"],
    notionalUsd: null as number | null,
    horizonDays: 30,
    openedOn: today,
  });

  useEffect(() => { save(positions); }, [positions]);

  const check = useCallback(async (list: Position[]) => {
    if (!list.length) { setAnalyses({}); return; }
    setChecking(true);
    setError(null);
    const out: Record<string, SwitchAnalysis> = {};
    try {
      // One fetch per ticker, however many positions share it.
      const tickers = [...new Set(list.map((p) => p.ticker))];
      const market = new Map<string, { books: Partial<Record<string, Book>>; funding: Settlement[]; interval: number }>();

      for (const t of tickers) {
        const pair = await resolvePair(t);
        if (!pair) continue;
        const [spot, perp, fund] = await Promise.all([
          fetchQuote(pair.spotSymbol).catch(() => ({ asks: [], bids: [], ts: null, source: "quote" }) as Book),
          fetchBook("USDT-FUTURES", pair.perpSymbol).catch(() => ({ asks: [], bids: [], ts: null }) as Book),
          fetchFunding(pair.perpSymbol).catch(() => [] as Settlement[]),
        ]);
        market.set(t, {
          books: { rtoken: spot, perp },
          funding: fund,
          interval: pair.fundingIntervalHours,
        });
      }

      for (const p of list) {
        const m = market.get(p.ticker);
        if (!m) continue;
        out[p.id] = analysePosition(p, {
          books: m.books as Partial<Record<Position["route"], Book>>,
          funding: m.funding,
          fundingIntervalHours: m.interval,
        });
      }
      setAnalyses(out);
      setCheckedAt(Date.now());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => { void check(positions); /* on mount and whenever the list changes */ },
    [positions, check]);

  const ready = Boolean(form.ticker && form.notionalUsd && form.openedOn <= today);
  const add = () => {
    if (!ready) return;
    /*
     * The opening date matters: someone who bought a month ago has a month less funding to
     * pay than someone buying today, and the switch arithmetic only counts what is left.
     */
    const opened = new Date(`${form.openedOn}T12:00:00Z`);
    const p: Position = {
      id: `${form.ticker}-${Date.now()}`,
      ticker: form.ticker,
      // A short can only be held on the perpetual.
      route: form.direction === "short" ? "perp" : form.route,
      notionalUsd: form.notionalUsd!,
      direction: form.direction,
      openedAt: opened.toISOString(),
      horizonDays: form.horizonDays,
    };
    setPositions((prev) => [...prev, p]);
    setForm((f) => ({ ...f, ticker: "", notionalUsd: null, openedOn: today }));
  };

  const remove = (id: string) => setPositions((prev) => prev.filter((p) => p.id !== id));

  const money = (bp: number, notional: number) => `$${Math.abs((bp / 10_000) * notional).toFixed(2)}`;
  const toMove = useMemo(
    () => Object.values(analyses).filter((a) => a.verdict === "switch").length,
    [analyses],
  );
  const stuck = useMemo(
    () => Object.values(analyses).filter((a) => a.verdict === "stuck").length,
    [analyses],
  );

  return (
    <section className="monitor">
      <h2>Positions you already hold</h2>
      <p className="sub">
        Entered by hand and kept in this browser. Nothing is sent anywhere.
      </p>

      <div className="addpos">
        <div className="addpos-ticker">
          <Combobox
            value={form.ticker}
            placeholder="Type a ticker"
            onChange={(t) => setForm((f) => ({ ...f, ticker: t }))}
            groups={[
              { label: `Watched every five minutes (${groups.tradeable.length})`, items: groups.tradeable },
              { label: `Priced live, no history yet (${groups.untracked.length})`, items: groups.untracked, suffix: "no history", tone: "warn" },
            ]}
          />
        </div>
        <select
          value={form.direction}
          onChange={(e) => {
            const direction = e.target.value as Position["direction"];
            setForm((f) => ({ ...f, direction, route: direction === "short" ? "perp" : f.route }));
          }}
          aria-label="Direction"
        >
          <option value="long">Long</option>
          <option value="short">Short</option>
        </select>
        <select
          value={form.route}
          onChange={(e) => setForm((f) => ({ ...f, route: e.target.value as Position["route"] }))}
          aria-label="What you hold"
        >
          <option value="perp">in the perpetual</option>
          <option value="rtoken" disabled={form.direction === "short"}>in the tokenized stock</option>
        </select>
        <div className="amount addpos-amount">
          <span className="prefix">$</span>
          <input
            type="text"
            inputMode="numeric"
            autoComplete="off"
            aria-label="How much"
            placeholder="Amount"
            value={form.notionalUsd === null ? "" : form.notionalUsd.toLocaleString()}
            onChange={(e) => {
              const digits = e.target.value.replace(/[^\d.]/g, "");
              const n = Number(digits);
              setForm((f) => ({ ...f, notionalUsd: digits === "" || !Number.isFinite(n) || n <= 0 ? null : n }));
            }}
          />
        </div>
        <label className="addpos-date">
          opened
          <input
            type="date"
            value={form.openedOn}
            max={today}
            onChange={(e) => setForm((f) => ({ ...f, openedOn: e.target.value || today }))}
          />
        </label>
        <select
          value={form.horizonDays}
          onChange={(e) => setForm((f) => ({ ...f, horizonDays: Number(e.target.value) }))}
          aria-label="Planned holding period"
        >
          {[7, 14, 30, 90, 365].map((d) => (
            <option key={d} value={d}>held for {d === 365 ? "a year" : `${d} days`}</option>
          ))}
        </select>
        <button onClick={add} disabled={!ready}>Add</button>
      </div>

      {positions.length > 0 && (
        <div className="monitor-head">
          <span>
            {positions.length} position{positions.length > 1 ? "s" : ""}
            {toMove > 0 && <strong className="act"> · {toMove} worth moving</strong>}
            {stuck > 0 && <strong className="dead"> · {stuck} cannot be priced</strong>}
          </span>
          <button className="recheck" onClick={() => void check(positions)} disabled={checking}>
            {checking ? "Checking" : "Check again"}
          </button>
          {checkedAt && !checking && (
            <span className="when">
              checked at {new Date(checkedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </span>
          )}
        </div>
      )}

      {error && <p className="caveat">Could not reach Bitget: {error}</p>}

      {positions.length === 0 && (
        <p className="sub">
          Add a position above and this will watch it, then tell you if moving it would save
          more than moving costs, or that staying put is cheaper.
        </p>
      )}

      {positions.map((p) => {
        const a = analyses[p.id];
        const v = VERDICT[a?.verdict ?? "unknown"];
        const left = daysRemaining(p);
        return (
          <div key={p.id} className={`position ${v.tone}`}>
            <div className="pos-head">
              <strong>{p.ticker}</strong>
              <span className="pos-what">
                ${p.notionalUsd.toLocaleString()} {p.direction === "short" ? "short " : ""}in the {ROUTE_WORD[p.route]}
              </span>
              <span className={`badge ${v.tone}`}>{v.title}</span>
              <button className="drop" onClick={() => remove(p.id)} aria-label={`Remove ${p.ticker}`}>
                remove
              </button>
            </div>
            <div className="pos-meta">
              {left > 0 ? `${left.toFixed(0)} of ${p.horizonDays} days left` : "past your planned holding period"}
              {" · opened "}{p.openedAt.slice(0, 10)}
            </div>
            {a ? (
              <>
                <p className="pos-msg">{a.message}</p>
                {a.switchCostBp !== null && a.netSavingBp !== null && (
                  <div className="pos-sums">
                    <span>Moving costs {money(a.switchCostBp, p.notionalUsd)} today</span>
                    <span>
                      {a.netSavingBp.mid >= 0 ? "Saves" : "Loses"}{" "}
                      {money(a.netSavingBp.mid, p.notionalUsd)} over the days left
                    </span>
                    {Math.abs(a.netSavingBp.high - a.netSavingBp.low) > 0.01 && (
                      <span className="band">
                        anywhere from {money(a.netSavingBp.low, p.notionalUsd)} to{" "}
                        {money(a.netSavingBp.high, p.notionalUsd)}, because funding is a forecast
                      </span>
                    )}
                  </div>
                )}
              </>
            ) : (
              <p className="pos-msg dim">{checking ? "Checking Bitget" : "No reading yet"}</p>
            )}
          </div>
        );
      })}
    </section>
  );
}
