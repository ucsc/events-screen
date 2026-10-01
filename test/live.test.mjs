/**
 * Opt-in checks against the real events.ucsc.edu REST API. They need network
 * access and depend on live content, so they only run when LIVE_TESTS=1:
 *
 *   LIVE_TESTS=1 npm test
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

const live = process.env.LIVE_TESTS === "1";
const SITE = (process.env.EVENTS_SITE_URL || "https://events.ucsc.edu").replace(/\/$/, "");

describe("live: The Events Calendar REST API", { skip: !live && "set LIVE_TESTS=1 to run" }, () => {
  test("lists upcoming events with the fields the function relies on", async () => {
    const res = await fetch(`${SITE}/wp-json/tribe/events/v1/events?per_page=3`, { headers: { Accept: "application/json" } });
    assert.equal(res.status, 200, `calendar responded ${res.status}`);
    const data = await res.json();
    assert.ok(Array.isArray(data.events) && data.events.length > 0, "at least one upcoming event");

    const ev = data.events[0];
    for (const field of ["slug", "title", "url", "start_date", "end_date", "all_day", "venue"]) {
      assert.ok(field in ev, `event has ${field}`);
    }
    assert.match(ev.start_date, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  test("by-slug returns the same event the listing does", async () => {
    const list = await (await fetch(`${SITE}/wp-json/tribe/events/v1/events?per_page=1`)).json();
    const slug = list.events[0].slug;
    const res = await fetch(`${SITE}/wp-json/tribe/events/v1/events/by-slug/${encodeURIComponent(slug)}`);
    assert.equal(res.status, 200);
    const ev = await res.json();
    assert.equal(ev.slug, slug);
  });

  test("by-slug answers 400 for a slug that does not exist", async () => {
    const res = await fetch(`${SITE}/wp-json/tribe/events/v1/events/by-slug/this-slug-should-not-exist-${Date.now()}`);
    assert.equal(res.status, 400);
  });
});
