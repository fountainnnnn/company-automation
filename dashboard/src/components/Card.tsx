import type { CSSProperties, ReactNode } from "react";

/** Solid data surface — dense text never sits on a glow. */
export function Card({
  children,
  padded = true,
  className = "",
  style,
}: {
  children: ReactNode;
  padded?: boolean;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div className={`panel ${padded ? "panel-p" : ""} ${className}`.trim()} style={style}>
      {children}
    </div>
  );
}

const HUE_PAIRS: Array<[string, string]> = [
  ["var(--amber)", "var(--sky)"],
  ["var(--sky)", "var(--violet)"],
  ["var(--violet)", "var(--amber)"],
];

/** CSS custom properties driving `.glow-card::before`, rotating per index. */
export function glowVars(index: number): CSSProperties {
  const [a, b] = HUE_PAIRS[index % HUE_PAIRS.length];
  return { "--glow-a": a, "--glow-b": b } as CSSProperties;
}
