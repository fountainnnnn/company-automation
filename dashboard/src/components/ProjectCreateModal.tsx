import { useRef, useState } from "react";
import { Modal } from "./Modal";
import { Button } from "./Button";
import { supabase } from "../lib/supabase";
import { useToast } from "./Toast";
import type { Project } from "../lib/types";

interface Props {
  onClose: () => void;
  onCreated: (project: Project) => void;
}

type FieldName = "code" | "name";

export function ProjectCreateModal({ onClose, onCreated }: Props) {
  const toast = useToast();
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [lat, setLat] = useState("");
  const [lng, setLng] = useState("");
  const [busy, setBusy] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<FieldName, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  async function submit() {
    const errors: Partial<Record<FieldName, string>> = {};
    if (!code.trim()) errors.code = "A code is required.";
    if (!name.trim()) errors.name = "A name is required.";
    setFieldErrors(errors);
    setFormError(null);
    if (errors.code || errors.name) {
      (errors.code ? codeRef : nameRef).current?.focus();
      return;
    }

    setBusy(true);
    const { data, error } = await supabase
      .from("projects")
      .insert({
        code: code.trim(),
        name: name.trim(),
        site_address: address.trim() || null,
        site_lat: lat.trim() ? Number(lat) : null,
        site_lng: lng.trim() ? Number(lng) : null,
        status: "active",
      })
      .select("*")
      .single();
    setBusy(false);
    if (error || !data) {
      const message = error?.message ?? "Could not create the project.";
      // A duplicate code is the one server error the user can fix in place.
      if (error?.code === "23505") {
        setFieldErrors({ code: "That code is already in use." });
        codeRef.current?.focus();
      } else {
        setFormError(message);
      }
      return;
    }
    toast.success(`Project ${data.code} created.`);
    onCreated(data as Project);
  }

  return (
    <Modal
      title="New project"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void submit()}>
            Create project
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
        <label htmlFor="np-code">Code</label>
        <input
          id="np-code"
          ref={codeRef}
          className="input"
          value={code}
          placeholder="SB-01"
          aria-invalid={fieldErrors.code ? true : undefined}
          aria-describedby={fieldErrors.code ? "np-code-error" : undefined}
          onChange={(e) => setCode(e.target.value)}
        />
        {fieldErrors.code && (
          <p className="form-error" id="np-code-error" role="alert">
            {fieldErrors.code}
          </p>
        )}
      </div>
      <div className="field">
        <label htmlFor="np-name">Name</label>
        <input
          id="np-name"
          ref={nameRef}
          className="input"
          value={name}
          placeholder="Site B — Tower 1"
          aria-invalid={fieldErrors.name ? true : undefined}
          aria-describedby={fieldErrors.name ? "np-name-error" : undefined}
          onChange={(e) => setName(e.target.value)}
        />
        {fieldErrors.name && (
          <p className="form-error" id="np-name-error" role="alert">
            {fieldErrors.name}
          </p>
        )}
      </div>
      <div className="field">
        <label htmlFor="np-addr">Site address</label>
        <input
          id="np-addr"
          className="input"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
        />
      </div>
      <div className="row">
        <div className="field" style={{ flex: 1 }}>
          <label htmlFor="np-lat">Latitude (optional)</label>
          <input
            id="np-lat"
            className="input"
            inputMode="decimal"
            value={lat}
            onChange={(e) => setLat(e.target.value)}
          />
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label htmlFor="np-lng">Longitude (optional)</label>
          <input
            id="np-lng"
            className="input"
            inputMode="decimal"
            value={lng}
            onChange={(e) => setLng(e.target.value)}
          />
        </div>
      </div>
    </Modal>
  );
}
