import { useEffect, useRef } from "react";
import { useFocusTrap } from "../lib/useFocusTrap";
import { fileNameOf } from "../lib/format";
import type { ReportMedia } from "../lib/types";

export interface LightboxItem {
  media: ReportMedia;
  url: string | null;
  alt: string;
}

interface Props {
  items: LightboxItem[];
  index: number;
  onIndex: (next: number) => void;
  onClose: () => void;
}

function downloadHref(url: string): string {
  return `${url}${url.includes("?") ? "&" : "?"}download=`;
}

export function Lightbox({ items, index, onIndex, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const touchX = useRef<number | null>(null);
  useFocusTrap(ref, true);

  const current = items[index];
  const hasPrev = index > 0;
  const hasNext = index < items.length - 1;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowLeft" && index > 0) onIndex(index - 1);
      if (e.key === "ArrowRight" && index < items.length - 1) onIndex(index + 1);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [index, items.length, onIndex, onClose]);

  if (!current) return null;

  const name = fileNameOf(current.media.storage_path);

  return (
    <div
      className="lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={`Media viewer, ${index + 1} of ${items.length}`}
      ref={ref}
      tabIndex={-1}
      onTouchStart={(e) => {
        touchX.current = e.touches[0].clientX;
      }}
      onTouchEnd={(e) => {
        const start = touchX.current;
        touchX.current = null;
        if (start === null) return;
        const dx = e.changedTouches[0].clientX - start;
        if (dx > 60 && hasPrev) onIndex(index - 1);
        if (dx < -60 && hasNext) onIndex(index + 1);
      }}
    >
      <div className="lightbox-bar">
        <span className="title truncate" title={name}>
          {name}
        </span>
        <span className="tnum" style={{ color: "#fff", opacity: 0.7, flex: "none" }}>
          {index + 1} / {items.length}
        </span>
        <span style={{ flex: 1 }} />
        {current.url && (
          <a
            className="btn btn-on-dark"
            href={downloadHref(current.url)}
            download={name}
            target="_blank"
            rel="noreferrer"
          >
            Download
          </a>
        )}
        <button className="btn btn-on-dark" onClick={onClose}>
          Close
        </button>
      </div>

      <div className="lightbox-stage">
        <button
          className="nav-arrow"
          onClick={() => onIndex(index - 1)}
          disabled={!hasPrev}
          aria-label="Previous media"
        >
          ‹
        </button>

        <figure key={current.media.id}>
          {!current.url ? (
            <div className="lightbox-doc">This file could not be loaded.</div>
          ) : current.media.media_type === "photo" ? (
            <img src={current.url} alt={current.alt} />
          ) : current.media.media_type === "video" ? (
            <video src={current.url} controls autoPlay playsInline />
          ) : (
            <div className="lightbox-doc">
              <p className="truncate" title={name}>
                {name}
              </p>
              <p style={{ opacity: 0.7, fontSize: "0.85rem", marginTop: 8 }}>
                Use Download to open this document.
              </p>
            </div>
          )}
        </figure>

        <button
          className="nav-arrow"
          onClick={() => onIndex(index + 1)}
          disabled={!hasNext}
          aria-label="Next media"
        >
          ›
        </button>
      </div>
    </div>
  );
}
