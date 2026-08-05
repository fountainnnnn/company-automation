import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  ArrowUpRight,
  Camera,
  Check,
  Clock3,
  FileText,
  MessageSquareText,
  RefreshCw,
  Video,
} from "lucide-react";
import { EmptyState } from "../components/EmptyState";
import { SectionHeader } from "../components/SectionHeader";
import { SiteMap, type MapPoint } from "../components/SiteMap";
import { Skeleton } from "../components/Skeleton";
import { Sparkline } from "../components/Sparkline";
import { useToast } from "../components/Toast";
import { RankedBars, type BarItem } from "../components/charts/RankedBars";
import { StackedHoursChart } from "../components/charts/StackedHoursChart";
import { useAuth } from "../lib/auth";
import {
  formatDayShort,
  formatHours,
  formatMoney,
  formatRelative,
  formatTime,
  toSgtDay,
} from "../lib/format";
import { REPORT_SELECT, signReportMedia } from "../lib/reports";
import { supabase } from "../lib/supabase";
import type {
  DayVolumeRow,
  OtDayRow,
  OverviewStats,
  Project,
  ProjectCostRow,
  PayrollRow,
  Report,
  TeamHoursRow,
  TimesheetStats,
} from "../lib/types";

const RANGES = [7, 30, 90];
const FALLBACK_IMAGES = [
  "/site-fallbacks/site-crane.webp",
  "/site-fallbacks/site-structure.webp",
  "/site-fallbacks/site-survey.webp",
];

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

interface OverviewData {
  stats: OverviewStats;
  days: DayVolumeRow[];
  projects: Project[];
  reports: Report[];
  signedUrls: Record<string, string>;
  teams: TeamHoursRow[];
  costs: ProjectCostRow[];
  otDays: OtDayRow[];
  timesheetExceptions: number;
  payrollExceptions: number;
  range: number;
}

interface SiteCard {
  project: Project;
  report: Report | undefined;
  image: string;
  uploaded: boolean;
}

function fallbackFor(project: Project): string {
  const key = `${project.id}:${project.code}`;
  const hash = Array.from(key).reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return FALLBACK_IMAGES[hash % FALLBACK_IMAGES.length];
}

function normaliseStats(row: OverviewStats | undefined): OverviewStats {
  if (!row) return EMPTY_STATS;
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, Number(value)]),
  ) as unknown as OverviewStats;
}

function firstName(value: string | null | undefined): string {
  return value?.trim().split(/\s+/)[0] || "there";
}

