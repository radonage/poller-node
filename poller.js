import http from "http";

const POLL_URL =
  "https://massage-cyan-delta.vercel.app/api/poll?secret=123456";

const INTERVAL_MS = 3000;
const PORT = process.env.PORT || 8080;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function tick() {
  console.log("--------------------------------------------------");
  console.log("Envoi requête :", new Date().toLocaleString());

  const res = await fetch(POLL_URL);
  const text = await res.text();

  console.log("Status HTTP :", res.status);
  console.log("Réponse brute :", text);

  if (!res.ok) {
    throw new Error(`HTTP error ${res.status}`);
  }
}

async function main() {
  console.log("Poller démarré...");

  while (true) {
    try {
      await tick();
    } catch (e) {
      console.error("Erreur :", e.message);
    }

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
    console.log(`Health server listening on 0.0.0.0:${PORT}`);
  });

main();
