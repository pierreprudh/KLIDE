import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { startObserverPoll } from "./observerPoll";
import type { Observer } from "./observers";

const observer = (state: "running" | "exited"): Observer => ({
  id: "watch-1", command: "gh run watch 1", startedMs: 0, endedMs: null, notifyOnExit: true,
  status: state === "running" ? { state } : { state, code: 0 },
});

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

it("asks once and then rests when the conversation has no observer", async () => {
  const list = vi.fn(async () => [] as Observer[]);
  startObserverPoll({ list, onRows: () => {}, followup: () => true });
  await vi.advanceTimersByTimeAsync(10_000);
  expect(list).toHaveBeenCalledTimes(1);
});

it("follows a running observer every second, and stops once it exits", async () => {
  let rows = [observer("running")];
  const list = vi.fn(async () => rows);
  startObserverPoll({ list, onRows: () => {}, followup: () => true });
  await vi.advanceTimersByTimeAsync(3_000);
  expect(list).toHaveBeenCalledTimes(4);
  rows = [observer("exited")];
  await vi.advanceTimersByTimeAsync(5_000);
  expect(list).toHaveBeenCalledTimes(5);
});

it("a kick from a new Watching row starts following again", async () => {
  let rows: Observer[] = [];
  const list = vi.fn(async () => rows);
  const poll = startObserverPoll({ list, onRows: () => {}, followup: () => true });
  await vi.advanceTimersByTimeAsync(2_000);
  rows = [observer("running")];
  poll.kick();
  await vi.advanceTimersByTimeAsync(2_000);
  expect(list).toHaveBeenCalledTimes(4);
});

it("keeps retrying a woken follow-up until the local turn lets it start", async () => {
  let ready = false;
  const followup = vi.fn(() => ready);
  const list = vi.fn(async () => [] as Observer[]);
  const poll = startObserverPoll({ list, onRows: () => {}, followup });
  await vi.advanceTimersByTimeAsync(0);
  poll.wake();
  await vi.advanceTimersByTimeAsync(2_000);
  expect(followup).toHaveBeenCalledTimes(3);
  ready = true;
  await vi.advanceTimersByTimeAsync(5_000);
  expect(followup).toHaveBeenCalledTimes(4);
});

it("a stopped poll never asks again", async () => {
  const list = vi.fn(async () => [observer("running")]);
  const poll = startObserverPoll({ list, onRows: () => {}, followup: () => true });
  poll.stop();
  poll.kick();
  await vi.advanceTimersByTimeAsync(5_000);
  expect(list).toHaveBeenCalledTimes(1);
});
