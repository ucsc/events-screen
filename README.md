# UCSC upcoming events

This site shows the most popular upcoming events at UC Santa Cruz. Plausible Analytics traffic sets the order. Each event has a QR code. When a viewer scans the code, the event page opens on their phone.

## How it works

The site has two parts: a static web page and a Netlify Function. A Netlify Function is a small program on Netlify's servers. When the browser requests it, the function runs.

**The web page** is in `public/`: `index.html`, `css/styles.css`, and `js/app.js`. The browser makes the QR codes with `js/vendor/qrcode.min.js` (qrcode-generator 1.4.4, MIT license). The page requests the event list from the function one time per hour after a good load. If a request fails, the page shows the error and tries again after one minute.

**The function** is `netlify/functions/upcoming-events.mjs`. It does these steps:

1. It gets the most-viewed event pages from the Plausible Stats API.
2. It combines the pages of a repeating event into one event. For example, `/event/farm-tour/2026-09-19/` and `/event/farm-tour/` count as one event.
3. It gets the title, dates, venue, and image of each event from the calendar API on events.ucsc.edu.
4. It removes events that are not published. It also removes events that have ended.
5. It returns the events as JSON. Netlify stores the result in its content delivery network (CDN) for one hour.

If an event starts today or later, it is upcoming. If an event started earlier and ends today or later, it is also upcoming. The function reads "today" in the `EVENTS_TIMEZONE` time zone. The default is `America/Los_Angeles`.

For a repeating event, the function first tries the date that got the most views. If that date has passed, the function uses the next date in the series.

The `UPCOMING_EVENTS_RANGE` environment variable sets the time period that the traffic numbers cover. The default is the last 30 days.

## Setup

1. Create a Stats API key in Plausible, under Settings and then API keys.
2. In Netlify, set the `PLAUSIBLE_API_KEY` environment variable to this key.
3. If you want a different time period, set the `UPCOMING_EVENTS_RANGE` environment variable. The values are `day`, `7d`, `30d`, `month`, `12mo`, or any number of days such as `14d`.
4. Deploy the site. The `netlify.toml` file already points to `public/` and `netlify/functions/`.

## Local development

```bash
cp .env.example .env
```

Add your API key to `.env`. Then start the local server:

```bash
npm run dev
```

This command runs `netlify dev` on http://localhost:8888.

## Tests

```bash
npm test
```

The tests use the test runner that is built into Node. You do not install anything. The tests replace `fetch` with a fake, so they do not use the network. They cover these parts of the function:

- `aggregateEventPaths`: combines the pages of a repeating event, ignores query strings and list pages, and sorts the events.
- `isUpcoming` and `todayIn`: the upcoming filter and the date in campus time.
- `fetchPlausiblePages`: the exact request to the Plausible Stats API (URL, API key header, metrics, filters) and the error for a rejected request.
- `enrichEvents`:
  - the requests to the calendar API by slug and by date
  - the next date for a repeating event
  - events that are not published
  - network errors
  - image size selection
  - HTML character codes in titles
  - the venue and address fields
- `collectUpcoming`: the upcoming filter, the new rank numbers, and requests in groups of ten until the list is full.
- The complete function:
  - the JSON fields
  - the cache headers
  - the limits on the `limit` parameter
  - the 500 error for a missing API key
  - the 502 error for a Plausible failure
  - the empty list when no popular event is upcoming

`test/live.test.mjs` has three tests that use the real calendar API on events.ucsc.edu. These tests need the network and depend on the current calendar content. They do not run unless you ask for them:

```bash
npm run test:live
```

## Function API

`GET /api/upcoming-events?limit=10`

| Parameter | Values | Default |
|---|---|---|
| `limit` | 1 to 24 | 10 |

The response has these top-level fields:

- `range`: the time period from `UPCOMING_EVENTS_RANGE`.
- `today`: the date that the upcoming filter used.
- `generatedAt`: the time that the function made the response.
- `events`: the list of events.

Each event has these fields: `rank`, `title`, `url`, `startDate`, `endDate`, `allDay`, `venue`, `address`, `isVirtual`, `categories`, `image`, `visitors`, and `pageviews`.
