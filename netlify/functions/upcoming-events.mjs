/**
 * Netlify Function: /api/upcoming-events
 *
 * Pulls the most-viewed event pages from Plausible Analytics (Stats API v2),
 * rolls recurring-event date paths up into a single event, enriches each one
 * with title, date, venue and image from The Events Calendar REST API on
 * events.ucsc.edu, and keeps only events that are still upcoming: anything
 * that starts today or later, or that started earlier and runs through today.
 *
 * Query string:
 *   limit  - number of events to return, 1–24 (default 10)
 *
 * Environment:
 *   PLAUSIBLE_API_KEY     (required) Stats API key from plausible.io
 *   UPCOMING_EVENTS_RANGE  (optional) Plausible date range the page covers:
 *                         day | 7d | 30d | month | 12mo | any <N>d  (default 30d)
 *   PLAUSIBLE_SITE_ID   (optional) defaults to events.ucsc.edu
 *   PLAUSIBLE_API_HOST  (optional) defaults to https://plausible.io
 *   EVENTS_SITE_URL     (optional) defaults to https://events.ucsc.edu
 *   EVENTS_TIMEZONE     (optional) IANA zone used to decide what "today" is,
 *                       defaults to America/Los_Angeles
 */

const RANGE = parseRange(process.env.UPCOMING_EVENTS_RANGE, "30d");
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 24;

const PLAUSIBLE_HOST = (process.env.PLAUSIBLE_API_HOST || "https://plausible.io").replace(/\/$/, "");
const SITE_ID = process.env.PLAUSIBLE_SITE_ID || "events.ucsc.edu";
const EVENTS_SITE = (process.env.EVENTS_SITE_URL || "https://events.ucsc.edu").replace(/\/$/, "");
const EVENTS_TIMEZONE = process.env.EVENTS_TIMEZONE || "America/Los_Angeles";
const ENRICH_BATCH = 10; // event lookups per round while filling the list

export const config = { path: "/api/upcoming-events" };

export default async function handler(request) {
  const url = new URL(request.url);
  const range = RANGE;
  const limit = parseLimit(url.searchParams.get("limit"));

  if (!process.env.PLAUSIBLE_API_KEY) {
    return json({ error: "PLAUSIBLE_API_KEY is not configured." }, 500);
  }

  try {
    const pages = await fetchPlausiblePages(range);
    const ranked = aggregateEventPaths(pages);
    const today = todayIn(EVENTS_TIMEZONE);
    const events = await collectUpcoming(ranked, limit, today);

    return json(
      { site: SITE_ID, range, today, generatedAt: new Date().toISOString(), events },
      200,
      {
        // Browser keeps it briefly; Netlify's CDN keeps it longer and revalidates in the background,
        // so Plausible and WordPress are not hit on every page load.
        "Cache-Control": "public, max-age=120",
        "Netlify-CDN-Cache-Control": "public, durable, max-age=600, stale-while-revalidate=3600",
        "Netlify-Vary": "query=limit",
      }
    );
  } catch (err) {
    console.error(err);
    return json({ error: err.message || "Unexpected error" }, 502);
  }
}

// ---------- Plausible ----------