export function OverviewPage() {
  const { profile, isAdmin } = useAuth();
  const toast = useToast();
  const [range, setRange] = useState(30);
  const [data, setData] = useState<OverviewData | null>(null);

  useEffect(() => {
    let active = true;
    setData(null);

    void (async () => {
      const [
        statsResult,
        daysResult,
        projectsResult,
        reportsResult,
        teamsResult,
        costResult,
        otResult,
        timesheetResult,
        payrollResult,
      ] = await Promise.all([
        supabase.rpc("overview_stats"),
        supabase.rpc("reports_by_day", { days: range }),
        supabase
          .from("projects")
          .select("id,code,name,site_address,site_lat,site_lng,status,created_at")
          .eq("status", "active")
          .order("code"),
        supabase
          .from("reports")
          .select(REPORT_SELECT)
          .order("created_at", { ascending: false })
          .limit(24),
        supabase.rpc("hours_by_team", { days: range }),
        // The two pay RPCs read attendance, which RLS closes to staff — they come
        // back empty there and their sections are simply not rendered.
        supabase.rpc("cost_by_project", { days: range }),
        supabase.rpc("ot_by_day", { days: range }),
        supabase.rpc("timesheet_stats", { days: range }),
        supabase.rpc("payroll_summary", {
          from_date: toSgtDay(new Date(Date.now() - (range - 1) * 86_400_000)),
          to_date: toSgtDay(new Date()),
        }),
      ]);

      if (!active) return;
      const failed = [
        statsResult,
        daysResult,
        projectsResult,
        reportsResult,
        teamsResult,
        costResult,
        otResult,
        timesheetResult,
        payrollResult,
      ].find((result) => result.error);
      if (failed?.error) toast.error(failed.error.message);

      const reports = (reportsResult.data ?? []) as unknown as Report[];
      const signedUrls = await signReportMedia(reports);
      if (!active) return;
      const timesheetStats = (timesheetResult.data as TimesheetStats[] | null)?.[0];
      const payrollRows = (payrollResult.data ?? []) as PayrollRow[];

      setData({
        stats: normaliseStats((statsResult.data as OverviewStats[] | null)?.[0]),
        days: ((daysResult.data ?? []) as DayVolumeRow[]).map((day) => ({
          ...day,
          reports: Number(day.reports),
          media: Number(day.media),
        })),
        projects: (projectsResult.data ?? []) as unknown as Project[],
        reports,
        signedUrls,
        teams: ((teamsResult.data ?? []) as TeamHoursRow[]).map((team) => ({
          ...team,
          hours: Number(team.hours),
          entries: Number(team.entries),
          absences: Number(team.absences),
          workers: Number(team.workers),
        })),
        costs: ((costResult.data ?? []) as ProjectCostRow[]).map((row) => ({
          ...row,
          hours: Number(row.hours),
          ot_hours: Number(row.ot_hours),
          gross_pay: Number(row.gross_pay),
        })),
        otDays: ((otResult.data ?? []) as OtDayRow[]).map((row) => ({
          ...row,
          normal_hours: Number(row.normal_hours),
          ot_hours: Number(row.ot_hours),
        })),
        timesheetExceptions: Number(timesheetStats?.unresolved ?? 0),
        payrollExceptions: payrollRows.reduce(
          (total, row) =>
            total + (row.hourly_rate === null ? 1 : 0) + Number(row.missing_checkout ?? 0),
          0,
        ),
        range,
      });
    })();

    return () => {
      active = false;
    };
  }, [range, toast]);

  return (
    <div className="command-overview reveal">
      <SectionHeader title="Overview" />
      <div className="command-heading">
        <div>
          <p className="command-kicker">Operations overview</p>
          <h2>Good morning, {firstName(profile?.full_name)}.</h2>
          <p className="command-summary">
            {data?.stats.active_projects ?? 0} active sites <span aria-hidden="true">·</span>{" "}
            Singapore
          </p>
        </div>
        <div className="command-range" role="group" aria-label="Overview time range">
          {RANGES.map((days) => (
            <button
              key={days}
              type="button"
              aria-pressed={days === range}
              className={days === range ? "active" : ""}
              onClick={() => setRange(days)}
            >
              {days} days
            </button>
          ))}
        </div>
      </div>

      {data === null ? (
        <CommandSkeleton isAdmin={isAdmin} />
      ) : (
        <CommandBoard data={data} isAdmin={isAdmin} />
      )}
    </div>
  );
}

function CommandSkeleton({ isAdmin }: { isAdmin: boolean }) {
  return (
    <div className="command-board" aria-busy="true" aria-label="Loading operations overview">
      <div className="command-metrics glass-panel"><Skeleton height={72} radius={12} /></div>
      <div className="command-analytics">
        <Skeleton height={34} width="24%" />
        <div className="command-charts">
          <div className="command-chart glass-panel"><Skeleton height={250} radius={12} /></div>
          {isAdmin && (
            <>
              <div className="command-chart glass-panel"><Skeleton height={250} radius={12} /></div>
              <div className="command-chart command-ot glass-panel"><Skeleton height={250} radius={12} /></div>
            </>
          )}
        </div>
      </div>
      <div className="command-map glass-panel"><Skeleton height={330} radius={14} /></div>
      <div className="command-review glass-panel"><Skeleton height={330} radius={14} /></div>
      <div className="command-sites glass-panel"><Skeleton height={260} radius={12} /></div>
      <div className="command-activity glass-panel"><Skeleton height={260} radius={12} /></div>
    </div>
  );
}

