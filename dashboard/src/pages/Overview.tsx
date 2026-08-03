import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  CircleAlert,
  Clock,
  FileText,
  Flag,
  Images,
  MapPin,
  UserPlus,
} from "lucide-react";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth";
import { Card } from "../components/Card";
import { SectionHeader } from "../components/SectionHeader";
import { Skeleton } from "../components/Skeleton";
import { EmptyState } from "../components/EmptyState";
import { StatCard } from "../components/StatCard";
import { useToast } from "../components/Toast";
import { ActivityChart } from "../components/charts/ActivityChart";
import { RankedBars } from "../components/charts/RankedBars";
import { MediaMixBar } from "../components/charts/MediaMixBar";
import type {
  DayVolumeRow,
  MediaMixRow,
  OverviewStats,
  ProjectVolumeRow,
  RoleHoursRow,
  WorkerHoursRow,
} from "../lib/types";

const RANGES = [7, 30, 90];

interface OverviewData {
  stats: OverviewStats;
  days: DayVolumeRow[];
  projects: ProjectVolumeRow[];
  workers: WorkerHoursRow[];
  roles: RoleHoursRow[];
  mix: MediaMixRow[];
}

const EMPTY_STATS: OverviewStats = {
  reports_7d: 0,
  reports_30d: 0,
  media_total: 0,
  media_7d: 0,
  active_workers: 0,
  pending_workers: 0,
  active_projects: 0,
  on_site_now: 0,
  open_flags: 0,
  hours_7d: 0,
};

export function OverviewPage() {
  const { isAdmin } = useAuth();
  const toast = useToast();
  const [days, setDays] = useState(30);
  const [data, setData] = useState<OverviewData | null>(null);

  useEffect(() => {
    let active = true;
    setData(null);

    void (async () => {
      // One round trip for the whole page — six aggregates, no waterfall.
      const [stats, byDay, byProject, byWorker, byRole, mix] = await Promise.all([
        supabase.rpc("overview_stats"),
        supabase.rpc("reports_by_day", { days }),
        supabase.rpc("reports_by_project", { days }),
        supabase.rpc("hours_by_worker", { days }),
        supabase.rpc("hours_by_role", { days }),
        supabase.rpc("media_mix", { days }),
      ]);
      if (!active) return;

      const failed = [stats, byDay, byProject, byWorker, byRole, mix].find((r) => r.error);
      if (failed?.error) toast.error(failed.error.message);

      const statRow = (stats.data as OverviewStats[] | null)?.[0];
      setData({
        stats: statRow
          ? {
              reports_7d: Number(statRow.reports_7d),
              reports_30d: Number(statRow.reports_30d),
              media_total: Number(statRow.media_total),
              media_7d: Number(statRow.media_7d),
              active_workers: Number(statRow.active_workers),
              pending_workers: Number(statRow.pending_workers),
              active_projects: Number(statRow.active_projects),
              on_site_now: Number(statRow.on_site_now),
              open_flags: Number(statRow.open_flags),
              hours_7d: Number(statRow.hours_7d),
            }
          : EMPTY_STATS,
        days: ((byDay.data ?? []) as DayVolumeRow[]).map((d) => ({
          day: d.day,
          reports: Number(d.reports),
          media: Number(d.media),
        })),
        projects: ((byProject.data ?? []) as ProjectVolumeRow[]).map((p) => ({
          ...p,
          reports: Number(p.reports),
          media: Number(p.media),
        })),
        workers: ((byWorker.data ?? []) as WorkerHoursRow[]).map((w) => ({
          ...w,
          hours: Number(w.hours),
          shifts: Number(w.shifts),
        })),
        roles: ((byRole.data ?? []) as RoleHoursRow[]).map((r) => ({
          ...r,
          hours: Number(r.hours),
          entries: Number(r.entries),
        })),
        mix: (mix.data ?? []) as MediaMixRow[],
      });
    })();

    return () => {
      active = false;
    };
  }, [days, toast]);

  return (
    <div className="reveal">
      <SectionHeader
        title="Overview"
        actions={
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
        }
      />

      {data === null ? (
        <OverviewSkeleton />
      ) : (
        <OverviewBody data={data} isAdmin={isAdmin} days={days} />
      )}
    </div>
  );
}

