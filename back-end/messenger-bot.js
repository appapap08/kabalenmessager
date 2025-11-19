// messenger-bot.js (CommonJS) — Full-featured Kabalen Messenger Bot
// Requires: express, body-parser, node-fetch@2
// Start: node messenger-bot.js

const express = require("express");
const bodyParser = require("body-parser");
const fetch = require("node-fetch"); // v2
const app = express();

app.use(bodyParser.json());

// CONFIG (via env)
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN || "";
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "verify_kabalen";
const BOT_SECRET = process.env.BOT_SECRET || "kabalen123secret";
const BACKEND_URL = process.env.BACKEND_URL || "https://kabalenmessager.onrender.com";
const GOOGLE_MAPS_KEY = process.env.GOOGLE_MAPS_KEY || ""; // optional
const PORT = process.env.PORT || 3000;

// In-memory session store (simple)
const sessions = {}; // { psid: { stage, data:{...} } }

function getSession(psid) {
  if (!sessions[psid]) sessions[psid] = { stage: "start", data: {} };
  return sessions[psid];
}
function clearSession(psid) {
  delete sessions[psid];
}

// Facebook send helper
function sendToFacebookAPI(body) {
  return fetch(`https://graph.facebook.com/v16.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  }).then(r => r.json());
}
function sendText(psid, text) {
  return sendToFacebookAPI({ recipient: { id: psid }, message: { text } });
}

// Service buttons (4 wheels shown but unavailable)
function sendServiceButtons(psid) {
  const payload = {
    recipient: { id: psid },
    message: {
      attachment: {
        type: "template",
        payload: {
          template_type: "button",
          text: "What service do you need today? 😊",
          buttons: [
            { type: "postback", title: "🍔 Food", payload: "SERVICE_FOOD" },
            { type: "postback", title: "🛒 Pabili", payload: "SERVICE_PABILI" },
            { type: "postback", title: "🛺 3 Wheels Taxi", payload: "SERVICE_3WHEELS" },
            { type: "postback", title: "🚗 4 Wheels Taxi (Unavailable)", payload: "SERVICE_4WHEELS" }
          ]
        }
      }
    }
  };
  return sendToFacebookAPI(payload);
}

// Distance helpers
async function getDistanceKmGoogle(lat1, lng1, lat2, lng2) {
  if (!GOOGLE_MAPS_KEY) return null;
  const origin = `${lat1},${lng1}`;
  const dest = `${lat2},${lng2}`;
  const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(dest)}&key=${GOOGLE_MAPS_KEY}`;
  try {
    const r = await fetch(url);
    const json = await r.json();
    if (json.routes && json.routes.length && json.routes[0].legs && json.routes[0].legs.length) {
      const legs = json.routes[0].legs;
      let meters = 0;
      for (const leg of legs) meters += (leg.distance && leg.distance.value) || 0;
      return meters / 1000;
    }
  } catch (e) {
    console.log("Google Directions error:", e && e.message);
  }
  return null;
}

async function getDistanceKmOSRM(lat1, lng1, lat2, lng2) {
  try {
    const url = `http://router.project-osrm.org/route/v1/driving/${lng1},${lat1};${lng2},${lat2}?overview=false`;
    const r = await fetch(url);
    const json = await r.json();
    if (json && json.routes && json.routes[0] && typeof json.routes[0].distance === "number") {
      return json.routes[0].distance / 1000;
    }
  } catch (e) {
    console.log("OSRM error:", e && e.message);
  }
  return null;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = v => v * Math.PI / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// Fare calculation rules
function calculateFee(service, km) {
  if (typeof km !== "number" || isNaN(km)) return null;

  // Food + Pabili: 5 km min ₱150, +₱10/km thereafter
  if (service === "SERVICE_FOOD" || service === "SERVICE_PABILI") {
    if (km <= 5) return 150;
    return 150 + Math.ceil(km - 5) * 10;
  }

  // 3 wheels: 5 km min ₱100, +₱15/km thereafter
  if (service === "SERVICE_3WHEELS") {
    if (km <= 5) return 100;
    return 100 + Math.ceil(km - 5) * 15;
  }

  // 4 wheels: unavailable
  if (service === "SERVICE_4WHEELS") return null;

  return null;
}

function labelForService(payload) {
  switch (payload) {
    case "SERVICE_FOOD": return "Food";
    case "SERVICE_PABILI": return "Pabili";
    case "SERVICE_3WHEELS": return "3 Wheels Taxi";
    case "SERVICE_4WHEELS": return "4 Wheels Taxi";
    default: return "Service";
  }
}

// Webhook verification (GET)
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verified ✔");
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// Main webhook (POST)
app.post("/webhook", async (req, res) => {
  const body = req.body;
  if (body.object !== "page") return res.sendStatus(404);

  try {
    for (const entry of body.entry) {
      const messaging = entry.messaging || [];
      for (const event of messaging) {
        const psid = event.sender && event.sender.id;
        if (!psid) continue;
        const session = getSession(psid);

        // POSTBACKS
        if (event.postback && event.postback.payload) {
          const payload = event.postback.payload;

          // Service selection
          if (["SERVICE_FOOD", "SERVICE_PABILI", "SERVICE_3WHEELS", "SERVICE_4WHEELS"].includes(payload)) {
            if (payload === "SERVICE_4WHEELS") {
              await sendText(psid, "🚗 4 Wheels Taxi is currently unavailable. Please choose another service.");
              continue;
            }
            session.data.service = payload;
            session.stage = "awaiting_pickup";
            await sendText(psid, "Great — send your pickup location 📍\nTap the + icon → Location → Send.");
            continue;
          }

          // Confirm / Cancel
          if (payload === "CONFIRM_ORDER") {
            await finalizeOrder(psid);
            continue;
          }
          if (payload === "CANCEL_ORDER") {
            clearSession(psid);
            await sendText(psid, "Order cancelled. Type 'Order' to start again.");
            continue;
          }
        }

        // MESSAGE EVENTS
        if (event.message) {
          // If message has attachments (location)
          if (event.message.attachments && event.message.attachments.length) {
            const att = event.message.attachments[0];
            if (att.type === "location" && att.payload && att.payload.coordinates) {
              const lat = att.payload.coordinates.lat;
              const lng = att.payload.coordinates.long || att.payload.coordinates.lon;

              if (session.stage === "awaiting_pickup" || !session.data.pickup) {
                session.data.pickup = { lat, lng };
                session.stage = "awaiting_dropoff";
                await sendText(psid, "Pickup saved ✅. Now send the dropoff location (location pin).");
                continue;
              } else if (session.stage === "awaiting_dropoff" || !session.data.dropoff) {
                session.data.dropoff = { lat, lng };
                // compute distance & show summary
                await computeDistanceAndShowSummary(psid);
                continue;
              }
            } else {
              // Other attachments
              await sendText(psid, "Attachment received. If you're ordering, please send pickup & dropoff location pins.");
              continue;
            }
          }

          // TEXT messages
          if (event.message.text) {
            const text = event.message.text.trim();
            const lower = text.toLowerCase();

            console.log(`[WEBHOOK] text from ${psid}:`, lower);

            // start ordering
            if (lower === "order") {
              clearSession(psid);
              const s = getSession(psid);
              s.stage = "choosing_service";
              await sendServiceButtons(psid);
              continue;
            }

            if (lower === "help") {
              await sendText(psid, "Type 'Order' to start. Send location pins for pickup & dropoff.");
              continue;
            }

            // If waiting for pickup but user typed an address (text)
            if (session.stage === "awaiting_pickup" && text) {
              session.data.pickup = { text }; // best-effort (no coords)
              session.stage = "awaiting_dropoff";
              await sendText(psid, "Pickup noted. For accurate pricing please send location pins. Now send dropoff (or a pin).");
              continue;
            }

            // If waiting for dropoff but user typed an address (text)
            if (session.stage === "awaiting_dropoff" && text) {
              session.data.dropoff = { text };
              session.stage = "awaiting_compute_confirm";
              await sendText(psid, "Dropoff noted. To compute accurate distance please send location pins. If you want to continue with text addresses type 'compute'.");
              continue;
            }

            if (session.stage === "awaiting_compute_confirm" && (lower === "compute" || lower === "yes")) {
              await sendText(psid, "Sorry — I need location pins to compute distance accurately. Please send pickup & dropoff location pins.");
              session.stage = "awaiting_pickup";
              continue;
            }

            // If waiting for notes before finalize
            if (session.stage === "awaiting_notes" && text) {
              session.data.notes = text === "-" ? "" : text;
              // create order
              await createOrderFromSession(psid);
              continue;
            }

            // default fallback
            await sendText(psid, "Type 'Order' to start placing a delivery request.");
            continue;
          } // end if event.message.text
        } // end event.message
      } // end messaging loop
    } // end entry loop

    res.status(200).send("EVENT_RECEIVED");
  } catch (err) {
    console.error("Webhook processing error:", err && err.message);
    res.sendStatus(500);
  }
});

// Compute distance, fee, and show summary with Confirm/Cancel
async function computeDistanceAndShowSummary(psid) {
  const session = getSession(psid);
  const d = session.data;
  if (!d.pickup || !d.dropoff) {
    await sendText(psid, "Missing pickup or dropoff. Please send both location pins.");
    session.stage = "awaiting_pickup";
    return;
  }

  // both must have coordinates for distance calc
  if (!d.pickup.lat || !d.dropoff.lat) {
    await sendText(psid, "Please send pickup & dropoff *location pins* for accurate distance & fee calculation.");
    session.stage = "awaiting_pickup";
    return;
  }

  // Try Google Directions if key provided
  let km = null;
  if (GOOGLE_MAPS_KEY) {
    km = await getDistanceKmGoogle(d.pickup.lat, d.pickup.lng, d.dropoff.lat, d.dropoff.lng);
  }
  if (km === null) {
    // Try OSRM
    km = await getDistanceKmOSRM(d.pickup.lat, d.pickup.lng, d.dropoff.lat, d.dropoff.lng);
  }
  if (km === null) {
    // fallback haversine
    km = haversineKm(d.pickup.lat, d.pickup.lng, d.dropoff.lat, d.dropoff.lng);
  }

  d.distance = Number(km.toFixed(2));
  d.fee = calculateFee(d.service, d.distance);

  if (d.fee === null) {
    await sendText(psid, "Selected service is currently unavailable. Please choose another service.");
    clearSession(psid);
    return;
  }

  const summaryText = `Service: ${labelForService(d.service)}\nDistance: ${d.distance} km\nFee: ₱${d.fee}\nNotes: ${d.notes || "(none)"}`;

  await sendToFacebookAPI({
    recipient: { id: psid },
    message: {
      attachment: {
        type: "template",
        payload: {
          template_type: "generic",
          elements: [{
            title: `Confirm Order • ₱${d.fee}`,
            subtitle: summaryText,
            buttons: [
              { type: "postback", title: "Confirm Order", payload: "CONFIRM_ORDER" },
              { type: "postback", title: "Cancel", payload: "CANCEL_ORDER" }
            ]
          }]
        }
      }
    }
  });

  session.stage = "awaiting_confirmation";
}

// Create order on backend
async function createOrderFromSession(psid) {
  const session = getSession(psid);
  const d = session.data;

  const orderPayload = {
    messenger_psid: psid,
    pickup: d.pickup.text || "Location pin",
    dropoff: d.dropoff.text || "Location pin",
    pickup_lat: d.pickup.lat || null,
    pickup_lng: d.pickup.lng || null,
    dropoff_lat: d.dropoff.lat || null,
    dropoff_lng: d.dropoff.lng || null,
    items: d.items || "",
    service_type: d.service,
    fee: d.fee || 0,
    distance: d.distance || 0,
    notes: d.notes || ""
  };

  try {
    const resp = await fetch(`${BACKEND_URL}/orders`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-bot-secret": BOT_SECRET
      },
      body: JSON.stringify(orderPayload)
    });
    const json = await resp.json();
    if (!resp.ok) {
      console.log("Backend order error:", json);
      await sendText(psid, "Sorry — failed to create your order. Try again later.");
      return;
    }
    await sendText(psid, `Order placed! Order ID: ${json.order && json.order.id ? json.order.id : "(created)"} — We'll notify you here.`);
    clearSession(psid);
  } catch (e) {
    console.log("createOrder error:", e && e.message);
    await sendText(psid, "Network error while creating order. Try again later.");
  }
}

