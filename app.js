import {
  AIRPORTS,
  KVEL_BLOCKS,
  WEATHER_REGIMES,
  INITIAL_FLIGHTS,
  PASSENGER_QUEUE,
  DYNAMIC_SCENARIOS
} from "./data.js";
import { PlayClock, advanceSurfaceDeparture, departureNeeds, divertFlight, holdDeparture, isDeparture, releaseFlight, updateReleases } from "./dispatch.js";
import { renderDispatchDesk } from "./dispatch-desk.js";

// ============================================================================
// MODERN WEB GUIDANCE CONDITIONAL POLYFILLS & FALLBACKS
// ============================================================================
// Native controls have local fallbacks so the packaged simulator also runs offline.

// Dialog closedby="any" fallback (only when native closedBy is missing)
if (!("closedBy" in HTMLDialogElement.prototype)) {
  const outside = (e, dialog) => {
    const r = dialog.getBoundingClientRect();
    return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
  };
  for (const dialog of document.querySelectorAll('dialog[closedby="any"]')) {
    let pressedOutside = false;
    dialog.addEventListener("pointerdown", (e) => {
      pressedOutside = outside(e, dialog);
    });
    dialog.addEventListener("pointerup", (e) => {
      if (pressedOutside && outside(e, dialog)) dialog.close();
    });
  }
}

// ============================================================================
// SIMULATION STATE
// ============================================================================
function initialFleet(activeRwy = WEATHER_REGIMES[0].activeRwy) {
  return INITIAL_FLIGHTS.map(f => ({
    ...f, pos: { ...f.pos },
    blockId: f.blockId === "RNAV-35-FINAL" && activeRwy === "17" ? "FINAL-17" : f.blockId,
    parkedAt: ["PARKED", "BOARDING"].includes(f.state) ? f.origin : null
  }));
}

const playClock = new PlayClock();
const state = {
  simMinutes: 7 * 60 + 5, // 07:05 MST
  speed: 1,
  role: "armchair", // armchair | dispatcher | fbo | tsa | pilot
  view: "split", // split | kvel | basin
  surfaceDetail: true,
  weatherId: "inversion_fog",
  radioPopupsEnabled: true,
  selectedFlightId: "VTE3101",
  blocks: KVEL_BLOCKS.map((b) => ({ ...b })),
  flights: initialFleet(),
  passengers: PASSENGER_QUEUE.map((p) => ({ ...p })),
  radioLog: [],
  rwyClosedTicks: 0,
  rwyCloseReason: "",
  tickCount: 0,
  scenarioIndex: 0,
  nextCrewMinute: 7 * 60 + 6,
  lastFocusedBeforeToast: null
};

const activeToasts = [];
let toastIdSeq = 0;

// ============================================================================
// DOM REFERENCES
// ============================================================================
const dom = {
  simClock: document.getElementById("simClock"),
  airportConditions: document.getElementById("airportConditions"),
  metarText: document.getElementById("metarText"),
  methaneBadge: document.getElementById("methaneBadge"),
  weatherSelect: document.getElementById("weatherSelect"),
  radioPopupsToggle: document.getElementById("radioPopupsToggle"),
  diagramsContainer: document.getElementById("diagramsContainer"),
  kvelSchematicBox: document.getElementById("kvelSchematicBox"),
  basinRadarBox: document.getElementById("basinRadarBox"),
  kvelSvg: document.getElementById("kvelSvg"),
  basinSvg: document.getElementById("basinSvg"),
  surfaceExtent: document.getElementById("surfaceExtent"),
  dispatchMapLabel: document.getElementById("dispatchMapLabel"),
  flightTableBody: document.getElementById("flightTableBody"),
  opsCountBadge: document.getElementById("opsCountBadge"),
  rolePanelTitle: document.getElementById("rolePanelTitle"),
  roleAiBadge: document.getElementById("roleAiBadge"),
  roleDeskBody: document.getElementById("roleDeskBody"),
  dispatchPanel: document.getElementById("dispatchPanel"),
  workspace: document.querySelector(".workspace-grid"),
  workstation: document.getElementById("workstation"),
  trafficDetails: document.getElementById("trafficDetails"),
  radioLogFeed: document.getElementById("radioLogFeed"),
  radioToastRegion: document.getElementById("radioToastRegion"),
  srAnnouncement: document.getElementById("srAnnouncement"),
  airportDialog: document.getElementById("airportDialog"),
  airportDirectoryList: document.getElementById("airportDirectoryList"),
  wxBriefingNote: document.getElementById("wxBriefingNote"),
  triggerScenarioBtn: document.getElementById("triggerScenarioBtn"),
  clearLogBtn: document.getElementById("clearLogBtn"),
  resetSimBtn: document.getElementById("resetSimBtn")
};

// ============================================================================
// HELPERS
// ============================================================================
function getWeather() {
  return WEATHER_REGIMES.find((w) => w.id === state.weatherId) || WEATHER_REGIMES[0];
}

function formatSimTime(totalMins) {
  const m = Math.floor(totalMins) % (24 * 60);
  const hh = String(Math.floor(m / 60)).padStart(2, "0");
  const mm = String(m % 60).padStart(2, "0");
  return `${hh}:${mm} MST`;
}

function getFlight(id) {
  return state.flights.find((f) => f.id === id);
}

function getBlock(id) {
  return state.blocks.find((b) => b.id === id);
}

function isAnyModalOpen() {
  return Boolean(document.querySelector("dialog:modal"));
}

function announceScreenReader(message) {
  if (typeof document.ariaNotify === "function") {
    document.ariaNotify(message);
  } else if (dom.srAnnouncement) {
    dom.srAnnouncement.textContent = "";
    requestAnimationFrame(() => {
      dom.srAnnouncement.textContent = message;
    });
  }
}

// ============================================================================
// RADIO COMMS & UNOBTRUSIVE POPOVER TOAST ENGINE (persistent-toast-notifications)
// ============================================================================
function positionRadioToasts() {
  let offset = 0;
  for (const { el } of [...activeToasts].reverse()) {
    el.style.setProperty("--toast-offset", offset + "px");
    offset += el.getBoundingClientRect().height + 8;
  }
}
const toastSizes = new ResizeObserver(positionRadioToasts);

function emitRadioCall({ freq, sender, message, isGuard = false, logOnly = false }) {
  const timeStr = formatSimTime(state.simMinutes);
  const entry = { id: ++toastIdSeq, timeStr, freq, sender, message, isGuard };
  state.radioLog.unshift(entry);
  if (state.radioLog.length > 50) state.radioLog.pop();
  renderRadioLog();

  // Suppress popups if user disabled them OR a modal dialog is open
  if (logOnly) {
    announceScreenReader(message);
    return;
  }
  if (!state.radioPopupsEnabled || isAnyModalOpen()) return;

  const toastId = `radio-toast-${entry.id}`;
  const toast = document.createElement("div");
  toast.id = toastId;
  toast.className = `radio-toast${isGuard || freq === "121.500" ? " toast-guard" : ""}`;
  // MANDATORY per persistent-toast-notifications: use setAttribute, never IDL .popover
  toast.setAttribute("popover", "manual");

  toast.innerHTML = `
    <div class="radio-toast-header">
      <span><span class="freq-chip">${freq} MHz</span> <strong>${escapeHtml(sender)}</strong> • ${timeStr}</span>
      <button type="button" class="radio-toast-close" popovertarget="${toastId}" popovertargetaction="hide" aria-label="Dismiss radio call from ${escapeHtml(sender)}">✕</button>
    </div>
    <div>"${escapeHtml(message)}"</div>
  `;

  dom.radioToastRegion.appendChild(toast);
  if (typeof toast.showPopover === "function") {
    try {
      toast.showPopover();
    } catch {
      toast.classList.add(":popover-open");
    }
  } else {
    toast.classList.add(":popover-open");
  }

  announceScreenReader(`${sender} on ${freq} megahertz: ${message}`);

  const record = { id: toastId, el: toast, timer: null };
  activeToasts.push(record);
  toastSizes.observe(toast);

  // Keep max 3 simultaneous unobtrusive popups
  while (activeToasts.length > 3) {
    dismissToast(activeToasts[0], false);
  }

  const closeBtn = toast.querySelector(".radio-toast-close");
  closeBtn.addEventListener("click", () => {
    const wasFocused = toast.contains(document.activeElement);
    dismissToast(record, wasFocused);
  });

  // Auto-dismiss after 9s unless user focuses inside toast
  const scheduleDismiss = () => {
    clearTimeout(record.timer);
    record.timer = setTimeout(() => {
      if (toast.contains(document.activeElement)) {
        // Pause dismissal while focused inside toast
        toast.addEventListener("focusout", () => scheduleDismiss(), { once: true });
      } else {
        dismissToast(record, false);
      }
    }, isGuard ? 13000 : 9000);
  };
  scheduleDismiss();
}

