type Kind = "ok" | "warn" | "flag" | "info" | "neutral";

interface Props {
  kind: Kind;
  label: string;
  /** live states ("on site") get a breathing dot; frozen under reduced-motion */
  pulse?: boolean;
  title?: string;
}

/** The one way status is rendered anywhere in the app: colored dot + label. */
export function StatusChip({ kind, label, pulse = false, title }: Props) {
  return (
    <span className={`status-chip ${kind}`} title={title}>
      <span className={`status-dot${pulse ? " pulse" : ""}`} aria-hidden="true" />
      {label}
    </span>
  );
}
