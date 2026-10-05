# Åttapus — deploy from Cloud Shell

## 1. Upload and unzip
In Cloud Shell, click the **⋮ menu → Upload**, select `attapus-build.zip`, then:

```bash
unzip attapus-build.zip -d attapus
cd attapus
```

## 2. Install the Firebase CLI (one time)
```bash
npm install -g firebase-tools
firebase login --no-localhost
```
This prints a URL — open it in a new tab, sign in with the same Google account
you used for Firebase, and paste the code back into Cloud Shell.

## 3. Confirm the project
```bash
firebase use ottapus-demo
```

## 4. Store your Gemini API key as a secret
```bash
firebase functions:secrets:set GEMINI_API_KEY
```
Paste your key when prompted. It's stored securely, never in code or git.

## 5. Install function dependencies
```bash
cd functions
npm install
cd ..
```

## 6. Deploy everything
```bash
firebase deploy
```
This deploys Firestore rules, both Cloud Functions, and Hosting. It prints
your live URL at the end, something like:
`https://ottapus-demo.web.app`

## 7. Seed the demo data (once)
Open your live URL and tap **Seed demo data** — or visit:
`https://ottapus-demo.web.app/api/seed`

## 8. Try the signature scenario
Paste this and tap "Let Åttapus read this":
> Hey, can we change the tile colour for the east wing? Client mentioned it
> earlier, shouldn't be a big deal

It should come back classified as **Construction**, category
**Contradiction**, referencing the seeded `tile-selection` item that was
logged as closed.

Try the "Silent, due tomorrow" preset too — it should come back flagged
**at_risk** or **urgent** against the seeded `influencer-contract` item.

## If something fails
- `firebase deploy` errors mentioning the Blaze plan → the project isn't
  upgraded yet; do that in the Firebase console first.
- Gemini errors in the function logs (`firebase functions:log`) → double
  check the secret was set correctly in step 4.
- CORS errors in the browser console → make sure you're opening the
  `.web.app` URL Firebase printed, not `localhost`.

## What's real here vs. what's still a mockup
This deploys the actual capture → classify → triage pipeline on a real
Gemini call, which is the piece that matters for the technical-merit score.
It intentionally does **not** rebuild the full dashboard, morning brief, or
routing screens — those stay as the polished interactive mockup for the
demo video. This page is the proof that the reasoning is real.
