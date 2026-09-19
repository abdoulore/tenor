/**
 * A company picker you can type into.
 *
 * A native select over 219 entries cannot be scanned, and a datalist filters to what is
 * already typed, which is why the old one appeared to contain a single company. This is a
 * plain combobox: type to filter, arrow keys to move, Enter to take, Escape to close.
 *
 * It keeps the three groups from the select, because which group a company is in is the most
 * useful thing about it. Typing "NFL" should surface Netflix under a heading that says nobody
 * trades it, not hide that until after the user commits.
 */

import { useEffect, useId, useMemo, useRef, useState } from "react";

export interface ComboGroup {
  label: string;
  items: string[];
  /** Shown after each item, for groups that need a warning rather than a name. */
  suffix?: string;
  tone?: "dead" | "warn";
}

export function Combobox({
  value,
  groups,
  onChange,
  disabled,
  placeholder = "Type or choose",
  id,
}: {
  value: string;
  groups: ComboGroup[];
  onChange: (next: string) => void;
  disabled?: boolean;
  placeholder?: string;
  id?: string;
}) {
  const [text, setText] = useState(value);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  // The field follows the value when it changes from outside, such as a typed sentence.
  useEffect(() => { setText(value); }, [value]);

  useEffect(() => {
    const away = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, []);

  // Matches at the start of a name come first, so typing "NF" puts NFLX above SNDK.
  const filtered = useMemo(() => {
    const q = text.trim().toUpperCase();
    const score = (s: string) => (s.startsWith(q) ? 0 : 1);
    return groups
      .map((g) => ({
        ...g,
        items: (q ? g.items.filter((i) => i.includes(q)) : g.items).sort((a, b) => score(a) - score(b)),
      }))
      .filter((g) => g.items.length > 0);
  }, [groups, text]);

  const flat = useMemo(() => filtered.flatMap((g) => g.items), [filtered]);

  const take = (next: string) => {
    onChange(next);
    setText(next);
    setOpen(false);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) { setOpen(true); return; }
      setActive((i) => {
        const n = e.key === "ArrowDown" ? i + 1 : i - 1;
        return Math.max(0, Math.min(flat.length - 1, n));
      });
    } else if (e.key === "Enter") {
      if (open && flat[active]) { e.preventDefault(); take(flat[active]); }
    } else if (e.key === "Escape") {
      setOpen(false);
      setText(value);
    }
  };

  let index = -1;

  return (
    <div className="combo" ref={boxRef}>
      <input
        id={id}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        autoComplete="off"
        spellCheck={false}
        disabled={disabled}
        value={text}
        placeholder={placeholder}
        onChange={(e) => { setText(e.target.value.toUpperCase()); setOpen(true); setActive(0); }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKey}
      />
      {open && (
        <ul className="combo-list" id={listId} role="listbox">
          {flat.length === 0 && <li className="combo-empty">No company matches that</li>}
          {filtered.map((g) => (
            <li key={g.label} className="combo-group">
              <span className="combo-glabel">{g.label}</span>
              <ul>
                {g.items.map((item) => {
                  index++;
                  const here = index;
                  return (
                    <li
                      key={item}
                      role="option"
                      aria-selected={item === value}
                      className={`combo-item ${g.tone ?? ""} ${here === active ? "active" : ""}`}
                      onMouseEnter={() => setActive(here)}
                      onMouseDown={(e) => { e.preventDefault(); take(item); }}
                    >
                      <span className="combo-name">{item}</span>
                      {g.suffix && <span className="combo-suffix">{g.suffix}</span>}
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
