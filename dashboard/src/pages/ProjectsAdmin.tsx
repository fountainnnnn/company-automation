import { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import type { Project } from "../lib/types";
import { SectionHeader } from "../components/SectionHeader";
import { Button } from "../components/Button";
import { EmptyState } from "../components/EmptyState";
import { SkeletonList } from "../components/Skeleton";
import { ConfirmDialog } from "../components/Modal";
import { ProjectCreateModal } from "../components/ProjectCreateModal";
import { StatusChip } from "../components/StatusChip";
import { useToast } from "../components/Toast";

type EditableField = "code" | "name" | "site_address";

export function ProjectsAdminPage() {
  const toast = useToast();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [archiving, setArchiving] = useState<Project | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const { data, error } = await supabase.from("projects").select("*").order("code");
    if (error) toast.error(error.message);
    setProjects((data ?? []) as Project[]);
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  async function patch(id: string, values: Partial<Project>, message: string) {
    const { error } = await supabase.from("projects").update(values).eq("id", id);
    if (error) {
      toast.error(error.message);
      return;
    }
    setProjects((prev) => (prev ?? []).map((p) => (p.id === id ? { ...p, ...values } : p)));
    toast.success(message);
  }

  function onFieldBlur(project: Project, field: EditableField, raw: string) {
    const value = raw.trim();
    const current = project[field] ?? "";
    if (value === current) return;
    if (!value && field !== "site_address") {
      toast.error("Code and name cannot be empty.");
      return;
    }
    void patch(project.id, { [field]: value || null } as Partial<Project>, "Project updated.");
  }

  return (
    <div className="reveal">
      <SectionHeader
        eyebrow="Manage"
        title="Sites and their details."
        subtitle="Codes drive the bot's keyboards — keep them short and unambiguous."
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            New project
          </Button>
        }
      />

      {projects === null ? (
        <SkeletonList rows={2} />
      ) : projects.length === 0 ? (
        <EmptyState
          title="No projects yet"
          hint="Create the first site and its code before pointing workers at the bot."
          action={
            <Button variant="primary" onClick={() => setCreating(true)}>
              New project
            </Button>
          }
        />
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th style={{ width: 120 }}>Code</th>
                <th>Name</th>
                <th>Address</th>
                <th>Coordinates</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {projects.map((p) => (
                <tr key={p.id}>
                  <td>
                    <label className="sr-only" htmlFor={`code-${p.id}`}>
                      Code
                    </label>
                    <input
                      id={`code-${p.id}`}
                      className="input"
                      defaultValue={p.code}
                      onBlur={(e) => onFieldBlur(p, "code", e.target.value)}
                    />
                  </td>
                  <td style={{ minWidth: 180 }}>
                    <label className="sr-only" htmlFor={`name-${p.id}`}>
                      Name
                    </label>
                    <input
                      id={`name-${p.id}`}
                      className="input"
                      defaultValue={p.name}
                      onBlur={(e) => onFieldBlur(p, "name", e.target.value)}
                    />
                  </td>
                  <td style={{ minWidth: 200 }}>
                    <label className="sr-only" htmlFor={`addr-${p.id}`}>
                      Site address
                    </label>
                    <input
                      id={`addr-${p.id}`}
                      className="input"
                      defaultValue={p.site_address ?? ""}
                      onBlur={(e) => onFieldBlur(p, "site_address", e.target.value)}
                    />
                  </td>
                  <td className="tnum muted" style={{ whiteSpace: "nowrap" }}>
                    {p.site_lat !== null && p.site_lng !== null
                      ? `${p.site_lat.toFixed(4)}, ${p.site_lng.toFixed(4)}`
                      : "—"}
                  </td>
                  <td>
                    <StatusChip
                      kind={p.status === "active" ? "ok" : "neutral"}
                      label={p.status}
                    />
                  </td>
                  <td>
                    <div className="cell-actions">
                      {p.status === "active" ? (
                        <Button variant="danger" onClick={() => setArchiving(p)}>
                          Archive
                        </Button>
                      ) : (
                        <Button
                          variant="secondary"
                          onClick={() =>
                            void patch(p.id, { status: "active" }, "Project restored.")
                          }
                        >
                          Unarchive
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {archiving && (
        <ConfirmDialog
          title="Archive this project?"
          message={`${archiving.code} · ${archiving.name} will disappear from the bot's keyboards and from the active projects list. Its records stay, and you can unarchive it later.`}
          confirmLabel="Archive project"
          busy={busy}
          onConfirm={() => {
            const project = archiving;
            setBusy(true);
            void patch(project.id, { status: "archived" }, "Project archived.").finally(() => {
              setBusy(false);
              setArchiving(null);
            });
          }}
          onClose={() => setArchiving(null)}
        />
      )}

      {creating && (
        <ProjectCreateModal
          onClose={() => setCreating(false)}
          onCreated={(project) => {
            setCreating(false);
            setProjects((prev) => [...(prev ?? []), project]);
          }}
        />
      )}
    </div>
  );
}
