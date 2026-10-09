// Gate review: a one-page status between two dates.
// Everything here is counted straight from the data. Gemini (see index.js) only
// writes the short executive summary on top, and a plain-text fallback is used if
// it is unavailable, so the report never depends on the model being up.

const DAY = 864e5;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// "2026-09-20" in the visitor's timezone (tz = minutes east of UTC) -> epoch ms.
function dayStart(s, tz) {
  const [y, m, d] = s.split("-").map(Number);
  return Date.UTC(y, m - 1, d) - tz * 60000;
}

function parseRange(from, to, tz) {
  if (!DATE_RE.test(String(from)) || !DATE_RE.test(String(to))) return { error: "Dates must look like 2026-09-20" };
  const t = Number.isFinite(Number(tz)) ? Math.max(-840, Math.min(840, Math.round(Number(tz)))) : 0;
  const fromMs = dayStart(from, t);
  const toMs = dayStart(to, t) + DAY - 1; // end of the "to" day
  if (Number.isNaN(fromMs) || Number.isNaN(toMs)) return { error: "Invalid date" };
  if (toMs < fromMs) return { error: "The end date is before the start date" };
  if (toMs - fromMs > 366 * DAY) return { error: "Pick a range of one year or less" };
  return { fromMs, toMs };
}

const ms = (iso) => (iso ? Date.parse(iso) : NaN);

function buildGate({ workstreams, items, fragments, fromMs, toMs, ws, now }) {
  const refMs = Math.min(now, toMs);
  const wsName = (id) => (workstreams.find((w) => w.id === id) || {}).name || id;
  const keep = (i) => ws === "all" || i.workstreamId === ws;
  const mine = items.filter(keep);
  const inRange = (t) => t >= fromMs && t <= toMs;

  // When was an item superseded? When the item that replaces it was logged.
  const supersededAt = new Map();
  items.forEach((i) => {
    if (i.supersedes) supersededAt.set(i.supersedes, ms(i.loggedAt));
  });

  const shape = (i, extra) => {
    const due = i.dueDate || null;
    const silent = Math.max(0, Math.floor((refMs - ms(i.loggedAt)) / DAY));
    return {
      id: i.id,
      title: i.title,
      ws: i.workstreamId,
      wsName: wsName(i.workstreamId),
      summary: i.summary || "",
      category: i.category || null,
      risk: i.risk || null,
      due,
      silentDays: silent,
      ...extra,
    };
  };
  const atRisk = (i) =>
    i.risk === "at_risk" ||
    i.risk === "urgent" ||
    (!!i.dueDate && ms(i.dueDate) - refMs <= 2 * DAY && refMs - ms(i.loggedAt) >= 2 * DAY);
  const overdue = (i) => !!i.dueDate && ms(i.dueDate) < refMs;

  const logged = [];
  const completed = [];
  const inProgress = [];
  const superseded = [];
  mine.forEach((i) => {
    const logT = ms(i.loggedAt);
    if (i.status === "closed" && inRange(logT)) logged.push(shape(i, { date: i.loggedAt }));
    else if (i.status === "done" && inRange(ms(i.completedAt))) completed.push(shape(i, { date: i.completedAt }));
    else if (i.status === "open" && logT <= toMs) {
      inProgress.push(shape(i, { atRisk: atRisk(i), overdue: overdue(i) }));
    } else if (i.status === "reopened") {
      const t = supersededAt.get(i.id);
      if (inRange(t)) superseded.push(shape(i, { date: new Date(t).toISOString() }));
    }
  });
  const byDate = (a, b) => ms(a.date) - ms(b.date);
  logged.sort(byDate);
  completed.sort(byDate);
  superseded.sort(byDate);
  inProgress.sort((a, b) => (b.atRisk - a.atRisk) || ((a.due ? ms(a.due) : Infinity) - (b.due ? ms(b.due) : Infinity)));

  const needDecision = inProgress.filter((i) => i.category === "needs_decision" || i.category === "contradiction");
  const pending = (fragments || []).filter((f) => f.status === "pending" && (ws === "all" || f.workstreamId === ws)).length;

  const rank = { none: 0, green: 1, amber: 2, red: 3 };
  const perWs = workstreams
    .filter((w) => ws === "all" || w.id === ws)
    .map((w) => {
      const c = {
        logged: logged.filter((i) => i.ws === w.id).length,
        completed: completed.filter((i) => i.ws === w.id).length,
        inProgress: inProgress.filter((i) => i.ws === w.id).length,
        superseded: superseded.filter((i) => i.ws === w.id).length,
      };
      const total = c.logged + c.completed + c.inProgress;
      const resolved = c.logged + c.completed;
      const mineIp = inProgress.filter((i) => i.ws === w.id);
      let rag = "green";
      if (!total && !c.superseded) rag = "none";
      else if (mineIp.some((i) => i.overdue || i.risk === "urgent")) rag = "red";
      else if (mineIp.some((i) => i.atRisk) || c.superseded) rag = "amber";
      let note;
      if (rag === "none") note = "Nothing on record in this period.";
      else if (rag === "red") note = mineIp.find((i) => i.overdue || i.risk === "urgent").title + (mineIp.some((i) => i.overdue) ? " is overdue." : " is urgent.");
      else if (mineIp.some((i) => i.atRisk)) {
        const r = mineIp.find((i) => i.atRisk);
        note = r.title + " has gone quiet" + (r.silentDays ? " (" + r.silentDays + " day" + (r.silentDays === 1 ? "" : "s") + ")" : "") + ".";
      } else if (c.superseded) note = superseded.find((i) => i.ws === w.id).title + " was superseded.";
      else if (c.inProgress) note = c.inProgress + " item" + (c.inProgress === 1 ? "" : "s") + " in progress, nothing flagged.";
      else note = "Everything on record is resolved.";
      return { id: w.id, name: w.name, counts: c, total, resolved, progress: total ? Math.round((resolved / total) * 100) : 0, rag, note };
    });
  const overall = perWs.reduce((a, w) => (rank[w.rag] > rank[a] ? w.rag : a), "none");

  const totals = {
    logged: logged.length,
    completed: completed.length,
    inProgress: inProgress.length,
    atRisk: inProgress.filter((i) => i.atRisk).length,
    needDecision: needDecision.length,
    superseded: superseded.length,
    items: logged.length + completed.length + inProgress.length,
    pending,
  };
  return { totals, overall, workstreams: perWs, inProgress, needDecision, logged, completed, superseded };
}

