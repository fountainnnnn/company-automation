import { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import type { Project, ProjectWorker, TimesheetRole, Worker } from "../lib/types";
import { SectionHeader } from "../components/SectionHeader";
import { Button } from "../components/Button";
import { ConfirmDialog, Modal } from "../components/Modal";
import { EmptyState } from "../components/EmptyState";
import { SkeletonList } from "../components/Skeleton";
import { StatusChip } from "../components/StatusChip";
import { useToast } from "../components/Toast";

const WORKER_ROLES: TimesheetRole[] = ["worker", "driver", "welder", "supervisor"];

/** PostgREST can hand a numeric back as a string; every pay field is arithmetic. */
function normalizeWorker(w: Worker): Worker {
  return {
    ...w,
    hourly_rate:
      w.hourly_rate === null || w.hourly_rate === undefined ? null : Number(w.hourly_rate),
    expected_hours: Number(w.expected_hours ?? 8),
    ot_multiplier: Number(w.ot_multiplier ?? 1.5),
  };
}

/** Text for a pay input — an unset rate shows blank, never "0". */
function rateText(rate: number | null): string {
  return rate === null ? "" : String(rate);
}

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
  const [disabling, setDisabling] = useState<Worker | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [wk, pj, pw] = await Promise.all([
      supabase
        .from("workers")
        .select("*")
        .neq("status", "pending")
        .order("created_at", { ascending: false }),
      supabase.from("projects").select("*").eq("status", "active").order("code"),
      supabase.from("project_workers").select("project_id,worker_id"),
    ]);
    if (wk.error) toast.error(wk.error.message);
    setWorkers(((wk.data ?? []) as Worker[]).map(normalizeWorker));
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

  async function setPrimaryProject(worker: Worker, projectId: string) {
    const nextId = projectId || null;
    if (nextId && !links.some((link) => link.worker_id === worker.id && link.project_id === nextId)) {
      const { error } = await supabase
        .from("project_workers")
        .insert({ project_id: nextId, worker_id: worker.id });
      if (error && error.code !== "23505") {
        toast.error(error.message);
        return;
      }
      setLinks((prev) => [...prev, { project_id: nextId, worker_id: worker.id }]);
    }

    await patchWorker(
      worker.id,
      { default_project_id: nextId },
      nextId ? "Primary project updated." : "Primary project cleared.",
    );
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
    const patch: Partial<Worker> = { default_project_id: defaultId || null };
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
    toast.success(`Projects updated for ${worker.full_name}.`);
  }

  const rest = workers ?? [];

  return (
    <div className="reveal">
      <SectionHeader
        title="Workers"
        subtitle={workers === null ? undefined : `${rest.length} workers`}
      />

      <h2 className="sub-head">All workers</h2>
      {workers === null ? (
        <SkeletonList rows={2} />
      ) : rest.length === 0 ? (
        <EmptyState
          title="No workers yet"
          hint="Workers appear here after an admin adds their details."
        />
      ) : (
        <div className="table-wrap">
          <table className="data workers-table">
            <colgroup>
              <col className="worker-col-name" />
              <col className="worker-col-code" />
              <col className="worker-col-role" />
              <col className="worker-col-team" />
              <col className="worker-col-rate" />
              <col className="worker-col-hours" />
              <col className="worker-col-ot" />
              <col className="worker-col-telegram" />
              <col className="worker-col-project" />
              <col className="worker-col-status" />
              <col className="worker-col-actions" />
            </colgroup>
            <thead>
              <tr>
                <th>Name</th>
                <th>Worker ID</th>
                <th>Role</th>
                <th>Team</th>
                <th className="num">Rate (S$/h)</th>
                <th className="num">Expected h/day</th>
                <th className="num">OT ×</th>
                <th>Telegram</th>
                <th>Project</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rest.map((w) => {
                const assigned = projectsOf(w.id);
                return (
                  <tr key={w.id}>
                    <td>
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
                    <td>
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
                    <td>
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
                    <td>
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
                    <td>
                      <label className="sr-only" htmlFor={`wrate-${w.id}`}>
                        Hourly rate for {w.full_name}
                      </label>
                      <div className="pay-cell">
                        <input
                          id={`wrate-${w.id}`}
                          className="input input-sm tnum"
                          type="number"
                          step="0.01"
                          min={0}
                          inputMode="decimal"
                          defaultValue={rateText(w.hourly_rate)}
                          placeholder="not set"
                          onBlur={(e) => {
                            const input = e.target;
                            const raw = input.value.trim();
                            const parsed = raw === "" ? 0 : Number(raw);
                            if (!Number.isFinite(parsed) || parsed < 0) {
                              toast.error("Rate must be zero or more, or blank for not set.");
                              input.value = rateText(w.hourly_rate);
                              return;
                            }
                            // Blank and 0 both mean "no rate" — storing 0 would pay nothing
                            // while still counting the worker as priced.
                            const next = parsed > 0 ? Math.round(parsed * 100) / 100 : null;
                            if (next === w.hourly_rate) {
                              input.value = rateText(next);
                              return;
                            }
                            input.value = rateText(next);
                            void patchWorker(
                              w.id,
                              { hourly_rate: next },
                              next === null ? "Rate cleared." : `Rate set to S$${next.toFixed(2)}/h.`,
                            );
                          }}
                        />
                        {w.hourly_rate === null && (
                          <StatusChip
                            kind="warn"
                            label="no rate"
                            title="Without a rate this worker is left out of payroll totals."
                          />
                        )}
                      </div>
                    </td>
                    <td>
                      <label className="sr-only" htmlFor={`wexp-${w.id}`}>
                        Expected hours per day for {w.full_name}
                      </label>
                      <input
                        id={`wexp-${w.id}`}
                        className="input input-sm tnum"
                        type="number"
                        step="0.5"
                        min={1}
                        max={24}
                        inputMode="decimal"
                        defaultValue={String(w.expected_hours)}
                        onBlur={(e) => {
                          const input = e.target;
                          const next = Number(input.value.trim());
                          if (!Number.isFinite(next) || next < 1 || next > 24) {
                            toast.error("Expected hours must be between 1 and 24.");
                            input.value = String(w.expected_hours);
                            return;
                          }
                          const rounded = Math.round(next * 10) / 10;
                          input.value = String(rounded);
                          if (rounded === w.expected_hours) return;
                          void patchWorker(
                            w.id,
                            { expected_hours: rounded },
                            `Expected hours set to ${rounded}.`,
                          );
                        }}
                      />
                    </td>
                    <td>
                      <label className="sr-only" htmlFor={`wot-${w.id}`}>
                        Overtime multiplier for {w.full_name}
                      </label>
                      <input
                        id={`wot-${w.id}`}
                        className="input input-sm tnum"
                        type="number"
                        step="0.1"
                        min={1}
                        max={5}
                        inputMode="decimal"
                        defaultValue={String(w.ot_multiplier)}
                        onBlur={(e) => {
                          const input = e.target;
                          const next = Number(input.value.trim());
                          if (!Number.isFinite(next) || next < 1 || next > 5) {
                            toast.error("Overtime multiplier must be between 1 and 5.");
                            input.value = String(w.ot_multiplier);
                            return;
                          }
                          const rounded = Math.round(next * 100) / 100;
                          input.value = String(rounded);
                          if (rounded === w.ot_multiplier) return;
                          void patchWorker(
                            w.id,
                            { ot_multiplier: rounded },
                            `Overtime multiplier set to ×${rounded}.`,
                          );
                        }}
                      />
                    </td>
                    <td className="truncate">
                      {w.telegram_username ? `@${w.telegram_username}` : "—"}
                    </td>
                    <td>
                      <label className="sr-only" htmlFor={`wp-${w.id}`}>
                        Primary project for {w.full_name}
                      </label>
                      <select
                        id={`wp-${w.id}`}
                        className="select select-sm worker-project-select"
                        value={w.default_project_id ?? ""}
                        onChange={(event) => void setPrimaryProject(w, event.target.value)}
                      >
                        <option value="">Unassigned</option>
                        {projects.map((project) => (
                          <option key={project.id} value={project.id}>
                            {project.code} — {project.name}
                          </option>
                        ))}
                      </select>
                    </td>
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
                            onClick={() => setDisabling(w)}
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
          title="Disable this worker?"
          message={`${disabling.full_name} will stop being able to send reports or check in. Their past records stay intact.`}
          confirmLabel="Disable worker"
          busy={busy}
          onConfirm={() => {
            setBusy(true);
            void patchWorker(
              disabling.id,
              { status: "disabled" },
              "Worker disabled.",
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
