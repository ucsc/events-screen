import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { stubFetch, jsonResponse, page, plausibleRow, calendarEvent } from "./helpers.mjs";

// The function reads most settings when the module loads, so pin them first.
process.env.PLAUSIBLE_API_KEY = "test-key";
process.env.PLAUSIBLE_SITE_ID = "events.example.edu";
process.env.PLAUSIBLE_API_HOST = "https://plausible.test";
process.env.EVENTS_SITE_URL = "https://events.example.edu";
process.env.UPCOMING_EVENTS_RANGE = "7d";

const fn = await import("../netlify/functions/upcoming-events.mjs");
const { aggregateEventPaths, isUpcoming, todayIn, fetchPlausiblePages, enrichEvents, collectUpcoming } = fn;
const handler = fn.default;

const TODAY = "2026-10-01";
const BY_SLUG = /\/wp-json\/tribe\/events\/v1\/events\/by-slug\//;
const OCCURRENCES = /\/wp-json\/tribe\/events\/v1\/events\?/;
const slugOf = (url) => decodeURIComponent(url.split("/by-slug/")[1]);

beforeEach((t) => {
  // enrichEvents warns about events it can't load; keep test output quiet.
  t.mock.method(console, "warn", () => {});
});

// ---------------------------------------------------------------------------

describe("aggregateEventPaths", () => {
  test("collapses recurring date paths and query strings into one event", () => {
    const ranked = aggregateEventPaths([
      page("/event/farm-tour/2026-10-03/", 30, 40),
      page("/event/farm-tour/", 10, 12),
      page("/event/farm-tour/2026-10-10/", 5, 5),
      page("/event/farm-tour/?utm_source=newsletter", 2, 2),
    ]);
    assert.equal(ranked.length, 1);
    assert.deepEqual(ranked[0], { slug: "farm-tour", visitors: 47, pageviews: 59, occurrenceDate: "2026-10-03" });
  });

  test("ignores paths that are not single event pages", () => {
    const ranked = aggregateEventPaths([
      page("/events/", 500),
      page("/event/", 50),
      page("/events/category/music/", 40),
      page("/event/real-event/", 1),
    ]);
    assert.deepEqual(ranked.map((r) => r.slug), ["real-event"]);
  });

  test("sorts by visitors, then pageviews", () => {
    const ranked = aggregateEventPaths([
      page("/event/c/", 5, 9),
      page("/event/a/", 5, 20),
      page("/event/b/", 9, 9),
    ]);
    assert.deepEqual(ranked.map((r) => r.slug), ["b", "a", "c"]);
  });

  test("single-occurrence events have no occurrence date", () => {
    const [entry] = aggregateEventPaths([page("/event/one-off/", 3)]);
    assert.equal(entry.occurrenceDate, null);
  });
});

describe("isUpcoming", () => {
  const cases = [
    ["starts today", "2026-10-01 15:00:00", "2026-10-01 18:00:00", true],
    ["starts tomorrow, no end date", "2026-10-02 09:00:00", null, true],
    ["ended yesterday", "2026-09-30 12:00:00", "2026-09-30 13:00:00", false],
    ["multi-day running through today", "2026-09-28 09:00:00", "2026-10-03 17:00:00", true],
    ["multi-day that ended yesterday", "2026-09-20 09:00:00", "2026-09-30 17:00:00", false],
    ["same event last year", "2025-10-01 14:00:00", "2025-10-01 18:00:00", false],
    ["no dates at all", null, null, false],
  ];
  for (const [name, start, end, expected] of cases) {
    test(name, () => assert.equal(isUpcoming(start, end, TODAY), expected));
  }
});

describe("todayIn", () => {
  test("uses the campus calendar date, not the server's", () => {
    // 05:30 UTC on Oct 2 is still 22:30 on Oct 1 in Santa Cruz.
    const now = new Date("2026-10-02T05:30:00Z");
    assert.equal(todayIn("America/Los_Angeles", now), "2026-10-01");
    assert.equal(todayIn("UTC", now), "2026-10-02");
  });

  test("returns YYYY-MM-DD", () => {
    assert.match(todayIn("America/Los_Angeles"), /^\d{4}-\d{2}-\d{2}$/);
  });
});