function OverviewSkeleton() {
  return (
    <div className="ov-grid" aria-busy="true" aria-label="Loading overview">
      <div className="ov-main">
        <div className="panel panel-p stack-tight">
          <Skeleton height={14} width="26%" />
          <Skeleton height={230} radius={12} />
        </div>
        <div className="two-up">
          {Array.from({ length: 2 }, (_, i) => (
            <div key={i} className="panel panel-p stack-tight">
              <Skeleton height={14} width="34%" />
              <Skeleton height={150} radius={12} />
            </div>
          ))}
        </div>
      </div>
      <div className="ov-rail">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="panel panel-p stack-tight">
            <Skeleton height={12} width="52%" />
            <Skeleton height={30} width="40%" />
            <Skeleton height={12} width="66%" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Staff see the same row without a link — the target pages are admin-only. */
function AttnText({ to, title, sub }: { to?: string; title: string; sub: string }) {
  const body = (
    <>
      <span className="t truncate">{title}</span>
      <span className="s truncate">{sub}</span>
    </>
  );
  return to ? (
    <Link className="attn-text" to={to}>
      {body}
    </Link>
  ) : (
    <span className="attn-text">{body}</span>
  );
}

function AttentionBanner({
  pending,
  flags,
  isAdmin,
}: {
  pending: number;
  flags: number;
  isAdmin: boolean;
}) {
  const target = flags > 0 ? "/attendance" : "/workers";
  const parts: string[] = [];
  if (flags > 0) parts.push(`${flags} attendance flag${flags === 1 ? "" : "s"} open`);
  if (pending > 0) parts.push(`${pending} worker${pending === 1 ? "" : "s"} waiting for approval`);

  return (
    <div className="banner">
      <span className="banner-icon" aria-hidden="true">
        <CircleAlert size={20} strokeWidth={1.75} aria-hidden="true" />
      </span>
      <div className="banner-text">
        <p className="t">Needs attention</p>
        <p className="s">{parts.join(" · ")}</p>
      </div>
      {isAdmin && (
        <Link className="btn btn-white" to={target}>
          Review now
        </Link>
      )}
    </div>
  );
}

function OverviewBody({
  data,
  isAdmin,
  days,
}: {
  data: OverviewData;
  isAdmin: boolean;
  days: number;
}) {
  const { stats, projects, workers, roles, mix } = data;
  const attention = stats.pending_workers > 0 || stats.open_flags > 0;
  // Sparklines reuse the series already on screen — no extra query, no invention.
  const reportSeries = data.days.map((d) => d.reports);
  const mediaSeries = data.days.map((d) => d.media);

  return (
    <>
      {attention && (
        <AttentionBanner
          pending={stats.pending_workers}
          flags={stats.open_flags}
          isAdmin={isAdmin}
        />
      )}

      <div className="ov-grid">
        <div className="ov-main">
          <Card>
            <div className="card-head">
              <h2 className="panel-title">Activity</h2>
              <span className="card-head-end muted" style={{ fontSize: "0.8rem" }}>
                Last {days} days
              </span>
            </div>
            <ActivityChart data={data.days} />
          </Card>

          <div className="two-up">
            <Card>
              <h2 className="panel-title">Busiest sites</h2>
              <p className="panel-sub">Reports per project</p>
              <RankedBars
                label={`Reports per project over the last ${days} days`}
                items={projects.map((p) => ({
                  key: String(p.project_id),
                  label: p.code,
                  title: `${p.code} — ${p.name}`,
                  value: p.reports,
                }))}
                emptyTitle="No reports in this window"
                emptyHint="Widen the range, or wait for the next site report."
              />
            </Card>

            <Card>
              <h2 className="panel-title">Hours by worker</h2>
              <p className="panel-sub">Completed shifts</p>
              {!isAdmin && workers.length === 0 ? (
                <EmptyState
                  title="Admin-only data"
                  hint="Attendance hours are visible to administrators. Ask an admin if you need these numbers."
                />
              ) : (
                <RankedBars
                  label={`Hours per worker over the last ${days} days`}
                  items={workers.map((w) => ({
                    key: String(w.worker_id),
                    label: w.full_name,
                    title: `${w.full_name} — ${w.shifts} shifts`,
                    value: w.hours,
                  }))}
                  format={(v) => `${v.toFixed(1)}h`}
                  emptyTitle="No completed shifts"
                  emptyHint="Hours appear once workers check out of a shift."
                />
              )}
            </Card>
          </div>

          <Card>
            <h2 className="panel-title">Hours by role</h2>
            <p className="panel-sub">Timesheet hours per trade</p>
            <RankedBars
              label={`Timesheet hours per role over the last ${days} days`}
              items={roles.map((r) => ({
                key: r.role,
                label: r.role.charAt(0).toUpperCase() + r.role.slice(1),
                title: `${r.role} — ${r.entries} entries`,
                value: r.hours,
              }))}
              format={(v) => `${v.toFixed(1)}h`}
              emptyTitle="No timesheet hours yet"
              emptyHint="Hours appear once supervisors send a daily roster from Telegram."
            />
          </Card>

          <Card>
            <h2 className="panel-title">Media mix</h2>
            <p className="panel-sub">What arrived in the last {days} days</p>
            <MediaMixBar rows={mix} />
          </Card>
        </div>

        <div className="ov-rail">
          <StatCard
            label="Reports this week"
            value={String(stats.reports_7d)}
            sub={`${stats.reports_30d} in the last 30 days`}
            icon={<FileText size={20} strokeWidth={1.75} aria-hidden="true" />}
            spark={reportSeries}
            sparkColor="var(--series-1)"
          />
          <StatCard
            label="Photos & files"
            value={String(stats.media_total)}
            sub={`+${stats.media_7d} this week`}
            icon={<Images size={20} strokeWidth={1.75} aria-hidden="true" />}
            spark={mediaSeries}
            sparkColor="var(--series-2)"
          />
          <StatCard
            label="On site now"
            value={String(stats.on_site_now)}
            sub={`${stats.active_workers} active workers`}
            tone={stats.on_site_now > 0 ? "ok" : "blue"}
            to={isAdmin ? "/attendance" : undefined}
            linkLabel="Open attendance"
            icon={<MapPin size={20} strokeWidth={1.75} aria-hidden="true" />}
          />
          <StatCard
            label="Hours logged (7d)"
            value={stats.hours_7d.toFixed(1)}
            sub={`across ${stats.active_projects} active sites`}
            icon={<Clock size={20} strokeWidth={1.75} aria-hidden="true" />}
            to="/timesheets"
            linkLabel="Open timesheets"
          />

          <Card>
            <div className="card-head" style={{ marginBottom: 4 }}>
              <h2 className="panel-title">Needs attention</h2>
              {isAdmin && attention && (
                <Link className="btn btn-ghost card-head-end" to="/attendance">
                  View all
                </Link>
              )}
            </div>
            {!attention ? (
              <p className="panel-sub" style={{ marginBottom: 0 }}>
                No pending approvals and no open attendance flags
              </p>
            ) : (
              <ul className="attn-list">
                {stats.open_flags > 0 && (
                  <li className="attn-row">
                    <span className="attn-icon flag" aria-hidden="true">
                      <Flag size={18} strokeWidth={1.75} aria-hidden="true" />
                    </span>
                    <AttnText
                      to={isAdmin ? "/attendance" : undefined}
                      title="Attendance flags to review"
                      sub="Check-ins outside the allowed distance"
                    />
                    <span className="attn-meta">{stats.open_flags} open</span>
                  </li>
                )}
                {stats.pending_workers > 0 && (
                  <li className="attn-row">
                    <span className="attn-icon warn" aria-hidden="true">
                      <UserPlus size={18} strokeWidth={1.75} aria-hidden="true" />
                    </span>
                    <AttnText
                      to={isAdmin ? "/workers" : undefined}
                      title="Worker approvals waiting"
                      sub="New Telegram registrations"
                    />
                    <span className="attn-meta">{stats.pending_workers} pending</span>
                  </li>
                )}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
