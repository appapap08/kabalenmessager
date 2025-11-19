/* ============================================================
   client.js — Clean version (CHAT REMOVED)
   Compatible with your kabalen.js backend
============================================================ */

const API = "http://192.168.100.8:10000";
const API_URL = API;
const NOMINATIM_SEARCH = "https://nominatim.openstreetmap.org/search";
const NOMINATIM_REVERSE = "https://nominatim.openstreetmap.org/reverse";
const NOMINATIM_HEADERS = { "Accept": "application/json" };

/* ----------------- utilities ----------------- */
function debounce(fn, ms = 300) { let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); }; }
function throttle(fn, ms = 200) { let last = 0; return (...args) => { const now = Date.now(); if (now - last >= ms) { last = now; fn(...args); } }; }
function toRad(v) { return v * Math.PI / 180; }
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2)) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

/* -------------- map & tracking state ------------- */
let orderMap = null;
let pickupMarker = null;
let dropoffMarker = null;
let routeLine = null;
let lastPickup = null;
let lastDropoff = null;

/* --------------- rider info cache --------------- */
const RIDER_CACHE = {}; // riderId -> { id, name, phone }

/* ---------------- map icons ---------------- */
const riderIcon = L.icon({ iconUrl: "rider.gif", iconSize: [40,40], iconAnchor: [20,20] });
const clientIcon = L.icon({ iconUrl: "client-pin.png", iconSize: [32,32], iconAnchor: [16,32] });

/* ---------------- order service ---------------- */
let selectedService = 'food';
function chooseService(type) { 
  selectedService = type; 
  hideAllScreens();
  document.getElementById('orderScreen').style.display = 'block';
  initOrderMap();
  setupOrderAutocomplete();
}

/* --------------- fee formula --------------- */
function computeFeeForService(distanceKm) {
  if (isNaN(distanceKm)) return null;
  if (selectedService === 'food') {
    if (distanceKm <= 10) return 200;
    return Math.round(200 + (distanceKm - 10) * 20);
  }
  if (selectedService === 'wheels3') {
    if (distanceKm <= 5) return 50;
    return Math.round(50 + (distanceKm - 5) * 10);
  }
  if (selectedService === 'wheels4') {
    if (distanceKm <= 5) return 200;
    return Math.round(200 + (distanceKm - 5) * 25);
  }
  return Math.round(25 + distanceKm * 10);
}

/* --------------- map init --------------- */
function initOrderMap() {
  if (orderMap) return;
  orderMap = L.map('orderMap', { zoomControl: true }).setView([11.0, 122.0], 12);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(orderMap);
  routeLine = L.polyline([], { color: '#007bff', weight: 4, opacity: 0.85 }).addTo(orderMap);

  orderMap.on('click', (e) => setPickup(e.latlng.lat, e.latlng.lng, true));
}

/* --------------- pickup marker --------------- */
function setPickup(lat, lng, reverseFill = true) {
  initOrderMap();
  if (!pickupMarker) {
    pickupMarker = L.marker([lat, lng], { draggable: true })
      .addTo(orderMap)
      .bindPopup('Pickup (drag to adjust)').openPopup();
    pickupMarker.on('drag', throttle(updateRouteAndUI, 200));
    pickupMarker.on('dragend', async () => {
      const p = pickupMarker.getLatLng();
      const name = await reverseGeocode(p.lat, p.lng).catch(()=>null);
      document.getElementById('orderPickup').value = name || `${p.lat},${p.lng}`;
      lastPickup = { lat: p.lat, lng: p.lng, display_name: name || '' };
      updateRouteAndUI();
    });
  } else pickupMarker.setLatLng([lat, lng]);

  if (reverseFill) {
    reverseGeocode(lat, lng).then(name => {
      if (name) document.getElementById('orderPickup').value = name;
      lastPickup = { lat, lng, display_name: name || '' };
      updateRouteAndUI();
    });
  } else lastPickup = { lat, lng, display_name: '' };

  orderMap.setView([lat, lng], 14);
}

