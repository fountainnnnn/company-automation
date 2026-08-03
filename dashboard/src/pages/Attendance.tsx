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
  sgtDayRange,
  toDateInput,
  toSgtDay,
} from "../lib/format";
import type { Attendance } from "../lib/types";
import { SectionHeader } from "../components/SectionHeader";
import { StatusChip } from "../components/StatusChip";
import { Button } from "../components/Button";
import { EmptyState } from "../components/EmptyState";
import { SkeletonList } from "../components/Skeleton";
import { useToast } from "../components/Toast";
import { Modal } from "../components/Modal";
import { SiteMap } from "../components/SiteMap";
import type { MapPoint } from "../components/SiteMap";

const SELECT = "*,workers(full_name),projects(code,name,site_lat,site_lng)";

function coord(lat: number, lng: number): string {
  return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
}

/** In, out and — when the project has coordinates — the assigned site. */
function pointsFor(row: Attendance): MapPoint[] {
  const points: MapPoint[] = [];
  if (row.in_lat !== null && row.in_lng !== null) {
    points.push({
      lat: row.in_lat,
      lng: row.in_lng,
      kind: "in",
      label: "Check-in",
      sub: formatDateTime(row.check_in_at),
    });
  }
  if (row.out_lat !== null && row.out_lng !== null) {
    points.push({
      lat: row.out_lat,
      lng: row.out_lng,
      kind: "out",
      label: "Check-out",
      sub: formatDateTime(row.check_out_at),
    });
  }
  const p = row.projects;
  if (p && p.site_lat !== null && p.site_lng !== null) {
    points.push({ lat: p.site_lat, lng: p.site_lng, kind: "site", label: p.code, sub: p.name });
  }
  return points;
}

/** One map at a time: it lives in this dialog and dies with it. */
function MapModal({ row, onClose }: { row: Attendance; onClose: () => void }) {
  const points = pointsFor(row);
  const site = points.find((p) => p.kind === "site") ?? null;
  return (
    <Modal
      size="wide"
      title={`${row.workers?.full_name ?? "Unknown worker"} · ${formatDay(toSgtDay(row.check_in_at))}`}
      onClose={onClose}
      footer={
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      }
    >
      {points.length === 0 ? (
        <p className="muted">No coordinates were recorded for this shift.</p>
      ) : (
        <>
          <SiteMap points={points} connect height={360} />
          <div className="map-legend">
            <span>
              <i className="k-in" aria-hidden="true" />
              Check-in
            </span>
            {row.out_lat !== null && (
              <span>
                <i className="k-out" aria-hidden="true" />
                Check-out
              </span>
            )}
            {site && (
              <span>
                <i className="k-site" aria-hidden="true" />
                Project site
              </span>
            )}
            {row.distance_m !== null && (
              <span className="tnum">{formatDistance(row.distance_m)}</span>
            )}
          </div>
          <div className="flag-row">
            <MapLink label="in" lat={row.in_lat} lng={row.in_lng} />
            <MapLink label="out" lat={row.out_lat} lng={row.out_lng} />
          </div>
          <p className="map-coords">
            In {row.in_lat !== null && row.in_lng !== null ? coord(row.in_lat, row.in_lng) : "—"} ·
            Out {row.out_lat !== null && row.out_lng !== null ? coord(row.out_lat, row.out_lng) : "—"}
            {site && ` · Site ${coord(site.lat, site.lng)}`}
          </p>
        </>
      )}
    </Modal>
  );
}

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
  onShowMap,
}: {
  row: Attendance;
  onCleared: (id: string) => void;
  onShowMap: () => void;
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
        <span className="chip tnum">{formatDay(toSgtDay(row.check_in_at))}</span>
        {row.distance_m !== null && (
          <span className="dist-badge tnum">{formatDistance(row.distance_m)}</span>
        )}
      </div>

      <div className="flag-row">
        {(row.flags ?? []).map((f) => (
          <StatusChip key={f} kind="flag" label={f.replace("_", " ")} />
        ))}
        <span className="muted tnum" style={{ fontSize: "0.85rem" }}>
          In {formatDateTime(row.check_in_at)} · Out{" "}
          {row.check_out_at ? formatDateTime(row.check_out_at) : "not recorded"}
        </span>
      </div>

      <div className="flag-row">
        <Button variant="secondary" onClick={onShowMap}>
          View map
        </Button>
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
  const [mapRow, setMapRow] = useState<Attendance | null>(null);

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
    const { start, end } = sgtDayRange(day);
    const { data, error } = await supabase
      .from("attendance")
      .select(SELECT)
      .gte("check_in_at", start)
      .lt("check_in_at", end)
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
        title="Attendance"
        subtitle={
          flags === null
            ? undefined
            : `${flags.length} flag${flags.length === 1 ? "" : "s"} awaiting review`
        }
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
              onShowMap={() => setMapRow(row)}
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
                <th>Map</th>
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
                        <StatusChip kind="flag" label="flagged" />
                      ) : r.review_status === "cleared" ? (
                        <StatusChip kind="neutral" label="cleared" />
                      ) : r.check_out_at ? (
                        <StatusChip kind="ok" label="complete" />
                      ) : (
                        <StatusChip kind="info" label="on site" />
                      )}
                    </td>
                    <td>
                      <button
                        type="button"
                        className="btn btn-outline-ink"
                        onClick={() => setMapRow(r)}
                        title={`Map for ${r.workers?.full_name ?? "this shift"}`}
                      >
                        Map <span aria-hidden="true">📍</span>
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {mapRow && <MapModal row={mapRow} onClose={() => setMapRow(null)} />}
    </div>
  );
}
