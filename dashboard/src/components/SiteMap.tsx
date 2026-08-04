import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

export interface MapPoint {
  lat: number;
  lng: number;
  kind: "in" | "out" | "site";
  label: string;
  sub?: string;
  /** Optional numbered badge for multi-project overview maps. */
  number?: number;
}

interface Props {
  points: MapPoint[];
  /** Draw a dashed connector, with its distance, between the in and out points. */
  connect?: boolean;
  height?: number;
  className?: string;
}

const TILE_URL = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
const ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
/** The in→out connector is a measurement, not a status — it takes the warn hue. */
const CONNECTOR = "#e8871a";
/** Singapore, city-wide — the only region this company operates in. */
const SG_CENTRE = { lat: 1.3521, lng: 103.8198, zoom: 11 };

/** "820 m" / "15.4 km" — metres below a kilometre, one decimal above. */
function formatGap(meters: number): string {
  return meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${Math.round(meters)} m`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function iconFor(point: MapPoint): L.DivIcon {
  const overview = point.kind === "site" && point.number !== undefined;
  const size = overview ? 28 : point.kind === "site" ? 20 : 18;
  return L.divIcon({
    className: `map-pin map-pin-${point.kind}${overview ? " map-pin-overview" : ""}`,
    html: `<span class="map-pin-mark" aria-hidden="true">${overview ? point.number : ""}</span>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    tooltipAnchor: [0, -size / 2],
  });
}

/** The map is not screen-reader legible, so the container carries the summary. */
function describe(points: MapPoint[]): string {
  if (points.length === 0) return "Map with no recorded locations";
  const ins = points.filter((p) => p.kind === "in");
  const out = points.find((p) => p.kind === "out");
  const site = points.find((p) => p.kind === "site");
  const parts: string[] = [];

  if (ins.length === 1 && out) {
    const gap = L.latLng(ins[0].lat, ins[0].lng).distanceTo(L.latLng(out.lat, out.lng));
    parts.push(`check-in and check-out locations ${formatGap(gap)} apart`);
  } else if (ins.length > 1) {
    parts.push(`${ins.length} check-in locations`);
  } else if (ins.length === 1) {
    parts.push("the check-in location");
  } else if (out) {
    parts.push("the check-out location");
  }
  if (site) parts.push("the project site");

  return `Map showing ${parts.join(", plus ")}`;
}

export function SiteMap({ points, connect = false, height = 360, className = "" }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  // Points are rebuilt on every render; the geometry is what the map cares about.
  const key = JSON.stringify(points);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const parsed = JSON.parse(key) as MapPoint[];
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const animate = !reduced;

    const map = L.map(host, {
      scrollWheelZoom: false,
      keyboard: true,
      attributionControl: true,
      zoomControl: true,
    });

    L.tileLayer(TILE_URL, { maxZoom: 19, attribution: ATTRIBUTION }).addTo(map);

    const latlngs = parsed.map((p) => L.latLng(p.lat, p.lng));
    parsed.forEach((p, i) => {
      L.marker(latlngs[i], { icon: iconFor(p), keyboard: false })
        .addTo(map)
        .bindTooltip(
          `<strong>${escapeHtml(p.label)}</strong>${
            p.sub ? `<span>${escapeHtml(p.sub)}</span>` : ""
          }`,
          { direction: "top", className: "map-tip", offset: [0, -2] },
        );
    });

    if (connect) {
      const a = parsed.findIndex((p) => p.kind === "in");
      const b = parsed.findIndex((p) => p.kind === "out");
      if (a !== -1 && b !== -1) {
        L.polyline([latlngs[a], latlngs[b]], {
          color: CONNECTOR,
          weight: 2,
          dashArray: "5 6",
        }).addTo(map);
        const gap = formatGap(map.distance(latlngs[a], latlngs[b]));
        L.tooltip({
          permanent: true,
          direction: "center",
          className: "map-dist-tip",
          interactive: false,
        })
          .setLatLng(L.latLng((latlngs[a].lat + latlngs[b].lat) / 2, (latlngs[a].lng + latlngs[b].lng) / 2))
          .setContent(gap)
          .addTo(map);
      }
    }

    let fitted = false;
    const fit = () => {
      if (latlngs.length === 0) {
        map.setView(L.latLng(SG_CENTRE.lat, SG_CENTRE.lng), SG_CENTRE.zoom, { animate: false });
        fitted = true;
        return;
      }
      if (latlngs.length === 1) map.setView(latlngs[0], 16, { animate });
      else map.fitBounds(L.latLngBounds(latlngs), { padding: [40, 40], maxZoom: 17, animate });
      fitted = host.clientWidth > 0;
    };
    fit();

    // Leaflet measures the container on creation; inside a modal that is still
    // animating the tiles come out as grey slivers unless we re-measure after.
    const ro = new ResizeObserver(() => {
      map.invalidateSize({ animate: false });
      if (!fitted) fit();
    });
    ro.observe(host);

    const enableWheel = () => map.scrollWheelZoom.enable();
    const disableWheel = () => map.scrollWheelZoom.disable();
    host.addEventListener("click", enableWheel);
    host.addEventListener("focusin", enableWheel);
    host.addEventListener("mouseleave", disableWheel);
    host.addEventListener("focusout", disableWheel);

    return () => {
      ro.disconnect();
      host.removeEventListener("click", enableWheel);
      host.removeEventListener("focusin", enableWheel);
      host.removeEventListener("mouseleave", disableWheel);
      host.removeEventListener("focusout", disableWheel);
      map.remove();
      // StrictMode mounts twice; without this Leaflet refuses to re-init the node.
      delete (host as HTMLDivElement & { _leaflet_id?: number })._leaflet_id;
    };
  }, [key, connect]);

  return (
    <div
      ref={hostRef}
      className={`site-map${className ? ` ${className}` : ""}`}
      style={{ height }}
      role="img"
      aria-label={describe(points)}
    />
  );
}