// ---------------------------------------------------------------------------

describe("fetchPlausiblePages", () => {
  test("posts a Stats API v2 query for top /event/ pages with the API key", async (t) => {
    const calls = stubFetch(t, [["/api/v2/query", { results: [plausibleRow("/event/a/", 7, 9)] }]]);

    const pages = await fetchPlausiblePages("7d");

    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.equal(call.url, "https://plausible.test/api/v2/query");
    assert.equal(call.init.method, "POST");
    assert.equal(call.init.headers.Authorization, "Bearer test-key");
    assert.equal(call.body.site_id, "events.example.edu");
    assert.equal(call.body.date_range, "7d");
    assert.deepEqual(call.body.metrics, ["visitors", "pageviews"]);
    assert.deepEqual(call.body.dimensions, ["event:page"]);
    assert.deepEqual(call.body.filters, [["contains", "event:page", ["/event/"]]]);
    assert.deepEqual(call.body.order_by, [["visitors", "desc"]]);
    assert.deepEqual(pages, [{ path: "/event/a/", visitors: 7, pageviews: 9 }]);
  });

  test("returns an empty list when Plausible has no rows", async (t) => {
    stubFetch(t, [["/api/v2/query", { results: [] }]]);
    assert.deepEqual(await fetchPlausiblePages("7d"), []);
  });

  test("throws with the status and body when Plausible rejects the query", async (t) => {
    stubFetch(t, [["/api/v2/query", () => new Response('{"error":"Invalid API key"}', { status: 401 })]]);
    await assert.rejects(fetchPlausiblePages("7d"), /Plausible responded 401: .*Invalid API key/);
  });
});

// ---------------------------------------------------------------------------

