import http from "http";

const POLL_URL =
  "https://massage-cyan-delta.vercel.app/api/poll?secret=123456";

const INTERVAL_MS = 10000;
const PORT = process.env.PORT || 8080;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function tick() {
  console.log("--------------------------------------------------");
  console.log("⏱ Envoi requête :", new Date().toLocaleString());

  try {
    const res = await fetch(POLL_URL);
    const text = await res.text();

    console.log("Status HTTP :", res.status);
    console.log("Réponse brute :", text);

    if (!res.ok) {
      throw new Error(`HTTP error ${res.status}`);
    }
  } catch (err) {
    console.error("Erreur tick :", err.message);
  }
}

async function main() {
  console.log("Poller démarré...");

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
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Poller running");
  })
  .listen(PORT, "0.0.0.0", () => {
    console.log(`HTTP server listening on 0.0.0.0:${PORT}`);
  });

main();
