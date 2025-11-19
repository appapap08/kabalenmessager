// messenger-bot.js (CommonJS)
// Full-featured Messenger bot for Kabalen
// Requires: express, body-parser, node-fetch@2
// Start: node messenger-bot.js

const express = require("express");
const bodyParser = require("body-parser");
const fetch = require("node-fetch"); // v2
const app = express();

app.use(bodyParser.json());

// ===== CONFIG (from env) =====
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN || "";
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "verify_kabalen";
const BOT_SECRET = process.env.BOT_SECRET || "kabalen123secret";
const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:10000";
const PORT = process.env.PORT || 3000;

// ===== In-memory sessions (replace with Redis in prod) =====
const sessions = {}; // keyed by psid

function getSession(psid) {
  if (!sessions[psid]) sessions[psid] = { stage: "start", data: {} };
  return sessions[psid];
}

function clearSession(psid) {
  delete sessions[psid];
}

// ===== Facebook API helper =====
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

// Generic quick reply helper
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

// ===== Distance helpers =====
async function getDistanceKmOSRM(lat1, lon1, lat2, lon2) {
  try {
    const url = `http://router.project-osrm.org/route/v1/driving/${lon1},${lat1};${lon2},${lat2}?overview=false`;
    const r = await fetch(url);
    const json = await r.json();
    if (json && json.routes && json.routes[0] && typeof json.routes[0].distance === "number") {
      return json.routes[0].distance / 1000; // meters -> km
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
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  const c = 2*Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

// ===== Fee calculation (your rules) =====
function calculateFee(service, km) {
  if (typeof km !== "number" || isNaN(km)) return null;

  // FOOD + PABILI: 5 km minimum ₱150, then ₱10 per km
  if (service === "SERVICE_FOOD" || service === "SERVICE_PABILI") {
    if (km <= 5) return 150;
    return 150 + Math.ceil(km - 5) * 10;
  }

  // 3 WHEELS TAXI: 5 km minimum ₱100, then ₱15 per km
  if (service === "SERVICE_3WHEELS") {
    if (km <= 5) return 100;
    return 100 + Math.ceil(km - 5) * 15;
  }

  // 4 WHEELS TAXI - unavailable
  if (service === "SERVICE_4WHEELS") {
    return null;
  }

  return null;
}

// ===== Webhook verification (GET) =====
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

// ===== Receive messages & postbacks (POST) =====
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

        // POSTBACK handling (buttons)
        if (event.postback && event.postback.payload) {
          const payload = event.postback.payload;
          // service selection
          if (["SERVICE_FOOD","SERVICE_PABILI","SERVICE_3WHEELS","SERVICE_4WHEELS"].includes(payload)) {
            if (payload === "SERVICE_4WHEELS") {
              await sendText(psid, "🚗 4 Wheels Taxi is currently unavailable. Please choose another service.");
              continue;
            }
            session.data.service = payload;
            session.stage = "awaiting_pickup";
            await sendText(psid, "Great — send your *pickup location* 📍\nTap the + (plus) icon → Location → Send Location pin.");
            continue;
          }

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

        // MESSAGE handling
        if (event.message) {
          // if user sent location attachment
          if (event.message.attachments && event.message.attachments.length) {
            const att = event.message.attachments[0];
            if (att.type === "location" && att.payload && att.payload.coordinates) {
              const lat = att.payload.coordinates.lat;
              const lng = att.payload.coordinates.long || att.payload.coordinates.lon;

              if (session.stage === "awaiting_pickup" || !session.data.pickup) {
                session.data.pickup = { lat, lng };
                session.stage = "awaiting_dropoff";
                await sendText(psid, "Pickup saved ✅. Now send the *dropoff location* (send a location pin).");
                continue;
              } else if (session.stage === "awaiting_dropoff" || !session.data.dropoff) {
                session.data.dropoff = { lat, lng };
                // compute distance & fee
                await computeDistanceAndShowSummary(psid);
                continue;
              }
            } else {
              // other attachments (image) - optional handling
              await sendText(psid, "Attachment received. If you're ordering, please send pickup & dropoff locations.");
              continue;
            }
          }

          // text messages
          const raw = (event.message.text || "").trim();
          const text = raw.toLowerCase();

          // initial triggers
          if (text === "order") {
            clearSession(psid);
            session.stage = "choosing_service";
            await sendServiceButtons(psid);
            continue;
          }
          if (text === "help") {
            await sendText(psid, "Type 'Order' to begin. You can send location pins for pickup & dropoff.");
            continue;
          }
          if (text === "my orders") {
            // fetch recent orders from BACKEND if you implement endpoint /orders/messenger/:psid
            try {
              const r = await fetch(`${BACKEND_URL}/orders/messenger/${psid}`, { headers: { "Content-Type": "application/json" } });
              const json = await r.json();
              if (!Array.isArray(json) || json.length === 0) {
                await sendText(psid, "You have no recent orders.");
              } else {
                // show up to 5
                const elements = json.slice(0,5).map(o => ({
                  title: `${o.service_type || "Order"} • ₱${o.fee} • ${o.status}`,
                  subtitle: `From: ${o.pickup || "—"}\nTo: ${o.dropoff || "—"}\nID: ${o.id}`,
                }));
                await sendToFacebookAPI({ recipient: { id: psid }, message: { attachment: { type: "template", payload: { template_type: "generic", elements } } } });
              }
            } catch (e) {
              console.log("fetch orders error", e && e.message);
              await sendText(psid, "Couldn't fetch orders.");
            }
            continue;
          }

          // Flow: typed pickup/dropoff (geocoding not included) - if user types anything during pick/drop flow
          if (session.stage === "awaiting_pickup" && raw) {
            // Ask user to send location pin for better accuracy
            session.data.pickup = { text: raw };
            session.stage = "awaiting_dropoff";
            await sendText(psid, "Pickup noted. It's better to send a location pin for precise distance — but send dropoff now (or send a location pin).");
            continue;
          }
          if (session.stage === "awaiting_dropoff" && raw) {
            session.data.dropoff = { text: raw };
            // We don't have coords — ask user to send location pins for better accuracy; do best-effort
            await sendText(psid, "Got dropoff. To compute distance accurately, please send location pins. If you want to continue with text addresses, type 'compute'.");
            session.stage = "awaiting_compute_confirm";
            continue;
          }
          if (session.stage === "awaiting_compute_confirm" && (text === "compute" || text === "yes")) {
            // fallback: can't compute without coords — ask for pins
            await sendText(psid, "Sorry — I need location pins to compute distance. Please send pickup & dropoff location pins.");
            session.stage = "awaiting_pickup";
            continue;
          }

          // After computed summary: collect notes (finalize)
          if (session.stage === "awaiting_notes" && raw) {
            session.data.notes = raw === "-" ? "" : raw;
            // finalize: create order
            await createOrderFromSession(psid);
            continue;
          }

          // fallback
          await sendText(psid, "Type 'Order' to start. Type 'Help' for assistance.");
        } // end event.message
      } // end messaging loop
    } // end entry loop
    res.status(200).send("EVENT_RECEIVED");
  } catch (err) {
    console.error("webhook error:", err && err.message);
    res.sendStatus(500);
  }
});

