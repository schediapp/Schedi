// Public sample booking page at /demo.
// Visitors pick a service and a time. Confirm does not create a booking.
// The only way forward is the signup link, which carries ?ref=demo.

export const DEMO_PATH = "/demo";
export const DEMO_SCRIPT_PATH = "/demo-booking.js";
export const DEMO_SIGNUP_HREF = "/signup?ref=demo";

export const DEMO_SERVICES = [
  { id: "cut", name: "Classic cut", mins: 45, price: 35, blurb: "Scissor cut and a clean finish." },
  { id: "beard", name: "Beard trim", mins: 20, price: 18, blurb: "Shape and a clean lineup." },
  { id: "both", name: "Cut and beard", mins: 60, price: 48, blurb: "A cut plus a beard trim." },
] as const;

export function renderDemoBookingScript(): string {
  const services = JSON.stringify(DEMO_SERVICES);
  const signup = JSON.stringify(DEMO_SIGNUP_HREF);
  return `(function(){
var SERVICES = ${services};
var SIGNUP = ${signup};
var OPEN_START = 9 * 60;
var OPEN_END = 17 * 60;
var STEP = 30;

function esc(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, function (ch) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\\"": "&quot;", "'": "&#39;" }[ch];
  });
}

function isoDate(date) {
  return date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0") + "-" + String(date.getDate()).padStart(2, "0");
}

function parseIso(iso) {
  var parts = String(iso || "").split("-");
  return new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
}

function closedDay(date) {
  var day = date.getDay();
  return day === 0 || day === 1;
}

function openDays(now, count) {
  var days = [];
  var cursor = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  var i;
  for (i = 0; i < 28 && days.length < count; i++) {
    var day = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + i);
    if (!closedDay(day)) days.push(isoDate(day));
  }
  return days;
}

function formatTime(mins) {
  var h = Math.floor(mins / 60);
  var m = mins % 60;
  var ampm = h >= 12 ? "PM" : "AM";
  var h12 = h % 12 === 0 ? 12 : h % 12;
  return String(h12).padStart(2, "0") + ":" + String(m).padStart(2, "0") + " " + ampm;
}

function timesFor(iso, duration, now) {
  var day = parseIso(iso);
  if (isNaN(day.getTime()) || closedDay(day)) return [];
  var today = isoDate(now);
  var nowMins = now.getHours() * 60 + now.getMinutes();
  var out = [];
  var t;
  for (t = OPEN_START; t + duration <= OPEN_END; t += STEP) {
    if (iso === today && t <= nowMins) continue;
    out.push(formatTime(t));
  }
  return out;
}

function dayLabel(iso) {
  return parseIso(iso).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

function findService(id) {
  var i;
  for (i = 0; i < SERVICES.length; i++) if (SERVICES[i].id === id) return SERVICES[i];
  return SERVICES[0];
}

function money(price) {
  return "$" + String(price);
}

var state = { step: "service", serviceId: "", date: "", time: "" };

function paintSteps(root) {
  var steps = root.querySelectorAll("[data-step]");
  var i;
  for (i = 0; i < steps.length; i++) {
    if (steps[i].getAttribute("data-step") === state.step) steps[i].setAttribute("aria-current", "step");
    else steps[i].removeAttribute("aria-current");
  }
}

function serviceHtml() {
  var cards = SERVICES.map(function (svc) {
    return '<button type="button" class="demo-choice" data-service="' + esc(svc.id) + '">' +
      '<span class="demo-choice-name">' + esc(svc.name) + '</span>' +
      '<span class="demo-choice-meta">' + esc(svc.mins + " min · " + money(svc.price)) + '</span>' +
      '<span class="demo-choice-blurb">' + esc(svc.blurb) + '</span>' +
      '</button>';
  }).join("");
  return '<p class="demo-kicker">1. Choose a service</p><div class="demo-list">' + cards + '</div>';
}

function timeHtml(now) {
  var svc = findService(state.serviceId);
  var days = openDays(now, 8);
  if (!state.date || days.indexOf(state.date) === -1) state.date = days[0] || "";
  var dayButtons = days.map(function (iso) {
    var on = iso === state.date ? " on" : "";
    return '<button type="button" class="demo-chip' + on + '" data-date="' + esc(iso) + '" aria-pressed="' + (iso === state.date ? "true" : "false") + '">' + esc(dayLabel(iso)) + '</button>';
  }).join("");
  var slots = state.date ? timesFor(state.date, svc.mins, now) : [];
  var times = slots.length
    ? slots.map(function (label) {
        return '<button type="button" class="demo-chip" data-time="' + esc(label) + '">' + esc(label) + '</button>';
      }).join("")
    : '<p class="demo-empty">No open times left this day. Pick another day.</p>';
  return '<p class="demo-kicker">2. Pick a day and time</p>' +
    '<p class="muted small">Fresh Cuts Studio is open Tuesday through Saturday, 9:00 AM to 5:00 PM, shown in your time zone. ' + esc(svc.name) + ' takes ' + esc(String(svc.mins)) + ' min.</p>' +
    '<div class="demo-days" role="list">' + dayButtons + '</div>' +
    '<div class="demo-times" role="list">' + times + '</div>' +
    '<button type="button" class="btn btn-ghost" data-back="service">Back to services</button>';
}

function confirmHtml() {
  var svc = findService(state.serviceId);
  var when = state.date ? dayLabel(state.date) : "";
  return '<p class="demo-kicker">3. Confirm</p>' +
    '<p class="demo-summary"><strong>' + esc(svc.name) + '</strong><br>' + esc(when) + ' · ' + esc(state.time) + ' · ' + esc(svc.mins + " min · " + money(svc.price)) + '</p>' +
    '<p>This sample stops here. Nothing is booked.</p>' +
    '<p>Create your own booking page to take appointments like this one.</p>' +
    '<div class="ctas">' +
    '<a class="btn btn-primary btn-lg" href="' + esc(SIGNUP) + '">Create your booking page</a>' +
    '<button type="button" class="btn btn-ghost btn-lg" data-back="time">Change the time</button>' +
    '</div>';
}

function render(root, panel) {
  paintSteps(root);
  var now = new Date();
  if (state.step === "time") panel.innerHTML = timeHtml(now);
  else if (state.step === "confirm") panel.innerHTML = confirmHtml();
  else panel.innerHTML = serviceHtml();
}

function attrFrom(node, panel, name) {
  while (node && node !== panel) {
    if (node.getAttribute && node.getAttribute(name)) return node.getAttribute(name);
    node = node.parentNode;
  }
  return "";
}

function boot() {
  var root = document.getElementById("demo-book");
  var panel = document.getElementById("demo-panel");
  if (!root || !panel) return;
  render(root, panel);
  panel.addEventListener("click", function (event) {
    var target = event.target;
    var serviceId = attrFrom(target, panel, "data-service");
    var date = attrFrom(target, panel, "data-date");
    var time = attrFrom(target, panel, "data-time");
    var back = attrFrom(target, panel, "data-back");
    if (serviceId) {
      state.serviceId = serviceId;
      state.date = "";
      state.time = "";
      state.step = "time";
    } else if (date) {
      state.date = date;
      state.time = "";
      state.step = "time";
    } else if (time) {
      state.time = time;
      state.step = "confirm";
    } else if (back === "service" || back === "time") {
      state.step = back;
      if (back === "service") state.time = "";
    } else {
      return;
    }
    render(root, panel);
  });
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else boot();
})();
`;
}
