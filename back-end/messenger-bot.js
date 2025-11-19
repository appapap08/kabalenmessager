// filename: messenger-bot.js
// Node 18+ recommended. Run: npm init -y && npm i express node-fetch body-parser

import express from "express";
import fetch from "node-fetch";
import bodyParser from "body-parser";

const app = express();
app.use(bodyParser.json());

// ========== CONFIG - EDIT THESE ==========
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN || "PAGE_ACCESS_TOKEN_HERE";
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "VERIFY_TOKEN_HERE";
const BACKEND_API = process.env.BACKEND_API || "http://192.168.100.8:10000";
const BACKEND_AUTH_TOKEN = process.env.BACKEND_AUTH_TOKEN || "BEARER_TOKEN_FOR_BACKEND";
// Use Google Maps if you have key, otherwise Nominatim for geocoding (no key)
const GEOCODING_PROVIDER = process.env.GEOCODING_PROVIDER || "nominatim"; // or "google"
// =========================================

// Simple helpers
function sendToFacebookAPI(body) {
  return fetch(`https://graph.facebook.com/v16.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify(body)
  }).then(r => r.json());
}

function computeFee(service, km) {
  km = Number(km);
  if (service === "food") return km <= 10 ? 200 : 200 + (km - 10) * 20;
  if (service === "wheels") return km <= 10 ? 150 : 150 + (km - 10) * 15;
  if (service === "pabili") return 35 + km * 10;
  if (service === "padala") return 40 + km * 12;
  // default
  return 35 + km * 10;
}

// Haversine distance in kilometers
function haversine(lat1, lon1, lat2, lon2) {
  const toRad = v => v * Math.PI / 180;
  const R = 6371; // km
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  const c = 2*Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

// Basic state store (in-memory) for flow per PSID — replace with Redis in prod
const sessions = {};

// ========== Messenger webhook verification ==========
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode && token) {
    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      console.log("WEBHOOK_VERIFIED");
      return res.status(200).send(challenge);
    } else {
      return res.sendStatus(403);
    }
  }
  res.sendStatus(400);
});

// ========== Webhook receiver ==========
app.post("/webhook", async (req, res) => {
  const body = req.body;
  if (body.object === "page") {
    for (const entry of body.entry) {
      const event = entry.messaging[0];
      const psid = event.sender.id;
      if (!sessions[psid]) sessions[psid] = { stage: "start", data: {} };

      // message handling
      if (event.message) {
        // user sent location, text, or attachment
        if (event.message.attachments && event.message.attachments.length) {
          const att = event.message.attachments[0];
          if (att.type === "location" && att.payload && att.payload.coordinates) {
            // Determine whether we're asking for pickup or dropoff
            const coords = att.payload.coordinates;
            if (sessions[psid].stage === "awaiting_pickup") {
              sessions[psid].data.pickup_lat = coords.lat;
              sessions[psid].data.pickup_lng = coords.long;
              sessions[psid].stage = "awaiting_dropoff";
              await sendText(psid, "Got pickup location ✅. Please send the dropoff location (send a location pin or type the address).");
            } else if (sessions[psid].stage === "awaiting_dropoff") {
              sessions[psid].data.dropoff_lat = coords.lat;
              sessions[psid].data.dropoff_lng = coords.long;
              sessions[psid].stage = "confirm_calculation";
              await processDistanceAndShowSummary(psid);
            } else {
              // default
              await sendText(psid, "Thanks — tell me what you need (Order, My Orders, Help).");
            }
            continue;
          } else {
            // image/file - attach to order if in ordering flow
            if (sessions[psid].stage.startsWith("ordering_")) {
              sessions[psid].data.attachment = att.payload.url || att.payload.sticker_id;
              await sendText(psid, "Image received and attached to the order.");
            } else {
              await sendText(psid, "Attachment received.");
            }
            continue;
          }
        }

        // text message
        const text = (event.message.text || "").trim().toLowerCase();
        if (text === "order") {
          sessions[psid] = { stage: "choose_service", data: {} };
          await promptServiceChoices(psid);
        } else if (text === "my orders") {
          await fetchAndShowOrders(psid);
        } else if (sessions[psid].stage === "choose_service" && ["food","pabili","padala","wheels"].includes(text)) {
          sessions[psid].data.service = text;
          sessions[psid].stage = "awaiting_items";
          await sendText(psid, `You chose *${text}*. Please type the items/details (example: 2pc Chickenjoy w/ Rice) or type 'skip' if none.`);
        } else if (sessions[psid].stage === "awaiting_items") {
          sessions[psid].data.items = text === "skip" ? "" : text;
          sessions[psid].stage = "awaiting_pickup";
          await sendText(psid, "Please send the pickup location (send Location pin or type address).");
        } else if (sessions[psid].stage === "awaiting_pickup" && text) {
          // user typed address — attempt geocode
          sessions[psid].data.pickup_text = event.message.text;
          // attempt geocode
          const coords = await geocodeAddress(event.message.text);
          if (coords) {
            sessions[psid].data.pickup_lat = coords.lat;
            sessions[psid].data.pickup_lng = coords.lon;
            sessions[psid].stage = "awaiting_dropoff";
            await sendText(psid, "Pickup address found ✅. Send dropoff location (pin or address).");
          } else {
            await sendText(psid, "I couldn't find that pickup address. Please send a location pin or re-type a clearer address.");
          }
        } else if (sessions[psid].stage === "awaiting_dropoff" && text) {
          sessions[psid].data.dropoff_text = event.message.text;
          const coords2 = await geocodeAddress(event.message.text);
          if (coords2) {
            sessions[psid].data.dropoff_lat = coords2.lat;
            sessions[psid].data.dropoff_lng = coords2.lon;
            sessions[psid].stage = "confirm_calculation";
            await processDistanceAndShowSummary(psid);
          } else {
            await sendText(psid, "I couldn't find that dropoff address. Please send a location pin or re-type a clearer address.");
          }
        } else if (sessions[psid].stage === "confirm_calculation") {
          // expecting confirm or cancel
          if (text === "confirm" || text === "yes") {
            await finalizeOrder(psid);
          } else if (text === "cancel") {
            sessions[psid] = { stage: "start", data: {} };
            await sendText(psid, "Order cancelled.");
          } else {
            await sendText(psid, "Type 'confirm' to place the order or 'cancel' to abort.");
          }
        } else {
          // fallback quick help
          await sendText(psid, "Hi! Type 'Order' to start, or 'My Orders' to see recent orders.");
        }
      }

      // handle postbacks (button presses)
      if (event.postback) {
        const payload = event.postback.payload;
        if (payload.startsWith("SERVICE_")) {
          const svc = payload.split("_")[1].toLowerCase();
          sessions[psid].data.service = svc;
          sessions[psid].stage = "awaiting_items";
          await sendText(psid, `Selected ${svc}. What items/details? (or type 'skip')`);
        } else if (payload === "CONFIRM_ORDER") {
          await finalizeOrder(psid);
        } else if (payload === "CANCEL_ORDER") {
          sessions[psid] = { stage: "start", data: {} };
          await sendText(psid, "Order cancelled.");
        }
      }
    }
    res.status(200).send("EVENT_RECEIVED");
  } else {
    res.sendStatus(404);
  }
});

// ========== Quick UI helpers ==========
async function promptServiceChoices(psid) {
  const payload = {
    recipient: { id: psid },
    message: {
      attachment: {
        type: "template",
        payload: {
          template_type: "button",
          text: "Choose a service:",
          buttons: [
            { type: "postback", title: "Food", payload: "SERVICE_FOOD" },
            { type: "postback", title: "Pabili", payload: "SERVICE_PABILI" },
            { type: "postback", title: "Padala", payload: "SERVICE_PADALA" },
            { type: "postback", title: "Wheels", payload: "SERVICE_WHEELS" }
          ]
        }
      }
    }
  };
  return sendToFacebookAPI(payload);
}

function sendText(psid, text) {
  return sendToFacebookAPI({ recipient: { id: psid }, message: { text } });
}

// Show summary after computing distance and fee
async function processDistanceAndShowSummary(psid) {
  const d = sessions[psid].data;
  if (d.pickup_lat && d.dropoff_lat) {
    const km = haversine(d.pickup_lat, d.pickup_lng, d.dropoff_lat, d.dropoff_lng);
    d.distance_km = Number(km.toFixed(2));
    d.fee = computeFee(d.service, d.distance_km);
    // summary template
    const summaryText = `*Order Summary*\nService: ${d.service}\nPickup: ${d.pickup_text || "Location pin"}\nDropoff: ${d.dropoff_text || "Location pin"}\nDistance: ${d.distance_km} km\nFee: ₱${d.fee}\nItems: ${d.items || "(none)"}`;
    // send text + confirm/cancel quick buttons
    await sendToFacebookAPI({
      recipient: { id: psid },
      message: {
        attachment: {
          type: "template",
          payload: {
            template_type: "generic",
            elements: [{
              title: `${d.service.toUpperCase()} • ₱${d.fee}`,
              subtitle: summaryText,
              buttons: [
                { type: "postback", title: "Confirm Order", payload: "CONFIRM_ORDER" },
                { type: "postback", title: "Cancel", payload: "CANCEL_ORDER" },
                { type: "phone_number", title: "Call Support", payload: "+639123456789" }
              ]
            }]
          }
        }
      }
    });
    sessions[psid].stage = "confirm_calculation";
  } else {
    await sendText(psid, "Missing locations. Please send both pickup and dropoff (pin or address).");
  }
}

// Finalize order -> send to backend
async function finalizeOrder(psid) {
  const d = sessions[psid].data;
  const customer_name = d.customer_name || "Messenger User";
  const contact = d.customer_contact || null; // optional
  const orderPayload = {
    pickup: d.pickup_text || "Location",
    dropoff: d.dropoff_text || "Location",
    pickup_lat: d.pickup_lat,
    pickup_lng: d.pickup_lng,
    dropoff_lat: d.dropoff_lat,
    dropoff_lng: d.dropoff_lng,
    items: d.items || "",
    service_type: d.service,
    fee: d.fee,
    customer_name,
    customer_contact: contact,
    messenger_psid: psid,
    attachment: d.attachment || null
  };

  // POST to your backend
  try {
    const resp = await fetch(`${BACKEND_API}/orders`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${BACKEND_AUTH_TOKEN}`
      },
      body: JSON.stringify(orderPayload)
    });
    const json = await resp.json();
    if (resp.ok) {
      sessions[psid] = { stage: "start", data: {} };
      await sendText(psid, `Order placed! Order ID: ${json.id || "(from backend)"}\nWe'll update you via Messenger.`);
    } else {
      console.error("Backend error:", json);
      await sendText(psid, "Sorry, failed to create order on backend. Try again or contact support.");
    }
  } catch (err) {
    console.error("Error posting to backend:", err);
    await sendText(psid, "Network error while contacting backend. Try again later.");
  }
}

