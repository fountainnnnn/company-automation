import type { ReactNode } from "react";
import { Inbox } from "lucide-react";
import type { LucideIcon } from "lucide-react";

interface Props {
  title: string;
  hint: string;
  action?: ReactNode;
  /** Defaults to a neutral inbox mark. */
  icon?: LucideIcon;
}

export function EmptyState({ title, hint, action, icon: Icon = Inbox }: Props) {
  return (
    <div className="empty">
      <span className="badge-square" aria-hidden="true">
        <Icon size={28} strokeWidth={1.75} aria-hidden="true" />
      </span>
      <p className="title">{title}</p>
      <p className="hint">{hint}</p>
      {action && <div style={{ marginTop: 12 }}>{action}</div>}
    </div>
  );
}
