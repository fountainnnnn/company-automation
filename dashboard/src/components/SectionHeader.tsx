import type { ReactNode } from "react";

interface Props {
  eyebrow: string;
  title: string;
  subtitle: string;
  actions?: ReactNode;
}

export function SectionHeader({ eyebrow, title, subtitle, actions }: Props) {
  return (
    <header className="section-head">
      <div className="row">
        <div style={{ minWidth: 0, flex: 1 }}>
          <p className="eyebrow">{eyebrow}</p>
          <h1>{title}</h1>
          <p className="sub">{subtitle}</p>
        </div>
        {actions && <div className="row row-end">{actions}</div>}
      </div>
    </header>
  );
}
