// messenger-bot.js (CommonJS version)

// Imports
const express = require("express");
const bodyParser = require("body-parser");
const fetch = require("node-fetch");

// Express App
const app = express();
app.use(bodyParser.json());

// CONFIG
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "verify_kabalen";
const BOT_SECRET = process.env.BOT_SECRET || "kabalen123secret";
const BACKEND_URL = process.env.BACKEND_URL;
const PORT = process.env.PORT || 3000;

// Send message to Facebook API
function sendToFacebookAPI(body) {
    return fetch(
        `https://graph.facebook.com/v16.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
        }
    ).then(r => r.json());
}

// Basic replies
function sendText(psid, text) {
    return sendToFacebookAPI({
        recipient: { id: psid },
        message: { text }
    });
}

// Webhook verify
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

// Handle messages
app.post("/webhook", async (req, res) => {
    const body = req.body;

    if (body.object === "page") {
        for (const entry of body.entry) {
            const event = entry.messaging[0];
            const psid = event.sender.id;

            // User sent a message
            if (event.message && event.message.text) {
                const text = event.message.text.toLowerCase().trim();

                if (text === "order") {
                    await sendText(psid, "Thanks! Your order feature will be available soon.");
                } else {
                    await sendText(psid, "Type *Order* to start.");
                }
            }
        }

        return res.status(200).send("EVENT_RECEIVED");
    }

    res.sendStatus(404);
});

// Endpoint for backend to send notifications
app.post("/send-to-messenger", async (req, res) => {
    const secret = req.headers["x-bot-secret"];
    if (secret !== BOT_SECRET) {
        return res.status(403).json({ error: "Invalid bot secret" });
    }

    const { psid, text } = req.body;
    if (!psid || !text) {
        return res.status(400).json({ error: "Missing psid or text" });
    }

    await sendText(psid, text);
    return res.json({ success: true });
});

// START SERVER
app.listen(PORT, () => {
    console.log(`Messenger bot running on port ${PORT}`);
});
