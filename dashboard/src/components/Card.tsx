import type { CSSProperties, ReactNode } from "react";

/** Solid white data surface — dense text never sits on glass. */
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
