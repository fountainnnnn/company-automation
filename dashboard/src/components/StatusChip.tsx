type Kind = "ok" | "warn" | "flag" | "info" | "neutral";

interface Props {
  kind: Kind;
  label: string;
  title?: string;
}

/** Status is communicated through the labeled chip itself, never an orphan dot. */
export function StatusChip({ kind, label, title }: Props) {
  return (
    <span className={`status-chip ${kind}`} title={title}>
      {label}
    </span>
  );
}
