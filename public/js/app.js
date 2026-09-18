(function () {
  "use strict";

  var hero = document.getElementById("hero");
  var grid = document.getElementById("events");
  var status = document.getElementById("status");
  var empty = document.getElementById("empty");
  var errorBox = document.getElementById("error");
  var errorMessage = document.getElementById("error-message");
  var template = document.getElementById("event-card");
  var QR_REFERENCE = "?utm_medium=public_screen&utm_source=BookshopSC";

  var LIMIT = 9;                 // 1 hero + 8 cards = two full rows of four
  var REFRESH_MS = 10 * 60 * 1000;
  var RETRY_MS = 60 * 1000;      // there is nothing to click on a display screen, so retry sooner after an error
  var refreshTimer = null;

  load();

  // ---------------------------------------------------------------------

  function load() {
    clearTimeout(refreshTimer);
    showSkeletons();
    errorBox.hidden = true;
    empty.hidden = true;
    status.textContent = "Loading upcoming events from events.ucsc.edu…";

    fetch("/api/upcoming-events?limit=" + LIMIT)
      .then(function (res) {
        return res.json().then(function (body) {
          if (!res.ok) throw new Error(body.error || "Request failed (" + res.status + ")");
          return body;
        });
      })
      .then(function (data) {
        render(data);
        refreshTimer = setTimeout(load, REFRESH_MS);
      })
      .catch(function (err) {
        hero.hidden = true;
        grid.innerHTML = "";
        grid.setAttribute("aria-busy", "false");
        status.textContent = "";
        errorMessage.textContent = err.message;
        errorBox.hidden = false;
        refreshTimer = setTimeout(load, RETRY_MS);
      });
  }

  function showSkeletons() {
    grid.setAttribute("aria-busy", "true");
    grid.innerHTML = "";
    for (var i = 0; i < 4; i++) {
      var node = template.content.cloneNode(true);
      node.querySelector(".card").classList.add("skeleton");
      node.querySelector(".card-img img").remove();
      node.querySelector(".qr").remove();
      node.querySelector("h3").textContent = "Loading";
      node.querySelector(".when").textContent = "Loading";
      node.querySelector(".where").textContent = "Loading";
      grid.appendChild(node);
    }
  }

  function render(data) {
    var events = data.events || [];
    grid.innerHTML = "";
    grid.setAttribute("aria-busy", "false");

    if (!events.length) {
      hero.hidden = true;
      empty.hidden = false;
      status.textContent = "";
      return;
    }

    status.textContent = " " + describeRange(data.range) + ".";

    renderHero(events[0]);
    events.slice(1).forEach(function (event) {
      grid.appendChild(buildCard(event));
    });
  }

  function renderHero(event) {
    var img = hero.querySelector(".hero-img");
    var image = img.querySelector("img");
    if (event.image && event.image.url) {
      image.src = event.image.url;
      image.hidden = false;
      img.classList.remove("is-empty");
    } else {
      image.removeAttribute("src");
      image.hidden = true;
      img.classList.add("is-empty");
    }

    hero.querySelector("#hero-title").textContent = event.title;

    fillWhen(hero.querySelector(".when"), event);
    fillWhere(hero.querySelector(".where"), event);
    fillQr(hero.querySelector(".qr"), event.url);

    hero.hidden = false;
  }

  function buildCard(event) {
    var node = template.content.cloneNode(true);
    var img = node.querySelector(".card-img");
    var image = img.querySelector("img");

    if (event.image && event.image.url) {
      image.src = event.image.url;
    } else {
      image.remove();
      img.classList.add("is-empty");
    }

    node.querySelector("h3").textContent = event.title;

    fillWhen(node.querySelector(".when"), event);
    fillWhere(node.querySelector(".where"), event);
    fillQr(node.querySelector(".qr"), event.url + QR_REFERENCE);

    return node;
  }

  // "Saturday, August 29, 2026" on one line, "4 to 9 p.m." on the next.
  function fillWhen(el, event) {
    el.innerHTML = "";
    if (!event.startDate) { el.remove(); return; }

    var start = parseLocal(event.startDate);
    var end = event.endDate ? parseLocal(event.endDate) : null;

    var time = document.createElement("time");
    time.dateTime = event.startDate.replace(" ", "T").slice(0, 16);
    time.textContent = start.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
    el.appendChild(time);

    var second;
    if (end && !sameDay(start, end)) {
      second = "Through " + end.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
    } else if (event.allDay) {
      second = "All day";
    } else {
      second = formatTimeRange(start, end);
    }
    el.appendChild(document.createElement("br"));
    el.appendChild(document.createTextNode(second));
  }

  function fillWhere(el, event) {
    el.innerHTML = "";
    var venue = event.isVirtual ? "Online event" : event.venue;
    if (!venue) { el.remove(); return; }
    el.appendChild(document.createTextNode(venue));
    if (event.address && !event.isVirtual) {
      var addr = document.createElement("span");
      addr.className = "addr";
      addr.textContent = event.address;
      el.appendChild(addr);
    }
  }

  function fillQr(el, url) {
    var svg = buildQrSvg(url);
    if (svg) {
      el.querySelector(".qr-code").innerHTML = svg;
    } else {
      el.remove();
    }
  }

  // QR code as inline SVG (qrcode-generator, vendored in js/vendor). Returns "" if it can't be built.
  function buildQrSvg(url) {
    if (typeof qrcode !== "function" || !url) return "";
    try {
      var qr = qrcode(0, "M"); // type 0 = pick the smallest version that fits
      qr.addData(url);
      qr.make();
      return qr.createSvgTag({ cellSize: 1, margin: 0, scalable: true });
    } catch (err) {
      return "";
    }
  }

  // Turn a Plausible date range ("7d", "day", "month", "12mo") into words.
  function describeRange(range) {
    var m;
    if (range === "day") return "today";
    if (range === "month") return "this month";
    if (range === "year") return "this year";
    if ((m = /^(\d+)d$/.exec(range))) return m[1] === "1" ? "over the last day" : "over the last " + m[1] + " days";
    if ((m = /^(\d+)mo$/.exec(range))) return m[1] === "1" ? "over the last month" : "over the last " + m[1] + " months";
    return "";
  }

  // "4 to 9 p.m.", "10 a.m. to 2 p.m.", "6:30 p.m."
  function formatTimeRange(start, end) {
    if (!end || end.getTime() === start.getTime()) return formatClock(start, true);
    var sameMeridiem = (start.getHours() < 12) === (end.getHours() < 12);
    return formatClock(start, !sameMeridiem) + " to " + formatClock(end, true);
  }

  function formatClock(d, withMeridiem) {
    var h = d.getHours(), m = d.getMinutes();
    var hour12 = h % 12 || 12;
    var text = m ? hour12 + ":" + (m < 10 ? "0" : "") + m : String(hour12);
    if (!withMeridiem) return text;
    if (h === 12 && !m) return "noon";
    if (h === 0 && !m) return "midnight";
    return text + (h < 12 ? " a.m." : " p.m.");
  }

  // Dates from the Events Calendar arrive as "YYYY-MM-DD HH:MM:SS" in campus time.
  function parseLocal(str) {
    var p = str.split(/[- :]/).map(Number);
    return new Date(p[0], p[1] - 1, p[2], p[3] || 0, p[4] || 0);
  }

  function sameDay(a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  }
})();
