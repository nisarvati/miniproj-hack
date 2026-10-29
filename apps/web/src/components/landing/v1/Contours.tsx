/**
 * Decorative topographic linework: nested, slightly irregular closed curves, computed (not an image). Pure
 * ornament, hidden from assistive technology. Rounded to one decimal so server and browser render identical markup.
 */
export function Contours({ className, rings = 9 }: { className?: string; rings?: number }) {
  const paths = Array.from({ length: rings }, (_, k) => {
    const r = 34 + k * 30;
    const points = Array.from({ length: 72 }, (_, i) => {
      const a = (i / 72) * Math.PI * 2;
      const wobble = 1 + 0.1 * Math.sin(3 * a + k * 0.45) + 0.05 * Math.sin(5 * a + 1.3 + k * 0.2) + 0.03 * Math.sin(9 * a + k);
      const x = 300 + r * 1.25 * wobble * Math.cos(a);
      const y = 220 + r * wobble * Math.sin(a);
      return `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`;
    });
    return `${points.join(" ")} Z`;
  });
  return (
    <svg viewBox="0 0 600 440" aria-hidden="true" focusable="false" className={className}>
      {paths.map((d, i) => (
        <path key={i} d={d} fill="none" stroke="currentColor" strokeWidth={i % 4 === 0 ? 1.1 : 0.6} />
      ))}
    </svg>
  );
}