// ========== Helper: fetch & show last 5 orders ==========
async function fetchAndShowOrders(psid) {
  try {
    const resp = await fetch(`${BACKEND_API}/orders/messenger/${psid}`, {
      headers: { "Authorization": `Bearer ${BACKEND_AUTH_TOKEN}` }
    });
    const list = await resp.json();
    if (!Array.isArray(list) || list.length === 0) {
      return sendText(psid, "You have no recent orders.");
    }
    // show up to 5
    const elements = list.slice(0,5).map(o => ({
      title: `${o.service_type} • ₱${o.fee} • ${o.status}`,
      subtitle: `From: ${o.pickup}\nTo: ${o.dropoff}\nID: ${o.id}`,
      buttons: [{ type: "postback", title: "Track", payload: `TRACK_${o.id}` }]
    }));
    await sendToFacebookAPI({
      recipient: { id: psid },
      message: {
        attachment: { type: "template", payload: { template_type: "generic", elements } }
      }
    });
  } catch (err) {
    console.error(err);
    await sendText(psid, "Unable to fetch orders. Try again later.");
  }
}

// ========== Geocoding (Nominatim) ==========
async function geocodeAddress(text) {
  if (!text) return null;
  if (GEOCODING_PROVIDER === "google") {
    const key = process.env.GOOGLE_MAPS_KEY;
    if (!key) return null;
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(text)}&key=${key}`;
    const r = await fetch(url).then(r=>r.json());
    if (r.results && r.results[0]) {
      const loc = r.results[0].geometry.location;
      return { lat: loc.lat, lon: loc.lng };
    }
    return null;
  } else {
    // Nominatim (free)
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(text)}&format=json&limit=1`;
    const r = await fetch(url, { headers: { "User-Agent": "KabalenBot/1.0 (+yourdomain.com)" } }).then(r=>r.json());
    if (r && r[0]) return { lat: Number(r[0].lat), lon: Number(r[0].lon) };
    return null;
  }
}

// ========== Backend -> Messenger push endpoint ==========
app.post("/send-to-messenger", async (req, res) => {
  // secure with your own auth in production
  const { psid, text, template } = req.body;
  if (!psid || !text) return res.status(400).json({ error: "psid & text required" });
  try {
    await sendText(psid, text);
    return res.json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Messenger bot listening on ${PORT}`));