// Called when user presses confirm — ask for notes then create
async function finalizeOrder(psid) {
  const session = getSession(psid);
  if (!session || !session.data) {
    await sendText(psid, "No active order to confirm.");
    return;
  }
  session.stage = "awaiting_notes";
  await sendText(psid, "Type any notes or items (e.g., '2pc Chickenjoy') or type '-' to skip.");
}

// Endpoint for backend to push notifications to messenger
app.post("/send-to-messenger", async (req, res) => {
  const secret = req.headers["x-bot-secret"];
  if (!secret || secret !== BOT_SECRET) return res.status(403).json({ error: "Invalid bot secret" });

  const { psid, text } = req.body;
  if (!psid || !text) return res.status(400).json({ error: "psid & text required" });

  try {
    await sendText(psid, text);
    return res.json({ ok: true });
  } catch (e) {
    console.log("send-to-messenger error:", e && e.message);
    return res.status(500).json({ ok: false });
  }
});

// Optional: endpoint used by bot to fetch orders for a psid (if you add on backend)
app.get("/orders/messenger/:psid", async (req, res) => {
  // This endpoint is a convenience if you want the bot to fetch order history from backend.
  // If your backend implements it, you can uncomment and proxy here. For now return 404.
  return res.status(404).json({ message: "Not implemented on bot; implement on backend at /orders/messenger/:psid" });
});

// Start server
app.listen(PORT, () => {
  console.log(`Messenger bot running on port ${PORT}`);
});
