// The floor under the restock engine: read the Shopify catalogues from a
// GitHub runner and post them to the poller.
//
// Why this exists: the shops challenge our Cloudflare worker as a datacenter
// bot, so the only reader that works is a machine on an ordinary connection —
// which has been one PC. On 27 September that PC blue-screened six times and
// the engine was blind for 9 h 41 min of the day. The probe in this folder
// showed that GitHub's runners are NOT challenged: eight shops, eight 200s, no
// cf-mitigated header. So this is a second reader that does not depend on
// anyone's desktop staying up.
//
// It is a FLOOR, not a replacement. The PC agent reads every 60 seconds; a
// scheduled workflow cannot go faster than five minutes and will usually be
// slower. So the first thing this does is ask whether the agent is already
// feeding, and if it is, this exits without touching anything.
//
// It holds INGEST_TOKEN, which opens /ingest/shops and /ingest/shopify and
// nothing else — not the Supabase service-role key the PC agent uses, and not
// the Cloudflare API token. A runner we do not own gets the narrowest key that
// does the job.
import { createHash } from "node:crypto";

const POLLER = "https://collect-poller.nordicwebco.workers.dev";
const UA = "PokePlingBot/1.0 (+https://pokepling.com/bot; restock alerts)";
const TOKEN = process.env.INGEST_TOKEN;
const FORCE = process.argv.includes("--force");

// If the freshest shop was read more recently than this, the fast reader is
// alive and this run has nothing to add.
//
// Three minutes, deliberately BELOW the worker's four-minute trigger. When the
// worker sends a runner it also sends --force, so this check is only reached on
// GitHub's own schedule — but a gap between the two thresholds is what made the
// first live test dispatch a runner that then decided it was not needed.
const AGENT_ALIVE_MINUTES = 3;

if (!TOKEN) {
  console.error("INGEST_TOKEN is not set — refusing to run rather than failing shop by shop");
  process.exit(1);
}

// A secret travels from a file, through a human, into a web form, and one
// character of it arrived as an em dash instead of a hyphen. Node then refused
// to put it in a header and the run died with a stack trace about ByteStrings,
// which says nothing about what was actually wrong.
//
// So the token is checked before it is used, and the two facts needed to
// diagnose it are printed. The fingerprint is a hash prefix: it proves which
// token this is without being the token, which matters because these logs are
// public.
const bad = [...TOKEN].filter((c) => c.charCodeAt(0) > 126);
if (bad.length) {
  console.error(
    `INGEST_TOKEN contains ${bad.length} non-ASCII character(s) — ` +
    `almost always autocorrect turning a hyphen into an en or em dash on the way through a paste. ` +
    `Re-copy it without editing.`,
  );
  process.exit(1);
}
const fingerprint = createHash("sha256").update(TOKEN).digest("hex").slice(0, 8);
console.log(`token fingerprint ${fingerprint}, ${TOKEN.length} chars`);

const auth = { authorization: `Bearer ${TOKEN}` };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── is anyone already doing this? ──────────────────────────────────────────
const health = await fetch(`${POLLER}/health`, { headers: { "user-agent": UA } }).then((r) => r.json());
const shops = await fetch(`${POLLER}/ingest/shops`, { headers: { ...auth, "user-agent": UA } })
  .then(async (r) => {
    if (!r.ok) throw new Error(`/ingest/shops ${r.status}: ${(await r.text()).slice(0, 120)}`);
    return (await r.json()).shops;
  });

const tracked = new Set(shops.map((s) => s.slug));
const freshest = Math.min(
  ...(health.stores ?? []).filter((s) => tracked.has(s.slug)).map((s) => s.oldestMinutes ?? 999),
);
if (!FORCE && Number.isFinite(freshest) && freshest <= AGENT_ALIVE_MINUTES) {
  console.log(`the agent is feeding (freshest shop read ${freshest} min ago) — nothing to do`);
  process.exit(0);
}
console.log(`freshest Shopify read is ${freshest} min old — stepping in\n`);

