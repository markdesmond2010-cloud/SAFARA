# Safara

Automatic reminder calls for transport companies.

Bus companies' websites send it bookings. It phones each passenger before departure, retries if they don't pick up, and shows each company its own calls in a portal.

Needs Node 22.13+. No npm install. Data is stored in a SQLite file (`data/app.db`).

    node server.js

| Page | Who | Address |
|---|---|---|
| Company portal | each bus company | `/portal` |
| Admin | you | `/dashboard` (login in `.env`, default admin / changeme) |
| API | companies' website servers | `/v1/reminders` |

With no Africa's Talking keys it runs in MOCK mode: calls are simulated and free.

## Adding a bus company
Open `/dashboard`, type the company name, click **Add company**. You get a portal login, a portal password and an API key. They are shown once: send them to the company. You can reset a password later; the API key can't be shown again.

Per company you can set: how many minutes before departure to call (default 90; the company can also change this itself in its portal), how many calls to try (default 7), and the gap between tries (default 60 seconds).

## API (from the company's server, never from the browser)
`POST /v1/reminders` with header `Authorization: Bearer THEIR_KEY`

    {
      "reference": "VT123456",                 optional booking ID; sending it twice won't create two calls
      "passenger_name": "Ada Okafor",
      "phone": "08031234567",
      "from": "Abuja", "to": "Lagos",          optional
      "departure_time": "2026-10-08T08:00:00+01:00",
      "consent": true,                         required: the passenger agreed to an automated call
      "webhook_url": "https://their-site/hook" optional: we POST the final result there
    }

Also: `GET /v1/reminders`, `GET /v1/reminders/:id`, `POST /v1/reminders/:id/cancel`.
Statuses: `pending`, `calling`, `answered` (picked up and listened 5s+), `failed`, `cancelled`.

## How many calls at once
`MAX_CONCURRENT_CALLS` (default 10) caps calls in progress. Extra reminders wait their turn, nearest departure first. Raise it only to what your phone provider allows on your account.

## Real calls (Africa's Talking)
1. Create an account, fund it, get a Voice number. Check Nigeria voice rates and your concurrent-call limit.
2. Put AT_USERNAME, AT_API_KEY, AT_FROM_NUMBER in `.env` (or your host's environment variables).
3. In the Africa's Talking dashboard set the voice callback URL to `https://YOUR-ADDRESS/voice/callback`.
4. Restart. The log says "LIVE". Test with your own number.

This live path follows their documented API but has not been run against a real account yet.

## Hosting
It must run continuously (not on Netlify). Use Render, Railway or a VPS with Node 22.13+. The database is a file, so the host needs a persistent disk: set `DB_PATH` to a path on it. Without one, data is wiped on every redeploy.
