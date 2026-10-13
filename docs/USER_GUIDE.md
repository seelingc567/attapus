# Åttapus user guide

Åttapus is a memory and triage layer for anyone juggling several workstreams. You paste a message exactly as it arrived; Åttapus works out where it belongs, checks it against what is already on record, flags what matters, and **you confirm every item**.

Live demo: https://ottapus-demo.web.app

## Quick start (2 minutes)

1. Open the live demo. You get a private workspace in your own browser, on top of a small set of sample workstreams (Construction, Retail, Marketing Campaign). The sample data is invented.
2. In the left panel, tap **The day everything lands at once**. Three sample messages fill the box.
3. Tap **Let Åttapus read this**. After a few seconds, three proposals appear in the **Today** review queue.
4. Read each card, then tap **Confirm**, **Edit** or **Dismiss**.
5. Open **Status** to see what is open and the history of what you decided.

## Adding messages

- **Paste text:** choose where it came from (the **Outlook email**, **Teams chat** or **SharePoint doc** tab; these only label the source, nothing is connected), paste the message and tap **Let Åttapus read this**. Separate several messages with `---` on its own line.
- **Screenshot:** open the **Screenshot** tab, choose or paste an image of a chat or email, optionally add a note, and read it. The image is shrunk in your browser and sent once to Gemini. Only the text it read is kept, never the image. Works best for typed chats and emails; handwriting is not a supported use.
- **Your own text:** you can paste anything. Gemini judges it against the sample workstreams and items, so unrelated text may land in "Unsorted".

## The review queue (Today)

Each card shows a label, the workstream, a one-line summary, the original text, and a proposed action.

| Label | Meaning |
|---|---|
| Urgent / At risk | An open item has gone quiet and is close to its deadline |
| Contradiction | The message undoes a decision that was already closed |
| Needs reply / Needs decision | Something is waiting on you |
| Log only | Nothing to do, but worth keeping on record |

- **Confirm** saves the item to your record. A follow-up about an open item updates that item instead of creating a duplicate. Confirming a contradiction reopens the old decision and marks it **Superseded**.
- **Edit** lets you correct the proposed action or the workstream before confirming.
- **Dismiss** sets the message aside. Nothing changes on record.
- If reading fails (for example Gemini is busy), the card shows **Needs retry**. Tap it to try again.

## Workstreams and Status

- **Workstreams** shows each project with its items and shortcuts into Status and History.
- **Status** shows open actions (with **Mark done** and **View original message**), counts, and a filterable **History** of every message and what happened to it.
- A dismissed message stays in History until you delete it: tap **Delete** on the row, or use the **Dismissed** filter and **Delete all**. Deleting removes its stored text for good. Confirmed items stay on record.
- Open items have an **Add to Google Calendar** link: a prefilled event on the due date, or a 9:00 reminder tomorrow if there is no deadline. It is a one-way link; nothing is synced.

## Add your own project

On the **Workstreams** tab, tap **New project**, type a name and tap **Add project**. You can have up to 5 of your own. Åttapus can then sort messages into it, and you can give it project knowledge. A project you added has **Delete this project** at the bottom of its card, which also deletes what you captured in it. The three sample projects are shared and cannot be deleted.

## Timeline

The **Timeline** tab is a read-only picture of dates. Each project has a lane on a date axis (choose 4 or 8 weeks; the purple line is today). Dots show open items by deadline (amber), overdue items (red), completed items (green) and closed decisions (hollow). The list under each lane gives the same items with dates; tap an open one to jump to it. Use **Gate review** on a lane, or **Gate review for this window** at the top, to open the gate review with that range already filled in. Items with no deadline are counted under the lane. Milestones and gate dates cannot be added yet.

## Project knowledge (optional)

Each project card on the **Workstreams** tab has a **Project knowledge** box. Use it to tell Åttapus what it cannot guess from messages alone: the project's goal, who is involved, and any rules (for example, "Dana approves every tile change").

1. Tap **Add project knowledge** on a project.
2. Write a short brief (up to 800 characters), or tap **Fill with an example**.
3. Tap **Save**. Tap **Edit** later to change it; save it empty to remove it.

From then on, Gemini reads the brief whenever a message for that project is checked, and when you use Ask Åttapus. If a rule applies, the suggested action mentions it. You still confirm every item. The brief is stored in your own workspace and sent to Gemini with each request, so keep it free of confidential details.

## Morning brief

The **Morning brief** button summarises what is close to its deadline and which closed decisions to watch, from the items on record.

## Ask Åttapus

Tap **Ask Åttapus** in the header and ask one question, such as "What's at risk right now?". The answer comes only from what is tracked, with a **Based on** list of the items it used. There is no chat thread and nothing is stored.

## Gate review

For a gate or milestone review:

1. Tap **Ask Åttapus**, then the **Gate review** tab.
2. Pick a quick range or two dates, and optionally one workstream.
3. Tap **Generate gate review**.

You get a one-page report: executive summary, overall and per-workstream RAG status, progress bars, what is in progress, what is at risk and what needs a decision. Counts and RAG are computed from your data (the rules are shown on the page). Gemini writes only the short summary. Use **Print / save as PDF**, **Copy as text** or **Copy as markdown**. Nothing is stored.

## Start over

**Start over** clears your workspace and returns to the sample data. Your workspace belongs to your browser: another browser or device has its own separate one.

## Limits and privacy

- Each visitor can make 40 AI calls per hour (reading a message, asking a question and the gate-review summary each use one). There are also network-address and daily caps on the public demo. If you hit a limit, the app tells you when to try again, and the gate review still returns with a plain-text summary.
- Project knowledge text is sent to Gemini with each message check and question for that project.
- Raw pasted text is not sent to the gate review or to Ask Åttapus; they use item summaries only.
- The app has no sign-in. Do not paste confidential company data into the public demo.

## Troubleshooting

| Problem | What to do |
|---|---|
| "Needs retry" card | Gemini was busy or the image had no readable text. Tap retry, or paste the text instead. |
| "Demo limit reached" | Wait for the time shown, or use Start over in a new browser window. |
| Items missing on another device | Each browser keeps its own workspace; cross-device sync is not built yet. |
