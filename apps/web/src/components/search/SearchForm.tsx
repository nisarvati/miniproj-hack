"use client";

import { useEffect, useId, useMemo, useState, type FormEvent, type KeyboardEvent } from "react";
import { useDebounced } from "../../lib/use-debounced";
import { SearchIcon, XIcon } from "../ui/icons";
import { Button, cx } from "../ui/primitives";

export const SUGGESTIONS = ["Crocin 500mg", "Paracetamol", "Augmentin", "Cetzine", "Volini"];

/** The search box. Keeps what you typed until you submit; the URL (not this box) is the source of truth for results. */
export function SearchForm({ initial, onSearch, large, autoFocus }: { initial: string; onSearch: (q: string) => void; large?: boolean; autoFocus?: boolean }) {
  const [value, setValue] = useState(initial);
  const [problem, setProblem] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const id = useId();
  const debounced = useDebounced(value.trim(), 180);
  const options = useMemo(() => debounced.length >= 2 ? SUGGESTIONS.filter((s) => s.toLowerCase().includes(debounced.toLowerCase())) : [], [debounced]);
  useEffect(() => setValue(initial), [initial]); // back/forward navigation

  function submit(e: FormEvent) {
    e.preventDefault();
    const q = value.trim();
    if (!q) {
      setProblem("Enter a medicine name, e.g. Crocin 500mg or Paracetamol.");
      return;
    }
    setProblem(null);
    setOpen(false);
    onSearch(options[active] ?? q);
  }

  function keyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" && options.length) { e.preventDefault(); setOpen(true); setActive((n) => (n + 1) % options.length); }
    if (e.key === "ArrowUp" && options.length) { e.preventDefault(); setOpen(true); setActive((n) => (n <= 0 ? options.length - 1 : n - 1)); }
    if (e.key === "Escape") setOpen(false);
  }

  return (
    <form onSubmit={submit} role="search" noValidate>
      <div className={cx("search-field mx-card mx-card--solid flex items-center gap-2", problem && "border-bad", large ? "p-2" : "p-1.5")}>
        <SearchIcon size={large ? 22 : 20} className="ml-2.5 shrink-0 text-muted" />
        <label htmlFor="medicine-search" className="sr-only">
          Medicine name
        </label>
        <input
          id="medicine-search"
          type="search"
          inputMode="search"
          autoComplete="off"
          autoFocus={autoFocus}
          maxLength={100}
          placeholder="Search medicine name or brand"
          value={value}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open && options.length > 0}
          aria-controls={`${id}-suggestions`}
          aria-activedescendant={active >= 0 && open ? `${id}-option-${active}` : undefined}
          onKeyDown={keyDown}
          onChange={(e) => {
            setValue(e.target.value);
            if (problem) setProblem(null);
            setOpen(true);
            setActive(-1);
          }}
          aria-invalid={problem ? true : undefined}
          aria-describedby={problem ? "search-problem" : undefined}
          className={cx("min-w-0 flex-1 bg-transparent px-1 outline-none placeholder:text-placeholder [&::-webkit-search-cancel-button]:hidden", large ? "h-12 text-lg" : "h-10 text-base")}
        />
        {value && (
          <button type="button" aria-label="Clear search" onClick={() => { setValue(""); setOpen(false); setActive(-1); }} className="inline-flex h-11 w-11 items-center justify-center rounded-full text-muted hover:bg-control-hover hover:text-ink">
            <XIcon size={16} />
          </button>
        )}
        <Button type="submit" variant="primary" size={large ? "lg" : "md"}>
          Search
        </Button>
      </div>
      {open && options.length > 0 && (
        <ul id={`${id}-suggestions`} role="listbox" aria-label="Medicine suggestions" className="mx-card mx-card--overlay mt-1 overflow-hidden">
          {options.map((option, index) => (
            <li key={option} id={`${id}-option-${index}`} role="option" aria-selected={active === index} className={cx("flex min-h-11 cursor-pointer items-center px-4 py-2 text-sm hover:bg-control-hover", active === index && "bg-control-hover")} onMouseDown={(e) => e.preventDefault()} onClick={() => { setValue(option); setOpen(false); onSearch(option); }}>
              {option}
            </li>
          ))}
        </ul>
      )}
      {problem && (
        <p id="search-problem" role="alert" className="mt-2 px-1 text-sm text-bad">
          {problem}
        </p>
      )}
    </form>
  );
}
