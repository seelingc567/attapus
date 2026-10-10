# Åttapus 🐙

**A memory and triage layer for anyone juggling several live workstreams across email, chat and meetings.**

Built for the AI Builder Cup 2026 (Future of Work & Enterprise Productivity).

**Live demo:** https://ottapus-demo.web.app

---

## The problem

When work piles up, logging is the first thing people drop, and whatever isn't logged is what quietly goes missing. Logging asks you to decide the project, the category and the format *before* you can write anything down. On an overloaded day, nobody has the capacity for that.

## What Åttapus does

You **paste a message exactly as it arrived** (an email, a chat snippet, a meeting note). No decisions are required. Åttapus then:

1. **Works out which workstream it belongs to.**
2. **Checks it against what is already on record**, such as open items, closed decisions and due dates.
3. **Flags what matters** and proposes a next step, which you confirm or dismiss.

It catches two things that routinely slip through:

| Signal | Example |
|---|---|
| **Going quiet** | A chaser about an open item that has been silent for 2 days and is due tomorrow. It is flagged *before* it is late. |
| **Quiet contradiction** | A casual chat message that reopens a decision already marked closed. |

### Try it (signature scenario)

Open the live demo and tap **"The day everything lands at once"**. Three messy messages arrive together, across three projects (Construction, Retail, Marketing Campaign). Åttapus returns:

- the influencer contract flagged **Urgent** (silent for 2 days, due tomorrow),
- the east-wing tile request flagged as a **Contradiction** with the closed "tile selection" decision,
- the customer's bulk-quote request marked **Needs reply**.

You can also paste your own text. The demo's stored history is small, so Gemini is judging each message against these workstreams and items.

## How it uses Google Cloud and Gemini

```
Pasted text ──► Firebase Hosting (web UI)
                    │  POST /api/classify
                    ▼
        Cloud Functions (2nd gen)  ──reads──►  Firestore
          classifyFragment                     workstreams, items
                    │
                    │  prompt = workstreams + items on record
                    │           + today's date + the pasted fragment
                    ▼
            Gemini API (Flash)   ── structured JSON output
                    │
                    ▼
        category · risk · contradicted item · summary · suggested action
                    │
                    └──writes──► Firestore (fragments)  ──► review queue in the UI
```

- **Gemini Flash** (`gemini-flash-latest`) classifies each fragment. The function asks for **schema-constrained JSON** (`responseSchema`) so the UI can render results reliably.
- **Cloud Functions** hold the logic and the API key (stored in Secret Manager, never in the repo).
- **Firestore** holds workstreams, items and classified fragments. Security rules block all direct client access, so everything goes through the functions.
- **Firebase Hosting** serves the UI and routes `/api/*` to the functions.
- **Reliability:** the function retries automatically on Gemini 503 "high demand" errors, and the UI shows a retry card instead of failing silently.

### A private sandbox for every visitor

The seeded demo history is shared, but everything a visitor does on top of it (their pasted messages, confirmed items, reopened decisions) lives in a private sandbox identified by a random id kept in their browser. One judge's tests never affect another's, and **Start over** gives a clean slate. The shared seeded items are never modified.

| Endpoint | What it does |
|---|---|
| `POST /api/classify` | Reads a pasted fragment against the visitor's context and returns the proposal |
| `POST /api/resolve` | Confirm (save to memory) or dismiss a proposal |
| `POST /api/complete` | Mark an open item done (or undo) |
| `POST /api/ask` | Answers one question from the visitor's tracked items and message summaries (raw pasted text is never sent) |
| `POST /api/gate` | Builds a gate review for a date range: counts, progress and RAG are computed from the data; Gemini writes only the short executive summary from titles and counts (a plain-text fallback is used if Gemini is unavailable) |
| `GET /api/state` | Restores the visitor's queue and the items on record |
| `GET /api/seed` | (Re)loads the demo data; `?reset=1` also wipes every visitor sandbox |

### Usage limits on the public demo

The Gemini-backed endpoints are public, so each is protected by a usage limit: 40 AI calls per visitor per hour, 80 per network address per hour (stored only as a short hash, so rotating the session id does not get around it), and 1,500 per day across everyone as a circuit breaker on cost. A refused request uses none of the allowance. The gate review's counts are free; only its Gemini-written summary spends a call, and when the allowance is used up the report still returns with a plain-text summary.

### Why paste instead of a live Outlook/Teams connection?

Connecting to company mail and chat usually means a long IT security review. Pasting works on day one, with no approval and nothing leaving the user's control. Live connectors are a roadmap item, not part of this build.

## What is and isn't built