function CommandBoard({ data, isAdmin }: { data: OverviewData; isAdmin: boolean }) {
  const { stats } = data;

  const mapPoints = useMemo<MapPoint[]>(
    () =>
      data.projects
        .filter(
          (project) =>
            project.site_lat !== null &&
            project.site_lng !== null &&
            Number.isFinite(Number(project.site_lat)) &&
            Number.isFinite(Number(project.site_lng)),
        )
        .map((project, index) => ({
          lat: Number(project.site_lat),
          lng: Number(project.site_lng),
          kind: "site" as const,
          number: index + 1,
          label: `${project.code} · ${project.name}`,
          sub: project.site_address || "Active project",
        })),
    [data.projects],
  );

  const siteCards = useMemo<SiteCard[]>(() => {
    const latestByProject = new Map<string, Report>();
    for (const report of data.reports) {
      const key = String(report.project_id);
      if (!latestByProject.has(key)) latestByProject.set(key, report);
    }

    return data.projects
      .map((project) => {
        const report = latestByProject.get(String(project.id));
        const photo = report?.report_media?.find(
          (media) => media.media_type === "photo" && data.signedUrls[media.storage_path],
        );
        return {
          project,
          report,
          image: photo ? data.signedUrls[photo.storage_path] : fallbackFor(project),
          uploaded: Boolean(photo),
        };
      })
      .sort((a, b) => {
        const at = a.report?.created_at ?? "";
        const bt = b.report?.created_at ?? "";
        return bt.localeCompare(at);
      })
      .slice(0, 3);
  }, [data.projects, data.reports, data.signedUrls]);

  const teamBars = useMemo<BarItem[]>(
    () =>
      data.teams.map((team) => {
        const name = team.team_number === "—" ? "Unassigned" : `Team ${team.team_number}`;
        return {
          key: team.team_number,
          label: name,
          title: name,
          value: team.hours,
          sub: `${plural(team.workers, "worker")} · ${plural(team.absences, "absence")}`,
        };
      }),
    [data.teams],
  );

  const costBars = useMemo<BarItem[]>(
    () =>
      data.costs.map((row) => ({
        key: String(row.project_id),
        label: row.code,
        title: `${row.code} · ${row.name}`,
        value: row.gross_pay,
        sub: `${formatHours(row.hours)}h · ${formatHours(row.ot_hours)}h OT`,
      })),
    [data.costs],
  );

  const trend = data.days.slice(-12).map((day) => day.reports);
  const mediaTrend = data.days.slice(-12).map((day) => day.media);
  const mapped = mapPoints.length;

  return (
    <div className="command-board">
      <section className="command-metrics glass-panel" aria-label="Today at a glance">
        <div className="metric-intro">
          <strong>Today</strong>
          <span>{formatDayShort(toSgtDay(new Date()))}</span>
        </div>
        <Metric label="Workers on site" value={String(stats.on_site_now)} sub={`${stats.active_workers} active`} />
        <Metric label="Reports this week" value={String(stats.reports_7d)} sub={`${stats.reports_30d} in 30d`} trend={trend} />
        <Metric label="Hours logged" value={stats.hours_7d.toFixed(1)} sub="last 7 days" />
        <Metric label="Files received" value={String(stats.media_7d)} sub={`${stats.media_total} total`} trend={mediaTrend} />
      </section>

      <section className="command-analytics" aria-labelledby="workforce-insights-title">
        <div className="command-section-heading">
          <div>
            <p className="command-section-kicker">Workforce intelligence</p>
            <h3 id="workforce-insights-title">Performance and labour</h3>
          </div>
          <span>Last {data.range} days</span>
        </div>

        <div className="command-charts">
          <ChartPanel
            id="team-hours-title"
            title="Team performance"
            subtitle="Hours logged by active crew"
          >
            <RankedBars
              items={teamBars}
              label="Hours logged per team"
              format={(v) => `${formatHours(v)}h`}
              emptyTitle="No timesheets in this window"
              emptyHint="Crew hours appear once a supervisor files the daily roster."
            />
          </ChartPanel>

          {isAdmin && (
            <ChartPanel
              id="site-cost-title"
              title="Labour cost by site"
              subtitle="Gross pay from completed shifts"
            >
              <RankedBars
                items={costBars.slice(0, 4)}
                label="Gross pay per site"
                format={(v) => formatMoney(v, { cents: false })}
                emptyTitle="No priced shifts in this window"
                emptyHint="Pay is counted once a shift is checked out and the worker has a rate."
              />
            </ChartPanel>
          )}

          {isAdmin && (
            <ChartPanel
              id="ot-trend-title"
              className="command-ot"
              title="Overtime trend"
              subtitle="Normal and overtime hours by week"
            >
              <StackedHoursChart data={data.otDays} />
            </ChartPanel>
          )}
        </div>
      </section>

      <section className="command-map glass-panel" aria-labelledby="live-sites-title">
        <div className="command-panel-head map-head">
          <div>
            <h3 id="live-sites-title">Live sites</h3>
          </div>
          <span>{mapped} mapped of {data.projects.length} active</span>
        </div>
        <SiteMap points={mapPoints} height={330} className="overview-site-map" />
      </section>

      <ReviewQueue
        stats={stats}
        timesheetExceptions={data.timesheetExceptions}
        payrollExceptions={data.payrollExceptions}
        isAdmin={isAdmin}
      />

      <section className="command-sites glass-panel" aria-labelledby="latest-sites-title">
        <div className="command-panel-head">
          <h3 id="latest-sites-title">Latest from site</h3>
          <Link to="/projects">View all site activity <ArrowUpRight size={15} aria-hidden="true" /></Link>
        </div>
        {siteCards.length === 0 ? (
          <EmptyState title="No active sites yet" hint="Create a project to begin the live site feed." />
        ) : (
          <div className="site-card-row">
            {siteCards.map(({ project, report, image, uploaded }) => (
              <Link className="site-visual" to={`/projects/${project.id}`} key={project.id}>
                <img src={image} alt={`${project.name} construction site`} />
                <div className="site-visual-body">
                  <div>
                    <strong>{project.code}</strong>
                    <span className={`source-badge${uploaded ? " uploaded" : ""}`}>
                      {uploaded ? "Site upload" : "Project cover"}
                    </span>
                  </div>
                  <p>{project.name}</p>
                  <span>
                    {report?.workers?.full_name || "No report yet"}
                    {report ? ` · ${formatTime(report.created_at)}` : ""}
                  </span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>

      <section className="command-activity glass-panel" aria-labelledby="activity-title">
        <div className="command-panel-head">
          <h3 id="activity-title">Activity timeline</h3>
          <Link to="/search">View full timeline <ArrowUpRight size={15} aria-hidden="true" /></Link>
        </div>
        {data.reports.length === 0 ? (
          <EmptyState title="No reports yet" hint="New Telegram submissions will appear here." />
        ) : (
          <ol className="command-timeline">
            {data.reports.slice(0, 5).map((report) => (
              <li key={report.id}>
                <time dateTime={report.created_at}>
                  <span>{formatDayShort(toSgtDay(new Date(report.created_at)))}</span>
                  <strong>{formatTime(report.created_at)}</strong>
                </time>
                <div className="timeline-copy">
                  <Link to={`/projects/${report.project_id}`}>
                    <strong>{report.projects?.code || "Site"}</strong>
                    <span> report submitted</span>
                  </Link>
                  <span>
                    {report.workers?.full_name || "Telegram submission"}
                    <i aria-hidden="true">·</i>
                    {formatRelative(report.created_at)}
                  </span>
                </div>
                <span className="timeline-type-icon" aria-hidden="true">
                  {reportActivityIcon(report)}
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>

    </div>
  );
}

function ChartPanel({
  id,
  title,
  subtitle,
  className = "",
  children,
}: {
  id: string;
  title: string;
  subtitle: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={`command-chart glass-panel ${className}`.trim()} aria-labelledby={id}>
      <div className="command-panel-head">
        <div className="command-panel-title">
          <h3 id={id}>{title}</h3>
          <p>{subtitle}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

function plural(count: number, one: string): string {
  return `${count} ${count === 1 ? one : `${one}s`}`;
}

function reportActivityIcon(report: Report): ReactNode {
  const mediaTypes = report.report_media?.map((item) => item.media_type) ?? [];
  if (mediaTypes.includes("photo")) return <Camera size={15} strokeWidth={1.8} />;
  if (mediaTypes.includes("video")) return <Video size={15} strokeWidth={1.8} />;
  if (mediaTypes.includes("document")) return <FileText size={15} strokeWidth={1.8} />;
  return <MessageSquareText size={15} strokeWidth={1.8} />;
}

function ReviewQueue({
  stats,
  timesheetExceptions,
  payrollExceptions,
  isAdmin,
}: {
  stats: OverviewStats;
  timesheetExceptions: number;
  payrollExceptions: number;
  isAdmin: boolean;
}) {
  const clear =
    stats.open_flags === 0 &&
    timesheetExceptions === 0 &&
    (!isAdmin || payrollExceptions === 0);
  return (
    <section className="command-review glass-panel" aria-labelledby="review-title">
      <div className="command-panel-head">
        <h3 id="review-title">Needs review</h3>
      </div>
      {clear ? (
        <div className="review-clear">
          <span><Check size={19} aria-hidden="true" /></span>
          <strong>Queue clear</strong>
          <p>No attendance, timesheet, or payroll issues are waiting.</p>
        </div>
      ) : (
        <div className="review-list">
          {stats.open_flags > 0 && (
            <ReviewItem
              iconSrc="/ui-icons/attendance-review-transparent.png"
              category="Attendance control"
              count={stats.open_flags}
              label="attendance flags"
              detail="Location checks need review"
              to={isAdmin ? "/attendance" : undefined}
            />
          )}
          {timesheetExceptions > 0 && (
            <ReviewItem
              iconSrc="/ui-icons/timesheet-exception.svg"
              category="Timesheet control"
              count={timesheetExceptions}
              label={timesheetExceptions === 1 ? "unresolved entry" : "unresolved entries"}
              detail="Worker IDs need matching"
              to="/timesheets"
            />
          )}
          {isAdmin && payrollExceptions > 0 && (
            <ReviewItem
              iconSrc="/ui-icons/payroll-readiness.svg"
              category="Payroll readiness"
              count={payrollExceptions}
              label={payrollExceptions === 1 ? "payroll issue" : "payroll issues"}
              detail="Missing rates or checkout times"
              to="/payroll"
            />
          )}
        </div>
      )}
      <div className="review-updated"><RefreshCw size={13} aria-hidden="true" /> Live data</div>
    </section>
  );
}

function ReviewItem({
  iconSrc,
  category,
  count,
  label,
  detail,
  to,
}: {
  iconSrc: string;
  category: string;
  count: number;
  label: string;
  detail: string;
  to?: string;
}) {
  return (
    <article className="review-item">
      <img className="review-mark" src={iconSrc} alt="" aria-hidden="true" />
      <p className="review-category">{category}</p>
      <div className="review-title-row">
        <strong>{count}</strong>
        <h4>{label}</h4>
      </div>
      <p className="review-detail">{detail}</p>
      {to && (
        <Link className="review-action" to={to}>
          Review queue <ArrowUpRight size={14} aria-hidden="true" />
        </Link>
      )}
    </article>
  );
}

function Metric({
  label,
  value,
  sub,
  trend,
}: {
  label: string;
  value: string;
  sub: string;
  trend?: number[];
}) {
  return (
    <div className="command-metric">
      <div>
        <strong>{value}</strong>
        <span>{label}</span>
        <small>{sub}</small>
      </div>
      {trend && trend.length > 1 ? (
        <Sparkline values={trend} color="var(--blue)" title={`${label} trend`} />
      ) : (
        <Clock3 size={18} aria-hidden="true" />
      )}
    </div>
  );
}