// Plain-text fallback so a report always has a summary.
function autoSummary(g) {
  const t = g.totals;
  if (!t.items && !t.superseded) return "Nothing was logged or completed in this period.";
  const parts = [];
  const resolved = t.logged + t.completed;
  parts.push(resolved + " of " + t.items + " item" + (t.items === 1 ? " is" : "s are") + " resolved.");
  const risk = g.inProgress.find((i) => i.atRisk);
  if (risk) parts.push(risk.title + " (" + risk.wsName + ") has gone quiet" + (risk.due ? " and is due soon" : "") + ".");
  if (t.needDecision) parts.push(t.needDecision + " item" + (t.needDecision === 1 ? " needs" : "s need") + " a decision before the gate.");
  if (t.superseded) parts.push(g.superseded[0].title + " was superseded.");
  if (!risk && !t.needDecision && !t.superseded) parts.push("Nothing is flagged.");
  return parts.join(" ");
}

// The only thing Gemini sees: titles, workstreams and the counts. Never raw messages.
function summaryPromptData(g) {
  const slim = (a) => a.slice(0, 12).map((i) => ({ title: i.title, workstream: i.wsName, due: i.due ? i.due.slice(0, 10) : null, silentDays: i.silentDays }));
  return {
    overall: g.overall,
    totals: g.totals,
    workstreams: g.workstreams.map((w) => ({ name: w.name, rag: w.rag, resolved: w.resolved, total: w.total, note: w.note })),
    inProgress: slim(g.inProgress),
    atRisk: slim(g.inProgress.filter((i) => i.atRisk)),
    needDecision: slim(g.needDecision),
    superseded: slim(g.superseded),
    logged: slim(g.logged),
    completed: slim(g.completed),
  };
}

module.exports = { parseRange, buildGate, autoSummary, summaryPromptData };
