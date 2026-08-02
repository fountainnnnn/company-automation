import { useState } from "react";
import { Modal } from "./Modal";
import { Button } from "./Button";
import { supabase } from "../lib/supabase";
import { useToast } from "./Toast";
import type { Project } from "../lib/types";

interface Props {
  onClose: () => void;
  onCreated: (project: Project) => void;
}

export function ProjectCreateModal({ onClose, onCreated }: Props) {
  const toast = useToast();
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [lat, setLat] = useState("");
  const [lng, setLng] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!code.trim() || !name.trim()) {
      toast.error("Code and name are required.");
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
      toast.error(error?.message ?? "Could not create the project.");
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
      <div className="field">
        <label htmlFor="np-code">Code</label>
        <input
          id="np-code"
          className="input"
          value={code}
          placeholder="SB-01"
          onChange={(e) => setCode(e.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="np-name">Name</label>
        <input
          id="np-name"
          className="input"
          value={name}
          placeholder="Site B — Tower 1"
          onChange={(e) => setName(e.target.value)}
        />
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
