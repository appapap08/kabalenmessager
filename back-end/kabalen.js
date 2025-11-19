// kabalen.js
// KABALEN BACKEND — Web Client + Rider App + Messenger Orders
// Run: node kabalen.js
// Dependencies: express, cors, fs, path, jsonwebtoken, multer, node-fetch@2

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const fetch = require("node-fetch"); // node-fetch v2 for require()

const app = express();

// --------------------------------
// CONFIG (edit or use env vars)
// --------------------------------
const SECRET_KEY = process.env.SECRET_KEY || "supersecretkey";
const DATA_FILE = path.join(__dirname, "data.json");
const FRONTEND = path.join(__dirname, "../front-end");

// Messenger Bot integration
const BOT_SERVER_URL = process.env.BOT_SERVER_URL || "https://YOUR-BOT-SERVER"; // e.g. https://abcd.ngrok.io
const BOT_SECRET = process.env.BOT_SECRET || "bot_shared_secret"; // set same secret in bot

// --------------------------------
// HELPERS
// --------------------------------
function loadData() {
    if (!fs.existsSync(DATA_FILE)) {
        fs.writeFileSync(DATA_FILE, JSON.stringify({
            riders: [],
            clients: [],
            orders: [],
            nextRiderId: 1,
            nextClientId: 1,
            nextOrderId: 1
        }, null, 2));
    }
    return JSON.parse(fs.readFileSync(DATA_FILE));
}

function saveData(data) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// --------------------------------
// STATIC ROUTING (CLEAN & FIXED)
// --------------------------------

// Client Web App
app.use("/client", express.static(path.join(FRONTEND, "client")));

// Rider App
app.use("/rider", express.static(path.join(FRONTEND, "rider")));

// Admin App
app.use("/admin", express.static(path.join(FRONTEND, "admin")));

// Home Page
app.get("/", (req, res) => {
    res.sendFile(path.join(FRONTEND, "index.html"));
});

// Client SPA Fallback
app.get("/client/*", (req, res) => {
    res.sendFile(path.join(FRONTEND, "client/index.html"));
});

// --------------------------------
// MIDDLEWARE
// --------------------------------
app.use(express.json());
app.use(cors({ origin: "*", allowedHeaders: ["Content-Type", "Authorization", "x-bot-secret"] }));

function auth(req, res, next) {
    const h = req.headers.authorization;
    if (!h) return res.status(401).json({ message: "Missing token" });
    try {
        req.user = jwt.verify(h.split(" ")[1], SECRET_KEY);
        next();
    } catch (e) {
        return res.status(403).json({ message: "Invalid token" });
    }
}

function requireAdmin(req, res, next) {
    if (!req.user || req.user.username !== "admin")
        return res.status(403).json({ message: "Admin required" });
    next();
}

// --------------------------------
// MULTER (UPLOADS)
// --------------------------------
const uploads = multer({
    storage: multer.diskStorage({
        destination: (_, __, cb) =>
            cb(null, path.join(FRONTEND, "uploads")),
        filename: (_, file, cb) =>
            cb(null, Date.now() + path.extname(file.originalname))
    })
});

// --------------------------------
// NOTIFY MESSENGER HELPER
// --------------------------------
async function notifyMessenger(psid, text) {
    if (!psid) return;
    try {
        await fetch(`${BOT_SERVER_URL}/send-to-messenger`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-bot-secret": BOT_SECRET
            },
            body: JSON.stringify({ psid, text })
        });
    } catch (err) {
        console.log("Messenger notify error:", err && err.message ? err.message : err);
    }
}

// --------------------------------
// AUTH ROUTES
// --------------------------------

app.post("/admin/login", (req, res) => {
    const { username, password } = req.body;
    if (username === "admin" && password === "123") {
        const token = jwt.sign({ username }, SECRET_KEY, { expiresIn: "12h" });
        return res.json({ token });
    }
    res.status(401).json({ message: "Invalid credentials" });
});

app.post("/rider/login", (req, res) => {
    const { username, password } = req.body;
    const data = loadData();
    const r = data.riders.find(x => x.username === username && x.password === password);
    if (!r) return res.status(401).json({ message: "Invalid credentials" });
    const token = jwt.sign({ riderId: r.id }, SECRET_KEY, { expiresIn: "12h" });
    res.json({ token, rider: r });
});

app.post("/clients/login", (req, res) => {
    const { username, password } = req.body;
    const data = loadData();
    const c = data.clients.find(x => x.username === username && x.password === password);
    if (!c) return res.status(401).json({ message: "Invalid credentials" });
    const token = jwt.sign({ clientId: c.id }, SECRET_KEY, { expiresIn: "12h" });
    res.json({ token, client: c });
});

// --------------------------------
// ADMIN ROUTES (RIDERS)
// --------------------------------

app.get("/riders", auth, requireAdmin, (req, res) => {
    res.json(loadData().riders);
});

app.post("/riders", auth, requireAdmin, (req, res) => {
    const { name, phone, username, password } = req.body;
    const data = loadData();
    const newR = { id: data.nextRiderId++, name, phone, username, password, credit: 0 };
    data.riders.push(newR);
    saveData(data);
    res.json(newR);
});

