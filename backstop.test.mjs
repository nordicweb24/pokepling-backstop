// What this runner must never do again.
//
// On 6 October at 14:46 UTC the last restock alert PokePling has ever sent went
// out. For the next two days the engine detected every restock correctly, wrote
// every one to the database, and told nobody — because `quiet: true` was a
// constant in the body of the POST this file sends, and the endpoint honours it
// by applying the change and skipping the dispatcher entirely.
//
// Nothing could see it. The worker's cycles logged `changes: 0` because the
// flip had already been applied; `restocked_at` and `stock_events` were all
// correct; no error was raised, no operator alert fired, no row was written to
// say an alert had failed, because none was ever attempted. The only visible
// symptom was an absence, and absences do not raise alarms.
//
// A behavioural test cannot catch this. The code runs, the request succeeds,
// the database ends up right. The defect is one word in a JSON body, so the
// test has to read the source.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const raw = readFileSync(new URL("./backstop.mjs", import.meta.url), "utf8");

/**
 * The file with its comments removed.
 *
 * The first version of this test matched the whole file and failed on its own
 * explanation: the comment above the threshold quotes the exact line it exists
 * to forbid. A test that cannot tell code from prose about the code is a test
 * that goes off whenever somebody documents the bug.
 */
const src = raw.replace(/^\s*\/\/.*$/gm, "");

test("quiet is decided, never asserted", () => {
  // The exact line that cost thirty-five people the 30th Celebration drop.
  assert.doesNotMatch(src, /quiet:\s*true/,
    "a constant `quiet: true` silences every restock this runner ever finds");
  assert.match(src, /quiet:\s*catchUp\b/,
    "quiet must come from the staleness measurement, not a literal");
});

test("the staleness it decides from is the one it measured", () => {
  // `freshest` is computed from /health before any shop is read. The decision
  // has to use it: a `catchUp` derived from anything else (a flag, an argument,
  // the clock) is not evidence about how old the data is.
  const m = /const catchUp = ([^;]+);/.exec(src);
  assert.ok(m, "expected one place where old-news-vs-live-news is decided");
  assert.match(m[1], /freshest/, "the decision must read the measured staleness");
  assert.match(m[1], /CATCHUP_MINUTES/, "and compare it against the named threshold");
});

test("unknown staleness is treated as a catch-up, not as fresh", () => {
  // `freshest` is Math.min over an array that can be empty — which yields
  // Infinity — and /health can fail to report a shop at all. Reading that as
  // "fresh" would turn a blackout into a flood of alerts about drops that are
  // already over, which is the failure `quiet` was introduced to prevent.
  const m = /const catchUp = ([^;]+);/.exec(src);
  assert.match(m[1], /!Number\.isFinite\(freshest\)/,
    "an unmeasurable staleness must fail safe towards quiet");
});

test("the threshold is a number with a reason, not a guess", () => {
  const m = /const CATCHUP_MINUTES = (\d+);/.exec(src);
  assert.ok(m, "the threshold must be named and live in one place");
  const mins = Number(m[1]);
  // Below the backstop's own cadence it would call every ordinary run a
  // catch-up and we are back to silence. Far above it and genuinely stale news
  // gets paged out. Five minutes is the floor GitHub allows; runs get delayed.
  assert.ok(mins > 5, `${mins} min is at or under the run cadence — every run would be quiet`);
  assert.ok(mins <= 60, `${mins} min would page people about hours-old drops`);
});

test("the agent-alive gate still sits below the worker's trigger", () => {
  // Unrelated to the silence, and the reason the first live test dispatched a
  // runner that then decided it was not needed. Pinned so the two thresholds
  // cannot drift back together.
  const alive = Number(/const AGENT_ALIVE_MINUTES = (\d+);/.exec(src)[1]);
  assert.ok(alive < 4, `${alive} min must stay under the worker's 4-minute dispatch trigger`);
});
