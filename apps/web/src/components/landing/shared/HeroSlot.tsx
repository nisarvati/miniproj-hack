import styles from "./slot.module.css";

/**
 * The reserved place for a direction's hero image. It has a fixed aspect ratio, so the headline, the negative space
 * around it and the CTA are laid out as if the image were already there. To use the real image, pass `src` and `alt`:
 * it fills the same box (object-fit: cover), so nothing else in the layout changes.
 *
 * The placeholder is flat colour and a hatch only (see slot.module.css); it is not an attempt at the illustration.
 * A direction sets `--slot-bg`, `--slot-line` and `--slot-ink` on the className it passes.
 */
export function HeroSlot({
  width,
  height,
  label,
  src,
  alt = "",
  className,
}: {
  /** Intended pixel size of the final image; only the ratio is used for layout. */
  width: number;
  height: number;
  /** What the final image shows, for the reviewer. */
  label: string;
  src?: string;
  alt?: string;
  className?: string;
}) {
  const ratio = simplifyRatio(width, height);
  return (
    <figure
      data-slot="hero-image"
      className={[styles.slot, className].filter(Boolean).join(" ")}
      style={{ aspectRatio: `${width} / ${height}` }}
      {...(src ? {} : { role: "img", "aria-label": `Hero image placeholder: ${label}` })}
    >
      {src ? (
        <img src={src} alt={alt} width={width} height={height} className={styles.image} />
      ) : (
        <>
          <span className={styles.caption} data-slot-caption>
            Image slot · {ratio} · {width} × {height} px
          </span>
          <span className={styles.note} data-slot-note>
            {label}
          </span>
        </>
      )}
    </figure>
  );
}

function simplifyRatio(w: number, h: number): string {
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
  const d = gcd(w, h);
  return `${w / d}:${h / d}`;
}
