// The Focus hero's provider stack. Focus builds its own picker (the AI panel's
// dropdown is a different surface), so "self-hosted endpoints are selectable
// from Focus" only holds if this builder keeps including them.

import { describe, expect, it, vi } from "vitest";

import { buildProviderOptions } from "./FocusMode";
import type { CustomProvider } from "../customProviders";

const gateway: CustomProvider = {
  id: "custom:my-gateway",
  label: "My Gateway",
  baseUrl: "https://llm.example.com/v1",
  defaultModel: "devstral-small-2:24b",
};

const rowFor = (options: ReturnType<typeof buildProviderOptions>, value: string) =>
  options.find((option) => option.value === value);

describe("Focus provider stack", () => {
  it("offers llama.cpp alongside other local inference providers", () => {
    const options = buildProviderOptions([], new Set(), vi.fn());
    const row = rowFor(options, "llamacpp");
    expect(row?.label).toBe("llama.cpp");
    expect(row?.dimmed).toBeFalsy();
    expect(row?.resolve).toBeUndefined();
  });
  it("offers self-hosted endpoints under their own heading", () => {
    const options = buildProviderOptions([gateway], new Set(), vi.fn());

    expect(rowFor(options, "__heading_Self-hosted")?.heading).toBe(true);
    expect(rowFor(options, "custom:my-gateway")?.label).toBe("My Gateway");
  });

  it("keeps a self-hosted row selectable even with no key", () => {
    const onOpenKeySettings = vi.fn();
    // A self-hosted endpoint may need no auth at all, and the ones that do
    // resolve a `${VAR}` reference outside the keychain — so "no key" must not
    // quiet the row or divert the click to Settings.
    const options = buildProviderOptions([gateway], new Set(["custom:my-gateway"]), onOpenKeySettings);

    const row = rowFor(options, "custom:my-gateway");
    expect(row?.dimmed).toBeFalsy();
    expect(row?.resolve).toBeUndefined();
  });

  it("still quiets a hosted provider with no key and routes it to Settings", () => {
    const onOpenKeySettings = vi.fn();
    const options = buildProviderOptions([], new Set(["anthropic"]), onOpenKeySettings);

    const row = rowFor(options, "anthropic");
    expect(row?.dimmed).toBe(true);
    row?.resolve?.run();
    expect(onOpenKeySettings).toHaveBeenCalledTimes(1);
  });

  it("offers delegate CLIs, so a subscription can start a Focus conversation", () => {
    const options = buildProviderOptions([], new Set(), vi.fn());
    expect(rowFor(options, "claude-code")?.label).toBeTruthy();
  });

  it("never quiets a delegate for a missing API key", () => {
    const onOpenKeySettings = vi.fn();
    // A delegate authenticates through its own CLI login, so an empty keychain
    // says nothing about it — quieting the row would hide the one route that
    // runs on a subscription rather than a key.
    const options = buildProviderOptions([], new Set(["claude-code"]), onOpenKeySettings);

    const row = rowFor(options, "claude-code");
    expect(row?.dimmed).toBeFalsy();
    expect(row?.resolve).toBeUndefined();
  });
});