function dismissToast(record, manageFocus) {
  const idx = activeToasts.indexOf(record);
  if (idx === -1) return;
  clearTimeout(record.timer);
  activeToasts.splice(idx, 1);

  if (typeof record.el.hidePopover === "function") {
    try {
      record.el.hidePopover();
    } catch {
      record.el.classList.remove(":popover-open");
    }
  }
  toastSizes.unobserve(record.el);
  record.el.remove();
  positionRadioToasts();

  if (manageFocus) {
    if (activeToasts.length > 0) {
      const nextBtn = activeToasts[Math.min(idx, activeToasts.length - 1)].el.querySelector(".radio-toast-close");
      nextBtn?.focus();
    } else if (state.lastFocusedBeforeToast instanceof HTMLElement) {
      state.lastFocusedBeforeToast.focus();
    }
  }
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// ============================================================================
// DLR SIGNALLING BLOCK OCCUPANCY SYNC
// ============================================================================
function syncSignallingBlocks() {
  for (const b of state.blocks) {
    b.status = "clear";
    b.occupant = null;
  }

  // Runway wildlife / snow sweep closure
  if (state.rwyClosedTicks > 0) {
    for (const id of ["RWY-35-THR", "RWY-MID", "RWY-17-THR"]) {
      const b = getBlock(id);
      if (b) {
        b.status = "closed";
        b.occupant = state.rwyCloseReason || "OPS-1 SWEEP";
      }
    }
  }

  // Assign aircraft to KVEL surface/pattern blocks
  for (const f of state.flights) {
    if (!f.blockId) continue;
    const b = getBlock(f.blockId);
    if (!b) continue;
    if (b.status === "closed" && b.type === "runway") continue;
    b.status = f.state === "APPROACH" || f.state === "HOLD_SHORT" ? "reserved" : "occupied";
    b.occupant = f.id;
  }

  // Reserve runway if any flight is on final approach or holding short
  const rwyBusy = state.flights.some((f) => ["TAKEOFF", "LANDING"].includes(f.state));
  const rwyApproach = state.flights.some((f) => ["RNAV-35-FINAL", "FINAL-17", "HS-35", "HS-17"].includes(f.blockId));
  if (!rwyBusy && rwyApproach && state.rwyClosedTicks <= 0) {
    const activeThr = getWeather().activeRwy === "17" ? "RWY-17-THR" : "RWY-35-THR";
    for (const id of [activeThr, "RWY-MID"]) {
      const b = getBlock(id);
      if (b && b.status === "clear") b.status = "reserved";
    }
  }
}

// ============================================================================
// SIMULATION TICK & AI AUTONOMY (ARMCHAIR MODE + BACKGROUND TRAFFIC)
// ============================================================================
function stepSimulation() {
  if (state.speed === 0) return;

  const stepMins = 0.08 * state.speed;
  state.simMinutes += stepMins;
  state.tickCount++;

  if (state.rwyClosedTicks > 0) {
    state.rwyClosedTicks = Math.max(0, state.rwyClosedTicks - stepMins);
    if (state.rwyClosedTicks === 0) {
      emitRadioCall({
        freq: "122.800",
        sender: "VERNAL AIRPORT OPS (OPS-1)",
        message: "Vernal Traffic, Airport Ops 1 clear of Runway 17/35, wildlife dispersed east toward Ashley Creek. Runway 17/35 is open and clear."
      });
    }
  }

  const wx = getWeather();

  for (const f of state.flights) {
    // 1. Move enroute / approaching aircraft on Basin Radar
    if (["ENROUTE", "APPROACH", "EMERGENCY"].includes(f.state)) {
      const targetApt = AIRPORTS[f.dest] || AIRPORTS.KVEL;
      const dx = targetApt.coords.x - f.pos.x;
      const dy = targetApt.coords.y - f.pos.y;
      const dist = Math.hypot(dx, dy);
      const stepPx = (f.speedKt / 145) * 1.4 * Math.min(state.speed, 6);

      if (dist > 8) {
        f.pos.x += (dx / dist) * stepPx;
        f.pos.y += (dy / dist) * stepPx;
        f.heading = Math.round(((Math.atan2(dy, dx) * 180) / Math.PI + 450) % 360);
        // Smooth altitude transition
        if (Math.abs(f.altFt - f.targetAltFt) > 150) {
          f.altFt += Math.sign(f.targetAltFt - f.altFt) * 140;
        }
      } else {
        handleArrival(f, wx);
        continue;
      }

      // Entering KVEL final approach block
      const finalBlock = wx.activeRwy === "17" ? "FINAL-17" : "RNAV-35-FINAL";
      if (f.dest === "KVEL" && dist < 85 && f.blockId !== finalBlock) {
        f.blockId = finalBlock;
        f.state = f.state === "EMERGENCY" ? "EMERGENCY" : "APPROACH";
        f.freq = "122.800";
        f.targetAltFt = 5500;
        emitRadioCall({
          freq: "122.800",
          sender: f.callsign,
          message: `Vernal Traffic, ${f.callsign} on final for Runway ${wx.activeRwy}, ${wx.flightCategory} conditions, Vernal.`
        });
      }
    }

    // 2. Traffic Pattern Flight (Student C172)
    if (f.state === "PATTERN") {
      if (wx.crosswindWarning && state.tickCount % 60 === 0) {
        f.dest = "4V0";
        f.state = "ENROUTE";
        f.blockId = null;
        emitRadioCall({
          freq: "122.800",
          sender: f.callsign,
          message: `Vernal Traffic, ${f.callsign} aborting pattern work due to ${wx.windKt}G${wx.gustKt} crosswinds — departing southeast back to Rangely 4V0.`
        });
      } else if (state.tickCount % 16 === 0) {
        const activeThr = wx.activeRwy === "17" ? "RWY-17-THR" : "RWY-35-THR";
        const cycle = ["PAT-DOWNWIND", "PAT-BASE", activeThr, "PAT-UPWIND"];
        const nextIdx = (cycle.indexOf(f.blockId) + 1) % cycle.length;
        if (cycle[nextIdx] === activeThr && state.rwyClosedTicks > 0) {
          f.blockId = "PAT-UPWIND";
          emitRadioCall({
            freq: "122.800",
            sender: f.callsign,
            message: `Vernal Traffic, ${f.callsign} going around Runway ${wx.activeRwy} for runway closure, climbing upwind to 6,300.`
          });
        } else {
          f.blockId = cycle[nextIdx];
        }
      }
    }

    advanceSurfaceDeparture(f, state, wx, emitRadioCall);
  }

  // A gate agent and a ramp crew can work simultaneously. Their work follows sim time.
  while (state.simMinutes >= state.nextCrewMinute) {
    state.nextCrewMinute++;
    if (state.role === "dispatcher" || state.role === "armchair") runGroundCrews(wx);
  }
  updateReleases(state, wx, playClock.read(), reportDispatch);
  if (state.role === "armchair" && state.tickCount % 66 === 0) triggerNextDynamicScenario();

  syncSignallingBlocks();
  renderAll({ fromTick: true });
}

function handleArrival(f, wx) {
  if (AIRPORTS[f.dest]?.type === "portal") {
    // Reached off-map portal (KSLC / KDEN / KPHX): turn flight around after portal transit
    const oldOrigin = f.origin;
    const portalName = f.dest;
    emitRadioCall({
      freq: "135.775",
      sender: "SALT LAKE CENTER (ZLC)",
      message: `${f.callsign} leaving Uinta Basin airspace via ${portalName} portal, radar service continues outside map. Have a safe flight.`
    });
    // Cycle return leg so airspace stays lively
    f.origin = portalName;
    f.dest = oldOrigin === portalName ? "KVEL" : oldOrigin;
    f.state = "ENROUTE";
    f.blockId = null;
    f.targetAltFt = 11500;
    return;
  }

  if (f.dest === "KVEL") {
    if (state.rwyClosedTicks > 0 && f.state !== "EMERGENCY") {
      // Go-around!
      f.pos.y += 45;
      f.blockId = "PAT-UPWIND";
      emitRadioCall({
        freq: "122.800",
        sender: f.callsign,
        message: `Vernal Traffic, ${f.callsign} executing missed approach — Runway ${wx.activeRwy} occupied by Ops vehicle/wildlife!`
      });
      return;
    }

    // Check LIFR fog minimums for VFR-only GA
    if (wx.flightCategory === "LIFR" && (f.category === "ga_student" || f.category === "ga_patrol")) {
      f.dest = "74V";
      f.blockId = null;
      emitRadioCall({
        freq: "122.800",
        sender: f.callsign,
        message: `Vernal Traffic, ${f.callsign} unable LIFR 1/2SM fog at KVEL — diverting west to Roosevelt (74V).`
      });
      return;
    }

    f.state = "PARKED";
    f.parkedAt = "KVEL";
    f.speedKt = 0;
    f.altFt = 5281;
    f.pos = { ...AIRPORTS.KVEL.coords };
    f.blockId = f.category === "contour" ? "GATE-1" : f.category === "cargo" ? "CARGO-PAD" : "FBO-2";
    f.squawk = f.squawk === "7700" ? "1200" : f.squawk;
    emitRadioCall({
      freq: "122.800",
      sender: f.callsign,
      message: `Vernal Traffic, ${f.callsign} clear of Runway ${wx.activeRwy} at Alpha, taxiing to ${f.blockId}.`
    });
    if (f.nextLegDest) {
      f.origin = "KVEL";
      f.dest = f.nextLegDest;
      f.nextLegDest = null;
      f.schedDep = f.schedArr = "";
      f.fueled = f.deiced = f.dispatched = false;
      f.dispatchHeld = false;
      f.releasedBy = f.divertedFrom = f.releaseDue = null;
    }
    return;
  }

  // Arrived at Basin strip or helipad (74V, U69, 33U, 4V0, UT09, LZ-OURAY, LZ-DINO)
  f.state = "PARKED";
  f.parkedAt = f.dest;
  f.speedKt = 0;
  f.altFt = AIRPORTS[f.dest]?.elev || 5200;
  f.blockId = f.dest === "UT18" ? "ARMC-PAD" : null;
  emitRadioCall({
    freq: AIRPORTS[f.dest]?.ctaf || "122.800",
    sender: f.callsign,
    message: `${f.dest} Traffic, ${f.callsign} safely on the ground at ${AIRPORTS[f.dest]?.name || f.dest}.`
  });
}

function reportDispatch(flight, sender, decision) {
  emitRadioCall({
    freq: "129.450", sender,
    message: `${flight.callsign} · ${decision}.`,
    logOnly: true
  });
}

function runGroundCrews(wx) {
  const passenger = state.passengers.find(p => p.status === "pending" || p.status === "flagged");
  if (passenger) {
    const denied = passenger.correctAction === "deny_boarding";
    passenger.status = denied ? "denied" : "cleared";
    const flight = getFlight(passenger.flight.split(" ")[0]);
    if (flight && !denied && flight.tsaClearedPax < flight.tsaTotalPax) flight.tsaClearedPax++;
    emitRadioCall({
      freq: "129.450", sender: "KVEL GATE",
      message: `${flight?.callsign || "Gate 1"} boarding update · ${passenger.name} ${denied ? "will not board" : "cleared"}.`,
      logOnly: state.role === "dispatcher"
    });
  }

  const flight = state.flights.find(f => isDeparture(f) && ["BOARDING", "PARKED"].includes(f.state)
    && (!f.fueled || (wx.deiceRequired && !f.deiced)));
  if (!flight) return;
  const fueling = !flight.fueled;
  if (fueling) {
    flight.fueled = true;
    flight.fuelLbs += 650;
  } else {
    flight.deiced = true;
  }
  emitRadioCall({
    freq: "129.450", sender: "VERNAL JET CENTER",
    message: `${flight.callsign} · ${fueling ? "fueling" : "de-icing"} complete at ${flight.blockId}.`,
    logOnly: state.role === "dispatcher"
  });
}

// ============================================================================
// DYNAMIC SCENARIOS (7700 EMERGENCIES, DEER ON RWY, METHANE SPIKE, SAR, MEDEVAC)
// ============================================================================
function triggerNextDynamicScenario() {
  const scen = DYNAMIC_SCENARIOS[state.scenarioIndex % DYNAMIC_SCENARIOS.length];
  state.scenarioIndex++;

  emitRadioCall({
    freq: scen.freq,
    sender: scen.sender,
    message: scen.radioCall,
    isGuard: scen.freq === "121.500"
  });

  if (scen.id === "SCEN-DEER-RWY") {
    state.rwyClosedTicks = 3.5;
    state.rwyCloseReason = "DEER SWEEP";
  } else if (scen.id === "SCEN-7700-ICING") {
    if (!getFlight("N842K")) {
      state.flights.unshift({
        id: "N842K",
        callsign: "BONANZA 842K [7700]",
        operator: "Transient GA Emergency",
        type: "Beechcraft Bonanza A36",
        category: "ga_transit",
        tail: "N842K",
        origin: "KSLC",
        dest: "KVEL",
        alternate: "U69",
        schedDep: "LIVE",
        schedArr: "ASAP",
        state: "EMERGENCY",
        blockId: null,
        pos: { x: 165, y: 315 },
        altFt: 11200,
        targetAltFt: 5281,
        speedKt: 165,
        heading: 92,
        fuelLbs: 310,
        paxCount: 3,
        cargoLbs: 80,
        deiced: false,
        fueled: true,
        dispatched: true,
        tsaClearedPax: 0,
        tsaTotalPax: 0,
        squawk: "7700",
        freq: "121.500",
        pilotNotes: "MAYDAY — Severe rime ice over Daniels Summit; descending to KVEL Runway 35 priority."
      });
    }
  } else if (scen.id === "SCEN-SAR-LODORE") {
    const sar = getFlight("RESCUE1");
    if (sar) {
      sar.dest = "LZ-DINO";
      sar.state = "ENROUTE";
      sar.blockId = null;
      sar.speedKt = 135;
      sar.altFt = 6800;
      sar.targetAltFt = 5500;
    }
  } else if (scen.id === "SCEN-MEDEVAC-UBMC") {
    const med = getFlight("AIRMED4");
    if (med) {
      med.dest = "UT09";
      med.state = "ENROUTE";
      med.blockId = null;
      med.speedKt = 140;
      med.altFt = 6400;
      med.targetAltFt = 5300;
    }
  } else if (scen.id === "SCEN-CONTOUR-DEICE") {
    const vte = getFlight("VTE3101");
    if (vte && ["BOARDING", "PARKED"].includes(vte.state)) {
      vte.deiced = false;
    }
  }

  updateReleases(state, getWeather(), playClock.read(), reportDispatch, false);
  syncSignallingBlocks();
  renderAll();
}

// ============================================================================
// SVG RENDERER 1: ASHLEY VALLEY & KVEL DLR SIGNALLING DIAGRAM
// ============================================================================
const surfaceNames = { "GA-HANGAR": "GA hangar", "FBO-1": "FBO 1", "FBO-2": "FBO 2",
  "GATE-1": "Gate 1", "CARGO-PAD": "Cargo pad", "TWY-A-N": "Alpha N", "TWY-A-MID": "Alpha", "TWY-A-S": "Alpha S",
  "RWY-17-THR": "Rwy 17", "RWY-MID": "Midfield", "RWY-35-THR": "Rwy 35" };

let previousSurface = "";
function renderKvelSvg() {
  const signature = [state.weatherId, state.selectedFlightId, ...state.blocks.map(b => b.status + ":" + (b.occupant || ""))].join("|");
  if (signature === previousSurface) return;
  previousSurface = signature;
  const wx = getWeather();
  let svg = `
    <defs>
      <pattern id="dlrGrid" width="32" height="32" patternUnits="userSpaceOnUse">
        <path d="M 32 0 L 0 0 0 32" fill="none" stroke="#16272d" stroke-width="1"/>
      </pattern>
    </defs>
    <rect width="920" height="565" fill="var(--chart)"/>
    <rect width="920" height="565" fill="url(#dlrGrid)"/>

    <g class="valley-context">
    <!-- Asphalt Ridge (SW Terrain Wall) -->
    <path d="M 25 270 L 145 360 L 295 545 L 25 545 Z" fill="#142127" stroke="#344b53" stroke-width="1.5" stroke-dasharray="5 3"/>
    <text x="42" y="458" fill="#96abb1" font-size="11" font-weight="700">ASPHALT RIDGE (6,200'+)</text>
    <text x="42" y="474" fill="var(--text-muted)" font-size="9">SW Terrain / Downslope Turbulence</text>

    <!-- Steinaker Reservoir (North) & Red Fleet (NE) -->
    <ellipse cx="470" cy="44" rx="52" ry="18" fill="#142b31" stroke="#3b646c" stroke-width="1.2"/>
    <text x="470" y="47" text-anchor="middle" fill="#9cbdc4" font-size="9">STEINAKER RES.</text>
    <ellipse cx="785" cy="52" rx="46" ry="16" fill="#142b31" stroke="#3b646c" stroke-width="1.2"/>
    <text x="785" y="55" text-anchor="middle" fill="#9cbdc4" font-size="9">RED FLEET RES.</text>

    <!-- Split Mountain / Dinosaur NM East -->
    <path d="M 855 150 L 910 185 L 910 355 L 860 390 Z" fill="#142127" stroke="#3e565e" stroke-width="1.2"/>
    <text x="875" y="265" fill="#a3b9bd" font-size="10" transform="rotate(-90 875 265)" text-anchor="middle">SPLIT MTN / DINOSAUR NM →</text>

    <!-- US-40 Highway & Vernal Downtown -->
    <path d="M 35 225 L 305 225 L 495 450 L 895 495" fill="none" stroke="#48616a" stroke-width="3" stroke-dasharray="8 4"/>
    <text x="72" y="216" fill="var(--text-muted)" font-size="10">US-40 W (Vernal Main St → Roosevelt)</text>
    <text x="715" y="514" fill="var(--text-muted)" font-size="10">US-40 SE (Jensen / Ashley Creek)</text>

    <!-- Ashley Creek (Fog Corridor) -->
    <path d="M 340 20 Q 430 140 670 340 T 860 550" fill="none" stroke="#4c7980" stroke-width="2" opacity="0.55"/>
    <text x="720" y="390" fill="#93b9bf" font-size="9" opacity="0.8">Ashley Creek (Radiation Fog Basin)</text>

    </g>
    <!-- Historical crosswind runway -->
    <g class="old-runway"><line x1="425" y1="358" x2="695" y2="270" stroke="#344b53" stroke-width="14" stroke-dasharray="6 4" opacity="0.5"/>
    <text x="646" y="280" fill="#96abb1" font-size="8.5" transform="rotate(-18 646 280)">OLD 07/25 (CLOSED)</text></g>

    <path d="M 444 253 H 472" fill="none" stroke="#354f59" stroke-width="3"/>
    <path d="M 499 193 V 444" fill="none" stroke="#354f59" stroke-width="4"/>
    <rect class="runway-base" x="578" y="163" width="60" height="304"/>
    <path class="runway-edge" d="M 583 166 V 464 M 633 166 V 464"/>
    <path class="threshold-bars" d="M 588 167 v 4 m 5 -4 v 4 m 5 -4 v 4 m 5 -4 v 4 m 10 -4 v 4 m 5 -4 v 4 m 5 -4 v 4 m 5 -4 v 4
      M 588 463 v -4 m 5 4 v -4 m 5 4 v -4 m 5 4 v -4 m 10 4 v -4 m 5 4 v -4 m 5 4 v -4 m 5 4 v -4"/>
    <!-- Pattern and taxi connections -->
    <path class="valley-context" d="M 608 165 L 608 98 L 780 98 L 780 465 L 608 465" fill="none" stroke="#3a535c" stroke-width="2" stroke-dasharray="4 4"/>
    <line x1="446" y1="202" x2="472" y2="202" stroke="#354f59" stroke-width="3"/>
    <line x1="446" y1="296" x2="472" y2="296" stroke="#354f59" stroke-width="3"/>
    <line x1="446" y1="362" x2="472" y2="362" stroke="#354f59" stroke-width="3"/>
    <line x1="446" y1="415" x2="472" y2="415" stroke="#354f59" stroke-width="3"/>
    <line x1="526" y1="194" x2="580" y2="194" stroke="#69868d" stroke-width="3"/>
    <line x1="526" y1="440" x2="580" y2="440" stroke="#69868d" stroke-width="3"/>

    <!-- Active Wind & Runway Callout -->
    <g class="valley-context">
    <text x="30" y="36" fill="var(--accent-cyan)" font-size="11" font-weight="700">ACTIVE RWY: ${wx.activeRwy} • ${wx.flightCategory}</text>
    <text x="30" y="52" fill="var(--text-main)" font-size="10">WIND: ${String(wx.windDir).padStart(3, "0")}° @ ${wx.windKt}${wx.gustKt ? "G" + wx.gustKt : ""} KT</text>
    <text x="30" y="68" fill="var(--text-muted)" font-size="10">TEMP ${wx.tempC}°C • ${wx.deiceRequired ? "DE-ICE REQUIRED" : "DRY RAMP"}</text>
    </g>
  `;

  // Render Signalling Blocks
  for (const b of state.blocks) {
    const hasFlight = Boolean(b.occupant && getFlight(b.occupant));
    const selected = hasFlight && b.occupant === state.selectedFlightId;
    const symbol = { clear: "○", reserved: "◇", occupied: "●", closed: "×" }[b.status];
    const status = b.status[0].toUpperCase() + b.status.slice(1);
    const middle = b.x + b.w / 2;
    const longLabel = b.occupant && b.status !== "closed" ? b.occupant : status;
    const statusLabel = b.w < 40 ? symbol : symbol + " " + longLabel;
    const name = surfaceNames[b.id] || b.id;
    svg += `
      <g class="signal-block facility-${b.type} block-${b.status}${selected ? " is-selected" : ""}" data-block="${b.id}" ${hasFlight ? `data-flight-id="${b.occupant}"` : ""}>
        <title>${b.label} · ${status}${b.occupant ? " · " + b.occupant : ""}</title>
        <rect class="block-outline" x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}"/>
        ${b.type === "runway" ? `<path class="runway-stripe" d="M ${middle} ${b.y + 23} v ${b.h - 48}"/>` : ""}
        ${selected ? `<path class="selected-mark" d="M ${b.x + .8} ${b.y + 1} v ${b.h - 2}"/>` : ""}
        <text class="block-name" x="${middle}" y="${b.y + (b.type === "runway" ? 19 : 13)}" text-anchor="middle" font-size="${b.w < 40 ? 8 : 10}">${name}</text>
        <text class="block-occupant" x="${middle}" y="${b.y + b.h - (b.type === "runway" ? 10 : 6)}" text-anchor="middle" font-size="${b.w < 60 ? 8 : 9}">${escapeHtml(statusLabel)}</text>
      </g>`;
  }
  // Runway 17 / 35 Threshold Numbers
  svg += `
    <text x="608" y="158" text-anchor="middle" fill="var(--text-main)" font-size="13" font-weight="700">17</text>
    <text x="608" y="483" text-anchor="middle" fill="var(--text-main)" font-size="13" font-weight="700">35</text>
    <g class="detail-compass" transform="translate(296 182)" fill="var(--text-muted)" text-anchor="middle">
      <text y="-9" font-size="10" font-weight="650">N</text>
      <path d="M 0 0 L 4.5 15 L 0 12 L -4.5 15 Z" fill="none" stroke="currentColor"/>
    </g>
  `;

  dom.kvelSvg.innerHTML = svg;
}

// ============================================================================
// SVG RENDERER 2: UINTA BASIN REGIONAL AIRSPACE & OFF-MAP PORTALS RADAR
// ============================================================================
function renderBasinBackground() {
  let svg = `
    <rect width="1000" height="620" fill="var(--chart)"/>
    <!-- Basin Topography Hints -->
    <!-- High Uintas North Wall -->
    <path d="M 80 120 Q 350 75 610 115 T 920 95" fill="none" stroke="#344b53" stroke-width="2" stroke-dasharray="10 4"/>
    <text x="340" y="92" fill="#96abb1" font-size="15" font-weight="600">High Uinta Mountains · 11,000–13,528 ft</text>

    <!-- Tavaputs / Book Cliffs South Wall -->
    <path d="M 110 495 Q 480 475 880 510" fill="none" stroke="#344b53" stroke-width="2" stroke-dasharray="10 4"/>
    <text x="370" y="510" fill="#96abb1" font-size="15">Tavaputs Plateau &amp; Book Cliffs</text>

    <!-- Green River & White River -->
    <path d="M 605 135 Q 690 215 700 270 Q 615 335 525 425 L 480 560" fill="none" stroke="#4c7980" stroke-width="2.2" opacity="0.55"/>

    <!-- V200 / J15 / J60 Regional Airways -->
    <line x1="38" y1="245" x2="580" y2="310" stroke="#30474e" stroke-width="1.5" stroke-dasharray="4 4"/>
    <line x1="580" y1="310" x2="960" y2="300" stroke="#30474e" stroke-width="1.5" stroke-dasharray="4 4"/>
    <line x1="580" y1="310" x2="565" y2="590" stroke="#30474e" stroke-width="1.5" stroke-dasharray="4 4"/>
    <line x1="580" y1="310" x2="670" y2="45" stroke="#30474e" stroke-width="1.5" stroke-dasharray="4 4"/>
    <line x1="580" y1="310" x2="245" y2="545" stroke="#30474e" stroke-width="1.5" stroke-dasharray="4 4"/>
    <line x1="580" y1="310" x2="870" y2="565" stroke="#30474e" stroke-width="1.5" stroke-dasharray="4 4"/>

    <!-- 25nm & 50nm Range Rings centered on KVEL -->
    <circle cx="580" cy="310" r="105" fill="none" stroke="#263b41" stroke-width="1.2"/>
    <circle cx="580" cy="310" r="220" fill="none" stroke="#263b41" stroke-width="1.2"/>
    <text x="667" y="245" fill="var(--text-muted)" font-size="13">20 NM</text>
  `;

  // Render Airports, Helipads & Portals
  for (const apt of Object.values(AIRPORTS)) {
    const { x, y } = apt.coords;
    if (apt.type === "portal") {
      svg += `
        <rect x="${x - 32}" y="${y - 14}" width="64" height="28" fill="var(--chart)" stroke="#6f919a" stroke-width="1.5"/>
        <text x="${x}" y="${y + 4}" text-anchor="middle" fill="#b9cdd1" font-size="15" font-weight="650">${apt.code}</text>
      `;
    } else if (apt.type === "hub") {
      svg += `
        <circle cx="${x}" cy="${y}" r="10" fill="#17343b" stroke="var(--accent-cyan)" stroke-width="2.5"/>
        <text x="${x + 15}" y="${y - 4}" fill="var(--accent-cyan)" font-size="15" font-weight="700">KVEL</text>
        <text x="${x + 15}" y="${y + 9}" fill="var(--text-muted)" font-size="13">Vernal Regional</text>
      `;
    } else if (apt.type === "helipad" || apt.type === "patrol" || apt.type === "sar") {
      const color = "#9ebac0";
      svg += `
        <polygon points="${x},${y - 7} ${x + 7},${y + 6} ${x - 7},${y + 6}" fill="var(--chart)" stroke="${color}" stroke-width="1.8"/>
        <text x="${x + 10}" y="${y + 4}" fill="${color}" font-size="14" font-weight="600">${apt.code}</text>
      `;
    } else {
      const stroke = apt.type === "regional" ? "#a6b9bf" : "#b4e0df";
      svg += `
        <circle cx="${x}" cy="${y}" r="6" fill="var(--chart)" stroke="${stroke}" stroke-width="1.8"/>
        <text x="${x + 10}" y="${y + 4}" fill="${stroke}" font-size="15" font-weight="650">${apt.code}</text>
      `;
    }
  }

  dom.basinSvg.innerHTML = svg + '<g class="radar-traffic"></g>';
}

// Reserve room around fixed map symbols before placing movable aircraft labels.
const radarFacilities = Object.values(AIRPORTS).map(({ code, type, coords: { x, y } }) => ({
  x: x - (type === "portal" ? 35 : 10), y: y - 17,
  w: type === "hub" ? 116 : type === "portal" ? 70 : 24 + code.length * 10, h: 35
}));

function placeRadarLabel(point, used) {
  const width = 126, height = 36;
  for (const offset of [0, -38, 38, -76, 76, -114, 114, -152, 152]) {
    for (const x of [point.x + 17, point.x - width - 17]) {
      const box = { x: Math.max(3, Math.min(997 - width, x)), y: Math.max(3, Math.min(617 - height, point.y - 18 + offset)), w: width, h: height };
      if (used.some(b => box.x < b.x + b.w && box.x + width > b.x && box.y < b.y + b.h && box.y + height > b.y)) continue;
      used.push(box);
      return box;
    }
  }
  return { x: Math.min(point.x + 17, 997 - width), y: Math.max(3, point.y - height) };
}

function renderBasinSvg() {
  if (!dom.basinSvg.firstElementChild) renderBasinBackground();
  const used = [...radarFacilities, ...state.flights.map(f => ({ x: f.pos.x - 7, y: f.pos.y - 7, w: 14, h: 14 }))];
  let svg = "";
  for (const f of state.flights) {
    const isSel = f.id === state.selectedFlightId;
    const isEmg = f.state === "EMERGENCY" || f.squawk === "7700";
    const color = isEmg ? "#ffaaa7" : isSel ? "var(--accent-cyan)" : "#add1d5";

    const rad = ((f.heading - 90) * Math.PI) / 180;
    const vx = f.pos.x + Math.cos(rad) * (f.speedKt > 0 ? 18 : 0);
    const vy = f.pos.y + Math.sin(rad) * (f.speedKt > 0 ? 18 : 0);

    const label = placeRadarLabel(f.pos, used);
    const nearX = label.x > f.pos.x ? label.x : label.x + 120;
    svg += `
      <g class="radar-target" data-flight-id="${f.id}">
        <title>${escapeHtml(f.callsign)} · ${f.altFt.toLocaleString()} ft · ${f.speedKt} kt · ${f.dest}</title>
        <path d="M ${f.pos.x} ${f.pos.y} L ${nearX} ${label.y + 15}" fill="none" stroke="#486169" stroke-width="1"/>
        ${f.speedKt > 0 ? `<line x1="${f.pos.x}" y1="${f.pos.y}" x2="${vx}" y2="${vy}" stroke="${color}" stroke-width="2"/>` : ""}
        <circle cx="${f.pos.x}" cy="${f.pos.y}" r="4.5" fill="${color}"/>
        ${isSel ? `<circle cx="${f.pos.x}" cy="${f.pos.y}" r="9" fill="none" stroke="var(--accent-cyan)" stroke-width="2"/>` : ""}
        <text class="radar-label" x="${label.x + 2}" y="${label.y + 14}" fill="${color}" font-size="15" font-weight="700">${f.id}</text>
        <text class="radar-label" x="${label.x + 2}" y="${label.y + 29}" fill="var(--text-muted)" font-size="13">${Math.round(f.altFt / 100)} · ${f.speedKt} kt → ${f.dest}</text>
      </g>
    `;
  }

  dom.basinSvg.lastElementChild.innerHTML = svg;
}

// ============================================================================
// TRAFFIC TABLE & ROLE WORKSTATIONS
// ============================================================================
function renderFlightTable() {
  dom.opsCountBadge.textContent = `${state.flights.length} active · ${state.flights.filter(f => !["PARKED","BOARDING"].includes(f.state)).length} airborne or taxiing`;
  if (!dom.trafficDetails.open) return;
  // Keep the keyboard-selectable callsign in place while telemetry changes.
  let index = 0;
  for (const f of state.flights) {
    let row = dom.flightTableBody.rows[index++];
    if (!row || row.dataset.selectFlight !== f.id) {
      const next = row || null;
      row = document.createElement("tr");
      row.dataset.selectFlight = f.id;
      row.innerHTML = `<td><button type="button" class="flight-pick">${escapeHtml(f.callsign)}</button><br>${escapeHtml(f.tail)}</td>
        <td>${escapeHtml(f.type)}<br>${escapeHtml(f.operator)}</td><td></td><td></td><td></td><td></td>`;
      dom.flightTableBody.insertBefore(row, next);
    }
    const selected = f.id === state.selectedFlightId;
    row.classList.toggle("selected-row", selected);
    row.querySelector("button").setAttribute("aria-pressed", String(selected));
    const values = [
      `${f.origin} → ${f.dest}<br>Alt. ${f.alternate}`,
      `<span class="state-label state-${f.state}">${f.state}</span><br>${f.blockId || "AIRSPACE"}`,
      `${f.altFt.toLocaleString()}'<br>${f.speedKt} kt`,
      `${f.squawk}<br>${f.freq}`
    ];
    values.forEach((value, i) => {
      const cell = row.cells[i + 2];
      if (cell.dataset.content !== value) {
        cell.innerHTML = value;
        cell.dataset.content = value;
      }
    });
  }
  while (dom.flightTableBody.rows.length > index) dom.flightTableBody.deleteRow(-1);
}

function renderRoleWorkstation() {
  const wx = getWeather();
  const sel = getFlight(state.selectedFlightId) || state.flights[0];

  const titles = {
    armchair: ["Armchair Director", "Autonomous operations"],
    dispatcher: ["Flight Dispatch", "Vernal · KVEL"],
    fbo: ["FBO & Ramp", "Vernal Jet Center · KVEL"],
    tsa: ["TSA & Ticketing", "Gate 1 · KVEL"],
    pilot: ["Pilot Command", "Flight deck"]
  };
  dom.rolePanelTitle.textContent = titles[state.role][0];
  dom.roleAiBadge.textContent = titles[state.role][1];

  if (state.role === "armchair") {
    dom.roleDeskBody.innerHTML = `
      <div class="role-card">
        <h3>Basin operations</h3>
        <p class="desk-copy">${escapeHtml(wx.summary)}</p>
        <div class="action-row">
          <button type="button" class="btn" id="armchairScenBtn">Inject Dynamic Incident</button>
          <button type="button" class="btn" id="armchairMethaneBtn">Trigger Methane Plume Call</button>
          <button type="button" class="btn" id="armchair7700Btn">Inject 7700 Icing Emergency</button>
        </div>
      </div>
      <div class="role-card">
        <h3>Selected aircraft · ${escapeHtml(sel.callsign)}</h3>
        <p class="desk-copy">
          ${escapeHtml(sel.type)} (${sel.tail}) • ${sel.origin} → ${sel.dest} • Fuel: ${sel.fuelLbs} lbs • Pax: ${sel.paxCount} • Cargo: ${sel.cargoLbs} lbs<br>
          Notes: ${escapeHtml(sel.pilotNotes)}
        </p>
      </div>
    `;
    document.getElementById("armchairScenBtn")?.addEventListener("click", triggerNextDynamicScenario);
    document.getElementById("armchairMethaneBtn")?.addEventListener("click", () => {
      state.scenarioIndex = 0;
      triggerNextDynamicScenario();
    });
    document.getElementById("armchair7700Btn")?.addEventListener("click", () => {
      state.scenarioIndex = 1;
      triggerNextDynamicScenario();
    });
    return;
  }

  if (state.role === "dispatcher") {
    renderDispatchDesk(dom.dispatchPanel, state, wx, playClock.read());
    return;
  }

  if (state.role === "fbo") {
    const rampFlights = state.flights.filter((f) => ["GATE-1", "FBO-1", "FBO-2", "CARGO-PAD", "GA-HANGAR"].includes(f.blockId));
    dom.roleDeskBody.innerHTML = `
      <div class="role-card">
        <h3>KVEL Runway 17/35 &amp; Surface Ops</h3>
        <p class="desk-copy">
          Runway Status: <strong>${state.rwyClosedTicks > 0 ? "CLOSED (" + state.rwyCloseReason + ")" : "OPEN — Active Rwy " + wx.activeRwy}</strong>
        </p>
        <div class="action-row">
          <button type="button" class="btn" id="fboWildlifeBtn">Run Wildlife / FOD Sweep (Close Rwy)</button>
          <button type="button" class="btn" id="fboOpenRwyBtn">Clear &amp; Reopen Rwy 17/35</button>
        </div>
      </div>
      ${
        rampFlights.length > 0
          ? rampFlights
              .map(
                (f) => `
          <div class="role-card">
            <h3><span>${f.blockId}: ${escapeHtml(f.callsign)}</span><span class="desk-tag">${f.type}</span></h3>
            <div class="desk-copy">
              Fuel: ${f.fueled ? "Serviced" : "Needs Jet-A/100LL"} | De-Ice: ${f.deiced ? "Sprayed" : wx.deiceRequired ? "Frost Present" : "Clear"}
            </div>
            <div class="action-row">
              <button type="button" class="btn" data-fbo-fuel="${f.id}">Dispatch Fuel Truck</button>
              <button type="button" class="btn" data-fbo-deice="${f.id}">Type I/IV De-Ice Spray</button>
              <button type="button" class="btn" data-fbo-marshall="${f.id}">Marshall to TWY Alpha</button>
            </div>
          </div>
        `
              )
              .join("")
          : `<div class="role-card"><p class="desk-copy">All KVEL ramp stands (Gate 1, Vernal Jet Center, Cargo Pad, GA Hangar) are currently clear — awaiting next arrival.</p></div>`
      }
    `;
    document.getElementById("fboWildlifeBtn")?.addEventListener("click", () => {
      state.rwyClosedTicks = 4;
      state.rwyCloseReason = "FOD/DEER SWEEP";
      emitRadioCall({ freq: "122.800", sender: "VERNAL OPS-1", message: "Vernal Traffic, Airport Ops 1 entering Runway 17/35 at Alpha 3 for wildlife and FOD inspection. Runway closed." });
      syncSignallingBlocks();
      renderAll();
    });
    document.getElementById("fboOpenRwyBtn")?.addEventListener("click", () => {
      state.rwyClosedTicks = 0;
      emitRadioCall({ freq: "122.800", sender: "VERNAL OPS-1", message: "Vernal Traffic, Ops 1 clear of Runway 17/35, surface clear and braking action good." });
      syncSignallingBlocks();
      renderAll();
    });
    dom.roleDeskBody.querySelectorAll("[data-fbo-fuel]").forEach((btn) =>
      btn.addEventListener("click", () => {
        const f = getFlight(btn.dataset.fboFuel);
        if (!f) return;
        f.fueled = true;
        f.fuelLbs += 650;
        emitRadioCall({ freq: "129.450", sender: "VERNAL JET CENTER", message: `${f.callsign}, positive-bond fueling complete at ${f.blockId}. Receipt in cockpit.` });
        renderAll();
      })
    );
    dom.roleDeskBody.querySelectorAll("[data-fbo-deice]").forEach((btn) =>
      btn.addEventListener("click", () => {
        const f = getFlight(btn.dataset.fboDeice);
        if (!f) return;
        f.deiced = true;
        emitRadioCall({ freq: "129.450", sender: "VJC DE-ICE PAD", message: `${f.callsign}, wings and tail sprayed with Type I/IV glycol. Post-deice check clean, holdover starts now.` });
        renderAll();
      })
    );
    dom.roleDeskBody.querySelectorAll("[data-fbo-marshall]").forEach((btn) =>
      btn.addEventListener("click", () => {
        const f = getFlight(btn.dataset.fboMarshall);
        if (!f) return;
        if (f.dispatchHeld || f.releaseDue != null) {
          reportDispatch(f, "RAMP", "awaiting a dispatch release before marshalling");
          return;
        }
        f.parkedAt = null;
        f.state = "TAXI_OUT";
        f.blockId = "TWY-A-S";
        emitRadioCall({ freq: "129.450", sender: "VERNAL JET CENTER", message: `${f.callsign}, chocks pulled, wing-walkers clear — follow marshal to Taxiway Alpha.` });
        syncSignallingBlocks();
        renderAll();
      })
    );
    return;
  }

  if (state.role === "tsa") {
    const vte = getFlight("VTE3101");
    dom.roleDeskBody.innerHTML = `
      <div class="role-card">
        <h3>Contour VTE3101 (KVEL → KPHX) Boarding &amp; Checkpoint</h3>
        <p class="desk-copy">
          Gate 1 Cleared Pax: ${vte ? vte.tsaClearedPax : 0} / ${vte ? vte.tsaTotalPax : 27} • Inspect ID, Checked Firearms/Hazmat, &amp; X-Ray Carry-Ons
        </p>
      </div>
      ${state.passengers
        .map(
          (p) => `
          <div class="role-card">
            <h3><span>${escapeHtml(p.name)} — ${escapeHtml(p.role)}</span><span class="state-label state-${p.status === "pending" ? "HOLD_SHORT" : "TAKEOFF"}">${p.status.toUpperCase()}</span></h3>
            <div class="desk-copy">
              ID: ${escapeHtml(p.idStatus)}<br>
              Checked: ${escapeHtml(p.checkedBag)}<br>
              X-Ray Carry-On: ${escapeHtml(p.carryOn)}
            </div>
            ${
              p.status === "pending"
                ? `<div class="action-row">
                    <button type="button" class="btn" data-tsa-act="clear" data-pax="${p.id}">Clear to Gate 1</button>
                    <button type="button" class="btn" data-tsa-act="require_declaration" data-pax="${p.id}">Counter Declaration / Repack</button>
                    <button type="button" class="btn" data-tsa-act="secondary_search" data-pax="${p.id}">Confiscate Hazmat / Secondary</button>
                    <button type="button" class="btn" data-tsa-act="deny_boarding" data-pax="${p.id}">Deny Boarding &amp; Call LEO</button>
                  </div>`
                : `<div class="desk-outcome">Outcome: ${escapeHtml(p.issue)}</div>`
            }
          </div>
        `
        )
        .join("")}
    `;
    dom.roleDeskBody.querySelectorAll("[data-tsa-act]").forEach((btn) =>
      btn.addEventListener("click", () => {
        const pax = state.passengers.find((x) => x.id === btn.dataset.pax);
        if (!pax) return;
        const chosen = btn.dataset.tsaAct;
        const ok = chosen === pax.correctAction;
        pax.status = ok ? (chosen === "deny_boarding" ? "denied" : "cleared") : "flagged";
        if (ok && chosen !== "deny_boarding" && vte && vte.tsaClearedPax < vte.tsaTotalPax) {
          vte.tsaClearedPax++;
        }
        emitRadioCall({
          freq: "129.450",
          sender: "KVEL TSA & TICKETING",
          message: ok
            ? `Correct action on ${pax.name}: ${pax.issue}`
            : `Supervisor advisory on ${pax.name} — protocol recommended '${pax.correctAction.replace("_", " ")}'. (${pax.issue})`
        });
        renderAll();
      })
    );
    return;
  }

  // PILOT COMMAND ROLE
  dom.roleDeskBody.innerHTML = `
    <div class="role-card">
      <h3>Active cockpit · ${escapeHtml(sel.callsign)} (${escapeHtml(sel.type)})</h3>
      <div class="desk-copy">
        Route: <strong>${sel.origin} → ${sel.dest}</strong> | State: <strong>${sel.state}</strong> | Alt: ${sel.altFt.toLocaleString()}' | Spd: ${sel.speedKt} kt | Squawk: <strong>${sel.squawk}</strong><br>
        Mission: ${escapeHtml(sel.pilotNotes)}
      </div>
      <div class="field-pair">
        <label>Destination Airport / LZ
          <select id="pilotDestSelect" class="btn">
            ${Object.values(AIRPORTS)
              .map((a) => `<option value="${a.code}" ${a.code === sel.dest ? "selected" : ""}>${a.code} — ${escapeHtml(a.name.slice(0, 26))}</option>`)
              .join("")}
          </select>
        </label>
        <label>Transponder Squawk
          <select id="pilotSquawkSelect" class="btn">
            ${["1200","4215","7700","7600"].includes(sel.squawk) ? "" : `<option value="${escapeHtml(sel.squawk)}" selected>${escapeHtml(sel.squawk)} (assigned)</option>`}
            <option value="1200" ${sel.squawk === "1200" ? "selected" : ""}>1200 (VFR Basin)</option>
            <option value="4215" ${sel.squawk === "4215" ? "selected" : ""}>4215 (IFR ZLC)</option>
            <option value="7700" ${sel.squawk === "7700" ? "selected" : ""}>7700 (EMERGENCY)</option>
            <option value="7600" ${sel.squawk === "7600" ? "selected" : ""}>7600 (RADIO FAIL)</option>
          </select>
        </label>
      </div>
      <div class="action-row">
        <button type="button" class="btn" id="pilotLaunchBtn">Taxi / Takeoff / Fly to Dest</button>
        <button type="button" class="btn" id="pilotPatternBtn">Fly KVEL Rwy ${wx.activeRwy} Pattern</button>
        <button type="button" class="btn" id="pilotCtafBtn">Announce Position on CTAF</button>
        <button type="button" class="btn" id="pilotMaydayBtn">Declare 7700 Emergency</button>
      </div>
    </div>
    <div class="role-card">
      <h3>Pilot missions</h3>
      <div class="action-row">
        ${state.flights
          .map((f) => `<button type="button" class="btn ${f.id === sel.id ? "active" : ""}" data-pick-pilot="${f.id}">${f.id} (${f.category.replace("_", " ")})</button>`)
          .join("")}
      </div>
    </div>
  `;

  document.getElementById("pilotDestSelect")?.addEventListener("change", (e) => {
    sel.dest = e.target.value;
    renderAll();
  });
  document.getElementById("pilotSquawkSelect")?.addEventListener("change", (e) => {
    sel.squawk = e.target.value;
    if (sel.squawk === "7700") sel.state = "EMERGENCY";
    renderAll();
  });
  document.getElementById("pilotLaunchBtn")?.addEventListener("click", () => {
    if (sel.dispatchHeld || sel.releaseDue != null) {
      reportDispatch(sel, "DISPATCH DESK", "awaiting dispatch release before departure");
      return;
    }
    const currentCode = ["PARKED", "BOARDING"].includes(sel.state) ? sel.parkedAt : null;
    if (currentCode && sel.dest === currentCode) {
      emitRadioCall({ freq: sel.freq, sender: sel.callsign, message: `Select a new destination before departing ${currentCode}.` });
      return;
    }
    if (currentCode) sel.origin = currentCode;
    const isKvelRamp = currentCode === "KVEL";
    sel.parkedAt = null;
    sel.releaseDue = null;
    sel.dispatched = true;
    sel.state = isKvelRamp ? "TAXI_OUT" : "ENROUTE";
    if (sel.state === "ENROUTE") {
      sel.blockId = null;
      sel.speedKt = sel.category === "contour" || sel.category === "private_jet" ? 250 : 145;
      sel.targetAltFt = 9500;
    } else {
      sel.blockId = "TWY-A-S";
    }
    emitRadioCall({
      freq: "122.800",
      sender: sel.callsign,
      message: `${sel.origin} Traffic, ${sel.callsign} departing for ${sel.dest} (${AIRPORTS[sel.dest]?.name || sel.dest}).`
    });
    syncSignallingBlocks();
    renderAll();
  });
  document.getElementById("pilotPatternBtn")?.addEventListener("click", () => {
    if (sel.dispatchHeld || sel.releaseDue != null) {
      reportDispatch(sel, "DISPATCH DESK", "awaiting dispatch release before departure");
      return;
    }
    sel.parkedAt = null;
    sel.dest = "KVEL";
    sel.state = "PATTERN";
    sel.blockId = "PAT-DOWNWIND";
    sel.pos = { ...AIRPORTS.KVEL.coords };
    sel.altFt = 6300;
    sel.speedKt = 95;
    emitRadioCall({
      freq: "122.800",
      sender: sel.callsign,
      message: `Vernal Traffic, ${sel.callsign} entering East Downwind Runway ${wx.activeRwy} for touch-and-go, Vernal.`
    });
    syncSignallingBlocks();
    renderAll();
  });
  document.getElementById("pilotCtafBtn")?.addEventListener("click", () => {
    emitRadioCall({
      freq: sel.freq,
      sender: sel.callsign,
      message: `Vernal / Basin Traffic, ${sel.callsign} (${sel.type}) at ${sel.altFt.toLocaleString()} feet, ${sel.state.toLowerCase()} toward ${sel.dest}.`
    });
  });
  document.getElementById("pilotMaydayBtn")?.addEventListener("click", () => {
    sel.squawk = "7700";
    sel.state = "EMERGENCY";
    sel.dest = "KVEL";
    sel.freq = "121.500";
    emitRadioCall({
      freq: "121.500",
      sender: sel.callsign,
      message: `MAYDAY MAYDAY MAYDAY, ${sel.callsign} squawking 7700, requesting immediate priority landing Runway ${wx.activeRwy} at Vernal KVEL!`,
      isGuard: true
    });
    renderAll();
  });
  dom.roleDeskBody.querySelectorAll("[data-pick-pilot]").forEach((btn) =>
    btn.addEventListener("click", () => {
      state.selectedFlightId = btn.dataset.pickPilot;
      renderAll();
    })
  );
}

function renderRadioLog() {
  dom.radioLogFeed.innerHTML = state.radioLog
    .map((entry) => {
      const cls =
        entry.freq === "121.500"
          ? "freq-guard"
          : entry.freq === "135.775"
          ? "freq-zlc"
          : entry.freq === "129.450"
          ? "freq-fbo"
          : "";
      return `
        <div class="radio-entry ${cls}">
          <div class="radio-meta"><span class="freq-chip">${entry.freq}</span><strong>${escapeHtml(entry.sender)}</strong><time>${entry.timeStr}</time></div>
          <p class="radio-message">${escapeHtml(entry.message)}</p>
        </div>
      `;
    })
    .join("");
}

function renderHeaderAndWeather() {
  const wx = getWeather();
  dom.simClock.textContent = formatSimTime(state.simMinutes);
  if (state.role === "dispatcher") {
    const label = "Vernal " + (state.surfaceDetail ? "airfield" : "and Ashley Valley") +
      " · " + (state.rwyClosedTicks > 0 ? "Runway closed" : "Runway " + wx.activeRwy + " active");
    if (label !== dom.dispatchMapLabel.textContent) dom.dispatchMapLabel.textContent = label;
  }
  if (dom.airportConditions.dataset.weather === wx.id) return;
  dom.airportConditions.dataset.weather = wx.id;
  const localConditions = { KVEL: wx.flightCategory, ...wx.nearbyCategories };
  dom.airportConditions.innerHTML = Object.entries(localConditions).map(([code, category]) => {
    const airport = AIRPORTS[code];
    return `<li class="station"><div class="station-line"><strong class="station-code">${code}</strong>
      <span class="flight-category cat-${category}">${category}</span></div>
      <span class="station-name">${escapeHtml(airport.name.replace(/ Airport$/, ""))}</span></li>`;
  }).join("");
  dom.metarText.textContent = wx.metar;
  dom.methaneBadge.textContent = `Basin methane · ${wx.methaneTrapping}`;
  dom.wxBriefingNote.textContent = wx.summary;
}

function renderAirportDirectory() {
  dom.airportDirectoryList.innerHTML = `
    <table class="sim-table">
      <thead>
        <tr><th>Code</th><th>Facility &amp; Region</th><th>Elev</th><th>Runways / Pad</th><th>Freqs</th></tr>
      </thead>
      <tbody>
        ${Object.values(AIRPORTS)
          .map(
            (a) => `
            <tr>
              <td><strong>${a.code}</strong></td>
              <td>${escapeHtml(a.name)}<br><span style="color:var(--text-muted);font-size:0.7rem;">${escapeHtml(a.region)}</span></td>
              <td>${a.elev.toLocaleString()}'</td>
              <td>${escapeHtml(a.runways.join(", "))}</td>
              <td>CTAF ${a.ctaf}${a.awos ? "<br>AWOS " + a.awos : ""}</td>
            </tr>
          `
          )
          .join("")}
      </tbody>
    </table>
  `;
}

function renderAll({ fromTick = false } = {}) {
  renderHeaderAndWeather();
  if (state.view !== "basin") renderKvelSvg();
  if (state.view !== "kvel") renderBasinSvg();
  renderFlightTable();
  // Avoid clobbering open <select>/<input> controls inside the role desk during background ticks
  const active = document.activeElement;
  const interactingWithDeskInput = fromTick && state.role !== "dispatcher" &&
    active && dom.roleDeskBody.contains(active) && active.matches("select,input,textarea");
  if (!interactingWithDeskInput) {
    renderRoleWorkstation();
  }
}

// ============================================================================
// EVENT LISTENERS & BOOTSTRAP
// ============================================================================
function setSpeed(speed) {
  playClock.setRunning(speed !== 0);
  state.speed = speed;
  document.querySelectorAll("[data-speed]").forEach(button => {
    const active = Number(button.dataset.speed) === speed;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  if (state.role === "dispatcher") renderDispatchDesk(dom.dispatchPanel, state, getWeather(), playClock.read());
}

function setView(view) {
  state.view = view;
  for (const button of document.querySelectorAll("[data-view]")) {
    const active = button.dataset.view === view;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  }
  dom.diagramsContainer.classList.toggle("split-view", view === "split");
  dom.kvelSchematicBox.hidden = view === "basin";
  dom.basinRadarBox.hidden = view === "kvel";
}

function setSurfaceExtent() {
  const dispatch = state.role === "dispatcher";
  const closeUp = dispatch && state.surfaceDetail;
  dom.kvelSvg.setAttribute("viewBox", closeUp ? "270 141 435 354" : "0 0 920 565");
  dom.kvelSvg.classList.toggle("airfield-detail", closeUp);
  dom.surfaceExtent.hidden = dom.dispatchMapLabel.hidden = !dispatch;
  dom.surfaceExtent.textContent = closeUp ? "Show full valley" : "Show airfield detail";
}
dom.surfaceExtent.addEventListener("click", () => {
  state.surfaceDetail = !state.surfaceDetail;
  setSurfaceExtent();
  renderHeaderAndWeather();
});

let viewOutsideDispatch = "split";
let dispatchView = "kvel";
function setRole(role) {
  const wasDispatch = state.role === "dispatcher";
  const dispatch = role === "dispatcher";
  if (wasDispatch !== dispatch) {
    if (dispatch) {
      viewOutsideDispatch = state.view;
      dom.workspace.prepend(dom.workstation);
      setView(dispatchView);
    } else {
      dispatchView = state.view;
      dom.workspace.append(dom.workstation);
      setView(viewOutsideDispatch);
    }
    dom.workspace.classList.toggle("dispatch-mode", dispatch);
    dom.dispatchPanel.hidden = !dispatch;
    dom.roleDeskBody.hidden = dispatch;
    dom.trafficDetails.open = !dispatch;
  }
  state.role = role;
  setSurfaceExtent();
  for (const tab of document.querySelectorAll("[data-role]")) {
    const active = tab.dataset.role === role;
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
  }
  updateReleases(state, getWeather(), playClock.read(), reportDispatch, false);
  renderAll();
}

const roleTabs = [...document.querySelectorAll("[data-role]")];
for (const [index, tab] of roleTabs.entries()) {
  tab.addEventListener("click", () => setRole(tab.dataset.role));
  tab.addEventListener("keydown", e => {
    const target = { ArrowLeft: (index + roleTabs.length - 1) % roleTabs.length,
      ArrowRight: (index + 1) % roleTabs.length, Home: 0, End: roleTabs.length - 1 }[e.key];
    if (target === undefined) return;
    e.preventDefault();
    roleTabs[target].focus();
    setRole(roleTabs[target].dataset.role);
  });
}

for (const button of document.querySelectorAll("[data-speed]")) {
  button.addEventListener("click", () => setSpeed(Number(button.dataset.speed)));
}
for (const button of document.querySelectorAll("[data-view]")) {
  button.addEventListener("click", () => { setView(button.dataset.view); renderAll(); });
}

dom.workspace.addEventListener("click", event => {
  const target = event.target.closest("[data-dispatch-flight],[data-select-flight],[data-flight-id]");
  if (!target) return;
  state.selectedFlightId = target.dataset.dispatchFlight || target.dataset.selectFlight || target.dataset.flightId;
  renderAll();
});
dom.trafficDetails.addEventListener("toggle", renderFlightTable);
dom.dispatchPanel.addEventListener("click", event => {
  const action = event.target.closest("[data-dispatch-action]");
  if (!action || action.getAttribute("aria-disabled") === "true") return;
  const flight = getFlight(state.selectedFlightId);
  if (!flight) return;
  const needs = departureNeeds(flight, getWeather(), state.passengers);
  switch (action.dataset.dispatchAction) {
    case "release":
      if (!releaseFlight(flight, needs, "You")) return;
      reportDispatch(flight, "YOUR DISPATCH DESK", "released for departure");
      break;
    case "hold":
      if (!holdDeparture(flight)) return;
      reportDispatch(flight, "YOUR DISPATCH DESK", "hold acknowledged, crew holding position until your release");
      break;
    case "divert":
      if (!divertFlight(flight)) return;
      reportDispatch(flight, "YOUR DISPATCH DESK", "diverting to " + flight.dest);
      break;
  }
  syncSignallingBlocks();
  renderAll();
});

dom.weatherSelect.addEventListener("change", (e) => {
  state.weatherId = e.target.value;
  const wx = getWeather();
  for (const f of state.flights) {
    if (["FINAL-17", "RNAV-35-FINAL"].includes(f.blockId)) f.blockId = wx.activeRwy === "17" ? "FINAL-17" : "RNAV-35-FINAL";
  }
  updateReleases(state, wx, playClock.read(), reportDispatch, false);
  syncSignallingBlocks();
  emitRadioCall({
    freq: "135.225",
    sender: "KVEL AWOS-3PT",
    message: `Special Weather Update — ${wx.name}. ${wx.metar}`
  });
  renderAll();
});

dom.radioPopupsToggle.addEventListener("change", (e) => {
  state.radioPopupsEnabled = e.target.checked;
});

dom.triggerScenarioBtn.addEventListener("click", triggerNextDynamicScenario);
dom.clearLogBtn.addEventListener("click", () => {
  state.radioLog = [];
  renderRadioLog();
});

dom.resetSimBtn?.addEventListener("click", () => {
  state.simMinutes = 7 * 60 + 5;
  state.blocks = KVEL_BLOCKS.map((b) => ({ ...b }));
  state.flights = initialFleet(getWeather().activeRwy);
  playClock.reset(state.speed !== 0);
  state.nextCrewMinute = state.simMinutes + 1;
  state.radioLog = [];
  for (const toast of [...activeToasts]) dismissToast(toast, false);
  dom.flightTableBody.replaceChildren();
  dom.dispatchPanel.querySelector(".dispatch-roster").replaceChildren();
  state.passengers = PASSENGER_QUEUE.map((p) => ({ ...p }));
  state.rwyClosedTicks = 0;
  state.rwyCloseReason = "";
  state.tickCount = 0;
  state.scenarioIndex = 0;
  state.selectedFlightId = "VTE3101";
  syncSignallingBlocks();
  renderAll();
  emitRadioCall({
    freq: "122.800",
    sender: "VERNAL REGIONAL OPS (KVEL)",
    message: "Simulation reset to 07:05 MST initial Basin operations."
  });
});

// Spacebar toggles pause / 1x when not focused on an interactive form control
document.addEventListener("keydown", (e) => {
  if (e.code !== "Space" || isAnyModalOpen()) return;
  const tag = document.activeElement?.tagName;
  if (["INPUT", "SELECT", "TEXTAREA", "BUTTON"].includes(tag)) return;
  e.preventDefault();
  setSpeed(state.speed === 0 ? 1 : 0);
});

// MANDATORY per dialog guide: read and reset dialog.returnValue on close
dom.airportDialog.addEventListener("close", () => {
  dom.airportDialog.returnValue = "";
});

// Retain the local directory and radio controls on browsers without invoker commands.
if (!("commandForElement" in HTMLButtonElement.prototype)) {
  document.getElementById("openDirectoryBtn").addEventListener("click", () => dom.airportDialog.showModal());
}

// Track last focused non-toast element for accessible focus restoration
document.addEventListener("focusin", (e) => {
  if (!dom.radioToastRegion.contains(e.target)) {
    state.lastFocusedBeforeToast = e.target;
  }
});

// Initialize
renderAirportDirectory();
syncSignallingBlocks();
setSpeed(1);
setView("split");
setRole(location.hash === "#dispatch" ? "dispatcher" : "armchair");
emitRadioCall({
  freq: "122.800", sender: "VERNAL REGIONAL OPS (KVEL)",
  message: state.role === "dispatcher"
    ? "Dispatch on duty. Gate and ramp crews will report when flights are ready for release."
    : "Vernal Regional online. The Armchair Director has the field. Select a desk to take over.",
  logOnly: state.role === "dispatcher"
});

setInterval(stepSimulation, 900);
