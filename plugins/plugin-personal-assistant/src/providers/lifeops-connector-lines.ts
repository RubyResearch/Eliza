/**
 * One line per distinct `state[: message]`, listing every connector in it.
 * Six health connectors shared the same 90-character Wave-1 notice and three
 * shared ": disconnected" (live 2026-09-14: 13 lines, 1,215 chars, in every
 * planner and evaluator call); the grouped form states the same in 6 lines.
 */

export interface ConnectorLineStatus {
  label: string;
  state: string;
  message?: string;
}

export function formatConnectorDegradationLines(
  statuses: ReadonlyArray<ConnectorLineStatus>,
): string[] {
  const groups = new Map<string, string[]>();
  for (const { label, state, message } of statuses) {
    if (state === "ok") continue;
    const key = `${state}${message ? `: ${message}` : ""}`;
    const labels = groups.get(key);
    if (labels) labels.push(label);
    else groups.set(key, [label]);
  }
  return [...groups.entries()].map(([key, labels]) =>
    labels.length === 1
      ? `Connector ${labels[0]} ${key}`
      : `Connectors ${labels.join(", ")} ${key}`,
  );
}
