/**
 * The result in plain words, and questions about it.
 *
 * Every priced result gets a short explanation, and the reader can ask about it: "what if I held
 * three months", "what about at 3am", "why is the perpetual cheaper". The model answers from a
 * fact sheet the engine wrote (engine/grounding.ts), or asks for the result to be priced again
 * with something changed, in which case the engine prices it and the new result is explained.
 *
 * Before anything the model wrote is shown, every number in it is checked against the fact
 * sheet. One figure the engine did not produce and the answer is sent back once, with the
 * offending figures named. If the second answer fails too, it is withheld and the page says so.
 */

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { plainText, ungroundedNumbers, type FactSheet } from "../../engine/grounding.ts";
import type { Direction, Intent } from "../../engine/types.ts";
import type { DraftPatch } from "./IntentControls.tsx";

type Turn = { q: string; a: string };
type Changes = { ticker?: string; notionalUsd?: number; horizonDays?: number; direction?: Direction; leverage?: number };
type Outcome =
  | { kind: "answer"; text: string }
  | { kind: "reprice"; changes: Changes }
  | { kind: "withheld" }
  | { kind: "busy" }
  | { kind: "unavailable" };

type Entry = {
  id: number;
  /** The reader's question. Absent for an explanation of a freshly priced result. */
  q?: string;
  /** What the explanation is about, so an older one in the list is never mistaken for current. */
  about?: string;
  state: "loading" | "answer" | "repriced" | "withheld" | "busy" | "unavailable";
  text?: string;
};

const MAX_ENTRIES = 8;

async function callAsk(body: { facts: string; question: string; history: Turn[]; rejected: string[] }) {
  const res = await fetch("/api/ask", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 429) return { kind: "busy" as const };
  if (!res.ok) return { kind: "unavailable" as const };
  return (await res.json()) as { kind: "answer"; text: string } | { kind: "reprice"; changes: Changes };
}

/** Ask, check the answer against the sheet, and send it back once if a figure cannot be traced. */
async function grounded(sheet: FactSheet, question: string, history: Turn[]): Promise<Outcome> {
  let rejected: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    let r;
    try {
      r = await callAsk({ facts: sheet.text, question, history, rejected });
    } catch {
      return { kind: "unavailable" };
    }
    if (r.kind !== "answer") return r;
    const text = plainText(r.text);
    const bad = ungroundedNumbers(text, sheet, question);
    if (!bad.length) return { kind: "answer", text };
    rejected = bad;
  }
  return { kind: "withheld" };
}

/**
 * The model's requested change, limited to values the controls could hold. Anything outside
 * that is dropped rather than corrected, so the engine only ever prices something a person
 * could have entered by hand.
 */
function toPatch(c: Changes, tickers: string[], now: Intent): { patch: DraftPatch; words: string[] } {
  // The model often repeats fields that are not changing. Only a real change is applied or named.
  const patch: DraftPatch = {};
  const words: string[] = [];
  const t = typeof c.ticker === "string" ? c.ticker.toUpperCase().trim() : "";
  if (t && t !== now.ticker && tickers.includes(t)) { patch.ticker = t; words.push(t); }
  if (typeof c.notionalUsd === "number" && c.notionalUsd >= 100 && c.notionalUsd <= 10_000_000 &&
      Math.round(c.notionalUsd) !== now.notionalUsd) {
    patch.notionalUsd = Math.round(c.notionalUsd);
    words.push(`$${patch.notionalUsd.toLocaleString()}`);
  }
  if (typeof c.horizonDays === "number" && c.horizonDays >= 1 && c.horizonDays <= 3650 &&
      Math.round(c.horizonDays) !== now.horizonDays) {
    patch.horizonDays = Math.round(c.horizonDays);
    words.push(`held ${patch.horizonDays} ${patch.horizonDays === 1 ? "day" : "days"}`);
  }
  if ((c.direction === "long" || c.direction === "short") && c.direction !== now.direction) {
    patch.direction = c.direction;
    patch.constraints = { ...patch.constraints, needsShort: c.direction === "short" };
    words.push(c.direction === "short" ? "short" : "long");
  }
  if (typeof c.leverage === "number" && c.leverage >= 1 && c.leverage <= 125 && c.leverage !== now.constraints.leverage) {
    patch.constraints = { ...patch.constraints, leverage: c.leverage };
    words.push(`${c.leverage}x leverage`);
  }
  return { patch, words };
}

