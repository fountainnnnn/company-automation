import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth";
import { formatDay, formatDayShort, formatWeekday } from "../lib/format";
import {
  downloadCsv,
  fetchAllTimesheetRows,
  fetchTeams,
  fetchTimesheetPage,
  fetchTimesheetTotals,
  toCsv,
  TS_PAGE_SIZE,
  TS_SELECT,
} from "../lib/timesheets";
import type { TimesheetTotals } from "../lib/timesheets";
import { useDebounced } from "../lib/useDebounced";
import { EMPTY_TIMESHEET_FILTERS } from "../lib/types";
import type {
  Timesheet,
  TimesheetFilters,
  TimesheetRole,
  TimesheetRow,
  TimesheetStats,
} from "../lib/types";
import { ClipboardList, Clock, UserX, Users } from "lucide-react";
import { SectionHeader } from "../components/SectionHeader";
import { StatCard } from "../components/StatCard";
import { Button } from "../components/Button";
import { ConfirmDialog, Modal } from "../components/Modal";
import { EmptyState } from "../components/EmptyState";
import { Skeleton, SkeletonList } from "../components/Skeleton";
import { StatusChip } from "../components/StatusChip";
import { useToast } from "../components/Toast";

const RANGES = [7, 30, 90];
const ROLES: TimesheetRole[] = ["worker", "driver", "welder", "supervisor"];

const EMPTY_STATS: TimesheetStats = {
  total_hours: 0,
  entries: 0,
  absences: 0,
  crews: 0,
  unresolved: 0,
};

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function groupByDate(rows: TimesheetRow[]): Array<[string, TimesheetRow[]]> {
  const map = new Map<string, TimesheetRow[]>();
  for (const r of rows) {
    const list = map.get(r.work_date) ?? [];
    list.push(r);
    map.set(r.work_date, list);
  }
  return Array.from(map.entries());
}

function sumHours(rows: TimesheetRow[]): number {
  return rows.reduce((n, r) => n + (r.hours ?? 0), 0);
}

/** One row's edit state — the mode is what keeps hours and absence mutually exclusive. */
interface EditState {
  entryId: number;
  mode: "hours" | "absent";
  value: string;
}

