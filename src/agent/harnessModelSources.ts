import { providerGroupsWithCustom, type ProviderGroup } from "./providers";

/** Intelligence-source menus share the same catalog as the base picker.
 * Whether a harness can run a source is a separate adapter capability. */
export function harnessModelSourceGroups(
  custom: { id: string; label: string }[],
  customClis: { id: string; label: string }[] = [],
): ProviderGroup[] {
  const catalog = providerGroupsWithCustom(custom, customClis);
  return ["API", "Local", "Self-hosted", "Subscription"].map((label) => ({
    label,
    items: catalog.filter((group) => group.label === label || (label === "Subscription" && group.label === "Custom CLIs"))
      .flatMap((group) => group.items).filter((item) => item.available),
  }));
}