export function Conversation({
  sheet, current, sig, about, ready, tickers, onReprice, children,
}: {
  /** The fact sheet for the result on screen now. */
  sheet: FactSheet;
  /** What is priced now, so a reprice names only what it changes. */
  current: Intent;
  /** Changes whenever there is a new result to explain: a new intent or a fresh read of prices. */
  sig: string;
  about: string;
  /** False while data the sheet depends on is still arriving. */
  ready: boolean;
  tickers: string[];
  onReprice: (patch: DraftPatch) => void;
  children?: ReactNode;
}) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [text, setText] = useState("");
  const nextId = useRef(1);
  const sheetRef = useRef(sheet);
  sheetRef.current = sheet;
  const explainedFor = useRef<string | null>(null);
  const [asking, setAsking] = useState(false);

  const add = (e: Omit<Entry, "id">) => {
    const id = nextId.current++;
    setEntries((prev) => [...prev, { ...e, id }].slice(-MAX_ENTRIES));
    return id;
  };
  const settle = (id: number, patch: Partial<Entry>) =>
    setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, ...patch } : e)));

  // The last few exchanges, explanations included, so "why?" has something to refer to.
  const history = (): Turn[] =>
    entries
      .filter((e) => e.state === "answer" && e.text)
      .slice(-3)
      .map((e) => ({ q: e.q ?? "Explain this result.", a: e.text! }));

  const show = (id: number, out: Outcome) => {
    if (out.kind === "answer") settle(id, { state: "answer", text: out.text });
    else if (out.kind === "withheld") settle(id, { state: "withheld" });
    else if (out.kind === "busy") settle(id, { state: "busy" });
    else if (out.kind === "unavailable") settle(id, { state: "unavailable" });
  };

  const explain = () => {
    explainedFor.current = sig;
    const id = add({ about, state: "loading" });
    void grounded(sheetRef.current, "", []).then((out) => {
      // Asked to explain, the model has no business repricing. Treat it as no answer.
      if (out.kind === "reprice") settle(id, { state: "unavailable" });
      else show(id, out);
    });
  };

  // Explain each new result once it has settled. Typing in the amount box changes the result on
  // every keystroke, so this waits for a pause rather than explaining each digit.
  useEffect(() => {
    if (!ready || explainedFor.current === sig) return;
    const t = setTimeout(explain, 900);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, ready]);

  const ask = async (question: string) => {
    const q = question.trim();
    if (!q || asking) return;
    setAsking(true);
    setText("");
    const id = add({ q, state: "loading" });
    const out = await grounded(sheetRef.current, q, history());
    if (out.kind === "reprice") {
      const { patch, words } = toPatch(out.changes, tickers, current);
      if (!words.length) {
        settle(id, { state: "answer", text: "That is either what is already priced above, or a change Tenor cannot price." });
      } else {
        settle(id, { state: "repriced", text: `Priced again: ${words.join(", ")}.` });
        onReprice(patch);
      }
    } else {
      show(id, out);
    }
    setAsking(false);
  };

  // Retrying an explanation explains the result on screen now, which is the one that matters.
  const retry = (e: Entry) => {
    setEntries((prev) => prev.filter((x) => x.id !== e.id));
    if (e.q) void ask(e.q);
    else explain();
  };

  return (
    <section className="talk">
      <h3>In plain words</h3>

      <div className="talk-feed" aria-live="polite">
        {entries.map((e) => (
          <div key={e.id} className={`talk-entry ${e.q ? "asked" : "explained"}`}>
            {e.q && <p className="talk-q">{e.q}</p>}
            {!e.q && e.about && entries.filter((x) => !x.q).length > 1 && <p className="talk-about">{e.about}</p>}
            {e.state === "loading" && <p className="talk-a dim">{e.q ? "Thinking" : "Writing a short explanation"}&hellip;</p>}
            {(e.state === "answer" || e.state === "repriced") && (
              <p className={`talk-a ${e.state === "repriced" ? "repriced" : ""}`}>{e.text}</p>
            )}
            {e.state === "withheld" && (
              <p className="talk-a withheld">
                The answer used a figure Tenor did not work out, so it is not shown. Every figure on the
                page is unaffected. <button type="button" className="linklike" onClick={() => retry(e)}>Try again</button>
              </p>
            )}
            {e.state === "busy" && (
              <p className="talk-a dim">
                Too many questions in the last minute. <button type="button" className="linklike" onClick={() => retry(e)}>Try again</button>
              </p>
            )}
            {e.state === "unavailable" && (
              <p className="talk-a dim">
                The explanation is not available right now. Every figure on the page still stands.{" "}
                <button type="button" className="linklike" onClick={() => retry(e)}>Try again</button>
              </p>
            )}
          </div>
        ))}
      </div>

      <form
        className="talk-ask"
        onSubmit={(ev: FormEvent) => { ev.preventDefault(); void ask(text); }}
      >
        <input
          aria-label="Ask about this result"
          value={text}
          onChange={(ev) => setText(ev.target.value)}
          maxLength={300}
          placeholder="Ask about this, e.g. what if I held it for three months?"
        />
        <button type="submit" disabled={asking || !text.trim()}>{asking ? "Asking" : "Ask"}</button>
      </form>

      {children}

      <p className="note">
        Written by Claude from Tenor's own numbers. An answer with any figure Tenor did not work out
        is not shown.
      </p>
    </section>
  );
}
