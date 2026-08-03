import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { SectionHeader } from "../components/SectionHeader";
import { Button } from "../components/Button";
import { Card } from "../components/Card";
import { Skeleton } from "../components/Skeleton";
import { useToast } from "../components/Toast";

const KEY = "flag_distance_km";

export function SettingsPage() {
  const toast = useToast();
  const [value, setValue] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    void (async () => {
      const { data, error } = await supabase
        .from("settings")
        .select("value")
        .eq("key", KEY)
        .maybeSingle();
      if (!active) return;
      if (error) toast.error(error.message);
      const raw = data?.value;
      setValue(typeof raw === "number" ? String(raw) : raw ? String(raw) : "10");
    })();
    return () => {
      active = false;
    };
  }, [toast]);

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
    </div>
  );
}