// --------------------------------
// MESSENGER: Create order (from bot)
// --------------------------------
// Protected by header x-bot-secret to ensure only your bot server can call this.
app.post("/orders", (req, res) => {
    const incomingSecret = req.headers["x-bot-secret"];
    if (!incomingSecret || incomingSecret !== BOT_SECRET) {
        return res.status(403).json({ message: "Forbidden - invalid bot secret" });
    }

    const data = loadData();

    const newOrder = {
        id: data.nextOrderId++,
        // bot-provided messenger PSID to notify later
        messenger_psid: req.body.messenger_psid || null,
        // basic info
        pickup: req.body.pickup || "",
        dropoff: req.body.dropoff || "",
        pickup_lat: req.body.pickup_lat || null,
        pickup_lng: req.body.pickup_lng || null,
        dropoff_lat: req.body.dropoff_lat || null,
        dropoff_lng: req.body.dropoff_lng || null,
        items: req.body.items || "",
        fee: req.body.fee || 0,
        distance: req.body.distance || 0,
        notes: req.body.notes || "",
        status: "Pending",
        rider_id: null
    };

    data.orders.push(newOrder);
    saveData(data);

    // Optionally notify customer that their order was received
    if (newOrder.messenger_psid) {
        notifyMessenger(newOrder.messenger_psid,
            `Order received! Your order #${newOrder.id} is now pending. We'll notify you when a rider accepts it.`);
    }

    res.json({ message: "Order created", order: newOrder });
});

// --------------------------------
// ORDERS (existing client flows remain)
// --------------------------------

// CLIENT — Create order (web client using client auth)
app.post("/clients/orders", auth, (req, res) => {
    const data = loadData();
    const newOrder = {
        id: data.nextOrderId++,
        client_id: req.user.clientId,
        pickup: req.body.pickup,
        dropoff: req.body.dropoff,
        fee: req.body.fee,
        distance: req.body.distance,
        notes: req.body.notes || "",
        status: "Pending",
        rider_id: null
    };
    data.orders.push(newOrder);
    saveData(data);
    res.json({ message: "Order placed", order: newOrder });
});

// CLIENT — Get Orders
app.get("/clients/orders", auth, (req, res) => {
    const data = loadData();
    res.json(data.orders.filter(o => o.client_id === req.user.clientId));
});

// RIDER — Get their assigned orders
app.get("/rider/orders", auth, (req, res) => {
    const data = loadData();
    res.json(data.orders.filter(o => o.rider_id === req.user.riderId));
});

// RIDER — Accept Job
app.post("/orders/:id/accept", auth, (req, res) => {
    const orderId = parseInt(req.params.id);
    const data = loadData();
    const order = data.orders.find(o => o.id === orderId);
    if (!order) return res.status(404).json({ message: "Order not found" });
    order.status = "Accepted";
    order.rider_id = req.user.riderId;
    saveData(data);

    // Messenger notify
    if (order.messenger_psid) {
        const rider = data.riders.find(r => r.id === req.user.riderId);
        const riderName = rider ? rider.name : "A rider";
        notifyMessenger(order.messenger_psid,
            `Your order #${order.id} was accepted by ${riderName}. Rider is heading to the pickup location.`);
    }

    res.json({ message: "Order accepted", order });
});

// PICKED
app.post("/orders/:id/pick", auth, (req, res) => {
    const data = loadData();
    const o = data.orders.find(x => x.id == req.params.id);
    if (!o) return res.status(404).json({ message: "Order not found" });
    o.status = "Picked";
    saveData(data);

    // Messenger notify
    if (o.messenger_psid) {
        notifyMessenger(o.messenger_psid,
            `Rider has picked up your items for order #${o.id}. They're on the way.`);
    }

    res.json({ message: "Picked", order: o });
});

// DELIVERED
app.post("/orders/:id/deliver", auth, (req, res) => {
    const data = loadData();
    const o = data.orders.find(x => x.id == req.params.id);
    if (!o) return res.status(404).json({ message: "Order not found" });
    o.status = "Delivered";
    saveData(data);

    // Messenger notify
    if (o.messenger_psid) {
        notifyMessenger(o.messenger_psid,
            `Your delivery #${o.id} has been delivered. Thank you for using Kabalen!`);
    }

    res.json({ message: "Delivered", order: o });
});

// UPLOAD PROOF
app.post("/orders/:id/upload", auth, uploads.single("image"), (req, res) => {
    const data = loadData();
    const o = data.orders.find(x => x.id == req.params.id);
    if (!o) return res.status(404).json({ message: "Order not found" });
    if (req.body.type === "pickup") o.pickup_image = req.file.filename;
    if (req.body.type === "dropoff") o.dropoff_image = req.file.filename;
    saveData(data);

    // Notify customer with a short message and (optionally) the file name
    if (o.messenger_psid) {
        const t = req.body.type === "pickup" ? "pickup proof uploaded" : "dropoff proof uploaded";
        notifyMessenger(o.messenger_psid,
            `Rider uploaded ${t} for order #${o.id}.`);
    }

    res.json({ message: "Uploaded", file: req.file.filename });
});

// ADMIN — Delete Order
app.delete("/orders/:id", auth, requireAdmin, (req, res) => {
    const data = loadData();
    data.orders = data.orders.filter(o => o.id != req.params.id);
    saveData(data);
    res.json({ message: "Order deleted" });
});

// --------------------------------
// START SERVER
// --------------------------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, "0.0.0.0", () =>
    console.log(`SERVER RUNNING on port ${PORT}`)
);
