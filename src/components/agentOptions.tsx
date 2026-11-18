// The "Subscription / provider" menu a saved trigger picks its agent from —
// grouped Subscriptions / API providers / Local / Automatic / Self-hosted.
// Shared by the schedule editor and Watch CI so both offer the same list.

import { PROVIDER_CATALOG, providerDefinition, providerName } from "../agent/providers";
import type { ProviderId } from "../agent/types";
import { useCustomProviders } from "../hooks/useCustomProviders";
import { ProviderLogo } from "./ai/icons";
import type { ScheduleSelectOption } from "./ScheduleSelect";

const GROUPS = [
  { id: "subscription", name: "Subscriptions", description: "Uses the agent’s saved login" },
  { id: "hosted", name: "API providers", description: "Uses saved API credentials" },
  { id: "local", name: "Local models", description: "Runs on this Mac" },
  { id: "routed", name: "Automatic", description: "Chooses a model for the task" },
];

export function useAgentOptions(current: ProviderId): ScheduleSelectOption[] {
  const customProviders = useCustomProviders();
  const options: ScheduleSelectOption[] = [
    ...GROUPS.flatMap(group => PROVIDER_CATALOG.filter(row => row.group === group.id).map(row => ({ value: row.id, label: row.name, group: group.name, description: group.description, icon: <ProviderLogo id={row.id} size={18} /> }))),
    ...customProviders.map(row => ({ value: row.id, label: row.label, group: "Self-hosted", description: "Your configured endpoint", icon: <ProviderLogo id={row.id as ProviderId} size={18} /> })),
  ];
  if (!options.some(option => option.value === current)) options.unshift({ value: current, label: providerName(current), icon: <ProviderLogo id={current} size={18} /> });
  return options;
}

export function agentSourceLabel(provider: ProviderId): string {
  const group = providerDefinition(provider)?.group;
  return group === "subscription" ? "Subscription" : group === "local" ? "Local model" : group === "routed" ? "Automatic" : "API provider";
}
