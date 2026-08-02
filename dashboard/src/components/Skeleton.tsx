interface Props {
  height?: number;
  width?: string;
  radius?: number;
}

export function Skeleton({ height = 16, width = "100%", radius = 8 }: Props) {
  return (
    <div
      className="skeleton"
      style={{ height, width, borderRadius: radius }}
      aria-hidden="true"
    />
  );
}

export function SkeletonList({ rows = 3 }: { rows?: number }) {
  return (
    <div className="stack" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="panel panel-p stack-tight">
          <Skeleton height={14} width="34%" />
          <Skeleton height={12} width="72%" />
          <Skeleton height={72} radius={12} />
        </div>
      ))}
    </div>
  );
}

export function SkeletonCards({ count = 6 }: { count?: number }) {
  return (
    <div className="grid-cards" aria-busy="true" aria-label="Loading">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="panel" style={{ overflow: "hidden" }}>
          <Skeleton height={150} radius={0} />
          <div className="stack-tight" style={{ padding: 16 }}>
            <Skeleton height={14} width="60%" />
            <Skeleton height={12} width="40%" />
          </div>
        </div>
      ))}
    </div>
  );
}