/* --------------- dropoff marker --------------- */
function setDropoff(lat, lng, reverseFill = true) {
  initOrderMap();
  if (!dropoffMarker) {
    dropoffMarker = L.marker([lat, lng], { draggable: true })
      .addTo(orderMap)
      .bindPopup('Drop-off (drag to adjust)').openPopup();
    dropoffMarker.on('drag', throttle(updateRouteAndUI, 200));
    dropoffMarker.on('dragend', async () => {
      const p = dropoffMarker.getLatLng();
      const name = await reverseGeocode(p.lat, p.lng).catch(()=>null);
      document.getElementById('orderDropoff').value = name || `${p.lat},${p.lng}`;
      lastDropoff = { lat: p.lat, lng: p.lng, display_name: name || '' };
      updateRouteAndUI();
    });
  } else dropoffMarker.setLatLng([lat, lng]);

  if (reverseFill) {
    reverseGeocode(lat, lng).then(name => {
      if (name) document.getElementById('orderDropoff').value = name;
      lastDropoff = { lat, lng, display_name: name || '' };
      updateRouteAndUI();
    });
  } else lastDropoff = { lat, lng, display_name: '' };

  if (lastPickup) 
    orderMap.fitBounds([[lastPickup.lat,lastPickup.lng],[lat,lng]],{padding:[50,50]});
  else orderMap.setView([lat,lng], 14);
}

/* --------------- route + UI update --------------- */
const debouncedUpdateDistance = debounce(() => {
  if (!lastPickup || !lastDropoff) {
    document.getElementById('orderDistance').value = '';
    document.getElementById('orderFee').value = '';
    return;
  }
  const km = haversineKm(lastPickup.lat, lastPickup.lng, lastDropoff.lat, lastDropoff.lng);
  const rounded = Math.round(km * 10) / 10;
  document.getElementById('orderDistance').value = rounded;
  document.getElementById('orderFee').value = computeFeeForService(rounded);
}, 250);

function updateRouteAndUI() {
  if (pickupMarker) lastPickup = pickupMarker.getLatLng();
  if (dropoffMarker) lastDropoff = dropoffMarker.getLatLng();
  const pts = [];
  if (lastPickup) pts.push([lastPickup.lat,lastPickup.lng]);
  if (lastDropoff) pts.push([lastDropoff.lat,lastDropoff.lng]);
  routeLine.setLatLngs(pts);
  debouncedUpdateDistance();
}

/* --------------- Nominatim --------------- */
async function nominatimSearch(q, limit = 6) {
  if (!q) return [];
  const res = await fetch(`${NOMINATIM_SEARCH}?q=${encodeURIComponent(q)}&format=json&addressdetails=1&limit=${limit}`,{headers:NOMINATIM_HEADERS});
  if (!res.ok) return [];
  return res.json();
}
async function reverseGeocode(lat, lon) {
  const res = await fetch(`${NOMINATIM_REVERSE}?lat=${lat}&lon=${lon}&format=json`,{headers:NOMINATIM_HEADERS});
  if (!res.ok) return '';
  const data = await res.json();
  return data.display_name || '';
}

/* --------------- autocomplete --------------- */
function renderSuggestions(id, places, onPick) {
  const el = document.getElementById(id);
  if (!el) return;
  el.innerHTML = '';
  if (!places.length) { el.style.display='none'; return; }
  places.forEach(p=>{
    const d=document.createElement('div');
    d.className='suggestion-item';
    d.textContent=p.display_name;
    d.onclick=()=>onPick(p);
    el.appendChild(d);
  });
  el.style.display='block';
}

function attachAutocomplete(inputId, suggestionsId, cbPick) {
  const input = document.getElementById(inputId);
  const sugg = document.getElementById(suggestionsId);
  if (!input || !sugg) return;

  document.addEventListener('click',e=>{
    if (!sugg.contains(e.target) && e.target!==input) sugg.style.display='none';
  });

  const doSearch = debounce(async ()=>{
    const q=input.value.trim();
    if (!q) return renderSuggestions(suggestionsId,[]);
    const places=await nominatimSearch(q);
    renderSuggestions(suggestionsId,places,p=>{
      input.value=p.display_name;
      sugg.style.display='none';
      cbPick(p);
    });
  },350);

  input.addEventListener('input',doSearch);
}

