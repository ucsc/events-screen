# UCSC upcoming events

Popular upcoming events at UC Santa Cruz, ranked by Plausible Analytics traffic. The page shows one hero plus rows of additional events. The page is built for a display screen, so it has no links or buttons. Each event carries a QR code that viewers can scan to open the event page.

## How it works

- `public/` is the static site: `index.html`, `css/styles.css`, `js/app.js`. Each card carries a QR code for its event page, generated in the browser by `js/vendor/qrcode.min.js` (qrcode-generator 1.4.4, MIT license). 
- `netlify/functions/upcoming-events.mjs` is the serverless function. It collapses recurring-event paths like `/event/slug/2026-09-19/` into one event, drops events that have since been unpublished, and caches the result on Netlify's CDN for 10 minutes.
- Only upcoming events are shown: an event is kept if it starts today or later, or if it started earlier and runs through today. "Today" is computed in `EVENTS_TIMEZONE` (default `America/Los_Angeles`). For a recurring event whose most-viewed date has passed, the function falls back to the series' next occurrence.
- The page covers one fixed time period, set by `UPCOMING_EVENTS_RANGE`, and refreshes itself every 10 minutes. If a refresh fails, the error is shown on screen and the page tries again after one minute.

## Setup

1. Create a Stats API key in Plausible (Settings → API keys).
2. In Netlify, set the environment variable `PLAUSIBLE_API_KEY`.
3. Optionally set `UPCOMING_EVENTS_RANGE` to the period the page should cover
   (`day`, `7d`, **`30d`**, `month`, `12mo`, or any `<N>d`).
4. Deploy. The `netlify.toml` already points at `public/` and
   `netlify/functions/`.

## Local development

```bash
cp .env.example .env   # add your API key
npm run dev            # runs `netlify dev` on http://localhost:8888
```

## Function API

`GET /api/upcoming-events?limit=10`

| Parameter | Values | Default |
|---|---|---|
| `limit` | 1–24 | 10 |

The time period comes from the `UPCOMING_EVENTS_RANGE` environment variable
and is echoed back in the response as `range`.

The response also carries `today`, the date used for the upcoming filter.
Each event in the response includes `rank`, `title`, `url`, `startDate`,
`endDate`, `allDay`, `venue`, `isVirtual`, `categories`, `image`,
`visitors` and `pageviews`.

