import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { SectionHeader } from "../components/SectionHeader";
import { Button } from "../components/Button";
import { Card } from "../components/Card";
import { Skeleton } from "../components/Skeleton";
import { useToast } from "../components/Toast";

const KEY = "flag_distance_km";
const DAY_START_KEY = "payroll_day_start";

/** "8:5" and "08:05" both come out as "08:05"; anything else is rejected. */
function normalizeTime(raw: string): string | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

export function SettingsPage() {
  const toast = useToast();
  const [value, setValue] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dayStart, setDayStart] = useState<string | null>(null);
  const [dayBusy, setDayBusy] = useState(false);

  useEffect(() => {
    let active = true;
    void (async () => {
      const { data, error } = await supabase
        .from("settings")
        .select("key,value")
        .in("key", [KEY, DAY_START_KEY]);
      if (!active) return;
      if (error) toast.error(error.message);
      const byKey = new Map(
        ((data ?? []) as Array<{ key: string; value: unknown }>).map((r) => [r.key, r.value]),
      );
      const km = byKey.get(KEY);
      setValue(typeof km === "number" ? String(km) : km ? String(km) : "10");
      const start = byKey.get(DAY_START_KEY);
      setDayStart(normalizeTime(typeof start === "string" ? start : "") ?? "08:00");
    })();
    return () => {
      active = false;
    };
  }, [toast]);

  async function saveDayStart() {
    const time = normalizeTime(dayStart ?? "");
    if (!time) {
      toast.error("Enter a time of day, like 08:00.");
      return;
    }
    setDayBusy(true);
    const { error } = await supabase
      .from("settings")
      .upsert({ key: DAY_START_KEY, value: time }, { onConflict: "key" });
    setDayBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    setDayStart(time);
    toast.success(`Payroll day starts at ${time}.`);
  }

  async function save() {
    const km = Number(value);
    // An unbounded threshold silently disables flagging, so refuse the nonsense
    // range rather than storing it.
    if (!Number.isFinite(km) || km <= 0) {
      toast.error("Enter a distance greater than zero.");
      return;
    }
    if (km > 500) {
      toast.error("That's larger than any realistic shift — use 500 km or less.");
      return;
    }
    setBusy(true);
    const { error } = await supabase
      .from("settings")
      .upsert({ key: KEY, value: km }, { onConflict: "key" });
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success(`Flag threshold set to ${km} km.`);
  }

  return (
    <div className="reveal">
      <SectionHeader title="Settings" />

      <Card style={{ maxWidth: 520 }}>
        <div className="field">
          <label htmlFor="flag-km">Flag distance (km)</label>
          {value === null ? (
            <Skeleton height={40} radius={12} />
          ) : (
            <input
              id="flag-km"
              className="input tnum"
              type="number"
              min={0.1}
              max={500}
              step={0.1}
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          )}
        </div>

        <p className="muted" style={{ marginTop: 12, fontSize: "0.88rem" }}>
          When a worker checks out, the bot measures the straight-line distance between the
          check-in and check-out points. At or above this threshold the record is tagged{" "}
          <strong>far_apart</strong> and lands in the attendance flags queue for review.
        </p>

        <div className="modal-actions">
          <Button
            variant="primary"
            loading={busy}
            disabled={value === null}
            onClick={() => void save()}
          >
            Save threshold
          </Button>
        </div>
      </Card>

      <Card style={{ maxWidth: 520, marginTop: 20 }}>
        <div className="field">
          <label htmlFor="pay-day-start">Payroll day start</label>
          {dayStart === null ? (
            <Skeleton height={40} radius={12} />
          ) : (
            <input
              id="pay-day-start"
              className="input tnum"
              type="time"
              value={dayStart}
              onChange={(e) => setDayStart(e.target.value)}
            />
          )}
        </div>

        <p className="muted" style={{ marginTop: 12, fontSize: "0.88rem" }}>
          Pay is calculated from this time to check-out, whatever time the worker actually
          checked in.
        </p>

        <div className="modal-actions">
          <Button
            variant="primary"
            loading={dayBusy}
            disabled={dayStart === null}
            onClick={() => void saveDayStart()}
          >
            Save day start
          </Button>
        </div>
      </Card>
    </div>
  );
}
