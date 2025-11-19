// ============================================================
// Kabalen Rider App — CLEAN & NO-CHAT VERSION
// ============================================================

const API = "http://192.168.100.8:10000";

let selectedOrderId = null;
let uploadOrderId = null;

/* ------------------------------ UTIL ------------------------------ */

function hideAll() {
    [
        "loginScreen",
        "dashboardScreen",
        "acceptScreen",
        "uploadScreen"
    ].forEach(id => document.getElementById(id).style.display = "none");
}

function backToDashboard() {
    hideAll();
    document.getElementById("dashboardScreen").style.display = "block";
    loadRiderCredit();
    loadAvailableOrders();
}

/* ------------------------------ LOGIN ------------------------------ */

function riderLogin() {
    const username = loginUsername.value.trim();
    const password = loginPassword.value.trim();

    if (!username || !password) return alert("Enter username and password.");

    fetch(`${API}/rider/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password })
    })
        .then(r => r.json().then(data => ({ ok: r.ok, data })))
        .then(({ ok, data }) => {
            if (!ok) return alert(data.message);

            localStorage.setItem("rider_token", data.token);
            localStorage.setItem("rider_id", data.rider.id);
            localStorage.setItem("rider_name", data.rider.name);
            localStorage.setItem("rider_credit", data.rider.credit);

            riderName.textContent = data.rider.name;

            backToDashboard();
        })
        .catch(() => alert("Network error"));
}

/* ------------------------------ CREDIT ------------------------------ */

function loadRiderCredit() {
    riderBalance.textContent =
        localStorage.getItem("rider_credit") || 0;
}

/* ------------------------------ AVAILABLE ORDERS ------------------------------ */

function loadAvailableOrders() {
    fetch(`${API}/rider/orders`, {
        headers: { Authorization: "Bearer " + localStorage.getItem("rider_token") }
    })
        .then(r => r.json())
        .then(orders => {

            hideAll();
            dashboardScreen.style.display = "block";
            ordersList.innerHTML = "";

            const pending = orders.filter(o => o.status === "Pending");

            if (pending.length === 0) {
                ordersList.innerHTML = "<p>No available orders right now.</p>";
                return;
            }

            pending.forEach(o => {
                const div = document.createElement("div");
                div.className = "order-card";

                div.innerHTML = `
                    <b>Order #${o.id}</b><br>
                    <b>Pickup:</b> ${o.pickup}<br>
                    <b>Dropoff:</b> ${o.dropoff}<br>
                    <b>Fee:</b> ₱${o.fee}<br><br>

                    <button class="btn" onclick="viewOrder(${o.id})">View & Accept</button>
                `;

                ordersList.appendChild(div);
            });
        })
        .catch(() => alert("Unable to load orders"));
}

/* ------------------------------ VIEW ORDER ------------------------------ */

function viewOrder(id) {
    selectedOrderId = id;

    hideAll();
    acceptScreen.style.display = "block";

    fetch(`${API}/rider/orders`, {
        headers: { Authorization: "Bearer " + localStorage.getItem("rider_token") }
    })
        .then(r => r.json())
        .then(orders => {
            const o = orders.find(x => x.id === id);
            if (!o) return alert("Order not found");

            acceptDetails.innerHTML = `
                <p><b>Order #${o.id}</b></p>

                <p><b>Customer:</b> ${o.customer_name || "N/A"}</p>
                <p><b>Phone:</b> ${o.customer_phone || "N/A"}</p><br>

                <p><b>Pickup:</b> ${o.pickup}</p>
                <p><b>Dropoff:</b> ${o.dropoff}</p>
                <p><b>Fee:</b> ₱${o.fee}</p><br>

                <p><b>Client Notes:</b></p>
                <div class="notes-box">${o.notes || "None"}</div>
            `;
        });
}

/* ------------------------------ ACCEPT ORDER ------------------------------ */

function acceptThisOrder() {
    fetch(`${API}/orders/${selectedOrderId}/accept`, {
        method: "POST",
        headers: { Authorization: "Bearer " + localStorage.getItem("rider_token") }
    })
        .then(r => r.json().then(data => ({ ok: r.ok, data })))
        .then(({ ok, data }) => {
            if (!ok) return alert(data.message);

            alert("Order accepted! ₱25 deducted.");
            loadMyJobs();
        })
        .catch(() => alert("Network error"));
}

/* ------------------------------ MY JOBS ------------------------------ */

function loadMyJobs() {
    fetch(`${API}/rider/orders`, {
        headers: { Authorization: "Bearer " + localStorage.getItem("rider_token") }
    })
        .then(r => r.json())
        .then(orders => {

            hideAll();
            dashboardScreen.style.display = "block";
            ordersList.innerHTML = "";

            const riderId = parseInt(localStorage.getItem("rider_id"));

            const my = orders
                .filter(o => o.rider_id === riderId)
                .sort((a, b) => {
                    const order = { "Accepted": 1, "Picked": 1, "Pending": 2, "Delivered": 3 };
                    return order[a.status] - order[b.status];
                });

            if (my.length === 0) {
                ordersList.innerHTML = "<p>No assigned jobs.</p>";
                return;
            }

            my.forEach(o => {
                const div = document.createElement("div");
                div.className = "order-card";

                div.innerHTML = `
                    <b>Order #${o.id}</b><br>
                    Status: <b>${o.status}</b><br><br>

                    <b>Customer:</b> ${o.customer_name || "N/A"}<br>
                    <b>Phone:</b> ${o.customer_phone || "N/A"}<br><br>

                    <b>Pickup:</b> ${o.pickup}<br>
                    <b>Dropoff:</b> ${o.dropoff}<br><br>

                    <b>Client Notes:</b><br>
                    <div class="notes-box">${o.notes || "None"}</div><br>

                    ${o.status === "Accepted"
                        ? `<button class="btn" onclick="markPicked(${o.id})">Mark as Picked</button><br><br>`
                        : ""}

                    ${o.status === "Picked"
                        ? `<button class="btn" onclick="markDelivered(${o.id})">Mark as Delivered</button><br><br>`
                        : ""}

                    <button class="btn" onclick="goToUpload(${o.id})">Upload Proof</button>
                `;

                ordersList.appendChild(div);
            });
        });
}

/* ------------------------------ PICK / DELIVER ------------------------------ */

function markPicked(id) {
    fetch(`${API}/orders/${id}/pick`, {
        method: "POST",
        headers: { Authorization: "Bearer " + localStorage.getItem("rider_token") }
    }).then(() => loadMyJobs());
}

function markDelivered(id) {
    fetch(`${API}/orders/${id}/deliver`, {
        method: "POST",
        headers: { Authorization: "Bearer " + localStorage.getItem("rider_token") }
    }).then(() => loadMyJobs());
}

/* ------------------------------ UPLOAD PROOF ------------------------------ */

function goToUpload(id) {
    uploadOrderId = id;
    hideAll();
    uploadScreen.style.display = "block";
}

function uploadProof() {
    const file = uploadImage.files[0];
    if (!file) return alert("Select an image.");

    const type = uploadType.value;
    const form = new FormData();
    form.append("image", file);
    form.append("type", type);

    fetch(`${API}/orders/${uploadOrderId}/upload`, {
        method: "POST",
        headers: { Authorization: "Bearer " + localStorage.getItem("rider_token") },
        body: form
    })
        .then(() => {
            alert("Uploaded!");
            loadMyJobs();
        })
        .catch(() => alert("Upload failed."));
}

/* ------------------------------ LOGOUT ------------------------------ */

function logoutRider() {
    localStorage.clear();
    hideAll();
    loginScreen.style.display = "block";
}

/* ------------------------------ INIT ------------------------------ */

document.addEventListener("DOMContentLoaded", () => {
    if (localStorage.getItem("rider_token")) {
        backToDashboard();
    } else {
        loginScreen.style.display = "block";
    }
});
