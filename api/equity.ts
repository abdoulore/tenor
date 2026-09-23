/**
 * Share facts from Bitget's own market data service, bitget-mcp-server.
 *
 * The service speaks MCP over HTTP and does not answer browser preflight requests, so the page
 * cannot call it directly. This function does, and returns only what the page needs: the real
 * share price, past dividends and past earnings dates.
 *
 * No key is involved and the data is free, so the risk here is load rather than cost. Responses
 * are cached at the edge for ten minutes per symbol, and there is a per-address limit on top.
 */

const MCP_URL = "https://agent.bitget.com/mcp";
const SOURCE = "Bitget market data service (bitget-mcp-server)";
const WINDOW_MS = 60_000;
const PER_ADDRESS = 30;
const hits = new Map<string, number[]>();

type Req = { method?: string; query?: Record<string, string | string[] | undefined>; headers?: Record<string, string | string[] | undefined> };
type Res = {
  status: (code: number) => Res;
  json: (body: unknown) => void;
  setHeader: (k: string, v: string) => void;
};

function underLimit(address: string, now: number): boolean {
  const mine = (hits.get(address) ?? []).filter((t) => now - t < WINDOW_MS);
  if (mine.length >= PER_ADDRESS) { hits.set(address, mine); return false; }
  mine.push(now);
  hits.set(address, mine);
  if (hits.size > 5_000) hits.clear();
  return true;
}

/** One MCP session: initialise, then run each catalogue query through `do_query`. */
async function mcpSession() {
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  let sid: string | null = null;
  let id = 1;

  const rpc = async (body: Record<string, unknown>) => {
    const res = await fetch(MCP_URL, {
      method: "POST",
      headers: sid ? { ...headers, "mcp-session-id": sid } : headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(12_000),
    });
    sid = res.headers.get("mcp-session-id") ?? sid;
    const text = await res.text();
    const line = text.split("\n").find((l) => l.startsWith("data: "));
    return line ? JSON.parse(line.slice(6)) : null;
  };

  await rpc({
    jsonrpc: "2.0", id: id++, method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "tenor", version: "1" } },
  });
  await rpc({ jsonrpc: "2.0", method: "notifications/initialized" });

  return async (entry_id: string, params: Record<string, unknown>) => {
    const out = await rpc({ jsonrpc: "2.0", id: id++, method: "tools/call", params: { name: "do_query", arguments: { entry_id, params } } });
    const text = out?.result?.content?.map((c: { text?: string }) => c.text ?? "").join("") ?? "";
    try {
      const parsed = JSON.parse(text);
      return Array.isArray(parsed?.data?.results) ? parsed.data.results : [];
    } catch {
      return [];
    }
  };
}

export default async function handler(req: Req, res: Res): Promise<void> {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const symbol = String(one(req.query?.symbol) ?? "").toUpperCase().replace(/[^A-Z.]/g, "").slice(0, 8);
  if (!symbol) {
    res.status(400).json({ error: "symbol required" });
    return;
  }

  const address = (one(req.headers?.["x-forwarded-for"]) ?? "").split(",")[0].trim() || "unknown";
  if (!underLimit(address, Date.now())) {
    res.status(429).json({ error: "too many requests" });
    return;
  }

  try {
    const query = await mcpSession();
    const [quote, dividends, calendar] = await Promise.all([
      query("equity_price_quote", { symbol }),
      query("equity_fundamental_dividends", { symbol }),
      query("equity_calendar", { symbol }),
    ]);

    const q = quote[0];
    const body = {
      symbol,
      price: q && Number(q.last_price) > 0
        ? { last: Number(q.last_price), prevClose: Number(q.prev_close) || null }
        : null,
      dividends: (dividends as Record<string, unknown>[])
        .filter((d) => d.ex_dividend_date && Number(d.amount) > 0 && String(d.is_special_dividend ?? "0") === "0")
        .map((d) => ({ exDate: String(d.ex_dividend_date).slice(0, 10), amount: Number(d.amount) })),
      earnings: [...new Set((calendar as Record<string, unknown>[])
        .map((c) => c.perf_report_dsclsr_date ?? c.perf_brief_dsclsr_date ?? c.perf_briefing_fore_dsclsr_date)
        .filter((d): d is string => typeof d === "string" && d.length >= 10)
        .map((d) => d.slice(0, 10)))]
        .sort((a, b) => (a < b ? 1 : -1)),
      source: SOURCE,
      fetchedAt: new Date().toISOString(),
    };

    res.setHeader("cache-control", "public, s-maxage=600, stale-while-revalidate=300");
    res.status(200).json(body);
  } catch (e) {
    res.status(502).json({ error: "market data service unavailable", detail: String((e as Error)?.message ?? e).slice(0, 160) });
  }
}
