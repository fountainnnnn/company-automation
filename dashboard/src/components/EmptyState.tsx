import type { ReactNode } from "react";

interface Props {
  title: string;
  hint: string;
  action?: ReactNode;
}

export function EmptyState({ title, hint, action }: Props) {
  return (
    <div className="empty">
      <div className="mesh-badge" aria-hidden="true">
        <div className="mesh" />
      </div>
      <p className="title">{title}</p>
      <p className="hint">{hint}</p>
      {action && <div style={{ marginTop: 12 }}>{action}</div>}
    </div>
  );
}