export function TimesheetsPage() {
  const { isAdmin } = useAuth();
  const toast = useToast();

  const [days, setDays] = useState(30);
  const [stats, setStats] = useState<TimesheetStats | null>(null);

  const [filters, setFilters] = useState<TimesheetFilters>(EMPTY_TIMESHEET_FILTERS);
  const query = useDebounced(filters, 300);
  const [teams, setTeams] = useState<string[]>([]);

  const [rows, setRows] = useState<TimesheetRow[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [totals, setTotals] = useState<TimesheetTotals | null>(null);
  const loaded = useRef(0);

  const [edit, setEdit] = useState<EditState | null>(null);
  const [deleting, setDeleting] = useState<TimesheetRow | null>(null);
  const [detail, setDetail] = useState<TimesheetRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    let active = true;
    setStats(null);
    void (async () => {
      const { data, error } = await supabase.rpc("timesheet_stats", { days });
      if (!active) return;
      if (error) toast.error(error.message);
      const row = (data as TimesheetStats[] | null)?.[0];
      setStats(
        row
          ? {
              total_hours: Number(row.total_hours),
              entries: Number(row.entries),
              absences: Number(row.absences),
              crews: Number(row.crews),
              unresolved: Number(row.unresolved),
            }
          : EMPTY_STATS,
      );
    })();
    return () => {
      active = false;
    };
  }, [days, toast]);

  useEffect(() => {
    let active = true;
    void (async () => {
      const list = await fetchTeams();
      if (active) setTeams(list);
    })();
    return () => {
      active = false;
    };
  }, []);

  const refreshTotals = useCallback(async () => {
    try {
      setTotals(await fetchTimesheetTotals(query));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not total these rows.");
    }
  }, [query, toast]);

  const load = useCallback(async () => {
    setRows(null);
    setTotals(null);
    setEdit(null);
    const page = await fetchTimesheetPage(query, 0);
    if (page.error) toast.error(page.error);
    loaded.current = page.rows.length;
    setRows(page.rows);
    setHasMore(page.hasMore);
    await refreshTotals();
  }, [query, toast, refreshTotals]);

  useEffect(() => {
    void load();
  }, [load]);

  async function loadMore() {
    setLoadingMore(true);
    const page = await fetchTimesheetPage(query, loaded.current);
    setLoadingMore(false);
    if (page.error) {
      toast.error(page.error);
      return;
    }
    loaded.current += page.rows.length;
    setRows((prev) => [...(prev ?? []), ...page.rows]);
    setHasMore(page.hasMore);
  }

  async function exportCsv() {
    setExporting(true);
    try {
      const all = await fetchAllTimesheetRows(query);
      if (all.length === 0) {
        toast.error("Nothing to export with these filters.");
        return;
      }
      downloadCsv(`timesheets-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(all));
      toast.success(`Exported ${all.length} rows.`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Export failed.");
    } finally {
      setExporting(false);
    }
  }

  function patchRow(entryId: number, patch: Partial<TimesheetRow>) {
    setRows((prev) =>
      (prev ?? []).map((r) => (r.entry_id === entryId ? { ...r, ...patch } : r)),
    );
  }

  async function saveEdit() {
    if (!edit) return;
    const value = edit.value.trim();
    let patch: { hours: number | null; absence_reason: string | null };
    if (edit.mode === "hours") {
      const hours = Number(value);
      if (!value || Number.isNaN(hours) || hours < 0 || hours > 24) {
        toast.error("Hours must be a number between 0 and 24.");
        return;
      }
      patch = { hours: Math.round(hours * 10) / 10, absence_reason: null };
    } else {
      if (!value) {
        toast.error("Give a reason, or switch to hours.");
        return;
      }
      patch = { hours: null, absence_reason: value };
    }
    setBusy(true);
    const { error } = await supabase
      .from("timesheet_entries")
      .update(patch)
      .eq("id", edit.entryId);
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    patchRow(edit.entryId, patch);
    setEdit(null);
    void refreshTotals();
    toast.success("Entry updated.");
  }

  async function changeRole(row: TimesheetRow, role: TimesheetRole) {
    const { error } = await supabase
      .from("timesheet_entries")
      .update({ role })
      .eq("id", row.entry_id);
    if (error) {
      toast.error(error.message);
      return;
    }
    patchRow(row.entry_id, { role });
    toast.success("Role updated.");
  }

  async function deleteEntry(row: TimesheetRow) {
    setBusy(true);
    const { error } = await supabase.from("timesheet_entries").delete().eq("id", row.entry_id);
    setBusy(false);
    setDeleting(null);
    if (error) {
      toast.error(error.message);
      return;
    }
    setRows((prev) => (prev ?? []).filter((r) => r.entry_id !== row.entry_id));
    void refreshTotals();
    toast.success("Entry deleted.");
  }

  const groups = useMemo(() => groupByDate(rows ?? []), [rows]);
  const dirty = Object.values(filters).some((v) => v !== "");

  return (
    <div className="reveal">
      <SectionHeader
        title="Timesheets"
        subtitle={`Last ${days} days`}
        actions={
          <>
            <div className="range-control" role="group" aria-label="Time range">
              {RANGES.map((r) => (
                <button
                  key={r}
                  className={`range-btn${r === days ? " active" : ""}`}
                  aria-pressed={r === days}
                  onClick={() => setDays(r)}
                >
                  {r}d
                </button>
              ))}
            </div>
            <Button
              variant="secondary"
              loading={exporting}
              onClick={() => void exportCsv()}
            >
              Export CSV
            </Button>
          </>
        }
      />

      {stats === null ? (
        <div className="stat-row" aria-busy="true" aria-label="Loading totals">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="panel panel-p stack-tight">
              <Skeleton height={12} width="52%" />
              <Skeleton height={30} width="40%" />
              <Skeleton height={12} width="66%" />
            </div>
          ))}
        </div>
      ) : (
        <div className="stat-row">
          <StatCard
            label="Total hours"
            value={stats.total_hours.toFixed(1)}
            sub={`logged in the last ${days} days`}
            icon={TS_ICONS.hours}
          />
          <StatCard
            label="Entries"
            value={String(stats.entries)}
            sub={
              stats.unresolved > 0
                ? `${stats.unresolved} with an unknown worker ID`
                : "every ID matched a worker"
            }
            tone={stats.unresolved > 0 ? "warn" : "blue"}
            icon={TS_ICONS.entries}
          />
          <StatCard
            label="Absences"
            value={String(stats.absences)}
            sub="no-shows with a reason given"
            icon={TS_ICONS.absences}
          />
          <StatCard
            label="Crews"
            value={String(stats.crews)}
            sub="teams filing rosters"
            icon={TS_ICONS.crews}
          />
        </div>
      )}

      <h2 className="sub-head">All entries</h2>

      <TimesheetFilterBar
        filters={filters}
        teams={teams}
        dirty={dirty}
        onChange={setFilters}
      />

      {rows === null ? (
        <SkeletonList rows={3} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No entries match these filters"
          hint="Widen the dates, or clear the filters to see every roster on record."
        />
      ) : (
        <>
          {groups.map(([day, dayRows]) => (
            <section key={day}>
              <h3 className="date-head">
                <span className="truncate">{formatDay(day)}</span>
                <span className="chip">{formatWeekday(day)}</span>
                <span className="chip tnum">{sumHours(dayRows).toFixed(1)}h</span>
              </h3>
              <div className="table-wrap">
                <table className="data ts-table">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Team</th>
                      <th>Location</th>
                      <th>Worker ID</th>
                      <th>Name</th>
                      <th>Role</th>
                      <th className="num">Hours</th>
                      <th>Status</th>
                      <th>
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {dayRows.map((r) => (
                      <EntryRow
                        key={r.entry_id}
                        row={r}
                        isAdmin={isAdmin}
                        busy={busy}
                        edit={edit?.entryId === r.entry_id ? edit : null}
                        onEdit={setEdit}
                        onSave={() => void saveEdit()}
                        onRole={(role) => void changeRole(r, role)}
                        onDelete={() => setDeleting(r)}
                        onOpen={() => setDetail(r)}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ))}

          <div className="ts-total">
            <span className="label">Total for these filters</span>
            <span className="muted">
              {totals === null
                ? "counting…"
                : `${totals.entries} entr${totals.entries === 1 ? "y" : "ies"} · ${
                    totals.absences
                  } absent`}
            </span>
            <span className="sum tnum">
              {totals === null ? "—" : `${totals.hours.toFixed(1)}h`}
            </span>
          </div>

          {hasMore && (
            <div className="row" style={{ justifyContent: "center", marginTop: 24 }}>
              <Button variant="secondary" loading={loadingMore} onClick={() => void loadMore()}>
                Load {TS_PAGE_SIZE} more
              </Button>
            </div>
          )}
        </>
      )}

      {deleting && (
        <ConfirmDialog
          title="Delete this entry?"
          message={`${deleting.worker_code}${
            deleting.worker_name ? ` (${deleting.worker_name})` : ""
          } on ${formatDay(deleting.work_date)} will be removed from the roster. The rest of the roster stays intact.`}
          confirmLabel="Delete entry"
          busy={busy}
          onConfirm={() => void deleteEntry(deleting)}
          onClose={() => setDeleting(null)}
        />
      )}

      {detail && <RosterModal row={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}

const TS_ICONS = {
  hours: <Clock size={20} strokeWidth={1.75} aria-hidden="true" />,
  entries: <ClipboardList size={20} strokeWidth={1.75} aria-hidden="true" />,
  absences: <UserX size={20} strokeWidth={1.75} aria-hidden="true" />,
  crews: <Users size={20} strokeWidth={1.75} aria-hidden="true" />,
};

function TimesheetFilterBar({
  filters,
  teams,
  dirty,
  onChange,
}: {
  filters: TimesheetFilters;
  teams: string[];
  dirty: boolean;
  onChange: (next: TimesheetFilters) => void;
}) {
  const set = (patch: Partial<TimesheetFilters>) => onChange({ ...filters, ...patch });

  return (
    <div className="toolbar">
      <div className="field">
        <label htmlFor="ts-from">From</label>
        <input
          id="ts-from"
          className="input"
          type="date"
          value={filters.from}
          max={filters.to || undefined}
          onChange={(e) => set({ from: e.target.value })}
        />
      </div>

      <div className="field">
        <label htmlFor="ts-to">To</label>
        <input
          id="ts-to"
          className="input"
          type="date"
          value={filters.to}
          min={filters.from || undefined}
          onChange={(e) => set({ to: e.target.value })}
        />
      </div>

      <div className="field">
        <label htmlFor="ts-team">Team</label>
        <select
          id="ts-team"
          className="select"
          value={filters.team}
          onChange={(e) => set({ team: e.target.value })}
        >
          <option value="">All teams</option>
          {teams.map((t) => (
            <option key={t} value={t}>
              Team {t}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label htmlFor="ts-role">Role</label>
        <select
          id="ts-role"
          className="select"
          value={filters.role}
          onChange={(e) => set({ role: e.target.value })}
        >
          <option value="">All roles</option>
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {capitalise(r)}
            </option>
          ))}
        </select>
      </div>

      <div className="field grow">
        <label htmlFor="ts-worker">Worker</label>
        <input
          id="ts-worker"
          className="input"
          type="search"
          placeholder="ID or name, e.g. W103"
          value={filters.worker}
          onChange={(e) => set({ worker: e.target.value })}
        />
      </div>

      <div className="field">
        <label htmlFor="ts-location">Location</label>
        <input
          id="ts-location"
          className="input"
          type="search"
          placeholder="e.g. Marina"
          value={filters.location}
          onChange={(e) => set({ location: e.target.value })}
        />
      </div>

      {dirty && (
        <div className="toolbar-actions">
          <Button variant="ghost" onClick={() => onChange(EMPTY_TIMESHEET_FILTERS)}>
            Clear
          </Button>
        </div>
      )}
    </div>
  );
}

function RoleCell({ role }: { role: TimesheetRole }) {
  if (role === "worker") return <span className="muted">worker</span>;
  return <span className="chip">{role}</span>;
}

function EntryRow({
  row,
  isAdmin,
  busy,
  edit,
  onEdit,
  onSave,
  onRole,
  onDelete,
  onOpen,
}: {
  row: TimesheetRow;
  isAdmin: boolean;
  busy: boolean;
  edit: EditState | null;
  onEdit: (next: EditState | null) => void;
  onSave: () => void;
  onRole: (role: TimesheetRole) => void;
  onDelete: () => void;
  onOpen: () => void;
}) {
  const editing = edit !== null;

  return (
    <tr>
      <td className="tnum nowrap">{formatDayShort(row.work_date)}</td>
      <td className="tnum">{row.team_number ?? "—"}</td>
      <td className="truncate" title={row.location ?? ""}>
        {row.location ?? "—"}
      </td>
      <td>
        <span className="row" style={{ gap: 6 }}>
          <span className="chip code" title={row.worker_code}>
            {row.worker_code}
          </span>
          {row.unresolved && (
            <StatusChip
              kind="warn"
              label="unknown ID"
              title="This code matches no registered worker. Set the code on the Workers page and the entry links itself."
            />
          )}
        </span>
      </td>
      <td className="truncate" title={row.worker_name ?? ""}>
        {row.worker_name ?? <span className="muted">not linked</span>}
      </td>
      <td>
        {isAdmin ? (
          <>
            <label className="sr-only" htmlFor={`ts-role-${row.entry_id}`}>
              Role for {row.worker_code}
            </label>
            <select
              id={`ts-role-${row.entry_id}`}
              className="select select-sm"
              value={row.role}
              onChange={(e) => onRole(e.target.value as TimesheetRole)}
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {capitalise(r)}
                </option>
              ))}
            </select>
          </>
        ) : (
          <RoleCell role={row.role} />
        )}
      </td>

      {editing ? (
        <td colSpan={2}>
          <div className="ts-editor">
            <div className="range-control" role="group" aria-label="Entry type">
              <button
                className={`range-btn${edit.mode === "hours" ? " active" : ""}`}
                aria-pressed={edit.mode === "hours"}
                onClick={() => onEdit({ ...edit, mode: "hours", value: "" })}
              >
                Hours
              </button>
              <button
                className={`range-btn${edit.mode === "absent" ? " active" : ""}`}
                aria-pressed={edit.mode === "absent"}
                onClick={() => onEdit({ ...edit, mode: "absent", value: "" })}
              >
                Absent
              </button>
            </div>
            <label className="sr-only" htmlFor={`ts-val-${row.entry_id}`}>
              {edit.mode === "hours" ? "Hours worked" : "Reason for absence"}
            </label>
            <input
              id={`ts-val-${row.entry_id}`}
              className="input input-sm"
              type={edit.mode === "hours" ? "number" : "text"}
              step={edit.mode === "hours" ? "0.5" : undefined}
              min={edit.mode === "hours" ? 0 : undefined}
              max={edit.mode === "hours" ? 24 : undefined}
              placeholder={edit.mode === "hours" ? "8.0" : "e.g. MC"}
              value={edit.value}
              autoFocus
              onChange={(e) => onEdit({ ...edit, value: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter") onSave();
                if (e.key === "Escape") onEdit(null);
              }}
            />
            <Button variant="primary" loading={busy} onClick={onSave}>
              Save
            </Button>
            <Button variant="ghost" onClick={() => onEdit(null)}>
              Cancel
            </Button>
          </div>
        </td>
      ) : (
        <>
          <td className="num tnum">{row.hours === null ? "" : row.hours.toFixed(1)}</td>
          <td>
            {row.absence_reason ? (
              <StatusChip kind="warn" label={row.absence_reason} />
            ) : (
              <span className="muted" aria-hidden="true">
                —
              </span>
            )}
          </td>
        </>
      )}

      <td>
        <div className="cell-actions">
          <Button variant="ghost" onClick={onOpen}>
            Roster
          </Button>
          {isAdmin && !editing && (
            <>
              <Button
                variant="ghost"
                onClick={() =>
                  onEdit({
                    entryId: row.entry_id,
                    mode: row.absence_reason ? "absent" : "hours",
                    value: row.absence_reason ?? (row.hours === null ? "" : String(row.hours)),
                  })
                }
              >
                Edit
              </Button>
              <Button variant="danger" onClick={onDelete}>
                Delete
              </Button>
            </>
          )}
        </div>
      </td>
    </tr>
  );
}

/** The whole roster behind one row, plus what the supervisor actually typed. */
function RosterModal({ row, onClose }: { row: TimesheetRow; onClose: () => void }) {
  const toast = useToast();
  const [sheet, setSheet] = useState<Timesheet | null>(null);
  const [entries, setEntries] = useState<TimesheetRow[] | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      const [head, list] = await Promise.all([
        supabase.from("timesheets").select("*").eq("id", row.timesheet_id).maybeSingle(),
        supabase
          .from("timesheet_rows")
          .select(TS_SELECT)
          .eq("timesheet_id", row.timesheet_id)
          .order("worker_code"),
      ]);
      if (!active) return;
      if (head.error) toast.error(head.error.message);
      if (list.error) toast.error(list.error.message);
      setSheet((head.data as Timesheet | null) ?? null);
      setEntries(
        ((list.data ?? []) as unknown as TimesheetRow[]).map((r) => ({
          ...r,
          hours: r.hours === null ? null : Number(r.hours),
        })),
      );
    })();
    return () => {
      active = false;
    };
  }, [row.timesheet_id, toast]);

  return (
    <Modal
      title={`Team ${row.team_number ?? "—"} · ${formatDay(row.work_date)}`}
      onClose={onClose}
      footer={
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      }
    >
      <div className="row" style={{ marginBottom: 12 }}>
        {row.location && (
          <span className="chip truncate" title={row.location}>
            {row.location}
          </span>
        )}
        {row.project_code && <span className="chip code">{row.project_code}</span>}
        <span className="chip">
          {row.submitted_by_name ? `sent by ${row.submitted_by_name}` : "sender unknown"}
        </span>
        {entries && <span className="chip tnum">{sumHours(entries).toFixed(1)}h</span>}
      </div>

      {entries === null ? (
        <SkeletonList rows={1} />
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Worker ID</th>
                <th>Name</th>
                <th>Role</th>
                <th className="num">Hours</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.entry_id}>
                  <td>
                    <span className="chip code">{e.worker_code}</span>
                  </td>
                  <td className="truncate" title={e.worker_name ?? ""}>
                    {e.worker_name ?? <span className="muted">not linked</span>}
                  </td>
                  <td>
                    <RoleCell role={e.role} />
                  </td>
                  <td className="num tnum">{e.hours === null ? "" : e.hours.toFixed(1)}</td>
                  <td>
                    {e.absence_reason ? (
                      <StatusChip kind="warn" label={e.absence_reason} />
                    ) : (
                      <span className="muted" aria-hidden="true">
                        —
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3 className="panel-title" style={{ marginTop: 20 }}>
        As received
      </h3>
      <p className="panel-sub">Exactly what the supervisor typed into Telegram.</p>
      {sheet?.raw_text ? (
        <pre className="raw-text">{sheet.raw_text}</pre>
      ) : (
        <p className="muted">No original message was stored for this roster.</p>
      )}
    </Modal>
  );
}
