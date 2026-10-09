// Usage limits for the public Gemini endpoints, so one visitor (or a bot) cannot
// run up the bill. Three counters are checked and updated together in one
// transaction, and a refused request uses none of them:
//   - per visitor (the session id kept in their browser), per hour
//   - per network address (stored only as a short hash), per hour, so rotating the
//     session id does not get around the limit
//   - everyone together, per day: a circuit breaker on the total cost
// The numbers are generous for a judge testing the demo and small for abuse.

const crypto = require("crypto");

const LIMITS = {
  perVisitorHour: 40,
  perAddressHour: 80,
  globalDay: 1500,
};

const HOUR = 3600000;
const DAY = 86400000;

function addressHash(req) {
  const xff = String((req.headers && req.headers["x-forwarded-for"]) || "").split(",")[0].trim();
  const ip = xff || req.ip || "unknown";
  return crypto.createHash("sha256").update(ip).digest("hex").slice(0, 16);
}

// Takes one AI call from the visitor's allowance.
// Returns { ok: true } or { ok: false, error, retryAfterSec }.
// If the counter itself cannot be reached it allows the call (and logs), so a
// database hiccup never takes the whole demo down.
async function takeAiCall({ db, admin, logger, req, sid, now = Date.now(), limits = LIMITS }) {
  const hour = Math.floor(now / HOUR);
  const day = Math.floor(now / DAY);
  const col = db.collection("ratelimits");
  const refs = {
    visitor: { ref: col.doc("s_" + sid + "_" + hour), max: limits.perVisitorHour, ttl: (hour + 2) * HOUR, retry: (hour + 1) * HOUR },
    address: { ref: col.doc("i_" + addressHash(req) + "_" + hour), max: limits.perAddressHour, ttl: (hour + 2) * HOUR, retry: (hour + 1) * HOUR },
    global: { ref: col.doc("g_" + day), max: limits.globalDay, ttl: (day + 2) * DAY, retry: (day + 1) * DAY },
  };
  try {
    return await db.runTransaction(async (tx) => {
      const names = Object.keys(refs);
      const snaps = await Promise.all(names.map((n) => tx.get(refs[n].ref)));
      const counts = {};
      names.forEach((n, i) => { counts[n] = snaps[i].exists ? Number(snaps[i].data().count) || 0 : 0; });
      for (const n of names) {
        if (counts[n] >= refs[n].max) {
          const retryAfterSec = Math.max(60, Math.ceil((refs[n].retry - now) / 1000));
          const mins = Math.ceil(retryAfterSec / 60);
          const error =
            n === "global"
              ? "The demo has reached its daily limit of AI calls. Please try again tomorrow."
              : "Demo limit reached: " + limits.perVisitorHour + " AI calls per hour. Try again in about " + mins + " minute" + (mins === 1 ? "" : "s") + ".";
          return { ok: false, error, retryAfterSec, which: n };
        }
      }
      names.forEach((n) => {
        tx.set(refs[n].ref, { count: counts[n] + 1, expireAt: admin.firestore.Timestamp.fromMillis(refs[n].ttl) });
      });
      return { ok: true };
    });
  } catch (err) {
    if (logger) logger.error("rate limit check failed, allowing the call", err);
    return { ok: true, skipped: true };
  }
}

module.exports = { takeAiCall, addressHash, LIMITS };
