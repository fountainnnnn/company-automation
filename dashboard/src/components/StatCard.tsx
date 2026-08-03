import { Link } from "react-router-dom";
import type { ReactNode } from "react";
import { ArrowUpRight } from "lucide-react";
import { Sparkline } from "./Sparkline";

interface Props {
  label: string;
  value: string;
  sub?: string;
  icon: ReactNode;
  tone?: "blue" | "ok" | "warn";
  /** Omitted where there is no real series to draw. */
  spark?: number[];
  sparkColor?: string;
  to?: string;
  linkLabel?: string;
}

/** One figure, its icon, and — only when a real series exists — its trend. */
export function StatCard({
  label,
  value,
  sub,
  icon,
  tone = "blue",
  spark,
  sparkColor,
  to,
  linkLabel,
}: Props) {
  return (
    <div className="stat-card">
      {to && (
        <Link className="stat-link" to={to} aria-label={linkLabel ?? `Open ${label}`}>
          <ArrowUpRight size={18} strokeWidth={1.75} aria-hidden="true" />
        </Link>
      )}

      <div className="stat-top">
        <span className={`stat-icon ${tone}`} aria-hidden="true">
          {icon}
        </span>
        <span style={{ minWidth: 0 }}>
          <span className="stat-label">{label}</span>
          <p className="stat-value tnum">{value}</p>
        </span>
      </div>

      <div className="stat-foot">
        {sub && <p className="stat-sub">{sub}</p>}
        {spark && spark.length > 1 && (
          <Sparkline values={spark} color={sparkColor} title={`${label} trend`} />
        )}
      </div>
    </div>
  );
}
