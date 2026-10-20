export type CardConnectStatus = "not_started" | "in_progress" | "ready";

/** Not started until an account exists. Ready only when that account can take charges. */
export function cardConnectStatus(hasAccount: boolean, ready: boolean): CardConnectStatus {
  if (ready === true) return "ready";
  if (hasAccount) return "in_progress";
  return "not_started";
}

export function cardConnectStatusLabel(status: CardConnectStatus): string {
  if (status === "ready") return "Ready";
  if (status === "in_progress") return "In progress";
  return "Not started";
}
