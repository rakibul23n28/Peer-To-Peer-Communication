import type { ClientPresenceStatus } from "../presenceStore"

const labels: Record<ClientPresenceStatus, string> = {
  online: "Online",
  away: "Away",
  offline: "Offline",
}

export function PresenceIndicator({
  status,
  compact = false,
}: {
  status: ClientPresenceStatus
  compact?: boolean
}) {
  return <span
    className={`orbit-presence-indicator is-${status}${compact ? " is-compact" : ""}`}
    role="img"
    aria-label={labels[status]}
    title={labels[status]}
  >
    <i aria-hidden="true" />
    <span>{labels[status]}</span>
  </span>
}
