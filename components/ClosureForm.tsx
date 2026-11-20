"use client";

import { useActionState } from "react";
import { setClosureAction } from "@/lib/actions";

/**
 * The Company Admin's control for a temporary closure. Both days are included:
 * the store is due again the day after "Last closed day" with no further step.
 */
export function ClosureForm({
  storeId,
  closedFrom,
  closedUntil,
  today,
}: {
  storeId: number;
  closedFrom: string | null;
  closedUntil: string | null;
  today: string;
}) {
  const [state, formAction, pending] = useActionState(setClosureAction, {});
  const hasClosure = Boolean(closedFrom || closedUntil);
  const closedNow =
    hasClosure &&
    (!closedFrom || closedFrom <= today) &&
    (!closedUntil || closedUntil >= today);

  return (
    <form action={formAction} className="card">
      <div className="panel-head">
        <span className="panel-title">Temporary closure</span>
      </div>
      <div className="space-y-3 p-4">
        <input type="hidden" name="storeId" value={storeId} />
        <p className="hint">
          No deposit is required on these days, and they are never counted as
          missed. The store is due again the day after the last closed day.
        </p>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="label" htmlFor="closedFrom">
              First closed day
            </label>
            <input
              id="closedFrom"
              name="closedFrom"
              type="date"
              defaultValue={closedFrom ?? today}
              className="field"
            />
          </div>
          <div>
            <label className="label" htmlFor="closedUntil">
              Last closed day
            </label>
            <input
              id="closedUntil"
              name="closedUntil"
              type="date"
              defaultValue={closedUntil ?? ""}
              className="field"
            />
          </div>
        </div>

        {state.error && (
          <p role="alert" className="text-sm font-semibold text-miss">
            {state.error}
          </p>
        )}
        {state.saved && !state.error && (
          <p role="status" className="notice notice-ok">
            {state.saved}
          </p>
        )}

        <div className="flex gap-2">
          <button
            type="submit"
            name="intent"
            value="save"
            disabled={pending}
            className="btn btn-primary flex-1"
          >
            {pending ? "Saving…" : "Save closure"}
          </button>
          {closedNow && (
            <button
              type="submit"
              name="intent"
              value="reopen"
              disabled={pending}
              className="btn btn-ghost"
            >
              Open today
            </button>
          )}
        </div>
      </div>
    </form>
  );
}
