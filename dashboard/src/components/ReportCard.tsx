import { useMemo, useState } from "react";
import { Button } from "./Button";
import { ConfirmDialog, Modal } from "./Modal";
import { Lightbox, isImage } from "./Lightbox";
import type { LightboxItem } from "./Lightbox";
import { StatusChip } from "./StatusChip";
import { useToast } from "./Toast";
import { MEDIA_BUCKET, supabase } from "../lib/supabase";
import { mediaLabel, REPORT_SELECT, reportEntries } from "../lib/reports";
import { formatFileSize, formatTime } from "../lib/format";
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
  const [date, setDate] = useState(report.report_date);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [removed, setRemoved] = useState<string[]>([]);
  const [added, setAdded] = useState("");

  const entries = useMemo(() => reportEntries(report), [report]);
  // Only real `report_notes` rows are editable; the flat-mirror fallback is not
  // a row anyone can address.
  const notes = report.report_notes ?? [];

  // Seed the form from the report as it stands right now, so an edit never
  // starts from values a realtime update or a cancelled edit left behind.
  function openEditor() {
    setDate(report.report_date);
    setDrafts(Object.fromEntries(notes.map((n) => [n.id, n.body])));
    setRemoved([]);
    setAdded("");
    setEditing(true);
  }

  const alt = report.note?.trim() || "site photo";
  const items: LightboxItem[] = media.map((m) => ({
    media: m,
    url: urls[m.storage_path] ?? null,
    alt,
  }));

  /**
   * Notes are edited one entry at a time on `report_notes`. `reports.note` is a
   * trigger-maintained mirror, so writing it here would only be overwritten.
   */
  async function save() {
    setBusy(true);

    if (removed.length > 0) {
      const { error } = await supabase.from("report_notes").delete().in("id", removed);
      if (error) return fail(error.message);
    }

    for (const n of notes) {
      if (removed.includes(n.id)) continue;
      const body = (drafts[n.id] ?? n.body).trim();
      if (body === n.body) continue;
      if (!body) return fail("A note cannot be emptied — delete it instead.");
      const { error } = await supabase.from("report_notes").update({ body }).eq("id", n.id);
      if (error) return fail(error.message);
    }

    if (added.trim()) {
      const { error } = await supabase
        .from("report_notes")
        .insert({ report_id: report.id, worker_id: null, body: added.trim() });
      if (error) return fail(error.message);
    }

    if (date !== report.report_date) {
      const { error } = await supabase
        .from("reports")
        .update({ report_date: date })
        .eq("id", report.id);
      if (error) return fail(error.message);
    }

    const { data, error } = await supabase
      .from("reports")
      .select(REPORT_SELECT)
      .eq("id", report.id)
      .single();
    setBusy(false);
    if (error || !data) {
      toast.error(error?.message ?? "Saved, but the report could not be reloaded.");
      return;
    }
    toast.success("Report updated.");
    setEditing(false);
    onChanged(data as unknown as Report);
  }

  function fail(message: string) {
    setBusy(false);
    toast.error(message);
  }

  async function remove() {
    setBusy(true);

    // Drop the files first: the row is the only pointer to them, so once it is
    // gone the objects are unreachable.
    const paths = (report.report_media ?? []).map((m) => m.storage_path);
    let orphaned = false;
    if (paths.length > 0) {
      const { error: storageErr } = await supabase.storage.from(MEDIA_BUCKET).remove(paths);
      orphaned = Boolean(storageErr);
    }

    const { error } = await supabase.from("reports").delete().eq("id", report.id);
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    if (orphaned) {
      toast.error("Report deleted, but its files may still be in storage.");
    } else {
      toast.success("Report deleted.");
    }
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
        {report.status === "open" && (
          <StatusChip
            kind="info"
            label="still adding"
            title="The worker is still adding to this record from Telegram."
          />
        )}
        {showProject && report.projects && (
          <span className="chip code" title={report.projects.name}>
            {report.projects.code}
          </span>
        )}
        <span className="chip">{media.length} media</span>
        <span className="spacer" />
        {admin && (
          <>
            <Button variant="ghost" onClick={openEditor}>
              Edit
            </Button>
            <Button variant="danger" onClick={() => setConfirming(true)}>
              Delete
            </Button>
          </>
        )}
      </div>

      {entries.length > 0 && (
        <ul className="report-notes">
          {entries.map((e) => (
            <li key={e.key}>
              <time className="tnum" dateTime={e.at}>
                {formatTime(e.at)}
              </time>
              <span className="note-body">
                {e.body}
                {e.author && <span className="note-by"> — {e.author}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}

      {media.length > 0 && (
        <div className="thumbs">
          {media.map((m, i) => {
            const url = urls[m.storage_path];
            const name = mediaLabel(m);
            return (
              <button
                key={m.id}
                className="thumb"
                onClick={() => setOpenAt(i)}
                aria-label={`Open ${m.media_type}: ${name}`}
                title={name}
              >
                {isImage(m) && url ? (
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
          {notes.length > 0 && (
            <div className="field">
              <label>Entries</label>
              <ul className="note-editor">
                {notes.map((n) => {
                  const gone = removed.includes(n.id);
                  return (
                    <li key={n.id} className={gone ? "gone" : undefined}>
                      <span className="tnum">{formatTime(n.created_at)}</span>
                      <textarea
                        className="input"
                        aria-label={`Note at ${formatTime(n.created_at)}`}
                        rows={2}
                        disabled={gone}
                        value={drafts[n.id] ?? n.body}
                        onChange={(e) =>
                          setDrafts((prev) => ({ ...prev, [n.id]: e.target.value }))
                        }
                      />
                      <Button
                        variant="ghost"
                        onClick={() =>
                          setRemoved((prev) =>
                            gone ? prev.filter((id) => id !== n.id) : [...prev, n.id],
                          )
                        }
                      >
                        {gone ? "Undo" : "Delete"}
                      </Button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          <div className="field">
            <label htmlFor={`note-${report.id}`}>Add note</label>
            <textarea
              id={`note-${report.id}`}
              className="input"
              placeholder="Appended as a new entry, timestamped now."
              value={added}
              onChange={(e) => setAdded(e.target.value)}
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