function setupOrderAutocomplete() {
  attachAutocomplete('orderPickup','pickupSuggestions', p=>{
    lastPickup={lat:+p.lat,lng:+p.lon,display_name:p.display_name};
    setPickup(lastPickup.lat,lastPickup.lng,false);
    updateRouteAndUI();
  });

  attachAutocomplete('orderDropoff','dropoffSuggestions', p=>{
    lastDropoff={lat:+p.lat,lng:+p.lon,display_name:p.display_name};
    setDropoff(lastDropoff.lat,lastDropoff.lng,false);
    updateRouteAndUI();
  });
}

/* ----------- Fetch Rider public info ----------- */
async function fetchRiderInfo(riderId) {
  if (!riderId) return null;
  if (RIDER_CACHE[riderId]) return RIDER_CACHE[riderId];

  const token = localStorage.getItem('client_token') || '';
  const headers = token ? {'Authorization':'Bearer '+token}:{};

  const urls = [
    `${API_URL}/riders/public/${riderId}`,
    `${API_URL}/riders/${riderId}`
  ];

  for (const url of urls) {
    try {
      const res = await fetch(url, {headers});
      if (!res.ok) continue;
      const data = await res.json();
      const info = { id:riderId, name:data.name||'', phone:data.phone||'' };
      RIDER_CACHE[riderId]=info;
      return info;
    } catch {}
  }

  return {id:riderId,name:`Rider #${riderId}`,phone:null};
}

/* --------------- Submit order --------------- */
async function submitOrder() {
  const pickup = document.getElementById('orderPickup').value.trim();
  const dropoff = document.getElementById('orderDropoff').value.trim();
  const dist = Number(document.getElementById('orderDistance').value);
  const fee = Number(document.getElementById('orderFee').value);
  const notes = document.getElementById('orderNotes').value || '';

  if (!pickup || !dropoff || !dist || !fee) return alert('Complete pickup and dropoff.');

  const token = localStorage.getItem('client_token');
  if (!token) return alert('Login first.');

  const body = { pickup, dropoff, distance:dist, fee, notes, type:selectedService };
  if (lastPickup) { body.pickup_lat=lastPickup.lat; body.pickup_lng=lastPickup.lng; }
  if (lastDropoff) { body.dropoff_lat=lastDropoff.lat; body.dropoff_lng=lastDropoff.lng; }

  const res = await fetch(`${API_URL}/clients/orders`, {
    method:'POST',
    headers:{'Authorization':'Bearer '+token,'Content-Type':'application/json'},
    body:JSON.stringify(body)
  });

  const data = await res.json().catch(()=>null);
  if (!res.ok) return alert(data?.message || 'Order failed');

  alert('Order placed!');
  document.getElementById('orderPickup').value='';
  document.getElementById('orderDropoff').value='';
  document.getElementById('orderDistance').value='';
  document.getElementById('orderFee').value='';
  document.getElementById('orderNotes').value='';

  lastPickup = lastDropoff = null;

  if (pickupMarker) { orderMap.removeLayer(pickupMarker); pickupMarker=null; }
  if (dropoffMarker) { orderMap.removeLayer(dropoffMarker); dropoffMarker=null; }
  if (routeLine) routeLine.setLatLngs([]);

  backToDashboard();
  fetchOrders();
}

