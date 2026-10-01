/**
 * Shared test helpers: a fetch stub that routes requests by URL and records
 * every call, plus fixtures shaped like the real APIs' responses.
 */

/**
 * Replace globalThis.fetch for the duration of a test. `routes` is a list of
 * [matcher, responder] pairs; the first matcher that matches the URL wins.
 * A matcher is a string (substring match) or RegExp. A responder is either a
 * plain object (returned as 200 JSON) or a function (url, init) => Response | object.
 * Returns the list of recorded calls and a restore() function.
 */
export function stubFetch(t, routes) {
  const calls = [];
  const original = globalThis.fetch;

  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    for (const [matcher, responder] of routes) {
      const hit = matcher instanceof RegExp ? matcher.test(url) : url.includes(matcher);
      if (!hit) continue;
      const out = typeof responder === "function" ? await responder(url, init) : responder;
      return out instanceof Response ? out : jsonResponse(out);
    }
    return new Response("not found", { status: 404 });
  };

  t.after(() => { globalThis.fetch = original; });
  return calls;
}

export function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** A page entry as fetchPlausiblePages returns it (input to aggregateEventPaths). */
export const page = (path, visitors, pageviews = visitors) => ({ path, visitors, pageviews });

/** A raw Plausible v2 breakdown row, as the Stats API returns it. */
export const plausibleRow = (path, visitors, pageviews = visitors) => ({ dimensions: [path], metrics: [visitors, pageviews] });

/** An event as The Events Calendar REST API returns it, with overrides. */
export function calendarEvent(slug, overrides = {}) {
  return {
    id: 1000,
    status: "publish",
    url: `https://events.ucsc.edu/event/${slug}/`,
    title: slug.replace(/-/g, " "),
    slug,
    image: {
      url: `https://events.ucsc.edu/wp-content/uploads/${slug}.png`,
      width: 940,
      height: 557,
      sizes: {
        medium: { width: 800, height: 474, url: `https://events.ucsc.edu/wp-content/uploads/${slug}-800x474.png` },
        medium_large: { width: 768, height: 455, url: `https://events.ucsc.edu/wp-content/uploads/${slug}-768x455.png` },
      },
    },
    all_day: false,
    start_date: "2026-10-15 15:00:00",
    end_date: "2026-10-15 18:00:00",
    timezone: "America/Los_Angeles",
    cost: "",
    is_virtual: false,
    categories: [{ name: "Festival" }, { name: "Undergraduate" }],
    venue: { venue: "Upper East Field", address: "1156 High St", city: "Santa Cruz" },
    ...overrides,
  };
}
