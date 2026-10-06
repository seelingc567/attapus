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

// Each visitor gets a private sandbox (a random session id kept in their browser)
// layered on top of the shared seeded demo data, so one judge's tests never leak
// into another's.
const SID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const DOC_RE = /^[A-Za-z0-9]{10,40}$/;
const MAX_TEXT = 4000;
const getSid = (v) => (typeof v === "string" && SID_RE.test(v) ? v : "anon");
const iso = (t) => (t && t.toDate ? t.toDate().toISOString() : null);

// Workstreams + the items Gemini should see: the shared seeded items plus this
// visitor's own confirmed items. A seeded item that this visitor has reopened
// is shown as "reopened" so it is no longer treated as a closed decision.
async function loadContext(sid) {
  const [wsSnap, itemsSnap, ovSnap] = await Promise.all([
    db.collection("workstreams").get(),
    db.collection("items").get(),
    db.collection("overrides").where("sessionId", "==", sid).get(),
  ]);
  const workstreams = wsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  // A visitor can mark a shared (seeded) item done without changing it for anyone
  // else: that choice is stored as a per-visitor override.
  const overrides = new Map(ovSnap.docs.map((d) => [d.data().itemId, d.data()]));
  const all = itemsSnap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((i) => !i.sessionId || i.sessionId === sid);
  const superseded = new Set(all.filter((i) => i.supersedes).map((i) => i.supersedes));
  const items = all.map((i) => {
    const ov = overrides.get(i.id);
    return {
      id: i.id,
      workstreamId: i.workstreamId,
      title: i.title,
      status: ov ? ov.status : superseded.has(i.id) ? "reopened" : i.status,
      summary: i.summary,
      dueDate: iso(i.dueDate),
      loggedAt: iso(i.loggedAt),
      completedAt: iso(ov ? ov.completedAt : i.completedAt),
      category: i.category || null,
      risk: i.risk || null,
      sourceFragmentId: i.sourceFragmentId || null,
      mine: !!i.sessionId,
    };
  });
  return { workstreams, items };
}

// The subset of each item that Gemini needs to see.
const forPrompt = (items) =>
  items.map(({ id, workstreamId, title, status, summary, dueDate, loggedAt }) => ({
    id, workstreamId, title, status, summary, dueDate, loggedAt,
  }));

async function deleteRefs(refs) {
  for (let i = 0; i < refs.length; i += 400) {
    const b = db.batch();
    refs.slice(i, i + 400).forEach((r) => b.delete(r));
    await b.commit();
  }
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
          sessionId: null,
        },
        {
          id: "influencer-contract",
          workstreamId: "marketing",
          title: "Influencer contract",
          summary: "Confirming terms with influencer ahead of launch.",
          status: "open",
          loggedAt: twoDaysAgo,
          dueDate: tomorrow,
          sessionId: null,
        },
      ];

      const batch = db.batch();
      workstreams.forEach((w) =>
        batch.set(db.collection("workstreams").doc(w.id), w)
      );
      items.forEach((i) => batch.set(db.collection("items").doc(i.id), i));
      await batch.commit();

      // /api/seed?reset=1 also wipes every visitor's sandbox (their confirmed
      // items and saved fragments). Handy before recording a demo take.
      let removed = null;
      if (req.query.reset === "1") {
        const [itemsSnap, fragSnap, ovSnap] = await Promise.all([
          db.collection("items").get(),
          db.collection("fragments").get(),
          db.collection("overrides").get(),
        ]);
        const refs = [
          ...itemsSnap.docs.filter((d) => d.data().sessionId).map((d) => d.ref),
          ...fragSnap.docs.map((d) => d.ref),
          ...ovSnap.docs.map((d) => d.ref),
        ];
        await deleteRefs(refs);
        removed = refs.length;
      }

      res.status(200).json({ ok: true, removed, workstreams, items });
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
        const body = req.body || {};
        const text = typeof body.text === "string" ? body.text : "";
        const sid = getSid(body.sid);
        const source = typeof body.source === "string" ? body.source.slice(0, 40) : "";
        if (!text.trim()) {
          return res.status(400).json({ ok: false, error: "Missing 'text'" });
        }
        if (text.length > MAX_TEXT) {
          return res
            .status(400)
            .json({ ok: false, error: "Text is too long (max " + MAX_TEXT + " characters)" });
        }

        // Current context: the workstreams and items on record (shared seed +
        // this visitor's own), so Gemini can link or contradict real records.
        const { workstreams, items } = await loadContext(sid);

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
${JSON.stringify(forPrompt(items), null, 2)}

