// admin.js — Clean Updated Version with Notes + Realtime Updates

const API = "http://192.168.100.8:10000"; // CHANGE THIS
let token = localStorage.getItem("admin_token") || null;

/* -------------------------------------------------------
   LOGIN
------------------------------------------------------- */
async function login() {
    const username = document.getElementById("username").value;
    const password = document.getElementById("password").value;

    const res = await fetch(`${API}/admin/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password })
    });

    const data = await res.json();
    if (!res.ok) return alert(data.message);

    token = data.token;
    localStorage.setItem("admin_token", token);

    document.getElementById("loginDiv").style.display = "none";
    document.getElementById("dashboard").style.display = "block";

    loadRiders();
    loadOrders();
    loadHistory();
    loadAssignRiders();
}

function logout() {
    localStorage.removeItem("admin_token");
    token = null;
    location.reload();
}

/* -------------------------------------------------------
   LOAD RIDERS
------------------------------------------------------- */
async function loadRiders() {
    const res = await fetch(`${API}/riders`, {
        headers: { "Authorization": "Bearer " + token }
    });

    if (!res.ok) return;
    const riders = await res.json();

    const table = document.getElementById("ridersTable");
    table.innerHTML = `
        <tr>
            <th>ID</th>
            <th>Name</th>
            <th>Phone</th>
            <th>Username</th>
            <th>Credit</th>
            <th>Add Coins</th>
            <th>Delete</th>
        </tr>
    `;

    riders.forEach(r => {
        const tr = document.createElement("tr");
        tr.innerHTML = `
            <td>${r.id}</td>
            <td>${r.name}</td>
            <td>${r.phone}</td>
            <td>${r.username}</td>
            <td>${r.credit}</td>
            <td>
                <input id="coin${r.id}" type="number" placeholder="Amount" />
                <button onclick="addCoins(${r.id})">Add</button>
            </td>
            <td>
                <button onclick="deleteRider(${r.id})">Delete</button>
            </td>
        `;
        table.appendChild(tr);
    });
}

async function addRider() {
    const name = document.getElementById("riderName").value;
    const phone = document.getElementById("riderPhone").value;
    const username = document.getElementById("riderUsername").value;
    const password = document.getElementById("riderPassword").value;

    const res = await fetch(`${API}/riders`, {
        method: "POST",
        headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify({ name, phone, username, password })
    });

    const data = await res.json();
    if (!res.ok) return alert(data.message);

    alert("Rider added!");
    loadRiders();
    loadAssignRiders();
}

async function addCoins(id) {
    const coins = Number(document.getElementById(`coin${id}`).value);
    if (!coins) return alert("Enter amount");

    const res = await fetch(`${API}/riders/${id}/coins`, {
        method: "POST",
        headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify({ coins })
    });

    loadRiders();
}

async function deleteRider(id) {
    if (!confirm("Delete rider?")) return;

    await fetch(`${API}/riders/${id}`, {
        method: "DELETE",
        headers: { "Authorization": "Bearer " + token }
    });

    loadRiders();
    loadAssignRiders();
}

/* -------------------------------------------------------
   LOAD RIDERS FOR MANUAL ASSIGN SELECT
------------------------------------------------------- */
async function loadAssignRiders() {
    const res = await fetch(`${API}/riders`, {
        headers: { "Authorization": "Bearer " + token }
    });

    const riders = await res.json();
    const sel = document.getElementById("assignRider");

    sel.innerHTML = `<option value="">-- Optional: Assign Rider --</option>`;

    riders.forEach(r => {
        sel.innerHTML += `<option value="${r.id}">${r.name}</option>`;
    });
}

/* -------------------------------------------------------
   MANUAL ORDER CREATION (with Notes)
------------------------------------------------------- */
async function createOrder() {
    const customer_name = document.getElementById("custName").value;
    const customer_phone = document.getElementById("custPhone").value;
    const pickup = document.getElementById("pickup").value;
    const dropoff = document.getElementById("dropoff").value;
    const distance = Number(document.getElementById("distance").value);
    const fee = Number(document.getElementById("fee").value);
    const rider_id = document.getElementById("assignRider").value || null;
    const notes = document.getElementById("orderNotes").value;

    const res = await fetch(`${API}/orders/manual`, {
        method: "POST",
        headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify({ customer_name, customer_phone, pickup, dropoff, distance, fee, notes, rider_id })
    });

    const data = await res.json();
    if (!res.ok) return alert(data.message);

    alert("Order created!");
    loadOrders();
    loadHistory();
}

/* -------------------------------------------------------
   LOAD INCOMING ORDERS (Realtime)
------------------------------------------------------- */
async function loadOrders() {
    const res = await fetch(`${API}/orders`, {
        headers: { "Authorization": "Bearer " + token }
    });

    if (!res.ok) return;
    const orders = await res.json();

    const table = document.getElementById("incomingOrdersTable");
    table.innerHTML = `
        <tr>
            <th>ID</th>
            <th>Customer</th>
            <th>Pickup</th>
            <th>Dropoff</th>
            <th>Fee</th>
            <th>Notes</th>
            <th>Status</th>
            <th>Rider</th>
            <th>Actions</th>
        </tr>
    `;

    orders.filter(o => o.status !== "Delivered")
          .sort((a,b) => b.id - a.id)
          .forEach(o => {
        const tr = document.createElement("tr");

        tr.innerHTML = `
            <td>${o.id}</td>
            <td>${o.customer_name || "N/A"}<br>${o.customer_phone || ""}</td>
            <td>${o.pickup}</td>
            <td>${o.dropoff}</td>
            <td>₱${o.fee}</td>
            <td>${o.notes || "None"}</td>
            <td>${o.status}</td>
            <td>${o.rider_id ? "#" + o.rider_id : "--"}</td>
            <td>
                <button onclick="markDelivered(${o.id})">Delivered</button>
                <button onclick="deleteOrder(${o.id})">Delete</button>
            </td>
        `;

        table.appendChild(tr);
    });
}

/* -------------------------------------------------------
   LOAD HISTORY (Delivered Only)
------------------------------------------------------- */
async function loadHistory() {
    const res = await fetch(`${API}/orders`, {
        headers: { "Authorization": "Bearer " + token }
    });

    if (!res.ok) return;
    const orders = await res.json();

    const table = document.getElementById("historyOrdersTable");
    table.innerHTML = `
        <tr>
            <th>ID</th>
            <th>Customer</th>
            <th>Pickup</th>
            <th>Dropoff</th>
            <th>Fee</th>
            <th>Notes</th>
            <th>Rider</th>
        </tr>
    `;

    orders.filter(o => o.status === "Delivered")
          .sort((a,b)=> b.id - a.id)
          .forEach(o => {
        const tr = document.createElement("tr");
        tr.innerHTML = `
            <td>${o.id}</td>
            <td>${o.customer_name}</td>
            <td>${o.pickup}</td>
            <td>${o.dropoff}</td>
            <td>₱${o.fee}</td>
            <td>${o.notes || "None"}</td>
            <td>${o.rider_id ? "#" + o.rider_id : "--"}</td>
        `;
        table.appendChild(tr);
    });
}

/* -------------------------------------------------------
   ORDER ACTIONS
------------------------------------------------------- */
async function markDelivered(id) {
    await fetch(`${API}/orders/${id}/complete`, {
        method: "POST",
        headers: { "Authorization": "Bearer " + token }
    });

    loadOrders();
    loadHistory();
}

async function deleteOrder(id) {
    if (!confirm("Delete order?")) return;

    await fetch(`${API}/orders/${id}`, {
        method: "DELETE",
        headers: { "Authorization": "Bearer " + token }
    });

    loadOrders();
    loadHistory();
}

/* -------------------------------------------------------
   AUTO REFRESH
------------------------------------------------------- */
setInterval(() => {
    if (token) {
        loadOrders();
        loadHistory();
    }
}, 3000);