/* --------------- Load My Orders --------------- */
async function fetchOrders() {
  const token = localStorage.getItem('client_token');
  if (!token) return showLogin();
  const list = document.getElementById('ordersList');
  if (list) list.innerHTML='<p>Loading…</p>';

  try {
    const res = await fetch(`${API_URL}/clients/orders`,{
      headers:{'Authorization':'Bearer '+token}
    });
    if (!res.ok) {
      if (list) list.innerHTML='<p>Unable to load.</p>';
      return;
    }

    const orders = await res.json();
    if (!list) return;
    list.innerHTML='';

    if (!orders.length) {
      list.innerHTML='<p>No orders.</p>';
      return;
    }

    const sorted = orders.slice().sort((a,b)=>b.id-a.id);

    for (const o of sorted) {
      const div = document.createElement('div');
      div.className='order-card';

      const riderId = o.rider_id || o.assigned_rider_id || null;
      let riderHtml = '';
      if (riderId) {
        riderHtml = `
          <div class="rider-box" id="rider-box-${o.id}">
            <b>Rider:</b> #${riderId}<br>
            <b>Phone:</b> —
          </div>`;
      }

      const trackBtn = (o.rider_id && ['Accepted','Picked'].includes(o.status))
        ? `<button class="btn" onclick="openTrackMap(${o.id})">Track Rider</button>`
        : '';

      div.innerHTML=`
        <div class="order-title">Order #${o.id}</div>
        <div class="order-info"><b>Status:</b> ${o.status}</div>
        <div class="order-info"><b>Service:</b> ${o.type||''}</div>
        <div class="order-info"><b>Pickup:</b> ${o.pickup}</div>
        <div class="order-info"><b>Dropoff:</b> ${o.dropoff}</div>
        <div class="order-info"><b>Fee:</b> ₱${o.fee}</div>
        <div class="order-info"><b>Notes:</b> ${o.notes||'None'}</div>
        ${riderHtml}
        ${trackBtn}
      `;
      list.appendChild(div);

      // load rider details
      if (riderId) {
        const info = await fetchRiderInfo(riderId);
        const box = document.getElementById(`rider-box-${o.id}`);
        if (box) {
          box.innerHTML = `
            <b>Rider:</b> ${info.name}<br>
            <b>Phone:</b> ${info.phone ? `<a href="tel:${info.phone}">${info.phone}</a>` : "—"}
          `;
        }
      }
    }

  } catch (err) {
    console.error(err);
    if (list) list.innerHTML='<p>Error loading orders.</p>';
  }
}

/* ---------------- Tracking Map ---------------- */
let trackMap = null;
let trackRiderMarker = null;
let trackPollTimer = null;

function initTrackMapIfNeeded() {
  if (trackMap) return;
  trackMap = L.map('trackMap',{zoomControl:true}).setView([11,122],12);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19}).addTo(trackMap);
}

async function fetchAndShowRider(orderId) {
  const res = await fetch(`${API_URL}/orders/${orderId}/rider-location`);
  if (!res.ok) return;
  const data = await res.json();
  if (!data.lat || !data.lng) return;

  const lat = +data.lat, lng = +data.lng;
  initTrackMapIfNeeded();

  if (!trackRiderMarker) {
    trackRiderMarker = L.marker([lat,lng],{icon:riderIcon}).addTo(trackMap);
    trackMap.setView([lat,lng],15);
  } else {
    trackRiderMarker.setLatLng([lat,lng]);
  }
}

function openTrackMap(orderId) {
  hideAllScreens();
  document.getElementById('trackingScreen').style.display='block';
  initTrackMapIfNeeded();
  if (trackRiderMarker) trackMap.removeLayer(trackRiderMarker);
  trackRiderMarker=null;
  if (trackPollTimer) clearInterval(trackPollTimer);
  fetchAndShowRider(orderId);
  trackPollTimer=setInterval(()=>fetchAndShowRider(orderId),3000);
}

function closeTrackMap() {
  if (trackPollTimer) clearInterval(trackPollTimer);
  hideAllScreens();
  document.getElementById('dashboardScreen').style.display='block';
}

/* ---------------- Auth / Profile ---------------- */
function saveClientLocation() {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(pos=>{
    localStorage.setItem('client_lat',pos.coords.latitude);
    localStorage.setItem('client_lng',pos.coords.longitude);
  });
}

