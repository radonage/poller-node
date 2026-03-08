import http from "http";

const POLL_URL =
  "https://massage-cyan-delta.vercel.app/api/poll?secret=123456";

const INTERVAL_MS = 3000;
const PORT = Number(process.env.PORT || 8080);
const FETCH_TIMEOUT_MS = 15000;

let pollCount = 0;
let running = false;

async function tick() {
  if (running) {
    console.log("[SKIP] Requête précédente encore en cours");
    return;
  }

  running = true;
  pollCount += 1;
  const id = pollCount;
  const startMs = Date.now();

  console.log("--------------------------------------------------");
  console.log(`[POLL ${id}] Envoi requête : ${new Date(startMs).toISOString()}`);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(POLL_URL, {
      signal: controller.signal,
      headers: {
        Accept: "application/json, text/plain, */*",
        "Cache-Control": "no-cache",
        "User-Agent": "dream-care-poller",
      },
    });

    const text = await res.text();
    const endMs = Date.now();

    console.log(`[POLL ${id}] Réponse reçue : ${new Date(endMs).toISOString()}`);
    console.log(`[POLL ${id}] Durée ms : ${endMs - startMs}`);
    console.log(`[POLL ${id}] Status HTTP : ${res.status}`);
    console.log(`[POLL ${id}] Réponse brute : ${text}`);
  } catch (err) {
    const endMs = Date.now();
    console.error(`[POLL ${id}] Erreur : ${err.message}`);
    console.log(`[POLL ${id}] Fin erreur : ${new Date(endMs).toISOString()}`);
    console.log(`[POLL ${id}] Durée ms avant erreur : ${endMs - startMs}`);
  } finally {
    clearTimeout(timeout);
    running = false;
  }
}

function main() {
  console.log("Poller démarré...");
  console.log(`Intervalle configuré : ${INTERVAL_MS} ms`);

  tick();
  setInterval(tick, INTERVAL_MS);
}

http
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Poller running");
  })
  .listen(PORT, "0.0.0.0", () => {
    console.log(`HTTP server listening on 0.0.0.0:${PORT}`);
  });

main();
