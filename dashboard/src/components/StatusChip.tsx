type Kind = "ok" | "warn" | "flag" | "info" | "neutral";

interface Props {
  kind: Kind;
  label: string;
  title?: string;
}

/** The one way status is rendered anywhere in the app: colored dot + label. */
export function StatusChip({ kind, label, title }: Props) {
  return (
    <span className={`status-chip ${kind}`} title={title}>
      <span className="status-dot" aria-hidden="true" />
      {label}
    </span>
  );
}
