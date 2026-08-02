import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth";
import { formatDay, formatWeekday } from "../lib/format";
import {
  fetchReportById,
  fetchReports,
  groupByDate,
  mediaOf,
  PAGE_SIZE,
  signReportMedia,
  visibleReports,
} from "../lib/reports";
import { EMPTY_FILTERS } from "../lib/types";
import { useDebounced } from "../lib/useDebounced";
import type { Filters, Project, Report, Worker } from "../lib/types";
import { SectionHeader } from "../components/SectionHeader";
import { FilterBar } from "../components/FilterBar";
import { ReportCard } from "../components/ReportCard";
import { SkeletonList } from "../components/Skeleton";
import { EmptyState } from "../components/EmptyState";
import { Button } from "../components/Button";
import { useToast } from "../components/Toast";

export function GalleryPage() {
  const { id = "" } = useParams();
  const { isAdmin } = useAuth();
  const toast = useToast();

  const [project, setProject] = useState<Project | null>(null);
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const query = useDebounced(filters, 300);
  const [reports, setReports] = useState<Report[] | null>(null);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const reportIds = useRef<Set<string>>(new Set());

  useEffect(() => {
    let active = true;
    void (async () => {
      const [proj, wk] = await Promise.all([
        supabase.from("projects").select("*").eq("id", id).maybeSingle(),
        supabase.from("workers").select("*").order("full_name"),
      ]);
      if (!active) return;
      if (proj.data) setProject(proj.data as Project);
      setWorkers((wk.data ?? []) as Worker[]);
    })();
    return () => {
      active = false;
    };
  }, [id]);

  const mergeUrls = useCallback(async (rows: Report[]) => {
    const signed = await signReportMedia(rows);
    setUrls((prev) => ({ ...prev, ...signed }));
  }, []);

  const load = useCallback(async () => {
    setReports(null);
    const page = await fetchReports(query, id, 0);
    if (page.error) toast.error(page.error);
    reportIds.current = new Set(page.rows.map((r) => r.id));
    setReports(page.rows);
    setHasMore(page.hasMore);
    void mergeUrls(page.rows);
  }, [query, id, toast, mergeUrls]);

  useEffect(() => {
    void load();
  }, [load]);

  async function loadMore() {
    if (!reports) return;
    setLoadingMore(true);
    const page = await fetchReports(query, id, reports.length);
    setLoadingMore(false);
    if (page.error) {
      toast.error(page.error);
      return;
    }
    const added = page.rows.filter((r) => !reportIds.current.has(r.id));
    for (const r of added) reportIds.current.add(r.id);
    setReports((prev) => [...(prev ?? []), ...added]);
    setHasMore(page.hasMore);
    void mergeUrls(added);
  }

  const upsertReport = useCallback(
    (row: Report, markFresh: boolean) => {
      setReports((prev) => {
        const list = prev ?? [];
        const at = list.findIndex((r) => r.id === row.id);
        if (at >= 0) {
          const next = [...list];
          next[at] = row;
          return next;
        }
        return [row, ...list];
      });
      reportIds.current.add(row.id);
      if (markFresh) {
        setFresh((prev) => new Set(prev).add(row.id));
      }
      void mergeUrls([row]);
    },
    [mergeUrls],
  );

  // Realtime: new reports for this project, and media landing on loaded reports.
  useEffect(() => {
    if (!id) return;
    const channel = supabase
      .channel(`gallery-${id}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "reports",
          filter: `project_id=eq.${id}`,
        },
        (payload) => {
          const row = payload.new as { id: string };
          void fetchReportById(row.id).then((full) => {
            if (full) upsertReport(full, true);
          });
        },
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "report_media" },
        (payload) => {
          const row = payload.new as { report_id: string };
          if (!reportIds.current.has(row.report_id)) return;
          void fetchReportById(row.report_id).then((full) => {
            if (full) upsertReport(full, false);
          });
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [id, upsertReport]);

  const shown = reports ? visibleReports(reports, filters.mediaType) : [];
  const groups = groupByDate(shown);
  const mediaTotal = shown.reduce((n, r) => n + mediaOf(r, filters.mediaType).length, 0);

  return (
    <div className="reveal">
      <SectionHeader
        eyebrow={project?.code ?? "Project"}
        title={project ? `${project.name}.` : "Loading project…"}
        subtitle={
          project?.site_address ||
          "Every report filed against this site, newest first — filter to narrow it down."
        }
        actions={
          <Link className="btn btn-secondary" to="/">
            All projects
          </Link>
        }
      />

      <FilterBar filters={filters} onChange={setFilters} workers={workers} />

      {reports === null ? (
        <SkeletonList rows={4} />
      ) : shown.length === 0 ? (
        <EmptyState
          title="Nothing matches these filters"
          hint="Widen the date range, or clear the filters to see the full record."
        />
      ) : (
        <>
          <p className="muted tnum" style={{ marginBottom: 8, fontSize: "0.85rem" }}>
            {shown.length} report{shown.length === 1 ? "" : "s"} · {mediaTotal} media
          </p>

          {groups.map(([day, rows]) => (
            <section key={day}>
              <h2 className="date-head">
                <span className="truncate">{formatDay(day)}</span>
                <span className="chip">{formatWeekday(day)}</span>
              </h2>
              <div className="report-list">
                {rows.map((r) => (
                  <ReportCard
                    key={r.id}
                    report={r}
                    media={mediaOf(r, filters.mediaType)}
                    urls={urls}
                    admin={isAdmin}
                    fresh={fresh.has(r.id)}
                    onChanged={(next) => upsertReport(next, false)}
                    onDeleted={(deletedId) => {
                      reportIds.current.delete(deletedId);
                      setReports((prev) => (prev ?? []).filter((x) => x.id !== deletedId));
                    }}
                  />
                ))}
              </div>
            </section>
          ))}

          {hasMore && (
            <div className="row" style={{ justifyContent: "center", marginTop: 24 }}>
              <Button variant="secondary" loading={loadingMore} onClick={() => void loadMore()}>
                Load {PAGE_SIZE} more
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