async function clientLogin() {
  const u=document.getElementById("loginUsername").value.trim();
  const p=document.getElementById("loginPassword").value.trim();
  const loading=document.getElementById("loginLoading");

  if (!u || !p) return alert("Enter username & password");
  if (loading) loading.style.display="block";

  const res = await fetch(`${API_URL}/clients/login`,{
    method:'POST', headers:{'Content-Type':'application/json'},
    body:JSON.stringify({username:u,password:p})
  });
  const data = await res.json();

  if (loading) loading.style.display="none";
  if (!res.ok) return alert(data.message||"Login failed");

  localStorage.setItem('client_token',data.token);
  localStorage.setItem('client_id',data.client.id);
  localStorage.setItem('client_name',data.client.fullname);
  localStorage.setItem('client_phone',data.client.phone);
  localStorage.setItem('client_address',data.client.address);
  localStorage.setItem('client_username',data.client.username);
  localStorage.setItem('client_validId',data.client.validId);
  localStorage.setItem('client_selfie',data.client.selfie);

  document.getElementById('clientName').textContent=data.client.fullname;

  saveClientLocation();
  hideAllScreens();
  document.getElementById('dashboardScreen').style.display='block';
  initOrderMap();
  setupOrderAutocomplete();
  fetchOrders();
}

async function registerClient() {
  const fullname=document.getElementById('regFullname').value;
  const address=document.getElementById('regAddress').value;
  const phone=document.getElementById('regPhone').value;
  const username=document.getElementById('regUsername').value;
  const password=document.getElementById('regPassword').value;
  const validId=document.getElementById('regValidId').files[0];
  const selfie=document.getElementById('regSelfie').files[0];

  if (!fullname||!address||!phone||!username||!password||!validId||!selfie)
    return alert("Complete all fields");

  const fd=new FormData();
  fd.append('fullname',fullname);
  fd.append('address',address);
  fd.append('phone',phone);
  fd.append('username',username);
  fd.append('password',password);
  fd.append('validId',validId);
  fd.append('selfie',selfie);

  const res=await fetch(`${API_URL}/clients/register`,{method:'POST',body:fd});
  const data=await res.json();
  if (!res.ok) return alert(data.message||"Register failed");

  alert("Registration successful! You may login now.");
  showLogin();
}

function loadProfile() {
  document.getElementById('profileFullname').value = localStorage.getItem('client_name')||'';
  document.getElementById('profilePhone').value = localStorage.getItem('client_phone')||'';
  document.getElementById('profileAddress').value = localStorage.getItem('client_address')||'';
  document.getElementById('profileUsername').value = localStorage.getItem('client_username')||'';

  const vid=localStorage.getItem('client_validId');
  const sef=localStorage.getItem('client_selfie');
  if (vid) document.getElementById('profileValidId').src=`${API_URL}/uploads/${vid}`;
  if (sef) document.getElementById('profileSelfie').src=`${API_URL}/uploads/${sef}`;
}

function saveProfile() {
  localStorage.setItem('client_phone',document.getElementById('profilePhone').value);
  localStorage.setItem('client_address',document.getElementById('profileAddress').value);
  alert("Profile saved");
  backToDashboard();
}

function logoutClient() {
  if (trackPollTimer) clearInterval(trackPollTimer);
  localStorage.clear();
  hideAllScreens();
  showLogin();
}

/* --------------- UI Navigation ---------------- */
function hideAllScreens() { document.querySelectorAll('section').forEach(s=>s.style.display='none'); }
function showLogin() { hideAllScreens(); document.getElementById('loginScreen').style.display='block'; }
function showRegister() { hideAllScreens(); document.getElementById('registerScreen').style.display='block'; }
function backToDashboard() { hideAllScreens(); document.getElementById('dashboardScreen').style.display='block'; }
function newOrder() { hideAllScreens(); document.getElementById('serviceSelectScreen').style.display='block'; }
function openProfile() { hideAllScreens(); document.getElementById('profileScreen').style.display='block'; loadProfile(); }
function loadMyOrders() { hideAllScreens(); document.getElementById('ordersScreen').style.display='block'; fetchOrders(); }

/* --------------- INIT ---------------- */
document.addEventListener('DOMContentLoaded', () => {
  const token = localStorage.getItem('client_token');
  if (token) {
    document.getElementById('clientName').textContent = localStorage.getItem('client_name') || '';
    hideAllScreens();
    document.getElementById('dashboardScreen').style.display='block';
    initOrderMap();
    setupOrderAutocomplete();
    fetchOrders();
  } else showLogin();

  setupOrderAutocomplete();
});
