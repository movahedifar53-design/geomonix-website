# GeoMonix intake + quote Worker

Cloudflare Worker that powers the AI intake and quote generation on
geomonix.com. Two endpoints:

- `POST /api/intake` — conversational brief extraction (Claude Haiku 4.5)
- `POST /api/quote` — quote + sample generation (Claude Sonnet 4.6), with
  per-service routing:
  - **Safe** services (tutoring, writing, data) → quote card returned to chat
  - **Review** services (FEA, SHM, fibre optic, infrastructure) → quote
    emailed to Dr Movahedifar for review; client gets a holding email

Rate card and risk categories live in `src/service-rates.js` — edit there to
change pricing or routing.

## Cost shape

- Intake (Haiku, cached system prompt): ~£0.001-£0.003 per conversation
- Quote generation (Sonnet): ~£0.02-£0.08 per safe quote, ~£0.04-£0.12 per
  review-mode draft (larger output because of the drafted email)
- **Typical completed intake → quote cycle: ~£0.03-£0.15**
- Cloudflare Workers free tier covers this comfortably
- Resend free tier: 100 emails/day, 3000/month — plenty for Tier 1
- Anthropic spend cap: set a **£25/month** ceiling in the Anthropic console as
  a hard safety net

## One-time setup

### 1. Install wrangler

```bash
cd api
npm install
npx wrangler login
```

### 2. Set up Anthropic key

Get an API key from https://console.anthropic.com/, then:

```bash
npx wrangler secret put ANTHROPIC_API_KEY
```

In the Anthropic console → Settings → Billing → Usage limits, set a monthly
cap of **£25** to start.

### 3. Set up Cloudflare Turnstile

- Cloudflare dashboard → Turnstile → Add site
- Domain: `geomonix.com` (and `localhost` for local testing)
- Widget mode: **Managed**
- Copy the **site key** → into `index.html` `window.GM_TURNSTILE_SITE_KEY`
- Copy the **secret key** → into the Worker:

```bash
npx wrangler secret put TURNSTILE_SECRET
```

### 4. Set up Resend (for the review-category quote emails)

Resend sends two emails per review-category quote: a `[QUOTE DRAFT]` email to
your inbox and a holding confirmation to the client.

1. Sign up at https://resend.com (free tier: 100 emails/day)
2. **Create an API key** → Dashboard → API Keys → Create
3. Add the key to the Worker:
   ```bash
   npx wrangler secret put RESEND_API_KEY
   ```

#### Option A — use the Resend sandbox while DNS propagates (instant)

No DNS changes needed. In `wrangler.toml`:

```toml
FROM_EMAIL = "GeoMonix <onboarding@resend.dev>"
```

This works immediately but deliverability is imperfect (some clients mark
these as spam) and the "from" name isn't your domain. Good enough for the
first few days of testing.

#### Option B — verify geomonix.com in Resend (recommended within week 1)

1. Resend dashboard → Domains → Add Domain → enter `geomonix.com`
2. Resend shows you 3-4 DNS records (SPF, DKIM, optionally DMARC). They look
   something like:
   - `TXT send` with value `v=spf1 include:amazonses.com ~all`
   - `TXT resend._domainkey` with a long DKIM key
   - `MX send` record with priority 10
3. In your Cloudflare dashboard → geomonix.com → DNS → Records, add each one
   **exactly** as Resend displays. Critical: set the **proxy status to
   "DNS only"** (grey cloud, not orange) for every record — Resend requires
   unproxied DNS.
4. Back in Resend, click **Verify DNS records**. Propagation usually completes
   within 5 minutes on Cloudflare.
5. Once verified, update `wrangler.toml`:
   ```toml
   FROM_EMAIL = "GeoMonix <quotes@geomonix.com>"
   ```
6. Redeploy: `npx wrangler deploy`

### 5. Deploy the Worker

```bash
npx wrangler deploy
```

Wrangler prints your Worker URL, something like
`https://geomonix-intake.<your-cf-subdomain>.workers.dev`.

### 6. Point the frontend at the Worker

Open `../index.html`, find the block that reads:

```html
<script>
    window.GM_INTAKE_ENDPOINT = "https://geomonix-intake.YOUR-SUBDOMAIN.workers.dev/api/intake";
    window.GM_TURNSTILE_SITE_KEY = "";
</script>
```

Replace:
- `YOUR-SUBDOMAIN` with your real Cloudflare subdomain from step 5
- Paste the Turnstile **site key** (from step 3) into `GM_TURNSTILE_SITE_KEY`

Commit and push to GitHub Pages. The chat widget will go live on the next
deploy.

## Smoke test after deploy

Run these two scenarios in order. The first tests the **safe path** (instant
in-chat quote). The second tests the **review path** (emailed draft).

