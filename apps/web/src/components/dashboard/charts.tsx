"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { niceMax } from "../../lib/dashboard-data";
import { Card, cx } from "../ui/primitives";

/**
 * Small, dependency-free SVG charts in the MedLink palette. Every chart is a labelled image with the same numbers in a visually hidden table, a visible
 * legend or value list (never colour alone), and a tooltip on hover or keyboard focus. An axis always starts at 0 so bar lengths are honest.
 */
export const COLORS = {
  brand: "var(--brand)",
  brandSoft: "color-mix(in srgb, var(--brand) 38%, var(--surface))",
  ok: "var(--ok)",
  warn: "var(--warn-icon)",
  bad: "var(--bad)",
  neutral: "var(--placeholder)",
  line: "var(--line)",
} as const;

const FALLBACK_W = 560;
const PAD = { top: 12, right: 12, bottom: 28, left: 40 };

/**
 * The size a chart is drawn at: its container's own width (and, when it fills its card, its height), so text stays one size and a chart uses
 * the room it is given. Before it is measured, and where the browser cannot measure, it uses a sensible default.
 */
function useBox(height: number, fill: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: FALLBACK_W, h: height });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => {
      const r = el.getBoundingClientRect();
      const w = Math.round(r.width);
      const h = fill ? Math.round(r.height) : height;
      if (w > 0 && h > 0) setBox((b) => (b.w === w && b.h === h ? b : { w, h }));
    };
    read();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [height, fill]);
  return { ref, ...box };
}

/** The drawing area of a chart: it takes what the card leaves (`fill`) or a fixed height, and the svg sits inside without affecting the card's size. */
const frame = (fill: boolean, height: number) => ({ className: fill ? "dash-chart relative min-h-[8rem] flex-1" : "relative", style: fill ? undefined : { height } });

function HiddenTable({ caption, columns, rows }: { caption: string; columns: string[]; rows: (string | number)[][] }) {
  // The wrapper is what is clipped: a bare table ignores a 1px size, and its rows would quietly add scrollable height.
  return (
    <div className="sr-only">
      <table>
        <caption>{caption}</caption>
        <thead><tr>{columns.map((c) => <th key={c} scope="col">{c}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => (j === 0 ? <th key={j} scope="row">{c}</th> : <td key={j}>{c}</td>))}</tr>)}</tbody>
      </table>
    </div>
  );
}

export function Legend({ items }: { items: { label: string; color: string; value?: ReactNode }[] }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
      {items.map((i) => (
        <li key={i.label} className="flex items-center gap-1.5">
          <span aria-hidden="true" className="inline-block h-2.5 w-2.5 rounded-[3px]" style={{ background: i.color }} />
          {i.label}
          {i.value !== undefined && <span className="font-semibold tabular-nums text-ink">{i.value}</span>}
        </li>
      ))}
    </ul>
  );
}

