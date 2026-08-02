import { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth";
import {
  formatDateTime,
  formatDay,
  formatDistance,
  formatDuration,
  formatTime,
  mapsUrl,
  toDateInput,
} from "../lib/format";
import type { Attendance } from "../lib/types";
import { SectionHeader } from "../components/SectionHeader";
import { Button } from "../components/Button";
import { EmptyState } from "../components/EmptyState";
import { SkeletonList } from "../components/Skeleton";
import { useToast } from "../components/Toast";

const SELECT = "*,workers(full_name),projects(code,name)";

function MapLink({
  label,
  lat,
  lng,
}: {
  label: string;
  lat: number | null;
  lng: number | null;
}) {
  if (lat === null || lng === null) return null;
  return (
    <a
      className="btn btn-outline-ink"
      href={mapsUrl(lat, lng)}
      target="_blank"
      rel="noreferrer"
    >
      {label} <span aria-hidden="true">📍</span>
    </a>
  );
}

function FlagCard({
  row,
  onCleared,
}: {
  row: Attendance;
  onCleared: (id: string) => void;
}) {
  const { profile } = useAuth();
  const toast = useToast();
  const [note, setNote] = useState(row.admin_note ?? "");
  const [busy, setBusy] = useState(false);

  async function clear() {
    setBusy(true);
    const { error } = await supabase
      .from("attendance")
      .update({
        review_status: "cleared",
        reviewed_at: new Date().toISOString(),
        reviewed_by: profile?.id ?? null,
        admin_note: note.trim() || null,
      })
      .eq("id", row.id);
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Flag cleared.");
    onCleared(row.id);
  }

  return (
    <div className="flag-card stack-tight">
      <div className="flag-row">
        <span className="who truncate" title={row.workers?.full_name ?? ""}>
          <strong>{row.workers?.full_name ?? "Unknown worker"}</strong>
        </span>
        {row.projects && (
          <span className="chip code" title={row.projects.name}>
            {row.projects.code}
          </span>
        )}
        <span className="chip tnum">{formatDay(row.check_in_at.slice(0, 10))}</span>
        {row.distance_m !== null && (
          <span className="dist-badge tnum">{formatDistance(row.distance_m)}</span>
        )}
      </div>

      <div className="flag-row">
        {(row.flags ?? []).map((f) => (
          <span key={f} className="chip flag">
            {f}
          </span>
        ))}
        <span className="muted tnum" style={{ fontSize: "0.85rem" }}>
          In {formatDateTime(row.check_in_at)} · Out{" "}
          {row.check_out_at ? formatDateTime(row.check_out_at) : "not recorded"}
        </span>
      </div>

      <div className="flag-row">
        <MapLink label="in" lat={row.in_lat} lng={row.in_lng} />
        <MapLink label="out" lat={row.out_lat} lng={row.out_lng} />
      </div>

      <div className="flag-row">
        <div className="field" style={{ flex: "1 1 220px" }}>
          <label htmlFor={`note-${row.id}`}>Admin note (optional)</label>
          <input
            id={`note-${row.id}`}
            className="input"
            value={note}
            placeholder="Why this is fine, or what was agreed"
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
        <Button variant="primary" loading={busy} onClick={() => void clear()}>
          Clear
        </Button>
      </div>
    </div>
  );
}

export function AttendancePage() {
  const toast = useToast();
  const [day, setDay] = useState(toDateInput(new Date()));
  const [flags, setFlags] = useState<Attendance[] | null>(null);
  const [rows, setRows] = useState<Attendance[] | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      const { data, error } = await supabase
        .from("attendance")
        .select(SELECT)
        .eq("review_status", "pending")
        .order("check_in_at", { ascending: false });
      if (!active) return;
      if (error) toast.error(error.message);
      setFlags((data ?? []) as unknown as Attendance[]);
    })();
    return () => {
      active = false;
    };
  }, [toast]);

  const loadDay = useCallback(async () => {
    setRows(null);
    const start = new Date(`${day}T00:00:00`);
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
    const { data, error } = await supabase
      .from("attendance")
      .select(SELECT)
      .gte("check_in_at", start.toISOString())
      .lt("check_in_at", end.toISOString())
      .order("check_in_at", { ascending: true });
    if (error) toast.error(error.message);
    setRows((data ?? []) as unknown as Attendance[]);
  }, [day, toast]);

  useEffect(() => {
    void loadDay();
  }, [loadDay]);

  return (
    <div className="reveal">
      <SectionHeader
        eyebrow="Attendance"
        title="Who was on site, and where."
        subtitle="Flagged check-ins need a decision; the day table below is the full trail."
      />

      <h2 className="sub-head">Flags queue</h2>
      {flags === null ? (
        <SkeletonList rows={2} />
      ) : flags.length === 0 ? (
        <EmptyState
          title="Nothing to review"
          hint="Check-ins are flagged when in and out points are far apart, or a checkout never arrived."
        />
      ) : (
        <div className="stack">
          {flags.map((row) => (
            <FlagCard
              key={row.id}
              row={row}
              onCleared={(id) => setFlags((prev) => (prev ?? []).filter((f) => f.id !== id))}
            />
          ))}
        </div>
      )}

      <div className="row" style={{ marginTop: 40 }}>
        <h2 className="sub-head" style={{ margin: 0 }}>
          Day view
        </h2>
        <div className="field row-end" style={{ flex: "0 0 190px" }}>
          <label htmlFor="att-day">Date</label>
          <input
            id="att-day"
            className="input"
            type="date"
            value={day}
            onChange={(e) => setDay(e.target.value)}
          />
        </div>
      </div>

      {rows === null ? (
        <SkeletonList rows={2} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No check-ins on this day"
          hint="Pick another date, or check that the crew used /checkin in Telegram."
        />
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Worker</th>
                <th>Project</th>
                <th>Check-in</th>
                <th>Check-out</th>
                <th>Hours</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const noCheckout = (r.flags ?? []).includes("no_checkout");
                return (
                  <tr key={r.id}>
                    <td className="truncate" title={r.workers?.full_name ?? ""}>
                      {r.workers?.full_name ?? "Unknown"}
                    </td>
                    <td className="truncate" title={r.projects?.name ?? ""}>
                      {r.projects ? r.projects.code : "—"}
                    </td>
                    <td className="tnum">{formatTime(r.check_in_at)}</td>
                    <td className="tnum">{formatTime(r.check_out_at)}</td>
                    <td className="tnum">
                      {r.check_out_at
                        ? formatDuration(r.check_in_at, r.check_out_at)
                        : noCheckout
                          ? "no checkout"
                          : "still on site"}
                    </td>
                    <td>
                      {r.review_status === "pending" ? (
                        <span className="chip flag">flagged</span>
                      ) : r.review_status === "cleared" ? (
                        <span className="chip ok">cleared</span>
                      ) : r.check_out_at ? (
                        <span className="chip ok">complete</span>
                      ) : (
                        <span className="chip warn">open</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
