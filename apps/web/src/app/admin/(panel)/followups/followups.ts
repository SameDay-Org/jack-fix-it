import type { components } from "@jack/shared";

import { isUuid } from "../queue/queue";

export type FollowupsPage = components["schemas"]["FollowupsPage"];
export type FollowupDue = components["schemas"]["FollowupDue"];

export const FOLLOWUPS_PATH = "/admin/followups";

/** The page's two views, as the API lists them: due by tonight (overdue included), or all open. */
export const FOLLOWUP_VIEWS = ["today", "all"] as const satisfies readonly FollowupDue[];

type Param = string | string[] | undefined;

function one(value: Param): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** What the reader asked for in the URL; anything the API would refuse is dropped. */
export type FollowupsQuery = { due: FollowupDue; assignee?: string; cursor?: string };

export function toQuery(query: Record<string, Param>, isAdmin: boolean): FollowupsQuery {
  const due = query.due === "all" ? "all" : "today";
  const assignee = one(query.assignee);
  const cursor = one(query.cursor);
  return {
    due,
    // Only an admin reads another's list: an agent's URL never asks for one.
    assignee: isAdmin && assignee && isUuid(assignee) ? assignee : undefined,
    cursor: cursor && cursor.length <= 200 ? cursor : undefined,
  };
}

export function followupsHref({ due, assignee, cursor }: FollowupsQuery): string {
  const search = new URLSearchParams();
  if (due !== "today") search.set("due", due);
  if (assignee) search.set("assignee", assignee);
  if (cursor) search.set("cursor", cursor);
  const text = search.toString();
  return text ? `${FOLLOWUPS_PATH}?${text}` : FOLLOWUPS_PATH;
}
