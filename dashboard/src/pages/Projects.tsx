import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { getSignedUrls } from "../lib/signedUrls";
import { useAuth } from "../lib/auth";
import { formatRelative } from "../lib/format";
import { glowVars } from "../components/Card";
import { SectionHeader } from "../components/SectionHeader";
import { SkeletonCards } from "../components/Skeleton";
import { EmptyState } from "../components/EmptyState";
import { Button } from "../components/Button";
import { useToast } from "../components/Toast";
import { ProjectCreateModal } from "../components/ProjectCreateModal";
import type { Project, ProjectStats } from "../lib/types";

interface ReportStatRow {
  project_id: string;
  created_at: string;
  report_media: { count: number }[];
}

interface CoverRow {
  storage_path: string;
  reports: { project_id: string } | null;
}

export function ProjectsPage() {
  const { isAdmin } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();

  const [showArchived, setShowArchived] = useState(false);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [stats, setStats] = useState<Record<string, ProjectStats>>({});
  const [covers, setCovers] = useState<Record<string, string>>({});
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setProjects(null);
    const { data, error } = await supabase
      .from("projects")
      .select("*")
      .eq("status", showArchived ? "archived" : "active")
      .order("code", { ascending: true });

    if (error) {
      toast.error(error.message);
      setProjects([]);
      return;
    }
    setProjects((data ?? []) as Project[]);
  }, [showArchived, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  // Counts + last activity: one grouped query, aggregated client-side (no N+1).
  useEffect(() => {
    let active = true;
    void (async () => {
      const { data } = await supabase
        .from("reports")
        .select("project_id,created_at,report_media(count)");
      if (!active || !data) return;
      const rows = data as unknown as ReportStatRow[];
      const next: Record<string, ProjectStats> = {};
      for (const row of rows) {
        const entry = next[row.project_id] ?? {
          mediaCount: 0,
          reportCount: 0,
          lastActivity: null,
        };
        entry.reportCount += 1;
        entry.mediaCount += row.report_media?.[0]?.count ?? 0;
        if (!entry.lastActivity || row.created_at > entry.lastActivity) {
          entry.lastActivity = row.created_at;
        }
        next[row.project_id] = entry;
      }
      setStats(next);
    })();
    return () => {
      active = false;
    };
  }, []);

  // Covers: newest photos across all projects in one query, first-per-project wins.
  useEffect(() => {
    let active = true;
    void (async () => {
      const { data } = await supabase
        .from("report_media")
        .select("storage_path,created_at,reports!inner(project_id)")
        .eq("media_type", "photo")
        .order("created_at", { ascending: false })
        .limit(400);
      if (!active || !data) return;
      const rows = data as unknown as CoverRow[];
      const pick: Record<string, string> = {};
      for (const row of rows) {
        const pid = row.reports?.project_id;
        if (pid && !pick[pid]) pick[pid] = row.storage_path;
      }
      const urls = await getSignedUrls(Object.values(pick));
      if (!active) return;
      const next: Record<string, string> = {};
      for (const [pid, path] of Object.entries(pick)) {
        if (urls[path]) next[pid] = urls[path];
      }
      setCovers(next);
    })();
    return () => {
      active = false;
    };
  }, []);

  return (
    <div className="reveal">
      <SectionHeader
        eyebrow="Projects"
        title={showArchived ? "Archived sites." : "Every site, at a glance."}
        subtitle="Open a project to browse its photo record by date, worker or note."
        actions={
          isAdmin ? (
            <Button variant="secondary" onClick={() => setShowArchived((v) => !v)}>
              {showArchived ? "Show active" : "Show archived"}
            </Button>
          ) : undefined
        }
      />

      {projects === null ? (
        <SkeletonCards />
      ) : projects.length === 0 && !isAdmin ? (
        <EmptyState
          title={showArchived ? "No archived projects" : "No projects yet"}
          hint="An administrator creates projects before site reports can arrive."
        />
      ) : (
        <div className="grid-cards">
          {projects.map((p, i) => {
            const s = stats[p.id];
            const cover = covers[p.id];
            return (
              <button
                key={p.id}
                className="glow-card project-card"
                style={glowVars(i)}
                onClick={() => navigate(`/projects/${p.id}`)}
              >
                <div className="project-cover">
                  {cover ? (
                    <img src={cover} alt={`Latest site photo from ${p.name}`} loading="lazy" />
                  ) : (
                    <div className="mesh" aria-hidden="true" />
                  )}
                </div>
                <div className="project-body">
                  <div className="project-title-row">
                    <span className="proj-name truncate" title={p.name}>
                      {p.name}
                    </span>
                    <span className="chip code">{p.code}</span>
                  </div>
                  <p className="card-meta tnum">
                    {s ? `${s.mediaCount} media · ${s.reportCount} reports` : "No media yet"}
                  </p>
                  <p className="card-meta">
                    Last activity {formatRelative(s?.lastActivity ?? null)}
                  </p>
                </div>
              </button>
            );
          })}

          {isAdmin && !showArchived && (
            <button className="new-card" onClick={() => setCreating(true)}>
              <span aria-hidden="true">＋</span> New project
            </button>
          )}
        </div>
      )}

      {creating && (
        <ProjectCreateModal
          onClose={() => setCreating(false)}
          onCreated={(project) => {
            setCreating(false);
            setProjects((prev) => (prev ? [...prev, project] : [project]));
          }}
        />
      )}
    </div>
  );
}
