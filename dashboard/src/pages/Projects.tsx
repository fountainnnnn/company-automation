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
import type { Project, ProjectStats, ProjectStatsRow } from "../lib/types";

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

  // Counts, last activity and cover in one server-side pass — no unbounded
  // scan of reports or report_media from the browser.
  useEffect(() => {
    let active = true;
    void (async () => {
      const { data } = await supabase.rpc("project_stats");
      if (!active || !data) return;
      const rows = data as ProjectStatsRow[];

      const nextStats: Record<string, ProjectStats> = {};
      const pick: Record<string, string> = {};
      for (const row of rows) {
        const pid = String(row.project_id);
        nextStats[pid] = {
          reportCount: row.report_count ?? 0,
          mediaCount: row.media_count ?? 0,
          lastActivity: row.last_activity,
        };
        if (row.cover_path) pick[pid] = row.cover_path;
      }
      setStats(nextStats);

      const urls = await getSignedUrls(Object.values(pick));
      if (!active) return;
      const nextCovers: Record<string, string> = {};
      for (const [pid, path] of Object.entries(pick)) {
        if (urls[path]) nextCovers[pid] = urls[path];
      }
      setCovers(nextCovers);
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
                    {s
                      ? `${s.mediaCount} ${s.mediaCount === 1 ? "media file" : "media"} · ${s.reportCount} ${s.reportCount === 1 ? "report" : "reports"}`
                      : "No media yet"}
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