export async function fetchPlausiblePages(range) {
  const res = await fetch(`${PLAUSIBLE_HOST}/api/v2/query`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.PLAUSIBLE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      site_id: SITE_ID,
      metrics: ["visitors", "pageviews"],
      date_range: range,
      dimensions: ["event:page"],
      filters: [["contains", "event:page", ["/event/"]]],
      order_by: [["visitors", "desc"]],
      pagination: { limit: 200 },
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Plausible responded ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  return (data.results || []).map((row) => ({
    path: row.dimensions[0],
    visitors: row.metrics[0],
    pageviews: row.metrics[1],
  }));
}

/**
 * Collapse `/event/<slug>/`, `/event/<slug>/2026-09-19/` and query-string
 * variants into one entry per event slug, summing the metrics.
 * Returns entries sorted by visitors, then pageviews.
 */
export function aggregateEventPaths(pages) {
  const bySlug = new Map();

  for (const page of pages) {
    const match = /^\/event\/([^/?#]+)(?:\/(\d{4}-\d{2}-\d{2}))?\/?(?:[?#].*)?$/.exec(page.path);
    if (!match) continue;

    const [, slug, date] = match;
    const entry = bySlug.get(slug) || { slug, visitors: 0, pageviews: 0, dates: new Map() };
    entry.visitors += page.visitors;
    entry.pageviews += page.pageviews;
    if (date) entry.dates.set(date, (entry.dates.get(date) || 0) + page.visitors);
    bySlug.set(slug, entry);
  }

  return [...bySlug.values()]
    .map((entry) => ({
      slug: entry.slug,
      visitors: entry.visitors,
      pageviews: entry.pageviews,
      // For recurring events, the occurrence date that drew the most traffic.
      occurrenceDate: [...entry.dates.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null,
    }))
    .sort((a, b) => b.visitors - a.visitors || b.pageviews - a.pageviews);
}

// ---------- The Events Calendar ----------

/**
 * Walk the ranked list in batches, looking each event up and keeping the ones
 * that are still upcoming, until `limit` events are collected or the list runs
 * out. Popular past events (and unpublished ones) fall through the filter, so
 * we usually need to look past the first `limit` candidates.
 */
export async function collectUpcoming(ranked, limit, today) {
  const upcoming = [];
  for (let i = 0; i < ranked.length && upcoming.length < limit; i += ENRICH_BATCH) {
    const batch = await enrichEvents(ranked.slice(i, i + ENRICH_BATCH), today);
    for (const event of batch) {
      if (event.found && isUpcoming(event.startDate, event.endDate, today)) upcoming.push(event);
    }
  }
  return upcoming.slice(0, limit).map((event, index) => ({ ...event, rank: index + 1 }));
}

/**
 * True when the event hasn't finished yet as of `today` (YYYY-MM-DD in campus
 * time): it starts today or later, or it started earlier and ends today or later.
 * Event dates arrive as "YYYY-MM-DD HH:MM:SS" in the same zone, so comparing
 * the date portion as text is enough.
 */
export function isUpcoming(startDate, endDate, today) {
  const last = (endDate || startDate || "").slice(0, 10);
  return Boolean(last) && last >= today;
}

/** Today's date as YYYY-MM-DD in the given IANA time zone. */
export function todayIn(timeZone, now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export async function enrichEvents(ranked, today) {
  const results = await Promise.all(
    ranked.map(async (entry, index) => {
      const event = await fetchEvent(entry.slug, entry.occurrenceDate, today).catch((err) => {
        console.warn(`Could not load ${entry.slug}: ${err.message}`);
        return null;
      });
      return shapeEvent(entry, event, index + 1);
    })
  );
  return results;
}

async function fetchEvent(slug, occurrenceDate, today) {
  // A recurring occurrence has its own start date; use that exact one if it is
  // still upcoming. Otherwise fall back to the by-slug lookup, which for a
  // recurring series resolves to its next occurrence.
  if (occurrenceDate && (!today || occurrenceDate >= today)) {
    const occurrence = await fetchOccurrence(slug, occurrenceDate);
    if (occurrence) return occurrence;
  }
  const res = await fetch(`${EVENTS_SITE}/wp-json/tribe/events/v1/events/by-slug/${encodeURIComponent(slug)}`);
  if (!res.ok) throw new Error(`Events API responded ${res.status}`);
  return res.json();
}

async function fetchOccurrence(slug, date) {
  const params = new URLSearchParams({
    start_date: `${date} 00:00:00`,
    end_date: `${date} 23:59:59`,
    per_page: "50",
  });
  const res = await fetch(`${EVENTS_SITE}/wp-json/tribe/events/v1/events?${params}`);
  if (!res.ok) return null;
  const data = await res.json();
  return (data.events || []).find((ev) => ev.slug === slug) || null;
}

function shapeEvent(entry, event, rank) {
  const base = {
    rank,
    slug: entry.slug,
    visitors: entry.visitors,
    pageviews: entry.pageviews,
    url: `${EVENTS_SITE}/event/${entry.slug}/${entry.occurrenceDate ? entry.occurrenceDate + "/" : ""}`,
  };

  if (!event) {
    return { ...base, title: humanizeSlug(entry.slug), found: false };
  }

  return {
    ...base,
    found: true,
    title: decodeEntities(event.title),
    url: event.url || base.url,
    startDate: event.start_date || null,
    endDate: event.end_date || null,
    allDay: Boolean(event.all_day),
    timezone: event.timezone || "America/Los_Angeles",
    venue: event.venue?.venue || null,
    address: [event.venue?.address, event.venue?.city].filter(Boolean).join(", ") || null,
    isVirtual: Boolean(event.is_virtual),
    categories: (event.categories || []).map((c) => c.name),
    cost: event.cost || null,
    image: pickImage(event.image),
  };
}

function pickImage(image) {
  if (!image || !image.url) return null;
  const sizes = image.sizes || {};
  const preferred = sizes.medium_large || sizes.large || sizes.medium;
  return {
    url: preferred?.url || image.url,
    width: preferred?.width || image.width || null,
    height: preferred?.height || image.height || null,
  };
}

// ---------- helpers ----------

function parseRange(value, fallback) {
  const trimmed = (value || "").trim();
  if (/^(day|month|year|\d+d|\d+mo)$/.test(trimmed)) return trimmed;
  if (trimmed) console.warn(`Ignoring invalid UPCOMING_EVENTS_RANGE "${trimmed}", using ${fallback}`);
  return fallback;
}

function parseLimit(value) {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) return DEFAULT_LIMIT;
  return Math.min(Math.max(n, 1), MAX_LIMIT);
}

function humanizeSlug(slug) {
  return slug.replace(/-/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

function decodeEntities(text = "") {
  return text
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#8217;|&rsquo;/g, "’")
    .replace(/&#8216;|&lsquo;/g, "‘")
    .replace(/&#8211;|&ndash;/g, "–")
    .replace(/&#8212;|&mdash;/g, "—")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...extraHeaders },
  });
}