function Tip({ at, children }: { at: { x: number; y: number; width: number } | null; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [left, setLeft] = useState(0);
  // Beside the point (right of it, or left when there is no room), and never outside the chart.
  useLayoutEffect(() => {
    if (!at || !ref.current) return;
    const w = ref.current.offsetWidth;
    const preferred = at.x + 12 + w <= at.width ? at.x + 12 : at.x - 12 - w;
    setLeft(Math.max(0, Math.min(preferred, at.width - w)));
  }, [at, children]);
  if (!at) return null;
  return (
    <div ref={ref} className="pointer-events-none absolute z-10 w-max max-w-[min(14rem,80%)]" style={{ left, top: Math.max(0, at.y), transform: "translateY(-50%)" }}>
      <Card variant="overlay" role="status" className="px-2.5 py-1.5 text-xs">{children}</Card>
    </div>
  );
}

interface Series {
  name: string;
  color: string;
  values: number[];
}

function useYScale(series: Series[], height: number) {
  const max = niceMax(Math.max(0, ...series.flatMap((s) => s.values)));
  const inner = Math.max(1, height - PAD.top - PAD.bottom);
  return { max, y: (v: number) => PAD.top + inner * (1 - v / max), ticks: [0, max / 2, max], inner };
}

const fmt = (n: number) => n.toLocaleString("en-IN", { maximumFractionDigits: 1 });

/** Grouped vertical bars: one group per label, one bar per series. For two or three series over days or buckets. */
export function GroupedBars({ labels, series, label, unit, height = 220, tickEvery = 1, fill = false }: { labels: string[]; series: Series[]; label: string; unit: string; height?: number; tickEvery?: number; fill?: boolean }) {
  const { ref, w: W, h: H } = useBox(height, fill);
  const [hover, setHover] = useState<number | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number; width: number } | null>(null);
  const id = useId();
  const { max, y, ticks } = useYScale(series, H);
  const gw = Math.max(1, (W - PAD.left - PAD.right) / Math.max(1, labels.length));
  const bw = Math.max(2, Math.min(18, (gw * 0.72) / series.length));
  const show = (i: number, el: Element) => {
    const box = el.closest("[data-chart]")!.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    setHover(i);
    setPos({ x: r.left - box.left + r.width / 2, y: 24, width: box.width });
  };
  return (
    <figure className={fill ? "flex min-h-0 flex-1 flex-col gap-2" : "space-y-2"}>
      <div ref={ref} data-chart {...frame(fill, height)}>
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-labelledby={`${id}-t`} className="absolute left-0 top-0" onPointerLeave={() => (setHover(null), setPos(null))}>
          <title id={`${id}-t`}>{label}</title>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} stroke={COLORS.line} strokeDasharray={t === 0 ? undefined : "3 4"} />
              <text x={PAD.left - 6} y={y(t) + 4} textAnchor="end" className="fill-[var(--muted)] text-[11px]">{fmt(t)}</text>
            </g>
          ))}
          {labels.map((l, i) => {
            const x0 = PAD.left + i * gw + (gw - bw * series.length) / 2;
            return (
              <g key={i} tabIndex={0} aria-label={`${l}: ${series.map((s) => `${s.name} ${fmt(s.values[i] ?? 0)}`).join(", ")} ${unit}`} onPointerEnter={(e) => show(i, e.currentTarget)} onFocus={(e) => show(i, e.currentTarget)} onBlur={() => (setHover(null), setPos(null))} className="outline-none">
                <rect x={PAD.left + i * gw} y={PAD.top} width={gw} height={Math.max(0, H - PAD.top - PAD.bottom)} fill={hover === i ? "var(--brand-soft)" : "transparent"} />
                {series.map((s, k) => {
                  const v = s.values[i] ?? 0;
                  return <rect key={s.name} x={x0 + k * bw} y={y(v)} width={bw - 1} height={Math.max(0, y(0) - y(v))} rx={2} fill={s.color} />;
                })}
                {i % tickEvery === 0 && <text x={PAD.left + i * gw + gw / 2} y={H - 8} textAnchor="middle" className="fill-[var(--muted)] text-[11px]">{l}</text>}
              </g>
            );
          })}
          <line x1={PAD.left} x2={W - PAD.right} y1={y(0)} y2={y(0)} stroke={COLORS.line} />
          <text x={PAD.left} y={8} className="fill-[var(--muted)] text-[10px]" aria-hidden="true">{unit} (axis 0 to {fmt(max)})</text>
        </svg>
        <Tip at={hover === null ? null : pos}>
          <p className="font-semibold">{labels[hover ?? 0]}</p>
          {series.map((s) => <p key={s.name} className="flex items-center gap-1.5"><span aria-hidden="true" className="inline-block h-2 w-2 rounded-sm" style={{ background: s.color }} />{s.name}: <span className="font-semibold tabular-nums">{fmt(s.values[hover ?? 0] ?? 0)}</span></p>)}
        </Tip>
      </div>
      <Legend items={series.map((s) => ({ label: s.name, color: s.color }))} />
      <HiddenTable caption={label} columns={["", ...series.map((s) => `${s.name} (${unit})`)]} rows={labels.map((l, i) => [l, ...series.map((s) => s.values[i] ?? 0)])} />
    </figure>
  );
}

