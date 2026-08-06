export const inFlightStates = new Set(["claimed", "processing"]);

export function requeueInFlight(messages = []) {
  const requeued = [];
  for (const entry of messages) {
    if (!entry || !inFlightStates.has(entry.state)) continue;
    entry.state = "queued";
    delete entry.claimedBy;
    delete entry.leaseUntil;
    requeued.push(entry);
  }
  return requeued;
}
