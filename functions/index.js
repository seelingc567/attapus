const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const cors = require("cors")({ origin: true });

admin.initializeApp();
const db = admin.firestore();

const GEMINI_API_KEY = defineSecret("GEMINI_API_KEY");
const MODEL = "gemini-flash-latest";

async function fetchWithRetry(url, options, retries = 6, delayMs = 5000) {
  for (let i = 0; i < retries; i++) {
    const resp = await fetch(url, options);
    if (resp.status !== 503) return resp;
    logger.info("Gemini 503, retrying attempt " + (i + 1));
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return fetch(url, options);
}

// ---------------------------------------------------------------------
// Seed demo data: three workstreams + two prior items that the
// signature scenario depends on (a closed item to be quietly reopened,
// and an item that's gone silent and is due tomorrow).
// Safe to call more than once - it overwrites with the same fixed data.
// ---------------------------------------------------------------------
exports.seedDemoData = onRequest(async (req, res) => {
  cors(req, res, async () => {
    try {
      const now = admin.firestore.Timestamp.now();
      const twoWeeksAgo = admin.firestore.Timestamp.fromMillis(
        now.toMillis() - 14 * 24 * 60 * 60 * 1000
      );
      const twoDaysAgo = admin.firestore.Timestamp.fromMillis(
        now.toMillis() - 2 * 24 * 60 * 60 * 1000
      );
      const tomorrow = admin.firestore.Timestamp.fromMillis(
        now.toMillis() + 1 * 24 * 60 * 60 * 1000
      );

      const workstreams = [
        { id: "construction", name: "Construction", color: "2B5C85" },
        { id: "retail", name: "Retail", color: "C08A2E" },
        { id: "marketing", name: "Marketing Campaign", color: "3E8E5A" },
      ];

      const items = [
        {
          id: "tile-selection",
          workstreamId: "construction",
          title: "Tile selection",
          summary: "East wing tile colour finalized with client sign-off.",
          status: "closed",
          loggedAt: twoWeeksAgo,
          dueDate: null,
        },
        {
          id: "influencer-contract",
          workstreamId: "marketing",
          title: "Influencer contract",
          summary: "Confirming terms with influencer ahead of launch.",
          status: "open",
          loggedAt: twoDaysAgo,
          dueDate: tomorrow,
        },
      ];

      const batch = db.batch();
      workstreams.forEach((w) =>
        batch.set(db.collection("workstreams").doc(w.id), w)
      );
      items.forEach((i) => batch.set(db.collection("items").doc(i.id), i));
      await batch.commit();

      res.status(200).json({ ok: true, workstreams, items });
    } catch (err) {
      logger.error("seedDemoData failed", err);
      res.status(500).json({ ok: false, error: String(err) });
    }
  });
});

// ---------------------------------------------------------------------
// classifyFragment: the core pipeline.
// Takes { text } (pasted email/chat/meeting note), asks Gemini to
// classify it against the workstreams and items already on record,
// writes the result as a fragment, and returns it.
// ---------------------------------------------------------------------
exports.classifyFragment = onRequest(
  { secrets: [GEMINI_API_KEY] },
  async (req, res) => {
    cors(req, res, async () => {
      try {
        if (req.method !== "POST") {
          return res.status(405).json({ ok: false, error: "Use POST" });
        }
        const text = (req.body && req.body.text) || "";
        if (!text.trim()) {
          return res.status(400).json({ ok: false, error: "Missing 'text'" });
        }

        // Pull current context: what workstreams and items already exist,
        // so Gemini can link/contradict against real records rather than
        // guessing blind.
        const [wsSnap, itemsSnap] = await Promise.all([
          db.collection("workstreams").get(),
          db.collection("items").get(),
        ]);
        const workstreams = wsSnap.docs.map((d) => ({
          id: d.id,
          ...d.data(),
        }));
        const items = itemsSnap.docs.map((d) => {
          const data = d.data();
          return {
            id: d.id,
            workstreamId: data.workstreamId,
            title: data.title,
            status: data.status,
            summary: data.summary,
            dueDate: data.dueDate ? data.dueDate.toDate().toISOString() : null,
            loggedAt: data.loggedAt && data.loggedAt.toDate ? data.loggedAt.toDate().toISOString() : null,
          };
        });

        const schema = {
          type: "OBJECT",
          properties: {
            workstreamId: {
              type: "STRING",
              description:
                "id of the matching workstream from the provided list, or 'unknown'",
            },
            category: {
              type: "STRING",
              enum: ["log_only", "needs_reply", "needs_decision", "contradiction"],
            },
            summary: {
              type: "STRING",
              description: "One sentence, plain-language summary of the fragment",
            },
            risk: { type: "STRING", enum: ["none", "at_risk", "urgent"] },
            contradictsItemId: {
              type: "STRING",
              description:
                "id of the existing item this contradicts, or empty string if none",
            },
            suggestedAction: {
              type: "STRING",
              description: "One short sentence proposing what to do next",
            },
          },
          required: [
            "workstreamId",
            "category",
            "summary",
            "risk",
            "contradictsItemId",
            "suggestedAction",
          ],
        };

        const prompt = `You are Åttapus, a memory and triage layer for someone juggling multiple concurrent workstreams. You read a pasted fragment (email, chat, or meeting note) and classify it.

Existing workstreams:
${JSON.stringify(workstreams, null, 2)}

Existing items already on record (some closed, some open):
${JSON.stringify(items, null, 2)}

Today's date: ${new Date().toISOString().slice(0, 10)}

New fragment to classify:
"""${text}"""

Rules:
- Match the fragment to the single best workstreamId from the list above.
- category "contradiction" means the fragment conflicts with an item whose status is "closed" - e.g. a casual message that quietly reopens a decision. Set contradictsItemId to that item's id in this case.
- risk "urgent" or "at_risk" applies ONLY when an existing OPEN item related to this fragment has gone quiet and has a near due date. A new request that merely mentions a deadline is NOT a risk, so set risk "none" for it. When you set a risk, the summary must say why, for example "silent for 2 days, due tomorrow".
- If nothing matches an existing item, contradictsItemId is an empty string.
- Keep summary and suggestedAction short and concrete, no more than one sentence each.`;

    logger.info("KEY LENGTH: " + GEMINI_API_KEY.value().length);
        const resp = await fetchWithRetry(
          `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_API_KEY.value()}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ role: "user", parts: [{ text: prompt }] }],
              generationConfig: {
                responseMimeType: "application/json",
                responseSchema: schema,
                temperature: 0.2,
              },
            }),
          }
        );

        if (!resp.ok) {
          const errText = await resp.text();
          logger.error("Gemini API error", errText);
          return res
            .status(502)
            .json({ ok: false, error: "Gemini API error", detail: errText });
        }

        const data = await resp.json();
        const raw = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!raw) {
          logger.error("No text in Gemini response", JSON.stringify(data));
          return res
            .status(502)
            .json({ ok: false, error: "No structured output from Gemini" });
        }

        const parsed = JSON.parse(raw);

        const fragmentDoc = {
          rawText: text,
          workstreamId: parsed.workstreamId || "unknown",
          category: parsed.category,
          summary: parsed.summary,
          risk: parsed.risk,
          contradictsItemId: parsed.contradictsItemId || null,
          suggestedAction: parsed.suggestedAction,
          createdAt: admin.firestore.Timestamp.now(),
        };

        const ref = await db.collection("fragments").add(fragmentDoc);

        res.status(200).json({
          ok: true,
          id: ref.id,
          ...fragmentDoc,
          createdAt: fragmentDoc.createdAt.toDate().toISOString(),
        });
      } catch (err) {
        logger.error("classifyFragment failed", err);
        res.status(500).json({ ok: false, error: String(err) });
      }
    });
  }
);