**Built and working:**
- Paste capture with multi-item input (separate messages with `---`)
- **Screenshot reading (Gemini multimodal)**: choose or paste a screenshot of a chat or email, optionally add a note, and Gemini reads the text in it and files it through the same review queue. The image is shrunk in the browser, sent once, and **never stored**: only the text Gemini read is kept, and the history labels it *Read from screenshot*. Best for screenshots of typed chats and emails; handwriting is not a tested use.
- Live Gemini classification against stored history, with contradiction and going-quiet detection
- Review queue with **Confirm / Dismiss that saves to Firestore**: a confirmed item joins the history Gemini checks next time, and a confirmed contradiction reopens the closed decision
- **Follow-ups update instead of duplicating**: when a message is a chaser or update about an open item, Gemini links it to that item, and confirming it replaces the old item (keeping its deadline) rather than creating a second one
- **Superseded, spelled out**: a contradiction card shows exactly what confirming will do to the old decision (~~Tile selection · closed~~ → **Superseded**) before anything changes
- **Approve → logged**: approving removes the card and adds a timestamped line to a *Recent changes* log, so you can watch an item go from suggested to approved to recorded
- **Edit before you confirm**: correct the proposed action or the workstream Gemini picked, then save the corrected version
- **Your session survives a refresh**: the pending queue and what is on record are restored from the database
- A **morning brief generated from the items on record** (what is close to its deadline, which closed decisions to watch), not hard-coded text
- **Status tab**: pending / open / done / dismissed counts per workstream, an **Open actions** list with *Mark done* (and *View original message*), and a **filterable history** of every message showing what happened to it (confirmed, edited, dismissed, done), including the original proposal next to your edited version
- **Ask Åttapus**: one question box (no chat thread, nothing stored) that Gemini answers only from what is already tracked, with a *Based on* list showing which items it used. It also writes status updates on request.
- **Gate review one-pager**: pick two dates (and optionally one workstream) and get a single page with an executive summary, an overall and per-workstream RAG, progress bars, what is in progress, what is at risk and what needs a decision. Counts and RAG come straight from the data (rules shown on the page); Gemini only writes the summary. Print / save as PDF uses the browser's print, and the page can be copied as text or markdown. Nothing is stored.
- **Add to Google Calendar**: open items get a prefilled Google Calendar link (due date as an all-day event, or a 9:00 nudge tomorrow if there is no deadline). It is a link, not a sync: no sign-in and nothing stored.
- **Delete dismissed messages**: a message you dismissed stays in History until you delete it (one at a time, or all dismissed at once); deleting removes its stored text for good. Confirmed items stay on record.
- Workstreams view with shortcuts into the Status tab and History
- Light and dark themes

**Not built yet (honest list):**
- Live Outlook / Teams / SharePoint connectors (intentionally out of scope)
- PowerPoint export (the gate review prints to PDF or copies as text or markdown)
- Two-way Google Calendar sync (the Add to calendar link is one-way and needs no sign-in)
- Cross-device sync: each browser has its own private sandbox (no sign-in), so a phone and a laptop do not share items
- Vector retrieval for large histories (the demo history is small, so the full history goes into the prompt)

## Roadmap

**Next: connect where the work lives, and carry your memory across devices.** None of this is built yet.

1. **Sign-in and cross-device sync**: one memory across phone, tablet and laptop (today each browser keeps its own private sandbox).
2. **Live Outlook, Teams and SharePoint connections**: read-only first, so messages arrive without pasting, once a company's security review allows it. Paste stays as the no-approval way in.
3. **Two-way Google Calendar sync**: reminders that update when an item changes (today "Add to Google Calendar" is a one-way link).
4. **PowerPoint export** of the gate review for steering-committee decks (today it prints to PDF or copies as text).
5. **Vector retrieval** for large histories, so the right past items are found without sending the whole history to the model.

## Project structure

```
public/index.html        Web UI (single file, no build step)
functions/index.js       Cloud Functions (seed, classify, state, resolve, complete, ask, gate)
functions/gate.js        Gate review logic: date ranges, counts, RAG (no Firebase dependency)
functions/limits.js      Usage limits for the Gemini endpoints
firebase.json            Hosting rewrites: /api/classify, /api/seed, /api/state, /api/resolve, /api/complete, /api/ask, /api/gate
firestore.rules          Locks Firestore to server-side access only
```

## Run it yourself

Prerequisites: a Firebase project on the **Blaze** plan, the Firebase CLI, and a Gemini API key.

```bash
# 1. Store the Gemini key as a secret (use a file so the paste can't be mangled)
firebase functions:secrets:set GEMINI_API_KEY --data-file=key.txt

# 2. Install function dependencies
cd functions && npm install && cd ..

# 3. Deploy everything
firebase deploy

# 4. Load the demo data (re-run any time; dates are relative to today)
#    open https://<your-project>.web.app/api/seed?reset=1
```

## Note on demo data

The sample workstreams (Construction, Retail, Marketing Campaign) and items are invented for the demo. No real company data is used.