// ===== compute distance & show order summary =====
async function computeDistanceAndShowSummary(psid) {
  const session = getSession(psid);
  const d = session.data;
  if (!d.pickup || !d.dropoff) {
    await sendText(psid, "Missing pickup or dropoff.");
    return;
  }

  // prefer coords - if either lacks coords, fail gracefully
  if (!d.pickup.lat || !d.dropoff.lat) {
    await sendText(psid, "Please send location pins for both pickup and dropoff so I can compute the distance.");
    session.stage = "awaiting_pickup";
    return;
  }

  // Try OSRM first
  let km = await getDistanceKmOSRM(d.pickup.lat, d.pickup.lng, d.dropoff.lat, d.dropoff.lng);
  if (km === null) {
    // fallback to haversine
    km = haversineKm(d.pickup.lat, d.pickup.lng, d.dropoff.lat, d.dropoff.lng);
  }

  d.distance = Number(km.toFixed(2));
  d.fee = calculateFee(d.service, d.distance);

  if (d.fee === null) {
    await sendText(psid, "Selected service is not available. Please choose another service.");
    clearSession(psid);
    return;
  }

  // send summary with confirm/cancel buttons
  const summaryText = `Service: ${labelForService(d.service)}\nPickup: ${d.pickup.text || "Location pin"}\nDropoff: ${d.dropoff.text || "Location pin"}\nDistance: ${d.distance} km\nFee: ₱${d.fee}\nItems/Notes: ${d.items || "(none)"}`;

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

// small label helper
function labelForService(payload) {
  switch (payload) {
    case "SERVICE_FOOD": return "Food";
    case "SERVICE_PABILI": return "Pabili";
    case "SERVICE_3WHEELS": return "3 Wheels Taxi";
    case "SERVICE_4WHEELS": return "4 Wheels Taxi";
    default: return "Service";
  }
}

// ===== create order by calling backend =====
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
      console.log("backend order error:", json);
      await sendText(psid, "Sorry — failed to create your order. Try again later.");
      return;
    }
    await sendText(psid, `Order placed! Order ID: ${json.order && json.order.id ? json.order.id : "(from backend)"}. We'll notify you here.`);
    clearSession(psid);
  } catch (e) {
    console.log("create order error:", e && e.message);
    await sendText(psid, "Network error while creating order. Try again later.");
  }
}

// Called when user presses CONFIRM_ORDER postback
async function finalizeOrder(psid) {
  const session = getSession(psid);
  if (!session || !session.data) {
    await sendText(psid, "No active order to confirm.");
    return;
  }
  // ask for notes before sending? We included notes step earlier; if none, proceed
  session.stage = "awaiting_notes";
  await sendText(psid, "Type any notes or items (e.g., '2pc Chickenjoy') or type '-' to skip.");
}

// ===== Endpoint used by backend to push messages to customer =====
app.post("/send-to-messenger", async (req, res) => {
  const secret = req.headers["x-bot-secret"];
  if (!secret || secret !== BOT_SECRET) return res.status(403).json({ error: "Invalid secret" });

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

// ===== small helper to accept natural-language "start" flow =====
async function handleStartIfNeeded(psid) {
  const session = getSession(psid);
  if (session.stage === "start") {
    await sendText(psid, "Hi! Type 'Order' to start or tap below.");
    await sendServiceButtons(psid);
    session.stage = "choosing_service";
  }
}

// ===== Start server =====
app.listen(PORT, () => {
  console.log(`Messenger bot running on port ${PORT}`);
});