describe("enrichEvents (The Events Calendar lookups)", () => {
  test("looks a one-off event up by slug and shapes the result", async (t) => {
    const calls = stubFetch(t, [
      [BY_SLUG, (url) => calendarEvent(slugOf(url), { title: "Fire &amp; Grace &#8217;26" })],
    ]);

    const [event] = await enrichEvents([{ slug: "fire-grace", visitors: 19, pageviews: 29, occurrenceDate: null }], TODAY);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://events.example.edu/wp-json/tribe/events/v1/events/by-slug/fire-grace");
    assert.equal(event.found, true);
    assert.equal(event.title, "Fire & Grace ’26", "HTML entities are decoded");
    assert.equal(event.url, "https://events.ucsc.edu/event/fire-grace/", "uses the URL the calendar reports");
    assert.equal(event.startDate, "2026-10-15 15:00:00");
    assert.equal(event.endDate, "2026-10-15 18:00:00");
    assert.equal(event.venue, "Upper East Field");
    assert.equal(event.address, "1156 High St, Santa Cruz");
    assert.deepEqual(event.categories, ["Festival", "Undergraduate"]);
    assert.equal(event.visitors, 19);
    assert.equal(event.pageviews, 29);
  });

  test("prefers the medium_large image size", async (t) => {
    stubFetch(t, [[BY_SLUG, (url) => calendarEvent(slugOf(url))]]);
    const [event] = await enrichEvents([{ slug: "pic", visitors: 1, pageviews: 1, occurrenceDate: null }], TODAY);
    assert.deepEqual(event.image, { url: "https://events.ucsc.edu/wp-content/uploads/pic-768x455.png", width: 768, height: 455 });
  });

  test("falls back to the full image when no sizes are listed, and to null when there is no image", async (t) => {
    stubFetch(t, [[BY_SLUG, (url) => {
      const slug = slugOf(url);
      return slug === "no-sizes"
        ? calendarEvent(slug, { image: { url: "https://x/full.png", width: 10, height: 20 } })
        : calendarEvent(slug, { image: false });
    }]]);
    const [withFull, without] = await enrichEvents(
      [{ slug: "no-sizes", visitors: 1, pageviews: 1 }, { slug: "no-image", visitors: 1, pageviews: 1 }], TODAY);
    assert.deepEqual(withFull.image, { url: "https://x/full.png", width: 10, height: 20 });
    assert.equal(without.image, null);
  });

  test("resolves a recurring event to the exact occurrence when that date is still upcoming", async (t) => {
    const calls = stubFetch(t, [
      [OCCURRENCES, { events: [
        calendarEvent("other-event", { start_date: "2026-10-05 09:00:00" }),
        calendarEvent("farm-tour", { start_date: "2026-10-05 10:00:00", end_date: "2026-10-05 11:30:00", url: "https://events.ucsc.edu/event/farm-tour/2026-10-05/" }),
      ] }],
      [BY_SLUG, (url) => calendarEvent(slugOf(url))],
    ]);

    const [event] = await enrichEvents([{ slug: "farm-tour", visitors: 5, pageviews: 5, occurrenceDate: "2026-10-05" }], TODAY);

    assert.equal(calls.length, 1, "the occurrence lookup was enough; no by-slug call");
    const q = new URL(calls[0].url).searchParams;
    assert.equal(q.get("start_date"), "2026-10-05 00:00:00");
    assert.equal(q.get("end_date"), "2026-10-05 23:59:59");
    assert.equal(event.startDate, "2026-10-05 10:00:00");
    assert.equal(event.url, "https://events.ucsc.edu/event/farm-tour/2026-10-05/");
  });

  test("skips the occurrence lookup when the most-viewed date has passed and uses the series' next occurrence", async (t) => {
    const calls = stubFetch(t, [
      [OCCURRENCES, () => { throw new Error("should not query a past occurrence"); }],
      [BY_SLUG, (url) => calendarEvent(slugOf(url), { start_date: "2026-10-12 10:00:00", end_date: "2026-10-12 11:30:00" })],
    ]);

    const [event] = await enrichEvents([{ slug: "farm-tour", visitors: 5, pageviews: 5, occurrenceDate: "2026-09-12" }], TODAY);

    assert.equal(calls.length, 1);
    assert.match(calls[0].url, BY_SLUG);
    assert.equal(event.startDate, "2026-10-12 10:00:00");
  });

  test("falls back to by-slug when the occurrence list does not contain the event", async (t) => {
    const calls = stubFetch(t, [
      [OCCURRENCES, { events: [calendarEvent("something-else")] }],
      [BY_SLUG, (url) => calendarEvent(slugOf(url))],
    ]);
    const [event] = await enrichEvents([{ slug: "farm-tour", visitors: 5, pageviews: 5, occurrenceDate: "2026-10-05" }], TODAY);
    assert.equal(calls.length, 2);
    assert.equal(event.found, true);
  });

  test("marks unpublished events as not found instead of failing the batch", async (t) => {
    stubFetch(t, [[BY_SLUG, (url) =>
      slugOf(url) === "gone" ? jsonResponse({ code: "rest_invalid_param" }, 400) : calendarEvent(slugOf(url)),
    ]]);

    const [gone, ok] = await enrichEvents(
      [{ slug: "gone", visitors: 9, pageviews: 9 }, { slug: "still-here", visitors: 1, pageviews: 1 }], TODAY);

    assert.equal(gone.found, false);
    assert.equal(gone.title, "Gone", "slug is humanized as a fallback title");
    assert.equal(gone.url, "https://events.example.edu/event/gone/");
    assert.equal(ok.found, true);
  });

  test("survives a network error for one event", async (t) => {
    stubFetch(t, [[BY_SLUG, () => { throw new TypeError("fetch failed"); }]]);
    const [event] = await enrichEvents([{ slug: "offline", visitors: 1, pageviews: 1 }], TODAY);
    assert.equal(event.found, false);
  });

  test("reports virtual events and events without a venue", async (t) => {
    stubFetch(t, [[BY_SLUG, (url) => calendarEvent(slugOf(url), { is_virtual: true, venue: [] })]]);
    const [event] = await enrichEvents([{ slug: "webinar", visitors: 1, pageviews: 1 }], TODAY);
    assert.equal(event.isVirtual, true);
    assert.equal(event.venue, null);
    assert.equal(event.address, null);
  });
});

