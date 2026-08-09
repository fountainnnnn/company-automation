import { useRef, useState } from "react";
import { Modal } from "./Modal";
import { Button } from "./Button";
import { supabase } from "../lib/supabase";
import { useToast } from "./Toast";
import type { Worker, WorkerRole } from "../lib/types";

const ROLES: WorkerRole[] = ["worker", "driver", "welder", "supervisor"];

interface Props {
  onClose: () => void;
  onCreated: (worker: Worker) => void;
}

type FieldName = "full_name" | "telegram_username" | "worker_code";

/**
 * The only way a worker comes into existence. The bot never creates one — it
 * reads this list and nothing else — so the Telegram username here is what
 * lets a person actually use it.
 */
export function WorkerCreateModal({ onClose, onCreated }: Props) {
  const toast = useToast();
  const [fullName, setFullName] = useState("");
  const [username, setUsername] = useState("");
  const [code, setCode] = useState("");
  const [role, setRole] = useState<WorkerRole>("worker");
  const [team, setTeam] = useState("");
  const [busy, setBusy] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<FieldName, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const userRef = useRef<HTMLInputElement>(null);

  async function submit() {
    const errors: Partial<Record<FieldName, string>> = {};
    if (!fullName.trim()) errors.full_name = "A name is required.";
    // Without it the bot has no way to recognise them, so it isn't optional.
    if (!username.trim()) errors.telegram_username = "Required — the bot matches on this.";
    setFieldErrors(errors);
    setFormError(null);
    if (errors.full_name || errors.telegram_username) {
      (errors.full_name ? nameRef : userRef).current?.focus();
      return;
    }

    setBusy(true);
    const { data, error } = await supabase
      .from("workers")
      .insert({
        full_name: fullName.trim(),
        // Stored bare; people type it either way and the bot matches
        // case-insensitively on the bare form.
        telegram_username: username.trim().replace(/^@+/, ""),
        worker_code: code.trim().toUpperCase() || null,
        role,
        team_number: team.trim() || null,
        status: "active",
      })
      .select("*")
      .single();
    setBusy(false);

    if (error || !data) {
      if (error?.code === "23505") {
        setFieldErrors({ worker_code: "That worker ID is already in use." });
        return;
      }
      setFormError(error?.message ?? "Could not add the worker.");
      return;
    }
    toast.success(`${data.full_name} added.`);
    onCreated(data as Worker);
  }

  return (
    <Modal
      title="Add worker"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void submit()}>
            Add worker
          </Button>
        </>
      }
    >
      {formError && (
        <p className="form-error" role="alert">
          {formError}
        </p>
      )}

      <div className="field">
        <label htmlFor="nw-name">Full name</label>
        <input
          id="nw-name"
          ref={nameRef}
          className="input"
          value={fullName}
          placeholder="Sithu Aung"
          aria-invalid={fieldErrors.full_name ? true : undefined}
          onChange={(e) => setFullName(e.target.value)}
        />
        {fieldErrors.full_name && (
          <p className="form-error" role="alert">{fieldErrors.full_name}</p>
        )}
      </div>

      <div className="field">
        <label htmlFor="nw-user">Telegram username</label>
        <input
          id="nw-user"
          ref={userRef}
          className="input"
          value={username}
          placeholder="@sithu_aung"
          aria-invalid={fieldErrors.telegram_username ? true : undefined}
          onChange={(e) => setUsername(e.target.value)}
        />
        {fieldErrors.telegram_username ? (
          <p className="form-error" role="alert">{fieldErrors.telegram_username}</p>
        ) : (
          <p className="field-hint">
            How the bot recognises them. They can message it as soon as you save.
          </p>
        )}
      </div>

      <div className="row">
        <div className="field" style={{ flex: 1 }}>
          <label htmlFor="nw-code">Worker ID (optional)</label>
          <input
            id="nw-code"
            className="input"
            value={code}
            placeholder="W110"
            onChange={(e) => setCode(e.target.value)}
          />
          {fieldErrors.worker_code && (
            <p className="form-error" role="alert">{fieldErrors.worker_code}</p>
          )}
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label htmlFor="nw-team">Team (optional)</label>
          <input
            id="nw-team"
            className="input"
            value={team}
            placeholder="2"
            onChange={(e) => setTeam(e.target.value)}
          />
        </div>
      </div>

      <div className="field">
        <label htmlFor="nw-role">Role</label>
        <select
          id="nw-role"
          className="input select"
          value={role}
          onChange={(e) => setRole(e.target.value as WorkerRole)}
        >
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </div>
    </Modal>
  );
}
