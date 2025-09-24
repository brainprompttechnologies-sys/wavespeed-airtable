import express from "express";
const f = rec.fields || {};
const reqIds = (() => { try { return JSON.parse(f["Request IDs"] || "[]"); } catch { return []; } })();
const startedAt = new Date(f["Created at"] || rec.createdTime || Date.now());
const cutoff = new Date(startedAt.getTime() + POLL_TIMEOUT_MIN * 60 * 1000);


const seen = new Set((f["Seen IDs"] || "").split(",").map((s) => s.trim()).filter(Boolean));
const failed = new Set((f["Failed IDs"] || "").split(",").map((s) => s.trim()).filter(Boolean));


const pending = reqIds.filter((id) => !seen.has(id) && !failed.has(id));


// Query WaveSpeed for each pending id
for (const id of pending) {
try {
const j = await withRetries(() => getWaveSpeedJob(id), { tries: 3, baseDelay: 600 });
if (j.status === "succeeded") {
const urls = (j.outputs || []).map((o) => o.url || o).filter(Boolean);
const current = await atGet(rec.id);
const mergedOutput = buildAttachmentMerge(current.fields.Output, urls);
const newSeen = new Set((current.fields["Seen IDs"] || "").split(",").map((s) => s.trim()).filter(Boolean));
newSeen.add(id);
await atUpdate(rec.id, {
Output: mergedOutput,
"Seen IDs": Array.from(newSeen).join(","),
"Last Update": new Date().toISOString(),
});
} else if (j.status === "failed") {
const current = await atGet(rec.id);
const newFailed = new Set((current.fields["Failed IDs"] || "").split(",").map((s) => s.trim()).filter(Boolean));
newFailed.add(id);
await atUpdate(rec.id, {
"Failed IDs": Array.from(newFailed).join(","),
"Last Update": new Date().toISOString(),
});
}
} catch (e) {
console.warn("poll job error", id, e.message);
}
}


// Timeout finalize
if (new Date() > cutoff) {
const current = await atGet(rec.id);
const f2 = current.fields || {};
const reqIds2 = (() => { try { return JSON.parse(f2["Request IDs"] || "[]"); } catch { return []; } })();
const seen2 = new Set((f2["Seen IDs"] || "").split(",").map((s) => s.trim()).filter(Boolean));
const failed2 = new Set((f2["Failed IDs"] || "").split(",").map((s) => s.trim()).filter(Boolean));
for (const id of reqIds2) {
if (!seen2.has(id) && !failed2.has(id)) failed2.add(id);
}
await atUpdate(rec.id, {
"Failed IDs": Array.from(failed2).join(","),
"Last Update": new Date().toISOString(),
});
}


await finalizeIfDone(rec);
}
}


setInterval(() => {
pollOnce().catch((e) => console.error("pollOnce error", e));
}, POLL_INTERVAL_MS);


// ====== START ======
const port = process.env.PORT || 3000;
app.listen(port, () => {
console.log(`Server listening on :${port}`);
});