import http from "http";

const POLL_URL =
  "https://massage-cyan-delta.vercel.app/api/poll?secret=123456";

const INTERVAL_MS = 3000;
const PORT = Number(process.env.PORT || 8080);
const FETCH_TIMEOUT_MS = 10000;

let pollCount = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function tick() {
  pollCount += 1;
  const id = pollCount;
  const startMs = Date.now();

  console.log("--------------------------------------------------");
  console.log(`[POLL ${id}] Envoi requête : ${new Date(startMs).toISOString()}`);

  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(POLL_URL, {
      method: "GET",
      headers: {
        Accept: "application/json, text/plain, */*",
        "User-Agent": "dream-care-poller",
        "Cache-Control": "no-cache",
      },
      signal: controller.signal,
    });

    const text = await res.text();
    const endMs = Date.now();

    console.log(`[POLL ${id}] Réponse reçue : ${new Date(endMs).toISOString()}`);
    console.log(`[POLL ${id}] Durée ms : ${endMs - startMs}`);
    console.log(`[POLL ${id}] Status HTTP : ${res.status}`);
    console.log(`[POLL ${id}] Réponse brute : ${text}`);

    if (!res.ok) {
      throw new Error(`HTTP error ${res.status}`);
    }
  } catch (err) {
    const endMs = Date.now();

    if (err.name === "AbortError") {
      console.error(`[POLL ${id}] Timeout après ${FETCH_TIMEOUT_MS} ms`);
    } else {
      console.error(`[POLL ${id}] Erreur tick : ${err.message}`);
    }

    console.log(`[POLL ${id}] Fin erreur : ${new Date(endMs).toISOString()}`);
    console.log(`[POLL ${id}] Durée ms avant erreur : ${endMs - startMs}`);
  } finally {
    clearTimeout(timeout);
  }
}

async function main() {
  console.log("Poller démarré...");
  console.log(`Intervalle : ${INTERVAL_MS} ms`);
  console.log(`Timeout fetch : ${FETCH_TIMEOUT_MS} ms`);
  console.log(`POLL_URL : ${POLL_URL}`);

  while (true) {
    await tick();
    await sleep(INTERVAL_MS);
  }
}

process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
});

process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection:", err);
});

http
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Poller running");
  })
  .listen(PORT, "0.0.0.0", () => {
    console.log(`HTTP server listening on 0.0.0.0:${PORT}`);
  });

main();