// ── read, exactly as the PC agent reads ────────────────────────────────────
// Same fields, same rules: availability is per variant, price is the cheapest
// variant, a page short of 250 is the last page. The engine must not be able to
// tell which reader fed it.
async function readShop(shop) {
  const out = [];
  for (let page = 1; page <= shop.pages; page++) {
    const res = await fetch(`${shop.url}?limit=250&page=${page}`, {
      headers: { "user-agent": UA, accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      if (page === 1) throw new Error(`HTTP ${res.status}${res.headers.get("cf-mitigated") ? " (challenged)" : ""}`);
      break;
    }
    const body = await res.text();
    if (!body) break;
    const products = JSON.parse(body).products ?? [];
    for (const p of products) {
      if (!p.handle) continue;
      const variants = p.variants ?? [];
      const prices = variants.map((v) => Number(v.price)).filter((n) => Number.isFinite(n) && n > 0);
      out.push({ handle: p.handle, available: variants.some((v) => v.available), price: prices.length ? Math.min(...prices) : null });
    }
    if (products.length < 250) break;
    await sleep(400 + Math.random() * 400);
  }
  return out;
}

// Two shops sell thousands of singles, so our sealed products sit far past any
// sane page cap — reading their catalogue matched 0 and 5 of 30 listings. For
// them the poller hands over the URLs we track and we ask about those by name.
// A 404 is kept rather than dropped: it is the shop saying the product is gone,
// and staying silent about it is what once left a dead listing unread for hours.
async function readByProduct(shop) {
  const out = [];
  const gone = [];
  for (const url of shop.urls) {
    const handle = url.replace(/\/$/, "").split("/").pop().split("?")[0];
    try {
      const res = await fetch(`${url.replace(/\/$/, "")}.js`, {
        headers: { "user-agent": UA, accept: "*/*" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        if (res.status === 404 || res.status === 410) gone.push(handle);
        continue;
      }
      const p = await res.json();
      const variants = p.variants ?? [];
      // This endpoint quotes prices in øre; the catalogue quotes them in kroner.
      const prices = variants.map((v) => Number(v.price) / 100).filter((n) => Number.isFinite(n) && n > 0);
      out.push({
        handle,
        available: p.available === true || variants.some((v) => v.available),
        price: prices.length ? Math.min(...prices) : null,
      });
    } catch {
      /* one product failing is not the shop failing */
    }
    await sleep(250);
  }
  out.gone = gone;
  return out;
}

let fed = 0, failed = 0, changes = 0, n = 0;
for (const shop of shops) {
  try {
    const products = shop.mode === "product" ? await readByProduct(shop) : await readShop(shop);
    // quiet: apply the data, alert nobody.
    //
    // This run only happens because the engine was blind for a while, so every
    // "change" it sees is a change that already happened — possibly hours ago.
    // Paging people about a restock they have already missed is worse than
    // saying nothing, and it is exactly what the agent's first round suppresses.
    const res = await fetch(`${POLLER}/ingest/shopify`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json", "user-agent": UA },
      body: JSON.stringify({ slug: shop.slug, products, quiet: true, gone: products.gone ?? [] }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`ingest ${res.status}: ${JSON.stringify(j).slice(0, 120)}`);
    changes += j.changes ?? 0;
    fed++;
    // Deliberately anonymous. These logs are public on a public repository, and
    // which shops PokePling tracks is not ours to publish. The service knows
    // exactly who is who; /health says which one is unhappy. Here a shop is a
    // number, and that is enough to tell a good run from a bad one.
    console.log(`shop ${String(++n).padStart(2)}  ${String(products.length).padStart(5)} read → ${j.matched ?? "?"} matched, ${j.changes ?? 0} changed`);
  } catch (err) {
    failed++;
    console.error(`shop ${String(++n).padStart(2)}  FAILED: ${err.message.replace(/https?:\/\/\S+/g, "<url>")}`);
  }
  await sleep(1000);
}

console.log(`\nfed ${fed} shops, ${failed} failed, ${changes} listings updated`);
// A run where every shop failed means the runner is being challenged after all,
// and that is worth a red mark rather than a quiet success.
if (fed === 0) process.exit(1);