// ---------------------------------------------------------------------------

describe("collectUpcoming", () => {
  // Build a ranked list of N slugs; the calendar stub answers from `catalog`.
  const ranked = (slugs) => slugs.map((slug, i) => ({ slug, visitors: 100 - i, pageviews: 100 - i, occurrenceDate: null }));
  const catalog = (map) => [BY_SLUG, (url) => {
    const slug = slugOf(url);
    if (!(slug in map)) return jsonResponse({}, 404);
    return calendarEvent(slug, map[slug]);
  }];

  test("drops events that have ended and unpublished events, then ranks what is left", async (t) => {
    stubFetch(t, [catalog({
      "big-past": { start_date: "2026-09-20 10:00:00", end_date: "2026-09-20 12:00:00" },
      "today": { start_date: "2026-10-01 10:00:00", end_date: "2026-10-01 12:00:00" },
      "ongoing": { start_date: "2026-09-25 10:00:00", end_date: "2026-10-04 12:00:00" },
      "future": { start_date: "2026-11-01 10:00:00", end_date: "2026-11-01 12:00:00" },
    })]);

    const events = await collectUpcoming(ranked(["big-past", "today", "unpublished", "ongoing", "future"]), 9, TODAY);

    assert.deepEqual(events.map((e) => e.slug), ["today", "ongoing", "future"]);
    assert.deepEqual(events.map((e) => e.rank), [1, 2, 3], "ranks are renumbered after filtering");
  });

  test("keeps looking past the first batch until the list is full", async (t) => {
    // 12 past events ranked first, then 3 upcoming ones further down.
    const slugs = [...Array.from({ length: 12 }, (_, i) => `past-${i}`), "up-1", "up-2", "up-3"];
    const map = Object.fromEntries(slugs.map((s) => [s, s.startsWith("past")
      ? { start_date: "2026-09-01 10:00:00", end_date: "2026-09-01 12:00:00" }
      : { start_date: "2026-10-20 10:00:00", end_date: "2026-10-20 12:00:00" }]));
    const calls = stubFetch(t, [catalog(map)]);

    const events = await collectUpcoming(ranked(slugs), 2, TODAY);

    assert.deepEqual(events.map((e) => e.slug), ["up-1", "up-2"]);
    assert.equal(calls.length, 15, "two batches of ten (15 candidates total) were looked up");
  });

  test("stops after the first batch when it already has enough", async (t) => {
    const slugs = Array.from({ length: 25 }, (_, i) => `ev-${i}`);
    const map = Object.fromEntries(slugs.map((s) => [s, { start_date: "2026-10-20 10:00:00", end_date: "2026-10-20 12:00:00" }]));
    const calls = stubFetch(t, [catalog(map)]);

    const events = await collectUpcoming(ranked(slugs), 9, TODAY);

    assert.equal(events.length, 9);
    assert.equal(calls.length, 10, "only the first batch of ten was fetched");
  });

  test("returns fewer than the limit when the ranking runs out", async (t) => {
    stubFetch(t, [catalog({ only: { start_date: "2026-10-20 10:00:00", end_date: "2026-10-20 12:00:00" } })]);
    const events = await collectUpcoming(ranked(["only"]), 9, TODAY);
    assert.equal(events.length, 1);
  });
});

// ---------------------------------------------------------------------------

