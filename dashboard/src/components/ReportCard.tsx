import { useState } from "react";
import { Button } from "./Button";
import { ConfirmDialog, Modal } from "./Modal";
import { Lightbox } from "./Lightbox";
import type { LightboxItem } from "./Lightbox";
import { useToast } from "./Toast";
import { supabase } from "../lib/supabase";
import { fileNameOf, formatFileSize, formatTime } from "../lib/format";
import type { Report, ReportMedia } from "../lib/types";

interface Props {
  report: Report;
  media: ReportMedia[];
  urls: Record<string, string>;
  admin: boolean;
  fresh?: boolean;
  showProject?: boolean;
  onChanged: (report: Report) => void;
  onDeleted: (id: string) => void;
}

export function ReportCard({
  report,
  media,
  urls,
  admin,
  fresh = false,
  showProject = false,
  onChanged,
  onDeleted,
}: Props) {
  const toast = useToast();
  const [openAt, setOpenAt] = useState<number | null>(null);
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(report.note ?? "");
  const [date, setDate] = useState(report.report_date);

  const alt = report.note?.trim() || "site photo";
  const items: LightboxItem[] = media.map((m) => ({
    media: m,
    url: urls[m.storage_path] ?? null,
    alt,
  }));

  async function save() {
    setBusy(true);
    const { data, error } = await supabase
      .from("reports")
      .update({ note: note.trim() || null, report_date: date })
      .eq("id", report.id)
      .select("*,workers(full_name),projects(code,name),report_media(*)")
      .single();
    setBusy(false);
    if (error || !data) {
      toast.error(error?.message ?? "Could not save the report.");
      return;
    }
    toast.success("Report updated.");
    setEditing(false);
    onChanged(data as Report);
  }

  async function remove() {
    setBusy(true);
    const { error } = await supabase.from("reports").delete().eq("id", report.id);
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Report deleted.");
    setConfirming(false);
    onDeleted(report.id);
  }

  return (
    <article className={`panel report-card ${fresh ? "fresh" : ""}`.trim()}>
      <div className="report-head">
        <span className="who truncate" title={report.workers?.full_name ?? "Unknown worker"}>
          {report.workers?.full_name ?? "Unknown worker"}
        </span>
        <span className="chip tnum">{formatTime(report.created_at)}</span>
        {showProject && report.projects && (
          <span className="chip code" title={report.projects.name}>
            {report.projects.code}
          </span>
        )}
        <span className="chip">{media.length} media</span>
        <span className="spacer" />
        {admin && (
          <>
            <Button variant="ghost" onClick={() => setEditing(true)}>
              Edit
            </Button>
            <Button variant="danger" onClick={() => setConfirming(true)}>
              Delete
            </Button>
          </>
        )}
      </div>

      {report.note && <p className="report-note">{report.note}</p>}

      {media.length > 0 && (
        <div className="thumbs">
          {media.map((m, i) => {
            const url = urls[m.storage_path];
            const name = fileNameOf(m.storage_path);
            return (
              <button
                key={m.id}
                className="thumb"
                onClick={() => setOpenAt(i)}
                aria-label={`Open ${m.media_type}: ${name}`}
                title={name}
              >
                {m.media_type === "photo" && url ? (
                  <img src={url} alt={alt} loading="lazy" decoding="async" />
                ) : (
                  <span className="file-tile">
                    <span className="truncate" style={{ maxWidth: "100%" }}>
                      {name}
                    </span>
                    <span>{formatFileSize(m.file_size)}</span>
                  </span>
                )}
                {m.media_type !== "photo" && <span className="badge">{m.media_type}</span>}
              </button>
            );
          })}
        </div>
      )}

      {openAt !== null && items.length > 0 && (
        <Lightbox
          items={items}
          index={openAt}
          onIndex={setOpenAt}
          onClose={() => setOpenAt(null)}
        />
      )}

      {editing && (
        <Modal
          title="Edit report"
          onClose={() => setEditing(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
              <Button variant="primary" loading={busy} onClick={() => void save()}>
                Save changes
              </Button>
            </>
          }
        >
          <div className="field">
            <label htmlFor={`date-${report.id}`}>Report date</label>
            <input
              id={`date-${report.id}`}
              className="input"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor={`note-${report.id}`}>Note</label>
            <textarea
              id={`note-${report.id}`}
              className="input"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
        </Modal>
      )}

      {confirming && (
        <ConfirmDialog
          title="Delete this report?"
          message={`${media.length} media file${media.length === 1 ? "" : "s"} will be removed from the record. This cannot be undone.`}
          confirmLabel="Delete report"
          busy={busy}
          onConfirm={() => void remove()}
          onClose={() => setConfirming(false)}
        />
      )}
    </article>
  );
}
