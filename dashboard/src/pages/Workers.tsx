import { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { formatDay, toSgtDay } from "../lib/format";
import type { Project, ProjectWorker, TimesheetRole, Worker } from "../lib/types";
import { SectionHeader } from "../components/SectionHeader";
import { Button } from "../components/Button";
import { ConfirmDialog, Modal } from "../components/Modal";
import { EmptyState } from "../components/EmptyState";
import { SkeletonList } from "../components/Skeleton";
import { StatusChip } from "../components/StatusChip";
import { useToast } from "../components/Toast";

const WORKER_ROLES: TimesheetRole[] = ["worker", "driver", "welder", "supervisor"];

interface AssignState {
  worker: Worker;
  projectIds: string[];
  defaultId: string;
}

export function WorkersPage() {
  const toast = useToast();
  const [workers, setWorkers] = useState<Worker[] | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [links, setLinks] = useState<ProjectWorker[]>([]);
  const [assign, setAssign] = useState<AssignState | null>(null);
  const [disabling, setDisabling] = useState<{ worker: Worker; reject: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [wk, pj, pw] = await Promise.all([
      supabase.from("workers").select("*").order("created_at", { ascending: false }),
      supabase.from("projects").select("*").eq("status", "active").order("code"),
      supabase.from("project_workers").select("project_id,worker_id"),
    ]);
    if (wk.error) toast.error(wk.error.message);
    setWorkers((wk.data ?? []) as Worker[]);
    setProjects((pj.data ?? []) as Project[]);
    setLinks((pw.data ?? []) as ProjectWorker[]);
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  function projectsOf(workerId: string): Project[] {
    const ids = new Set(links.filter((l) => l.worker_id === workerId).map((l) => l.project_id));
    return projects.filter((p) => ids.has(p.id));
  }

  async function patchWorker(
    id: string,
    patch: Partial<Worker>,
    message: string,
  ): Promise<boolean> {
    const { error } = await supabase.from("workers").update(patch).eq("id", id);
    if (error) {
      // A duplicate worker code is an everyday typo, not a database failure.
      toast.error(
        error.code === "23505" ? "That worker ID is already taken." : error.message,
      );
      return false;
    }
    setWorkers((prev) => (prev ?? []).map((w) => (w.id === id ? { ...w, ...patch } : w)));
    toast.success(message);
    return true;
  }

  async function saveAssignment() {
    if (!assign) return;
    setBusy(true);
    const { worker, projectIds, defaultId } = assign;

    // Only the projects this dialog can actually show are ours to rewrite —
    // an unscoped delete would silently drop links to archived projects.
    const activeProjectIds = projects.map((p) => p.id);
    const { error: delErr } = activeProjectIds.length
      ? await supabase
          .from("project_workers")
          .delete()
          .eq("worker_id", worker.id)
          .in("project_id", activeProjectIds)
      : { error: null };
    if (delErr) {
      setBusy(false);
      toast.error(delErr.message);
      return;
    }
    if (projectIds.length > 0) {
      const { error: insErr } = await supabase
        .from("project_workers")
        .insert(projectIds.map((project_id) => ({ project_id, worker_id: worker.id })));
      if (insErr) {
        setBusy(false);
        toast.error(insErr.message);
        return;
      }
    }
    // Approving a pending registration activates it; editing an existing
    // worker must never silently re-enable someone who was disabled.
    const patch: Partial<Worker> =
      worker.status === "pending"
        ? { status: "active", default_project_id: defaultId || null }
        : { default_project_id: defaultId || null };
    const { error: upErr } = await supabase
      .from("workers")
      .update(patch)
      .eq("id", worker.id);
    setBusy(false);
    if (upErr) {
      toast.error(upErr.message);
      return;
    }

    setLinks((prev) => [
      ...prev.filter(
        (l) => l.worker_id !== worker.id || !activeProjectIds.includes(l.project_id),
      ),
      ...projectIds.map((project_id) => ({ project_id, worker_id: worker.id })),
    ]);
    setWorkers((prev) => (prev ?? []).map((w) => (w.id === worker.id ? { ...w, ...patch } : w)));
    setAssign(null);
    toast.success(
      worker.status === "pending"
        ? `${worker.full_name} approved.`
        : `Projects updated for ${worker.full_name}.`,
    );
  }

  const pending = (workers ?? []).filter((w) => w.status === "pending");
  const rest = (workers ?? []).filter((w) => w.status !== "pending");

  return (
    <div className="reveal">
      <SectionHeader
        title="Workers"
        subtitle={
          workers === null
            ? undefined
            : `${pending.length} pending · ${rest.length} approved`
        }
      />

      <h2 className="sub-head">Pending registrations</h2>
      {workers === null ? (
        <SkeletonList rows={2} />
      ) : pending.length === 0 ? (
        <EmptyState
          title="No one waiting"
          hint="New Telegram sign-ups land here the moment a worker sends their name to the bot."
        />
      ) : (
        <div className="stack">
          {pending.map((w) => (
            <div key={w.id} className="panel panel-p row">
              <div style={{ minWidth: 0, flex: 1 }}>
                <p className="truncate" style={{ fontWeight: 500 }} title={w.full_name}>
                  {w.full_name}
                </p>
                <p className="muted" style={{ fontSize: "0.85rem" }}>
                  {w.telegram_username ? `@${w.telegram_username}` : "no username"} · registered{" "}
                  {formatDay(toSgtDay(w.created_at))}
                </p>
              </div>
              <div className="row row-end">
                <Button
                  variant="primary"
                  onClick={() =>
                    setAssign({
                      worker: w,
                      projectIds: projectsOf(w.id).map((p) => p.id),
                      defaultId: w.default_project_id ?? "",
                    })
                  }
                >
                  Approve
                </Button>
                <Button
                  variant="danger"
                  onClick={() => setDisabling({ worker: w, reject: true })}
                >
                  Reject
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <h2 className="sub-head">All workers</h2>
      {workers === null ? (
        <SkeletonList rows={2} />
      ) : rest.length === 0 ? (
        <EmptyState
          title="No approved workers yet"
          hint="Approve a pending registration and the worker shows up here."
        />
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Name</th>
                <th>Worker ID</th>
                <th>Role</th>
                <th>Team</th>
                <th>Telegram</th>
                <th>Projects</th>
                <th>Default</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rest.map((w) => {
                const assigned = projectsOf(w.id);
                const def = projects.find((p) => p.id === w.default_project_id);
                return (
                  <tr key={w.id}>
                    <td style={{ minWidth: 160 }}>
                      <label className="sr-only" htmlFor={`wn-${w.id}`}>
                        Full name
                      </label>
                      <input
                        id={`wn-${w.id}`}
                        className="input input-sm"
                        defaultValue={w.full_name}
                        onBlur={(e) => {
                          const next = e.target.value.trim();
                          if (next && next !== w.full_name) {
                            void patchWorker(w.id, { full_name: next }, "Name updated.");
                          }
                        }}
                      />
                    </td>
                    <td style={{ minWidth: 110 }}>
                      <label className="sr-only" htmlFor={`wc-${w.id}`}>
                        Worker ID for {w.full_name}
                      </label>
                      <input
                        id={`wc-${w.id}`}
                        className="input input-sm"
                        defaultValue={w.worker_code ?? ""}
                        placeholder="e.g. W103"
                        onBlur={(e) => {
                          const input = e.target;
                          const next = input.value.trim().toUpperCase();
                          if (next === (w.worker_code ?? "")) return;
                          void patchWorker(
                            w.id,
                            { worker_code: next || null },
                            // Setting the code links this worker's past roster entries.
                            next ? `Worker ID set to ${next}.` : "Worker ID cleared.",
                          ).then((ok) => {
                            // A rejected code must not sit in the field looking saved.
                            if (!ok) input.value = w.worker_code ?? "";
                          });
                        }}
                      />
                    </td>
                    <td style={{ minWidth: 120 }}>
                      <label className="sr-only" htmlFor={`wr-${w.id}`}>
                        Role for {w.full_name}
                      </label>
                      <select
                        id={`wr-${w.id}`}
                        className="select select-sm"
                        value={w.role}
                        onChange={(e) =>
                          void patchWorker(
                            w.id,
                            { role: e.target.value as Worker["role"] },
                            "Role updated.",
                          )
                        }
                      >
                        {WORKER_ROLES.map((r) => (
                          <option key={r} value={r}>
                            {r.charAt(0).toUpperCase() + r.slice(1)}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td style={{ minWidth: 84 }}>
                      <label className="sr-only" htmlFor={`wt-${w.id}`}>
                        Team for {w.full_name}
                      </label>
                      <input
                        id={`wt-${w.id}`}
                        className="input input-sm"
                        defaultValue={w.team_number ?? ""}
                        placeholder="e.g. 1"
                        onBlur={(e) => {
                          const next = e.target.value.trim();
                          if (next !== (w.team_number ?? "")) {
                            void patchWorker(
                              w.id,
                              { team_number: next || null },
                              next ? `Team set to ${next}.` : "Team cleared.",
                            );
                          }
                        }}
                      />
                    </td>
                    <td className="truncate">
                      {w.telegram_username ? `@${w.telegram_username}` : "—"}
                    </td>
                    <td>
                      <div className="row">
                        {assigned.length === 0 ? (
                          <span className="muted">none</span>
                        ) : (
                          assigned.map((p) => (
                            <span key={p.id} className="chip code" title={p.name}>
                              {p.code}
                            </span>
                          ))
                        )}
                      </div>
                    </td>
                    <td>{def ? def.code : "—"}</td>
                    <td>
                      <StatusChip
                        kind={w.status === "active" ? "ok" : w.status === "pending" ? "warn" : "neutral"}
                        label={w.status}
                      />
                    </td>
                    <td>
                      <div className="cell-actions">
                        <Button
                          variant="ghost"
                          onClick={() =>
                            setAssign({
                              worker: w,
                              projectIds: assigned.map((p) => p.id),
                              defaultId: w.default_project_id ?? "",
                            })
                          }
                        >
                          Projects
                        </Button>
                        {w.status === "active" ? (
                          <Button
                            variant="danger"
                            onClick={() => setDisabling({ worker: w, reject: false })}
                          >
                            Disable
                          </Button>
                        ) : (
                          <Button
                            variant="secondary"
                            onClick={() =>
                              void patchWorker(w.id, { status: "active" }, "Worker enabled.")
                            }
                          >
                            Enable
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {disabling && (
        <ConfirmDialog
          title={disabling.reject ? "Reject this registration?" : "Disable this worker?"}
          message={
            disabling.reject
              ? `${disabling.worker.full_name} will not be able to send from Telegram. You can enable them later from the workers table.`
              : `${disabling.worker.full_name} will stop being able to send reports or check in. Their past records stay intact.`
          }
          confirmLabel={disabling.reject ? "Reject" : "Disable worker"}
          busy={busy}
          onConfirm={() => {
            const { worker, reject } = disabling;
            setBusy(true);
            void patchWorker(
              worker.id,
              { status: "disabled" },
              reject ? `${worker.full_name} rejected.` : "Worker disabled.",
            ).finally(() => {
              setBusy(false);
              setDisabling(null);
            });
          }}
          onClose={() => setDisabling(null)}
        />
      )}

      {assign && (
        <Modal
          title={`Projects for ${assign.worker.full_name}`}
          onClose={() => setAssign(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setAssign(null)}>
                Cancel
              </Button>
              <Button variant="primary" loading={busy} onClick={() => void saveAssignment()}>
                Save
              </Button>
            </>
          }
        >
          {projects.length === 0 ? (
            <p className="muted">Create an active project first.</p>
          ) : (
            <>
              <div className="stack-tight">
                {projects.map((p) => {
                  const checked = assign.projectIds.includes(p.id);
                  return (
                    <label key={p.id} className="row" style={{ gap: 8, cursor: "pointer" }}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) =>
                          setAssign({
                            ...assign,
                            projectIds: e.target.checked
                              ? [...assign.projectIds, p.id]
                              : assign.projectIds.filter((x) => x !== p.id),
                          })
                        }
                      />
                      <span className="chip code">{p.code}</span>
                      <span className="truncate" title={p.name}>
                        {p.name}
                      </span>
                    </label>
                  );
                })}
              </div>

              <div className="field" style={{ marginTop: 12 }}>
                <label htmlFor="default-project">Default project (optional)</label>
                <select
                  id="default-project"
                  className="select"
                  value={assign.defaultId}
                  onChange={(e) => setAssign({ ...assign, defaultId: e.target.value })}
                >
                  <option value="">No default</option>
                  {projects
                    .filter((p) => assign.projectIds.includes(p.id))
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.code} · {p.name}
                      </option>
                    ))}
                </select>
              </div>
            </>
          )}
        </Modal>
      )}
    </div>
  );
}
