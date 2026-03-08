const POLL_URL =
  "https://massage-cyan-delta.vercel.app/api/poll?secret=123456";


const INTERVAL_MS = 3000;
const ACTIVE_FROM = 10;
const ACTIVE_TO = 22;

function inActiveWindow() {
  const h = new Date().getHours();
  return h >= ACTIVE_FROM && h < ACTIVE_TO;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function tick() {
  console.log("--------------------------------------------------");
  console.log("⏱ Envoi requête :", new Date().toLocaleString());

  const res = await fetch(POLL_URL);

  console.log("Status HTTP :", res.status);

  const text = await res.text();

  console.log("Réponse brute :", text);

  try {
    const json = JSON.parse(text);
    console.log("JSON parsé :", JSON.stringify(json, null, 2));

    if (json?.device) {
      console.log("Device ID :", json.device.device_id);
      console.log("Power :", json.device.power);
      console.log("Active :", json.device.active);
    }

  } catch (e) {
    console.log("Réponse non JSON");
  }

  if (!res.ok) {
    throw new Error("HTTP error");
  }
}

async function main() {
  console.log("Poller démarré...");

  while (true) {
    try {
      if (!inActiveWindow()) {
        console.log("⏸ Hors plage horaire...");
        await sleep(60000);
        continue;
      }

      await tick();
      await sleep(INTERVAL_MS);

    } catch (e) {
      console.log("Erreur -> retry dans 5s :", e.message);
      await sleep(3000);
    }
  }
}

main();
