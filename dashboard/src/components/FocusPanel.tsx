import { useCallback, useEffect, useState } from "react";
import { RefreshCw, Sparkles } from "lucide-react";
import { Button } from "./Button";
import { StatusChip } from "./StatusChip";
import { Skeleton } from "./Skeleton";
import { useAuth } from "../lib/auth";
import { formatRelative } from "../lib/format";
import { supabase } from "../lib/supabase";
import type { FocusItem, SiteSummary } from "../lib/types";

/** high/medium/low map onto the same chips the rest of the app uses. */
const CHIP: Record<string, "flag" | "warn" | "info"> = {
  high: "flag",
  medium: "warn",
  low: "info",
};

/**
 * The written briefing. It is generated server-side and cached, so this reads
 * the stored row on mount and only spends a model call when someone asks for a
 * refresh — the panel is on the landing page, and regenerating per page load
 * would bill for re-summarising data that hasn't moved.
 */
export function FocusPanel() {
  const { isAdmin } = useAuth();
  const [row, setRow] = useState<SiteSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      const { data, error } = await supabase
        .from("site_summaries")
        .select("id, generated_at, window_days, model, summary, focus")
        .order("generated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!active) return;
      if (error) setError(error.message);
      setRow((data as SiteSummary) ?? null);
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    setBusy(true);
    setError(null);
    const { data, error } = await supabase.functions.invoke("site-summary", {
      body: { force: true, days: 7 },
    });
    setBusy(false);

    if (error) {
      // The function answers non-2xx with a readable message; surface that
      // rather than the generic "Edge Function returned a non-2xx status code".
      let message = error.message;
      const body = (error as { context?: { body?: unknown } }).context?.body;
      if (typeof body === "string") {
        try {
          const parsed = JSON.parse(body) as { message?: string };
          if (parsed.message) message = parsed.message;
        } catch {
          // keep the original message
        }
      }
      setError(message);
      return;
    }
    setRow(data as SiteSummary);
  }, []);

  const items: FocusItem[] = row?.focus ?? [];

  return (
    <section className="command-focus glass-panel" aria-labelledby="focus-title">
      <div className="command-panel-head">
        <div className="command-panel-title">
          <h3 id="focus-title">
            <Sparkles size={16} aria-hidden="true" /> Needs focus
          </h3>
          <p>
            {row
              ? `Across sites and teams · last ${row.window_days} days · ${formatRelative(row.generated_at)}`
              : "Across sites and teams"}
          </p>
        </div>
        {isAdmin && (
          <Button
            variant="secondary"
            loading={busy}
            onClick={() => void refresh()}
            aria-label="Regenerate briefing"
          >
            <RefreshCw size={14} aria-hidden="true" /> Refresh
          </Button>
        )}
      </div>

      {loading ? (
        <Skeleton height={96} radius={12} />
      ) : error ? (
        <p className="focus-error">{error}</p>
      ) : !row ? (
        <p className="focus-empty">
          No briefing yet.{" "}
          {isAdmin ? "Tap Refresh to write the first one." : "An admin can generate one."}
        </p>
      ) : (
        <>
          <p className="focus-summary">{row.summary}</p>
          {items.length > 0 && (
            <ul className="focus-list">
              {items.map((item, i) => (
                <li key={`${item.title}-${i}`} className="focus-item">
                  <div className="focus-item-head">
                    <StatusChip kind={CHIP[item.severity] ?? "warn"} label={item.scope} />
                    <strong>{item.title}</strong>
                  </div>
                  {item.detail && <p>{item.detail}</p>}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