describe("handler (the Netlify function end to end)", () => {
  const today = todayIn("America/Los_Angeles");
  const future = (days) => {
    const d = new Date(`${today}T12:00:00`); d.setDate(d.getDate() + days);
    const ymd = d.toISOString().slice(0, 10);
    return { start_date: `${ymd} 10:00:00`, end_date: `${ymd} 12:00:00` };
  };

  const liveRoutes = () => [
    ["/api/v2/query", { results: [
      plausibleRow("/event/cornucopia/", 160, 213),
      plausibleRow("/event/cornucopia-2025/", 21, 23),       // last year's; must be dropped
      plausibleRow("/event/family-send-offs/2026-09-19/", 32, 39),
      plausibleRow("/event/family-send-offs/", 10, 12),
      plausibleRow("/event/harvest-festival/", 16, 25),      // unpublished; must be dropped
      plausibleRow("/events/", 900),                          // listing page; ignored
    ] }],
    [OCCURRENCES, { events: [] }],
    [BY_SLUG, (url) => {
      const slug = slugOf(url);
      if (slug === "harvest-festival") return jsonResponse({ code: "rest_invalid_param" }, 400);
      if (slug === "cornucopia-2025") return calendarEvent(slug, { start_date: "2025-09-22 14:00:00", end_date: "2025-09-22 18:00:00" });
      return calendarEvent(slug, future(slug === "cornucopia" ? 21 : 5));
    }],
  ];

  test("returns ranked upcoming events as JSON with long CDN caching", async (t) => {
    stubFetch(t, liveRoutes());

    const res = await handler(new Request("https://site.netlify.app/api/upcoming-events?limit=9"));
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /application\/json/);
    assert.equal(res.headers.get("cache-control"), "public, max-age=300");
    assert.match(res.headers.get("netlify-cdn-cache-control"), /max-age=3600/);
    assert.equal(res.headers.get("netlify-vary"), "query=limit");

    assert.equal(body.site, "events.example.edu");
    assert.equal(body.range, "7d");
    assert.equal(body.today, today);
    assert.match(body.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(body.events.map((e) => e.slug), ["cornucopia", "family-send-offs"]);
    assert.deepEqual(body.events.map((e) => e.rank), [1, 2]);
    assert.equal(body.events[1].visitors, 42, "recurring paths were merged before ranking");
    for (const e of body.events) assert.ok(e.endDate.slice(0, 10) >= today, `${e.slug} is upcoming`);
  });

  test("clamps the limit to 1..24 and defaults it to 10", async (t) => {
    const slugs = Array.from({ length: 30 }, (_, i) => `ev-${i}`);
    stubFetch(t, [
      ["/api/v2/query", { results: slugs.map((s, i) => plausibleRow(`/event/${s}/`, 100 - i)) }],
      [BY_SLUG, (url) => calendarEvent(slugOf(url), future(3))],
    ]);

    const count = async (qs) => (await (await handler(new Request(`https://x/api/upcoming-events${qs}`))).json()).events.length;
    assert.equal(await count(""), 10);
    assert.equal(await count("?limit=3"), 3);
    assert.equal(await count("?limit=0"), 1);
    assert.equal(await count("?limit=99"), 24);
    assert.equal(await count("?limit=abc"), 10);
  });

  test("responds 500 when the Plausible API key is missing", async (t) => {
    const calls = stubFetch(t, liveRoutes());
    const saved = process.env.PLAUSIBLE_API_KEY;
    delete process.env.PLAUSIBLE_API_KEY;
    t.after(() => { process.env.PLAUSIBLE_API_KEY = saved; });

    const res = await handler(new Request("https://x/api/upcoming-events"));

    assert.equal(res.status, 500);
    assert.match((await res.json()).error, /PLAUSIBLE_API_KEY/);
    assert.equal(calls.length, 0, "nothing was fetched");
  });

  test("responds 502 with the upstream message when Plausible fails", async (t) => {
    stubFetch(t, [["/api/v2/query", () => new Response("rate limited", { status: 429 })]]);
    t.mock.method(console, "error", () => {});

    const res = await handler(new Request("https://x/api/upcoming-events"));

    assert.equal(res.status, 502);
    assert.match((await res.json()).error, /Plausible responded 429/);
  });

  test("returns an empty list, not an error, when nothing upcoming is popular", async (t) => {
    stubFetch(t, [
      ["/api/v2/query", { results: [plausibleRow("/event/old/", 50)] }],
      [BY_SLUG, (url) => calendarEvent(slugOf(url), { start_date: "2024-01-01 10:00:00", end_date: "2024-01-01 12:00:00" })],
    ]);
    const res = await handler(new Request("https://x/api/upcoming-events"));
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).events, []);
  });
});
