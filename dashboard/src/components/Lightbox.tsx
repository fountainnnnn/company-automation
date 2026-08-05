import { useEffect, useRef, useState } from "react";
import { useFocusTrap } from "../lib/useFocusTrap";
import { mediaLabel } from "../lib/reports";
import { getSignedUrls } from "../lib/signedUrls";
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
  const closeRef = useRef<HTMLButtonElement>(null);
  const prevRef = useRef<HTMLButtonElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  const lastArrow = useRef<"prev" | "next" | null>(null);
  useFocusTrap(ref, true);

  const current = items[index];
  const hasPrev = index > 0;
  const hasNext = index < items.length - 1;

  // Grids are served resized copies; full resolution is fetched only for the
  // frame actually being looked at. The thumbnail stays on screen until the
  // original arrives, so opening never flashes empty.
  const [fullUrls, setFullUrls] = useState<Record<string, string>>({});
  const path = current?.media.storage_path;
  useEffect(() => {
    if (!path || fullUrls[path]) return;
    let alive = true;
    void getSignedUrls([path]).then((map) => {
      if (alive) setFullUrls((prev) => ({ ...prev, ...map }));
    });
    return () => {
      alive = false;
    };
  }, [path, fullUrls]);

  const shownUrl = (path && fullUrls[path]) || current?.url || null;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowLeft" && index > 0) onIndex(index - 1);
      if (e.key === "ArrowRight" && index < items.length - 1) onIndex(index + 1);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [index, items.length, onIndex, onClose]);

  // Reaching either end of the list disables the arrow you just pressed, and
  // the browser drops focus to <body> — outside the trap. Hand it to Close.
  useEffect(() => {
    const held = lastArrow.current;
    if (!held) return;
    if (held === "prev" ? hasPrev : hasNext) return;
    const active = document.activeElement;
    if (active && active !== document.body && active !== ref.current) return;
    lastArrow.current = null;
    closeRef.current?.focus();
  }, [hasPrev, hasNext]);

  if (!current) return null;

  const name = mediaLabel(current.media);

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
        {shownUrl && (
          <a
            className="btn btn-on-dark"
            href={downloadHref(shownUrl)}
            download={name}
            target="_blank"
            rel="noreferrer"
          >
            Download
          </a>
        )}
        <button className="btn btn-on-dark" ref={closeRef} onClick={onClose}>
          Close
        </button>
      </div>

      <div className="lightbox-stage">
        <button
          className="nav-arrow"
          ref={prevRef}
          onFocus={() => {
            lastArrow.current = "prev";
          }}
          onClick={() => onIndex(index - 1)}
          disabled={!hasPrev}
          aria-label="Previous media"
        >
          ‹
        </button>

        <figure key={current.media.id}>
          {!shownUrl ? (
            <div className="lightbox-doc">This file could not be loaded.</div>
          ) : current.media.media_type === "photo" ? (
            <img src={shownUrl} alt={current.alt} />
          ) : current.media.media_type === "video" ? (
            <video src={shownUrl} controls autoPlay playsInline />
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
          ref={nextRef}
          onFocus={() => {
            lastArrow.current = "next";
          }}
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
