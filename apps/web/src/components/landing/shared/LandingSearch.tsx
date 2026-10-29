"use client";

import { useRouter } from "next/navigation";
import { useId, useMemo, useState, type FormEvent, type KeyboardEvent } from "react";
import { SUGGESTIONS } from "../../search/SearchForm";
import { PRIMARY_CTA } from "./content";
import { buildSearchHref, validateQuery } from "./search-query";

/**
 * The landing pages' search box. It carries behaviour and semantics only: each direction styles it through the
 * `data-ls` hooks (form, label, field, input, button, list, option, problem, try, try-link), so five different
 * designs share one search. Submitting goes to the existing search page (`/search?q=...`); with JavaScript off the form
 * still works as a plain GET to `/search`.
 */
export function LandingSearch({
  cta = PRIMARY_CTA,
  label = "Medicine name",
  placeholder = "e.g. Crocin 500mg or Paracetamol",
  showTry = true,
  tryLabel = "Try",
  visibleLabel = false,
}: {
  cta?: string;
  label?: string;
  placeholder?: string;
  showTry?: boolean;
  tryLabel?: string;
  /** Show the label text instead of hiding it visually. It is always present for assistive technology. */
  visibleLabel?: boolean;
}) {
  const router = useRouter();
  const id = useId();
  const [value, setValue] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const options = useMemo(() => {
    const q = value.trim().toLowerCase();
    return q.length >= 2 ? SUGGESTIONS.filter((s) => s.toLowerCase().includes(q)) : [];
  }, [value]);
  const listOpen = open && options.length > 0;

  function go(query: string) {
    const message = validateQuery(query);
    setProblem(message);
    if (message) return;
    setOpen(false);
    router.push(buildSearchHref(query));
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    go((active >= 0 && listOpen ? options[active] : undefined) ?? value);
  }

  function keyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" && options.length) {
      e.preventDefault();
      setOpen(true);
      setActive((n) => (n + 1) % options.length);
    } else if (e.key === "ArrowUp" && options.length) {
      e.preventDefault();
      setOpen(true);
      setActive((n) => (n <= 0 ? options.length - 1 : n - 1));
    } else if (e.key === "Escape") {
      setOpen(false);
      setActive(-1);
    }
  }

  return (
    <div data-ls="root">
      <form action="/search" method="get" role="search" noValidate onSubmit={submit} data-ls="form">
        <label htmlFor={`${id}-q`} data-ls="label" data-visible={visibleLabel ? "true" : undefined} className={visibleLabel ? undefined : "sr-only"}>
          {label}
        </label>
        <div data-ls="field">
          <input
            id={`${id}-q`}
            name="q"
            type="search"
            inputMode="search"
            autoComplete="off"
            maxLength={100}
            placeholder={placeholder}
            value={value}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={listOpen}
            aria-controls={`${id}-list`}
            aria-activedescendant={listOpen && active >= 0 ? `${id}-option-${active}` : undefined}
            aria-invalid={problem ? true : undefined}
            aria-describedby={problem ? `${id}-problem` : undefined}
            onKeyDown={keyDown}
            onChange={(e) => {
              setValue(e.target.value);
              setProblem(null);
              setOpen(true);
              setActive(-1);
            }}
            data-ls="input"
          />
          <button type="submit" data-ls="button">
            {cta}
          </button>
        </div>
        <ul id={`${id}-list`} role="listbox" aria-label="Medicine suggestions" hidden={!listOpen} data-ls="list">
          {options.map((option, index) => (
            <li
              key={option}
              id={`${id}-option-${index}`}
              role="option"
              aria-selected={active === index}
              data-ls="option"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setValue(option);
                go(option);
              }}
            >
              {option}
            </li>
          ))}
        </ul>
        {problem && (
          <p id={`${id}-problem`} role="alert" data-ls="problem">
            {problem}
          </p>
        )}
      </form>
      {showTry && (
        <p data-ls="try">
          <span>{tryLabel}</span>
          {SUGGESTIONS.slice(0, 4).map((s) => (
            <a key={s} href={buildSearchHref(s)} data-ls="try-link">
              {s}
            </a>
          ))}
        </p>
      )}
    </div>
  );
}