/** A line chart for a measurement taken over time. `values` may hold null for "unknown at that moment": the line breaks there instead of dropping to 0. */
export function LineChart({ labels, series, label, unit, height = 200, format = fmt, fill = false }: { labels: string[]; series: { name: string; color: string; values: (number | null)[] }[]; label: string; unit: string; height?: number; format?: (n: number) => string; fill?: boolean }) {
  const { ref, w: W, h: H } = useBox(height, fill);
  const id = useId();
  const [hover, setHover] = useState<number | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number; width: number } | null>(null);
  const flat = series.map((s) => ({ ...s, values: s.values.map((v) => v ?? 0) }));
  const { y, ticks } = useYScale(flat, H);
  const n = Math.max(1, labels.length - 1);
  const x = (i: number) => PAD.left + ((W - PAD.left - PAD.right) * i) / n;
  const path = (values: (number | null)[]) => {
    let d = "";
    let pen = false;
    values.forEach((v, i) => {
      if (v === null) return void (pen = false);
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)} `;
      pen = true;
    });
    return d;
  };
  const move = (e: React.PointerEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - box.left;
    const i = Math.min(labels.length - 1, Math.max(0, Math.round(((px - PAD.left) / (W - PAD.left - PAD.right)) * n)));
    setHover(i);
    setPos({ x: x(i), y: 24, width: box.width });
  };
  return (
    <figure className={fill ? "flex min-h-0 flex-1 flex-col gap-2" : "space-y-2"}>
      <div ref={ref} data-chart {...frame(fill, height)}>
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-labelledby={`${id}-t`} className="absolute left-0 top-0 touch-pan-y" onPointerMove={move} onPointerLeave={() => (setHover(null), setPos(null))}>
          <title id={`${id}-t`}>{label}</title>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} stroke={COLORS.line} strokeDasharray={t === 0 ? undefined : "3 4"} />
              <text x={PAD.left - 6} y={y(t) + 4} textAnchor="end" className="fill-[var(--muted)] text-[11px]">{format(t)}</text>
            </g>
          ))}
          {labels.length > 0 && [0, Math.floor(labels.length / 2), labels.length - 1].filter((v, i, a) => a.indexOf(v) === i).map((i) => <text key={i} x={x(i)} y={H - 8} textAnchor={i === 0 ? "start" : i === labels.length - 1 ? "end" : "middle"} className="fill-[var(--muted)] text-[11px]">{labels[i]}</text>)}
          {series.map((s) => (
            <g key={s.name}>
              <path d={path(s.values)} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              {s.values.map((v, i) => v !== null && (labels.length <= 40 || i === hover) && <circle key={i} cx={x(i)} cy={y(v)} r={hover === i ? 4 : 2.5} fill={s.color} />)}
            </g>
          ))}
          {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={H - PAD.bottom} stroke={COLORS.line} />}
          <text x={PAD.left} y={8} className="fill-[var(--muted)] text-[10px]" aria-hidden="true">{unit}</text>
        </svg>
        <Tip at={hover === null ? null : pos}>
          <p className="font-semibold">{labels[hover ?? 0]}</p>
          {series.map((s) => <p key={s.name} className="flex items-center gap-1.5"><span aria-hidden="true" className="inline-block h-2 w-2 rounded-sm" style={{ background: s.color }} />{s.name}: <span className="font-semibold tabular-nums">{s.values[hover ?? 0] === null || s.values[hover ?? 0] === undefined ? "unknown" : format(s.values[hover ?? 0]!)}</span></p>)}
        </Tip>
      </div>
      <Legend items={series.map((s) => ({ label: s.name, color: s.color }))} />
      <HiddenTable caption={label} columns={["", ...series.map((s) => `${s.name} (${unit})`)]} rows={labels.map((l, i) => [l, ...series.map((s) => (s.values[i] === null || s.values[i] === undefined ? "unknown" : format(s.values[i]!)))])} />
    </figure>
  );
}

export interface Segment {
  label: string;
  value: number;
  color: string;
}

/** A donut for a distribution of one whole. The legend lists every segment with its count and share, so no meaning rests on colour. */
export function Donut({ segments, label, centre, size = 128 }: { segments: Segment[]; label: string; centre: { value: ReactNode; caption: string }; size?: number }) {
  const id = useId();
  const total = segments.reduce((n, s) => n + s.value, 0);
  const r = 52;
  const c = 2 * Math.PI * r;
  let offset = 0;
  return (
    <figure className="dash-donut flex flex-wrap items-center gap-x-5 gap-y-2">
      <svg width={size} height={size} viewBox="0 0 140 140" role="img" aria-labelledby={`${id}-t`} className="shrink-0">
        <title id={`${id}-t`}>{label}</title>
        <circle cx="70" cy="70" r={r} fill="none" stroke={COLORS.line} strokeWidth="16" />
        {total > 0 &&
          segments.filter((s) => s.value > 0).map((s) => {
            const len = (s.value / total) * c;
            const el = <circle key={s.label} cx="70" cy="70" r={r} fill="none" stroke={s.color} strokeWidth="16" strokeDasharray={`${Math.max(0, len - 1.5)} ${c - Math.max(0, len - 1.5)}`} strokeDashoffset={-offset} transform="rotate(-90 70 70)" />;
            offset += len;
            return el;
          })}
        <text x="70" y="68" textAnchor="middle" className="fill-[var(--ink)] text-[22px] font-bold">{centre.value}</text>
        <text x="70" y="86" textAnchor="middle" className="fill-[var(--muted)] text-[10px]">{centre.caption}</text>
      </svg>
      <ul className="min-w-[8.5rem] flex-1 space-y-1 text-sm">
        {segments.map((s) => (
          <li key={s.label} className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-2"><span aria-hidden="true" className="inline-block h-2.5 w-2.5 rounded-[3px]" style={{ background: s.color }} />{s.label}</span>
            <span className="tabular-nums"><span className="font-semibold">{s.value}</span> <span className="text-muted">{total > 0 ? `· ${Math.round((s.value / total) * 100)}%` : ""}</span></span>
          </li>
        ))}
      </ul>
    </figure>
  );
}

/** Horizontal bars for a ranking or a comparison: a label, a bar from 0, the value. Optionally stacked from `segments`. */
export function HBars({ rows, label, unit, empty }: { rows: { label: string; value: number; display?: string; hint?: string }[]; label: string; unit: string; empty?: ReactNode }) {
  const max = niceMax(Math.max(0, ...rows.map((r) => r.value)));
  if (rows.length === 0) return <>{empty}</>;
  return (
    <figure>
      <ol aria-label={label} className="dash-rows space-y-2">
        {rows.map((r) => (
          <li key={r.label} title={r.hint}>
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="min-w-0 truncate">{r.label}</span>
              <span className="shrink-0 tabular-nums"><span className="font-semibold">{r.display ?? r.value.toLocaleString("en-IN")}</span>{r.display === undefined && <span className="text-xs text-muted"> {unit}</span>}</span>
            </div>
            <div aria-hidden="true" className="mt-1 h-2 overflow-hidden rounded-full bg-[var(--surface-2)]"><div className="h-full rounded-full" style={{ width: `${(r.value / max) * 100}%`, background: COLORS.brand }} /></div>
          </li>
        ))}
      </ol>
    </figure>
  );
}

/** One horizontal bar per row made of coloured parts that add up to the row's total (for example stock status per pharmacy). */
export function StackedRows({ rows, parts, label }: { rows: { label: string; values: number[] }[]; parts: { label: string; color: string }[]; label: string }) {
  return (
    <figure className="space-y-2">
      <ol aria-label={label} className="dash-rows space-y-2.5">
        {rows.map((r) => {
          const total = r.values.reduce((a, b) => a + b, 0);
          return (
            <li key={r.label}>
              <div className="flex items-baseline justify-between text-sm"><span>{r.label}</span><span className="text-xs text-muted tabular-nums">{parts.map((p, i) => `${r.values[i]} ${p.label.toLowerCase()}`).join(" · ")}</span></div>
              <div aria-hidden="true" className="mt-1 flex h-2.5 overflow-hidden rounded-full bg-[var(--surface-2)]">
                {total > 0 && r.values.map((v, i) => v > 0 && <div key={i} style={{ width: `${(v / total) * 100}%`, background: parts[i]!.color }} />)}
              </div>
            </li>
          );
        })}
      </ol>
      <Legend items={parts} />
    </figure>
  );
}

export const ChartCard = ({ className, children }: { className?: string; children: ReactNode }) => <div className={cx("space-y-4", className)}>{children}</div>;
