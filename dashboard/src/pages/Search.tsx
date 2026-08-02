import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth";
import { formatDay } from "../lib/format";
import {
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

function groupByProject(reports: Report[]): Array<[string, Report[]]> {
  const map = new Map<string, Report[]>();
  for (const r of reports) {
    const list = map.get(r.project_id) ?? [];
    list.push(r);
    map.set(r.project_id, list);
  }
  return Array.from(map.entries());
}

/** Header name off the report's own embedded project — no lookup table needed. */
function projectHeader(rows: Report[]): string {
  const p = rows[0]?.projects;
  return p ? `${p.code} · ${p.name}` : "Unknown project";
}

export function SearchPage() {
  const { isAdmin } = useAuth();
  const toast = useToast();

  const [workers, setWorkers] = useState<Worker[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [filters, setFilters] = useState<Filters>({ ...EMPTY_FILTERS, projectId: "" });
  // Media type is a client-side filter; keeping it out of the query key stops
  // a toggle from refetching and discarding the pages already loaded.
  const serverFilters = useMemo<Filters>(
    () => ({ ...filters, mediaType: "" }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filters.from, filters.to, filters.workerId, filters.query, filters.projectId],
  );
  const query = useDebounced(serverFilters, 300);
  const [reports, setReports] = useState<Report[] | null>(null);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  // Rows fetched from the server — the paging cursor, independent of what the
  // list currently holds.
  const serverOffset = useRef(0);
  const reportIds = useRef<Set<string>>(new Set());

  useEffect(() => {
    let active = true;
    void (async () => {
      const [wk, pj] = await Promise.all([
        supabase.from("workers").select("*").order("full_name"),
        supabase.from("projects").select("*").order("code"),
      ]);
      if (!active) return;
      setWorkers((wk.data ?? []) as Worker[]);
      setProjects((pj.data ?? []) as Project[]);
    })();
    return () => {
      active = false;
    };
  }, []);

  const mergeUrls = useCallback(async (rows: Report[]) => {
    const signed = await signReportMedia(rows);
    setUrls((prev) => ({ ...prev, ...signed }));
  }, []);

  const load = useCallback(async () => {
    setReports(null);
    const page = await fetchReports(query, undefined, 0);
    if (page.error) toast.error(page.error);
    serverOffset.current = page.rows.length;
    reportIds.current = new Set(page.rows.map((r) => r.id));
    setReports(page.rows);
    setHasMore(page.hasMore);
    void mergeUrls(page.rows);
  }, [query, toast, mergeUrls]);

  useEffect(() => {
    void load();
  }, [load]);

  async function loadMore() {
    if (!reports) return;
    setLoadingMore(true);
    const page = await fetchReports(query, undefined, serverOffset.current);
    setLoadingMore(false);
    if (page.error) {
      toast.error(page.error);
      return;
    }
    serverOffset.current += page.rows.length;
    const added = page.rows.filter((r) => !reportIds.current.has(r.id));
    for (const r of added) reportIds.current.add(r.id);
    setReports((prev) => [...(prev ?? []), ...added]);
    setHasMore(page.hasMore);
    void mergeUrls(added);
  }

  const { shown, byProject } = useMemo(() => {
    const list = reports ? visibleReports(reports, filters.mediaType) : [];
    return { shown: list, byProject: groupByProject(list) };
  }, [reports, filters.mediaType]);

  return (
    <div className="reveal">
      <SectionHeader
        eyebrow="Global search"
        title="Find it across every site."
        subtitle="One query over all projects — by date range, worker, media type or note text."
      />

      <FilterBar
        filters={filters}
        onChange={setFilters}
        workers={workers}
        projects={projects}
      />

      {reports === null ? (
        <SkeletonList rows={3} />
      ) : shown.length === 0 ? (
        <EmptyState
          title="No reports match"
          hint="Try a wider date range or drop the note text to broaden the search."
        />
      ) : (
        <>
          <p className="muted tnum" style={{ marginBottom: 8, fontSize: "0.85rem" }}>
            {shown.length} report{shown.length === 1 ? "" : "s"} across {byProject.length} project
            {byProject.length === 1 ? "" : "s"}
          </p>

          {byProject.map(([projectId, rows]) => (
            <section key={projectId} style={{ marginBottom: 32 }}>
              <div className="row" style={{ marginTop: 24 }}>
                <h2 className="sub-head truncate" style={{ margin: 0 }}>
                  {projectHeader(rows)}
                </h2>
                <Link className="btn btn-ghost row-end" to={`/projects/${projectId}`}>
                  Open gallery
                </Link>
              </div>

              {groupByDate(rows).map(([day, dayRows]) => (
                <div key={day}>
                  <h3 className="date-head">
                    <span className="truncate">{formatDay(day)}</span>
                  </h3>
                  <div className="report-list">
                    {dayRows.map((r) => (
                      <ReportCard
                        key={r.id}
                        report={r}
                        media={mediaOf(r, filters.mediaType)}
                        urls={urls}
                        admin={isAdmin}
                        showProject
                        onChanged={(next) =>
                          setReports((prev) =>
                            (prev ?? []).map((x) => (x.id === next.id ? next : x)),
                          )
                        }
                        onDeleted={(deletedId) => {
                          reportIds.current.delete(deletedId);
                          setReports((prev) => (prev ?? []).filter((x) => x.id !== deletedId));
                        }}
                      />
                    ))}
                  </div>
                </div>
              ))}
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