Today's date: ${new Date().toISOString().slice(0, 10)}

New fragment to classify:
"""${text}"""

Rules:
- Match the fragment to the single best workstreamId from the list above.
- category "contradiction" means the fragment conflicts with an item whose status is "closed" - e.g. a casual message that quietly reopens a decision. Set contradictsItemId to that item's id in this case.
- risk "urgent" or "at_risk" applies ONLY when an existing OPEN item related to this fragment has gone quiet and has a near due date. A new request that merely mentions a deadline is NOT a risk, so set risk "none" for it. When you set a risk, the summary must say why, for example "silent for 2 days, due tomorrow".
- If nothing matches an existing item, contradictsItemId is an empty string.
- Keep summary and suggestedAction short and concrete, no more than one sentence each.`;

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
          source,
          sessionId: sid,
          status: "pending",
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

// ---------------------------------------------------------------------
// getState: everything the UI needs to restore a visitor's sandbox after a
// refresh - workstreams, items on record (seed + their own) and their
// pending / confirmed fragments.
// ---------------------------------------------------------------------
exports.getState = onRequest(async (req, res) => {
  cors(req, res, async () => {
    try {
      const sid = getSid(req.query.sid);
      const [{ workstreams, items }, fragSnap] = await Promise.all([
        loadContext(sid),
        db.collection("fragments").where("sessionId", "==", sid).get(),
      ]);
      const fragments = fragSnap.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .filter((f) => ["pending", "confirmed", "dismissed"].includes(f.status))
        .map((f) => ({ ...f, createdAt: iso(f.createdAt), resolvedAt: iso(f.resolvedAt) }))
        .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
        .slice(-100);
      res.status(200).json({ ok: true, workstreams, items, fragments });
    } catch (err) {
      logger.error("getState failed", err);
      res.status(500).json({ ok: false, error: String(err) });
    }
  });
});

// ---------------------------------------------------------------------
// resolveFragment: the user's decision on a proposed item.
//   confirm -> the fragment becomes part of the visitor's memory (a new item
//              on record); a confirmed contradiction reopens the closed item.
//   dismiss -> the fragment is set aside.
// ---------------------------------------------------------------------
exports.resolveFragment = onRequest(async (req, res) => {
  cors(req, res, async () => {
    try {
      if (req.method !== "POST") {
        return res.status(405).json({ ok: false, error: "Use POST" });
      }
      const { id, action } = req.body || {};
      const sid = getSid((req.body || {}).sid);
      if (!DOC_RE.test(String(id || "")) || !["confirm", "dismiss"].includes(action)) {
        return res.status(400).json({ ok: false, error: "Bad request" });
      }
      // Optional human corrections made before confirming: the proposed action
      // text and/or the workstream the fragment was filed under.
      const edits = (req.body || {}).edits || {};
      let editedAction = null;
      let editedWs = null;
      if (action === "confirm") {
        if (edits.action !== undefined) {
          const a = typeof edits.action === "string" ? edits.action.trim() : "";
          if (!a || a.length > 300) {
            return res.status(400).json({ ok: false, error: "Proposed action must be 1-300 characters" });
          }
          editedAction = a;
        }
        if (edits.workstreamId !== undefined) {
          const w = String(edits.workstreamId);
          const wsDoc = DOC_RE.test(w) || /^[a-z0-9_-]{2,40}$/.test(w) ? await db.collection("workstreams").doc(w).get() : null;
          if (!wsDoc || !wsDoc.exists) {
            return res.status(400).json({ ok: false, error: "Unknown workstream" });
          }
          editedWs = w;
        }
      }
      const ref = db.collection("fragments").doc(String(id));
      const snap = await ref.get();
      if (!snap.exists) return res.status(404).json({ ok: false, error: "Not found" });
      const f = snap.data();
      if (f.sessionId !== sid) return res.status(403).json({ ok: false, error: "Not yours" });
      if (f.status !== "pending") {
        return res.status(200).json({ ok: true, status: f.status, already: true });
      }

      const now = admin.firestore.Timestamp.now();
      if (action === "dismiss") {
        await ref.update({ status: "dismissed", resolvedAt: now });
        return res.status(200).json({ ok: true, status: "dismissed", resolvedAt: iso(now) });
      }

      const finalAction = editedAction || f.suggestedAction || f.summary || "";
      const finalWs = editedWs || f.workstreamId;
      const itemRef = db.collection("items").doc();
      const item = {
        sessionId: sid,
        workstreamId: finalWs,
        title: String(f.summary || "Logged item").slice(0, 90),
        summary: finalAction,
        status: f.category === "log_only" ? "closed" : "open",
        category: f.category || null,
        risk: f.risk || null,
        loggedAt: now,
        dueDate: null,
        sourceFragmentId: id,
        supersedes: f.contradictsItemId || null,
      };
      const batch = db.batch();
      const fragUpdate = { status: "confirmed", resolvedAt: now, itemId: itemRef.id };
      if (editedAction || editedWs) {
        fragUpdate.edited = true;
        fragUpdate.originalAction = f.suggestedAction || null;
        fragUpdate.originalWorkstreamId = f.workstreamId;
        fragUpdate.suggestedAction = finalAction;
        fragUpdate.workstreamId = finalWs;
      }
      batch.update(ref, fragUpdate);
      batch.set(itemRef, item);
      await batch.commit();

      res.status(200).json({
        ok: true,
        status: "confirmed",
        item: {
          id: itemRef.id,
          workstreamId: item.workstreamId,
          title: item.title,
          summary: item.summary,
          status: item.status,
          loggedAt: iso(now),
          dueDate: null,
          completedAt: null,
          category: item.category,
          risk: item.risk,
          sourceFragmentId: id,
          mine: true,
        },
        reopened: item.supersedes,
        resolvedAt: iso(now),
        edited: !!(editedAction || editedWs),
      });
    } catch (err) {
      logger.error("resolveFragment failed", err);
      res.status(500).json({ ok: false, error: String(err) });
    }
  });
});

// ---------------------------------------------------------------------
// completeItem: close the loop on an open item (e.g. the reply has been sent).
//   done   -> status "done" (for a shared demo item, only for this visitor)
//   reopen -> undo
// ---------------------------------------------------------------------
exports.completeItem = onRequest(async (req, res) => {
  cors(req, res, async () => {
    try {
      if (req.method !== "POST") {
        return res.status(405).json({ ok: false, error: "Use POST" });
      }
      const { id, action } = req.body || {};
      const sid = getSid((req.body || {}).sid);
      if (!/^[A-Za-z0-9_-]{2,60}$/.test(String(id || "")) || !["done", "reopen"].includes(action)) {
        return res.status(400).json({ ok: false, error: "Bad request" });
      }
      const ref = db.collection("items").doc(String(id));
      const snap = await ref.get();
      if (!snap.exists) return res.status(404).json({ ok: false, error: "Not found" });
      const it = snap.data();
      const now = admin.firestore.Timestamp.now();

      if (it.sessionId) {
        if (it.sessionId !== sid) return res.status(403).json({ ok: false, error: "Not yours" });
        if (action === "done") {
          if (it.status !== "open" && it.status !== "done") {
            return res.status(409).json({ ok: false, error: "Only open items can be completed" });
          }
          await ref.update({ status: "done", completedAt: now });
        } else if (it.status === "done") {
          await ref.update({ status: "open", completedAt: null });
        }
      } else {
        const oref = db.collection("overrides").doc(sid + "__" + String(id));
        if (action === "done") {
          if (it.status !== "open") {
            return res.status(409).json({ ok: false, error: "Only open items can be completed" });
          }
          await oref.set({ sessionId: sid, itemId: String(id), status: "done", completedAt: now });
        } else {
          await oref.delete();
        }
      }

      const { items } = await loadContext(sid);
      res.status(200).json({ ok: true, item: items.find((i) => i.id === String(id)) });
    } catch (err) {
      logger.error("completeItem failed", err);
      res.status(500).json({ ok: false, error: String(err) });
    }
  });
});