### Test 1 — Safe service (tutoring)

1. Open `https://geomonix.com/#contact`
2. Click **"Get an instant indicative quote"**
3. When the chat asks what you need help with, type:
   > I need help with Mohr's circle for my soil mechanics module
4. Answer 2-3 follow-up questions from the assistant (how many sessions,
   online or in-person, timeline)
5. When the mini-form appears, enter a **test name** and a **test email you
   actually check** (use your own personal address for the first run)
6. Click **Prepare my quote**
7. Within ~15 seconds you should see a **quote card** in the chat with:
   - Price range around **£260 – £520**
   - 4-6 scope bullets
   - A worked example showing Mohr's circle step by step
   - A "Book this engagement" button
8. Click **Book this engagement** — the chat closes, the page scrolls to the
   contact form, and the form should be pre-filled with your name, email, and
   a message containing the brief + quote summary

**Pass criterion:** card appears, price range looks right, sample reads like
something you'd put your name on.

### Test 2 — Review service (FEA)

1. Open `https://geomonix.com/#contact`
2. Click **"Get an instant indicative quote"**
3. When the chat asks what you need help with, type:
   > I need to model a pile-soil interaction under cyclic loading in ABAQUS
4. Answer the follow-ups (soil type, pile geometry, timeline, scope)
5. Enter test name + test email
6. Click **Prepare my quote**
7. Within ~15 seconds you should see a **holding card** (not a quote card)
   with an orange "Under personal review" badge and the message
   "Dr Movahedifar will review your brief and respond within 24 hours"
8. Check your Gmail (`Geomonix.info@gmail.com`) for a new email with subject
   starting `[QUOTE DRAFT] Finite Element Analysis...`
9. Check the test email inbox for the client holding email
   ("Your GeoMonix enquiry — preparing your quote")
10. Open the `[QUOTE DRAFT]` email in Gmail. It should contain:
    - Client contact block
    - AI-extracted brief
    - Indicative price range
    - Scope summary bullets
    - Internal notes for you
    - Draft email to client (ready to copy-paste)
    - **A `mailto:` one-click reply link** — click it
11. The `mailto:` link should open a pre-filled Gmail compose window with:
    - To: the test email
    - Subject: "Your GeoMonix enquiry — Finite Element Analysis..."
    - Body: the full drafted reply, ready for you to edit and send

**Pass criterion:** you received both emails, the draft reads plausibly, and
the one-click mailto link opens a pre-filled compose.

### If anything fails

Open a terminal in the `api/` folder and run:

```bash
npx wrangler tail
```

This streams live Worker logs while you repeat the test — any error from
Anthropic, Turnstile, or Resend will appear in real time with the reason.

Common issues:
- **"email not configured"** — you forgot one of `RESEND_API_KEY` /
  `FROM_EMAIL` / `REZA_EMAIL`. Check `wrangler secret list` and `wrangler.toml`.
- **"turnstile verification failed"** — site key in `index.html` doesn't
  match the domain you're visiting from, or Turnstile is blocking you as a
  bot. Try from a fresh browser / different network.
- **Holding card appears but no email in Gmail** — check your spam folder
  first, then check Resend's dashboard → Logs to see if the send was accepted.

## Local development

```bash
cd api
npx wrangler dev --local
```

Worker runs at `http://localhost:8787`. For local frontend testing,
temporarily set in `index.html`:

```html
window.GM_INTAKE_ENDPOINT = "http://localhost:8787/api/intake";
window.GM_TURNSTILE_SITE_KEY = "";
```

and serve the static site with `python -m http.server 8000` from the repo
root. Turnstile will be skipped when no secret is configured.

## Editing the rate card

All pricing and service routing lives in `src/service-rates.js`. Edit,
redeploy:

```bash
npx wrangler deploy
```

The system prompts read the rate card at request time, so changes take
effect immediately after deploy.

## Kill switch

If costs spike or something goes wrong:

- **Fastest**: Cloudflare dashboard → Workers → `geomonix-intake` → Disable
- **Alternative**: rotate the Anthropic key in the Anthropic console
- **Frontend fallback**: the normal Formspree form below the chat widget
  always works regardless of whether the Worker is up

## File layout

```
api/
├── src/
│   ├── index.js           # Router + handlers (Worker entry)
│   ├── system-prompt.js   # Stage 1 intake prompt
│   ├── quote-prompt.js    # Stage 2 quote prompt builder
│   ├── service-rates.js   # Rate card + risk categories  ← edit for pricing
│   └── email.js           # Resend wrapper + email body builders
├── wrangler.toml          # Worker config + public env vars
├── package.json
└── README.md              # this file
```
