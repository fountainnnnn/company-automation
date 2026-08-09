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
  Video,
} from "lucide-react";
import { EmptyState } from "../components/EmptyState";
import { FocusPanel } from "../components/FocusPanel";
import { SectionHeader } from "../components/SectionHeader";
import { SiteMap, type MapPoint } from "../components/SiteMap";
import { Skeleton } from "../components/Skeleton";
import { Sparkline } from "../components/Sparkline";
import { useToast } from "../components/Toast";
import { useAuth } from "../lib/auth";
import {
  formatDayShort,
  formatRelative,
  formatTime,
  toSgtDay,
} from "../lib/format";
import { REPORT_SELECT, signReportMedia } from "../lib/reports";
import { supabase } from "../lib/supabase";
import type {
  DayVolumeRow,
  OverviewStats,
  Project,
  Report,
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
  workers_7d: 0,
  undescribed_7d: 0,
  workers_no_code: 0,
  silent_sites: 0,
};

interface OverviewData {
  stats: OverviewStats;
  days: DayVolumeRow[];
  projects: Project[];
  reports: Report[];
  signedUrls: Record<string, string>;
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
  const { profile } = useAuth();
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
      ]);

      if (!active) return;
      const failed = [
        statsResult,
        daysResult,
        projectsResult,
        reportsResult,
      ].find((result) => result.error);
      if (failed?.error) toast.error(failed.error.message);

      const reports = (reportsResult.data ?? []) as unknown as Report[];
      const signedUrls = await signReportMedia(reports);
      if (!active) return;

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
        <CommandSkeleton />
      ) : (
        <CommandBoard data={data} />
      )}
    </div>
  );
}

function CommandSkeleton() {
  return (
    <div className="command-board" aria-busy="true" aria-label="Loading operations overview">
      <div className="command-metrics glass-panel"><Skeleton height={72} radius={12} /></div>
      <div className="command-map glass-panel"><Skeleton height={330} radius={14} /></div>
      <div className="command-focus glass-panel"><Skeleton height={120} radius={12} /></div>
      <div className="command-sites glass-panel"><Skeleton height={260} radius={12} /></div>
    </div>
  );
}

function CommandBoard({ data }: { data: OverviewData }) {
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
        <Metric label="Active sites" value={String(stats.active_projects)} sub={`${stats.active_workers} workers`} />
        <Metric label="Reports this week" value={String(stats.reports_7d)} sub={`${stats.reports_30d} in 30d`} trend={trend} />
        <Metric label="Workers reporting" value={String(stats.workers_7d)} sub="last 7 days" />
        <Metric label="Files received" value={String(stats.media_7d)} sub={`${stats.media_total} total`} trend={mediaTrend} />
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

      <ReviewQueue stats={stats} />

      <FocusPanel />

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

function reportActivityIcon(report: Report): ReactNode {
  const mediaTypes = report.report_media?.map((item) => item.media_type) ?? [];
  if (mediaTypes.includes("photo")) return <Camera size={15} strokeWidth={1.8} />;
  if (mediaTypes.includes("video")) return <Video size={15} strokeWidth={1.8} />;
  if (mediaTypes.includes("document")) return <FileText size={15} strokeWidth={1.8} />;
  return <MessageSquareText size={15} strokeWidth={1.8} />;
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

/**
 * The deterministic half of "what needs attention": exact counts with a link to
 * the place you fix them. The briefing above reasons in prose; this does not
 * guess. Items only render when they have something to say.
 */
function ReviewQueue({ stats }: { stats: OverviewStats }) {
  const items = [
    stats.undescribed_7d > 0 && {
      key: "undescribed",
      icon: <FileText className="review-mark" size={30} strokeWidth={1.5} aria-hidden="true" />,
      category: "Archive quality",
      count: stats.undescribed_7d,
      label: stats.undescribed_7d === 1 ? "record undescribed" : "records undescribed",
      detail: "Filed this week with no note — findable by date, not by content",
      to: "/search",
    },
    stats.silent_sites > 0 && {
      key: "silent",
      icon: <Clock3 className="review-mark" size={30} strokeWidth={1.5} aria-hidden="true" />,
      category: "Site coverage",
      count: stats.silent_sites,
      label: stats.silent_sites === 1 ? "site silent" : "sites silent",
      detail: "Nothing filed in the last 48 hours",
      to: "/projects",
    },
  ].filter(Boolean) as Array<{
    key: string;
    icon: ReactNode;
    category: string;
    count: number;
    label: string;
    detail: string;
    to: string;
  }>;

  return (
    <section className="command-review glass-panel" aria-labelledby="review-title">
      <div className="command-panel-head">
        <h3 id="review-title">Needs review</h3>
      </div>
      {items.length === 0 ? (
        <div className="review-clear">
          <span><Check size={19} aria-hidden="true" /></span>
          <strong>Queue clear</strong>
          <p>Nothing is waiting on you.</p>
        </div>
      ) : (
        <div className="review-list">
          {items.map((item) => (
            <article className="review-item" key={item.key}>
              {item.icon}
              <p className="review-category">{item.category}</p>
              <div className="review-title-row">
                <strong>{item.count}</strong>
                <h4>{item.label}</h4>
              </div>
              <p className="review-detail">{item.detail}</p>
              <Link className="review-action" to={item.to}>
                Open <ArrowUpRight size={14} aria-hidden="true" />
              </Link>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
