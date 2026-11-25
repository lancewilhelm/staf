import type { Activity } from "@staf/protocol";
import { useState } from "react";
import { activityIcon, Icon } from "./Icon.tsx";

/** One summary line for the steps behind an answer. It opens to show each step. */
export function Activities({ activities, streaming }: { activities: Activity[]; streaming: boolean }) {
  const [open, setOpen] = useState(false);
  if (activities.length === 0) return null;

  const running = activities.findLast((activity) => activity.status === "running");
  const label = streaming && running ? `${running.title}…` : summarize(activities);
  const lead = running ?? activities[activities.length - 1]!;

  return (
    <div className={`activities${open ? " open" : ""}`}>
      <button
        type="button"
        className={`activities-toggle${streaming && running ? " live" : ""}`}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <Icon name={activityIcon[lead.kind]} size={15} />
        <span>{label}</span>
        <span className="chevron">
          <Icon name="chevron" size={14} />
        </span>
      </button>
      {open && (
        <ol className="activity-list">
          {activities.map((activity) => (
            <ActivityRow key={activity.id} activity={activity} />
          ))}
        </ol>
      )}
    </div>
  );
}

function ActivityRow({ activity }: { activity: Activity }) {
  const [open, setOpen] = useState(false);
  const title = (
    <>
      <Icon name={activityIcon[activity.kind]} size={14} />
      <span className="activity-title">{activity.title}</span>
      {activity.status === "failed" && <span className="activity-failed">failed</span>}
    </>
  );
  return (
    <li className={`activity ${activity.status}`}>
      {activity.detail ? (
        <button type="button" className="activity-head" onClick={() => setOpen(!open)} aria-expanded={open}>
          {title}
        </button>
      ) : (
        <div className="activity-head">{title}</div>
      )}
      {open && activity.detail && <pre className="activity-detail">{activity.detail}</pre>}
    </li>
  );
}

function summarize(activities: Activity[]): string {
  const web = activities.filter((a) => a.kind === "search" || a.kind === "page").length;
  const steps = activities.filter((a) => a.kind !== "note" && a.kind !== "reasoning").length;
  const count = activities.length;
  const suffix = count === 1 ? "1 step" : `${count} steps`;
  if (web > 0 && web === steps) return `Searched the web · ${suffix}`;
  if (steps === 0) return `Worked it through · ${suffix}`;
  return `Took ${suffix}`;
}
