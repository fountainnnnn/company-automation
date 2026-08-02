import { useId } from "react";
import { Button } from "./Button";
import { EMPTY_FILTERS } from "../lib/types";
import type { Filters, Project, Worker } from "../lib/types";

interface Props {
  filters: Filters;
  onChange: (next: Filters) => void;
  workers: Worker[];
  projects?: Project[];
}

export function FilterBar({ filters, onChange, workers, projects }: Props) {
  const id = useId();
  const set = (patch: Partial<Filters>) => onChange({ ...filters, ...patch });
  const dirty =
    filters.from !== "" ||
    filters.to !== "" ||
    filters.workerId !== "" ||
    filters.mediaType !== "" ||
    filters.query !== "" ||
    (filters.projectId ?? "") !== "";

  return (
    <div className="toolbar">
      {projects && (
        <div className="field">
          <label htmlFor={`${id}-project`}>Project</label>
          <select
            id={`${id}-project`}
            className="select"
            value={filters.projectId ?? ""}
            onChange={(e) => set({ projectId: e.target.value })}
          >
            <option value="">All projects</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.code} · {p.name}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="field">
        <label htmlFor={`${id}-from`}>From</label>
        <input
          id={`${id}-from`}
          className="input"
          type="date"
          value={filters.from}
          max={filters.to || undefined}
          onChange={(e) => set({ from: e.target.value })}
        />
      </div>

      <div className="field">
        <label htmlFor={`${id}-to`}>To</label>
        <input
          id={`${id}-to`}
          className="input"
          type="date"
          value={filters.to}
          min={filters.from || undefined}
          onChange={(e) => set({ to: e.target.value })}
        />
      </div>

      <div className="field">
        <label htmlFor={`${id}-worker`}>Worker</label>
        <select
          id={`${id}-worker`}
          className="select"
          value={filters.workerId}
          onChange={(e) => set({ workerId: e.target.value })}
        >
          <option value="">Anyone</option>
          {workers.map((w) => (
            <option key={w.id} value={w.id}>
              {w.full_name}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label htmlFor={`${id}-type`}>Media</label>
        <select
          id={`${id}-type`}
          className="select"
          value={filters.mediaType}
          onChange={(e) => set({ mediaType: e.target.value })}
        >
          <option value="">All types</option>
          <option value="photo">Photos</option>
          <option value="video">Videos</option>
          <option value="document">Documents</option>
        </select>
      </div>

      <div className="field grow">
        <label htmlFor={`${id}-q`}>Search notes</label>
        <input
          id={`${id}-q`}
          className="input"
          type="search"
          placeholder="e.g. slab pour"
          value={filters.query}
          onChange={(e) => set({ query: e.target.value })}
        />
      </div>

      {dirty && (
        <div className="toolbar-actions">
          <Button
            variant="ghost"
            onClick={() =>
              onChange({ ...EMPTY_FILTERS, projectId: projects ? "" : undefined })
            }
          >
            Clear
          </Button>
        </div>
      )}
    </div>
  );
}
