import {
  AIRPORTS,
  KVEL_BLOCKS,
  WEATHER_REGIMES,
  INITIAL_FLIGHTS,
  PASSENGER_QUEUE,
  DYNAMIC_SCENARIOS
} from "./data.js";

// ============================================================================
// MODERN WEB GUIDANCE CONDITIONAL POLYFILLS & FALLBACKS
// ============================================================================
if (!Object.hasOwn(HTMLElement.prototype, "popover")) {
  import("https://unpkg.com/@oddbird/popover-polyfill@latest/dist/popover.min.js").catch(() => {});
}
if (!("commandForElement" in HTMLButtonElement.prototype)) {
  import("https://unpkg.com/invokers-polyfill@latest/invoker.min.js").catch(() => {});
}

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
const state = {
  simMinutes: 7 * 60 + 5, // 07:05 MST
  speed: 1,
  role: "armchair", // armchair | dispatcher | fbo | tsa | pilot
  view: "split", // split | kvel | basin
  weatherId: "inversion_fog",
  radioPopupsEnabled: true,
  selectedFlightId: "VTE3101",
  blocks: KVEL_BLOCKS.map((b) => ({ ...b })),
  flights: INITIAL_FLIGHTS.map((f) => ({ ...f, pos: { ...f.pos } })),
  passengers: PASSENGER_QUEUE.map((p) => ({ ...p })),
  radioLog: [],
  rwyClosedTicks: 0,
  rwyCloseReason: "",
  tickCount: 0,
  scenarioIndex: 0,
  aiCooldown: 0,
  lastFocusedBeforeToast: null
};

const activeToasts = [];
let toastIdSeq = 0;

// ============================================================================
// DOM REFERENCES
// ============================================================================
const dom = {
  simClock: document.getElementById("simClock"),
  flightCatBadge: document.getElementById("flightCatBadge"),
  metarText: document.getElementById("metarText"),
  methaneBadge: document.getElementById("methaneBadge"),
  weatherSelect: document.getElementById("weatherSelect"),
  radioPopupsToggle: document.getElementById("radioPopupsToggle"),
  diagramsContainer: document.getElementById("diagramsContainer"),
  kvelSchematicBox: document.getElementById("kvelSchematicBox"),
  basinRadarBox: document.getElementById("basinRadarBox"),
  kvelSvg: document.getElementById("kvelSvg"),
  basinSvg: document.getElementById("basinSvg"),
  flightTableBody: document.getElementById("flightTableBody"),
  opsCountBadge: document.getElementById("opsCountBadge"),
  rolePanelTitle: document.getElementById("rolePanelTitle"),
  roleAiBadge: document.getElementById("roleAiBadge"),
  roleDeskBody: document.getElementById("roleDeskBody"),
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
function emitRadioCall({ freq, sender, message, isGuard = false }) {
  const timeStr = formatSimTime(state.simMinutes);
  const entry = { id: ++toastIdSeq, timeStr, freq, sender, message, isGuard };
  state.radioLog.unshift(entry);
  if (state.radioLog.length > 50) state.radioLog.pop();
  renderRadioLog();

  // Suppress popups if user disabled them OR a modal dialog is open
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
  record.el.remove();

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
  const rwyApproach = state.flights.some((f) => ["RNAV-35-FINAL", "HS-35", "HS-17"].includes(f.blockId));
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
  const isArmchair = state.role === "armchair";

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
      }

      // Entering KVEL final approach block
      if (f.dest === "KVEL" && dist < 85 && f.blockId !== "RNAV-35-FINAL" && f.state !== "LANDING") {
        f.blockId = "RNAV-35-FINAL";
        f.state = f.state === "EMERGENCY" ? "EMERGENCY" : "APPROACH";
        f.freq = "122.800";
        f.targetAltFt = 5500;
        emitRadioCall({
          freq: "122.800",
          sender: f.callsign,
          message: `Vernal Traffic, ${f.callsign} 5 miles south on RNAV Runway ${wx.activeRwy} straight-in, ${wx.flightCategory} conditions, Vernal.`
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

    // 3. Surface Movement Progression (TAXI_OUT -> HOLD_SHORT -> TAKEOFF -> ENROUTE)
    if (f.state === "TAXI_OUT" && state.tickCount % 10 === 0) {
      f.blockId = wx.activeRwy === "35" ? "HS-35" : "HS-17";
      f.state = "HOLD_SHORT";
      emitRadioCall({
        freq: "122.800",
        sender: f.callsign,
        message: `Vernal Traffic, ${f.callsign} holding short Runway ${wx.activeRwy} at Alpha, ready for departure.`
      });
    } else if (f.state === "HOLD_SHORT" && state.tickCount % 12 === 0 && state.rwyClosedTicks <= 0) {
      const rwyFree = !state.flights.some((o) => o.id !== f.id && ["RWY-35-THR", "RWY-MID", "RWY-17-THR"].includes(o.blockId));
      if (rwyFree) {
        f.state = "TAKEOFF";
        f.blockId = "RWY-MID";
        f.speedKt = 110;
        emitRadioCall({
          freq: "122.800",
          sender: f.callsign,
          message: `Vernal Traffic, ${f.callsign} departing Runway ${wx.activeRwy}, climbing on course to ${f.dest}.`
        });
      }
    } else if (f.state === "TAKEOFF" && state.tickCount % 8 === 0) {
      f.state = "ENROUTE";
      f.blockId = null;
      f.altFt = 6800;
      f.speedKt = f.category === "contour" || f.category === "private_jet" ? 260 : f.category === "cargo" ? 185 : 120;
      f.freq = "135.775";
      emitRadioCall({
        freq: "135.775",
        sender: f.callsign,
        message: `Salt Lake Center, ${f.callsign} off Vernal passing 6,800 climbing ${f.targetAltFt.toLocaleString()} direct ${f.dest}.`
      });
    }
  }

  // 4. Armchair Mode Autonomous AI Director
  if (isArmchair && state.tickCount % 22 === 0) {
    runArmchairAiTick(wx);
  }

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
    return;
  }

  // Arrived at Basin strip or helipad (74V, U69, 33U, 4V0, UT09, LZ-OURAY, LZ-DINO)
  f.state = "PARKED";
  f.speedKt = 0;
  f.altFt = AIRPORTS[f.dest]?.elev || 5200;
  f.blockId = f.dest === "UT18" ? "ARMC-PAD" : null;
  emitRadioCall({
    freq: AIRPORTS[f.dest]?.ctaf || "122.800",
    sender: f.callsign,
    message: `${f.dest} Traffic, ${f.callsign} safely on the ground at ${AIRPORTS[f.dest]?.name || f.dest}.`
  });
}

function runArmchairAiTick(wx) {
  // Autonomous TSA check-in for pending passengers
  const pendingPax = state.passengers.find((p) => p.status === "pending");
  if (pendingPax) {
    pendingPax.status = pendingPax.correctAction === "clear" ? "cleared" : "resolved";
    const vte = getFlight("VTE3101");
    if (vte && vte.tsaClearedPax < vte.tsaTotalPax) vte.tsaClearedPax++;
    emitRadioCall({
      freq: "129.450",
      sender: "KVEL TSA / CONTOUR GATE",
      message: `AI Agent processed ${pendingPax.name} (${pendingPax.role}): ${pendingPax.correctAction === "clear" ? "Cleared to Gate 1." : "Handled security/hazmat item per FAA protocol."}`
    });
    return;
  }

  // Autonomous FBO / Dispatch for VTE3101 or N604XJ
  const readyToPrep = state.flights.find(
    (f) => ["BOARDING", "PARKED"].includes(f.state) && f.origin === "KVEL" && f.dest !== "KVEL" && (!f.dispatched || !f.fueled || (wx.deiceRequired && !f.deiced))
  );
  if (readyToPrep) {
    if (!readyToPrep.fueled) {
      readyToPrep.fueled = true;
      emitRadioCall({
        freq: "129.450",
        sender: "VERNAL JET CENTER (FBO)",
        message: `${readyToPrep.callsign}, Fuel Truck #1 completed Jet-A upload at ${readyToPrep.blockId || "ramp"}.`
      });
      return;
    }
    if (wx.deiceRequired && !readyToPrep.deiced) {
      readyToPrep.deiced = true;
      emitRadioCall({
        freq: "129.450",
        sender: "VERNAL JET CENTER DE-ICE",
        message: `${readyToPrep.callsign}, Type I & Type IV de-ice complete. Holdover time 35 minutes; clear to taxi.`
      });
      return;
    }
    if (!readyToPrep.dispatched) {
      readyToPrep.dispatched = true;
      readyToPrep.state = "TAXI_OUT";
      readyToPrep.blockId = "TWY-A-S";
      emitRadioCall({
        freq: "122.800",
        sender: readyToPrep.callsign,
        message: `Vernal Traffic, ${readyToPrep.callsign} released by Dispatch, taxiing from ${readyToPrep.category === "contour" ? "Gate 1" : "Vernal Jet Center"} to Runway ${wx.activeRwy} via Alpha.`
      });
      return;
    }
  }

  // Periodically fire dynamic Basin scenario in Armchair Mode
  if (state.tickCount % 66 === 0) {
    triggerNextDynamicScenario();
  }
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

  syncSignallingBlocks();
  renderAll();
}

// ============================================================================
// SVG RENDERER 1: ASHLEY VALLEY & KVEL DLR SIGNALLING DIAGRAM
// ============================================================================
function renderKvelSvg() {
  const wx = getWeather();
  const blockColor = (status) => {
    if (status === "occupied") return { fill: "#450a0a", stroke: "#ef4444", text: "#fecaca" };
    if (status === "reserved") return { fill: "#451a03", stroke: "#f59e0b", text: "#fde68a" };
    if (status === "closed") return { fill: "#3b0764", stroke: "#a855f7", text: "#e9d5ff" };
    return { fill: "#062c22", stroke: "#10b981", text: "#a7f3d0" };
  };

  let svg = `
    <defs>
      <pattern id="dlrGrid" width="32" height="32" patternUnits="userSpaceOnUse">
        <path d="M 32 0 L 0 0 0 32" fill="none" stroke="#111d30" stroke-width="1"/>
      </pattern>
    </defs>
    <rect width="920" height="565" fill="#060c16"/>
    <rect width="920" height="565" fill="url(#dlrGrid)"/>

    <!-- Ashley Valley Geographic Features (Accurate Relative Orientation) -->
    <!-- Asphalt Ridge (SW Terrain Wall) -->
    <path d="M 25 270 L 145 360 L 295 545 L 25 545 Z" fill="#171e2b" stroke="#334155" stroke-width="1.5" stroke-dasharray="5 3"/>
    <text x="42" y="458" fill="#64748b" font-family="monospace" font-size="11" font-weight="700">ASPHALT RIDGE (6,200'+)</text>
    <text x="42" y="474" fill="#475569" font-family="monospace" font-size="9">SW Terrain / Downslope Turbulence</text>

    <!-- Steinaker Reservoir (North) & Red Fleet (NE) -->
    <ellipse cx="470" cy="44" rx="52" ry="18" fill="#0c2d48" stroke="#0284c7" stroke-width="1.2"/>
    <text x="470" y="47" text-anchor="middle" fill="#7dd3fc" font-family="monospace" font-size="9">STEINAKER RES.</text>
    <ellipse cx="785" cy="52" rx="46" ry="16" fill="#0c2d48" stroke="#0284c7" stroke-width="1.2"/>
    <text x="785" y="55" text-anchor="middle" fill="#7dd3fc" font-family="monospace" font-size="9">RED FLEET RES.</text>

    <!-- Split Mountain / Dinosaur NM East -->
    <path d="M 855 150 L 910 185 L 910 355 L 860 390 Z" fill="#1f1714" stroke="#78350f" stroke-width="1.2"/>
    <text x="875" y="265" fill="#d97706" font-family="monospace" font-size="10" transform="rotate(-90 875 265)" text-anchor="middle">SPLIT MTN / DINOSAUR NM →</text>

    <!-- US-40 Highway & Vernal Downtown -->
    <path d="M 35 225 L 305 225 L 495 450 L 895 495" fill="none" stroke="#475569" stroke-width="3" stroke-dasharray="8 4"/>
    <text x="72" y="216" fill="#94a3b8" font-family="monospace" font-size="10">US-40 W (Vernal Main St → Roosevelt)</text>
    <text x="715" y="514" fill="#94a3b8" font-family="monospace" font-size="10">US-40 SE (Jensen / Ashley Creek)</text>

    <!-- Ashley Creek (Fog Corridor) -->
    <path d="M 340 20 Q 430 140 670 340 T 860 550" fill="none" stroke="#0369a1" stroke-width="2" opacity="0.55"/>
    <text x="720" y="390" fill="#38bdf8" font-family="monospace" font-size="9" opacity="0.8">Ashley Creek (Radiation Fog Basin)</text>

    <!-- Historical Crosswind 07/25 Ghost Strip -->
    <line x1="425" y1="358" x2="695" y2="270" stroke="#334155" stroke-width="14" stroke-dasharray="6 4" opacity="0.5"/>
    <text x="646" y="280" fill="#64748b" font-family="monospace" font-size="8.5" transform="rotate(-18 646 280)">OLD 07/25 (CLOSED)</text>

    <!-- DLR-Style Pattern & Taxi Track Interconnects -->
    <path d="M 608 165 L 608 98 L 780 98 L 780 465 L 608 465" fill="none" stroke="#1e3a5f" stroke-width="2" stroke-dasharray="4 4"/>
    <line x1="446" y1="202" x2="472" y2="202" stroke="#3b5380" stroke-width="3"/>
    <line x1="446" y1="296" x2="472" y2="296" stroke="#3b5380" stroke-width="3"/>
    <line x1="446" y1="362" x2="472" y2="362" stroke="#3b5380" stroke-width="3"/>
    <line x1="446" y1="415" x2="472" y2="415" stroke="#3b5380" stroke-width="3"/>
    <line x1="526" y1="194" x2="580" y2="194" stroke="#f59e0b" stroke-width="3"/>
    <line x1="526" y1="440" x2="580" y2="440" stroke="#f59e0b" stroke-width="3"/>

    <!-- Active Wind & Runway Callout -->
    <rect x="20" y="18" width="235" height="62" rx="5" fill="#0b1322" stroke="#243452"/>
    <text x="30" y="36" fill="#22d3ee" font-family="monospace" font-size="11" font-weight="700">ACTIVE RWY: ${wx.activeRwy} • ${wx.flightCategory}</text>
    <text x="30" y="52" fill="#e2e8f0" font-family="monospace" font-size="10">WIND: ${String(wx.windDir).padStart(3, "0")}° @ ${wx.windKt}${wx.gustKt ? "G" + wx.gustKt : ""} KT</text>
    <text x="30" y="68" fill="${wx.deiceRequired ? "#fbbf24" : "#34d399"}" font-family="monospace" font-size="10">TEMP ${wx.tempC}°C • ${wx.deiceRequired ? "DE-ICE REQUIRED" : "DRY RAMP"}</text>
  `;

  // Render Signalling Blocks
  for (const b of state.blocks) {
    const col = blockColor(b.status);
    const hasFlight = Boolean(b.occupant && getFlight(b.occupant));
    const isSelBlock = hasFlight && b.occupant === state.selectedFlightId;
    svg += `
      <g class="signal-block" data-block="${b.id}" ${hasFlight ? `data-flight-id="${b.occupant}" style="cursor:pointer;"` : ""}>
        <rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="4"
          fill="${col.fill}" stroke="${isSelBlock ? "#ffffff" : col.stroke}" stroke-width="${isSelBlock ? 2.5 : b.type === "runway" ? 2.2 : 1.5}"/>
        <text x="${b.x + b.w / 2}" y="${b.y + 13}" text-anchor="middle" fill="${col.text}" font-family="monospace" font-size="8.5" font-weight="700">${b.id}</text>
        <text x="${b.x + b.w / 2}" y="${b.y + b.h - 7}" text-anchor="middle" fill="#cbd5e1" font-family="monospace" font-size="8">
          ${b.occupant ? "✈ " + b.occupant : b.label.slice(0, 15)}
        </text>
      </g>
    `;
  }

  // Runway 17 / 35 Threshold Numbers
  svg += `
    <text x="608" y="158" text-anchor="middle" fill="#ffffff" font-family="monospace" font-size="12" font-weight="700">17 ▼</text>
    <text x="608" y="482" text-anchor="middle" fill="#ffffff" font-family="monospace" font-size="12" font-weight="700">▲ 35</text>
  `;

  dom.kvelSvg.innerHTML = svg;
  dom.kvelSvg.querySelectorAll(".signal-block[data-flight-id]").forEach((el) => {
    el.addEventListener("click", () => {
      state.selectedFlightId = el.dataset.flightId;
      renderAll();
    });
  });
}

// ============================================================================
// SVG RENDERER 2: UINTA BASIN REGIONAL AIRSPACE & OFF-MAP PORTALS RADAR
// ============================================================================
function renderBasinSvg() {
  let svg = `
    <rect width="1000" height="620" fill="#050a12"/>
    <!-- Basin Topography Hints -->
    <!-- High Uintas North Wall -->
    <path d="M 80 120 Q 350 75 610 115 T 920 95" fill="none" stroke="#334155" stroke-width="2" stroke-dasharray="10 4"/>
    <text x="340" y="92" fill="#64748b" font-family="monospace" font-size="11" font-weight="700">HIGH UINTA MOUNTAINS (11,000'–13,528' MSL)</text>

    <!-- Tavaputs / Book Cliffs South Wall -->
    <path d="M 110 495 Q 480 475 880 510" fill="none" stroke="#334155" stroke-width="2" stroke-dasharray="10 4"/>
    <text x="370" y="510" fill="#64748b" font-family="monospace" font-size="11">TAVAPUTS PLATEAU &amp; BOOK CLIFFS</text>

    <!-- Green River & White River -->
    <path d="M 605 135 Q 690 215 700 270 Q 615 335 525 425 L 480 560" fill="none" stroke="#0369a1" stroke-width="2.2" opacity="0.55"/>

    <!-- V200 / J15 / J60 Regional Airways -->
    <line x1="38" y1="245" x2="580" y2="310" stroke="#1e293b" stroke-width="1.5" stroke-dasharray="4 4"/>
    <line x1="580" y1="310" x2="960" y2="300" stroke="#1e293b" stroke-width="1.5" stroke-dasharray="4 4"/>
    <line x1="580" y1="310" x2="565" y2="590" stroke="#1e293b" stroke-width="1.5" stroke-dasharray="4 4"/>
    <line x1="580" y1="310" x2="670" y2="45" stroke="#1e293b" stroke-width="1.5" stroke-dasharray="4 4"/>
    <line x1="580" y1="310" x2="245" y2="545" stroke="#1e293b" stroke-width="1.5" stroke-dasharray="4 4"/>
    <line x1="580" y1="310" x2="870" y2="565" stroke="#1e293b" stroke-width="1.5" stroke-dasharray="4 4"/>

    <!-- 25nm & 50nm Range Rings centered on KVEL -->
    <circle cx="580" cy="310" r="105" fill="none" stroke="#13233b" stroke-width="1.2"/>
    <circle cx="580" cy="310" r="220" fill="none" stroke="#13233b" stroke-width="1.2"/>
    <text x="688" y="306" fill="#334155" font-family="monospace" font-size="9">20nm KVEL</text>
  `;

  // Render Airports, Helipads & Portals
  for (const apt of Object.values(AIRPORTS)) {
    const { x, y } = apt.coords;
    if (apt.type === "portal") {
      svg += `
        <rect x="${x - 32}" y="${y - 14}" width="64" height="28" rx="4" fill="#1e1b4b" stroke="#818cf8" stroke-width="1.5"/>
        <text x="${x}" y="${y + 4}" text-anchor="middle" fill="#c7d2fe" font-family="monospace" font-size="11" font-weight="700">${apt.code}</text>
      `;
    } else if (apt.type === "hub") {
      svg += `
        <circle cx="${x}" cy="${y}" r="11" fill="#064e3b" stroke="#22d3ee" stroke-width="2.5"/>
        <text x="${x + 15}" y="${y - 4}" fill="#22d3ee" font-family="monospace" font-size="12" font-weight="700">KVEL (HOME)</text>
        <text x="${x + 15}" y="${y + 9}" fill="#94a3b8" font-family="monospace" font-size="9">5,281' • CTAF 122.8</text>
      `;
    } else if (apt.type === "helipad" || apt.type === "patrol" || apt.type === "sar") {
      const color = apt.type === "sar" ? "#ef4444" : apt.type === "patrol" ? "#f59e0b" : "#ec4899";
      svg += `
        <polygon points="${x},${y - 7} ${x + 7},${y + 6} ${x - 7},${y + 6}" fill="#0f172a" stroke="${color}" stroke-width="1.8"/>
        <text x="${x + 10}" y="${y + 4}" fill="${color}" font-family="monospace" font-size="9.5" font-weight="700">${apt.code}</text>
      `;
    } else {
      const stroke = apt.type === "regional" ? "#60a5fa" : "#34d399";
      svg += `
        <circle cx="${x}" cy="${y}" r="6" fill="#0f172a" stroke="${stroke}" stroke-width="1.8"/>
        <text x="${x + 10}" y="${y + 4}" fill="${stroke}" font-family="monospace" font-size="10.5" font-weight="700">${apt.code}</text>
      `;
    }
  }

  // Render Live Moving Aircraft Targets
  for (const f of state.flights) {
    const isSel = f.id === state.selectedFlightId;
    const isEmg = f.state === "EMERGENCY" || f.squawk === "7700";
    const color = isEmg
      ? "#ef4444"
      : f.category === "contour"
      ? "#22d3ee"
      : f.category === "cargo"
      ? "#fbbf24"
      : f.category === "medevac" || f.category === "sar"
      ? "#f472b6"
      : "#4ade80";

    const rad = ((f.heading - 90) * Math.PI) / 180;
    const vx = f.pos.x + Math.cos(rad) * (f.speedKt > 0 ? 18 : 0);
    const vy = f.pos.y + Math.sin(rad) * (f.speedKt > 0 ? 18 : 0);

    svg += `
      <g class="radar-target" data-flight-id="${f.id}" style="cursor:pointer;">
        ${f.speedKt > 0 ? `<line x1="${f.pos.x}" y1="${f.pos.y}" x2="${vx}" y2="${vy}" stroke="${color}" stroke-width="1.5"/>` : ""}
        <circle cx="${f.pos.x}" cy="${f.pos.y}" r="${isSel ? 7 : 5}" fill="${color}" stroke="${isSel ? "#ffffff" : "#050a12"}" stroke-width="${isSel ? 2 : 1}"/>
        <text x="${f.pos.x + 10}" y="${f.pos.y - 6}" fill="${color}" font-family="monospace" font-size="9.5" font-weight="700">${f.id}</text>
        <text x="${f.pos.x + 10}" y="${f.pos.y + 5}" fill="#cbd5e1" font-family="monospace" font-size="8.5">${Math.round(f.altFt / 100)} ${f.speedKt}kt →${f.dest}</text>
      </g>
    `;
  }

  dom.basinSvg.innerHTML = svg;
  dom.basinSvg.querySelectorAll(".radar-target").forEach((el) => {
    el.addEventListener("click", () => {
      state.selectedFlightId = el.dataset.flightId;
      renderAll();
    });
  });
}

// ============================================================================
// TRAFFIC TABLE & ROLE WORKSTATIONS
// ============================================================================
function renderFlightTable() {
  dom.opsCountBadge.textContent = `${state.flights.length} ACTIVE OPS • ${state.flights.filter((f) => f.state !== "PARKED" && f.state !== "BOARDING").length} AIRBORNE/TAXI`;
  dom.flightTableBody.innerHTML = state.flights
    .map(
      (f) => `
      <tr class="${f.id === state.selectedFlightId ? "selected-row" : ""}" data-select-flight="${f.id}" style="cursor:pointer;">
        <td><strong>${escapeHtml(f.callsign)}</strong><br><span style="color:var(--text-muted);font-size:0.7rem;">${f.tail}</span></td>
        <td>${escapeHtml(f.type)}<br><span style="color:var(--text-muted);font-size:0.7rem;">${escapeHtml(f.operator)}</span></td>
        <td><strong>${f.origin} → ${f.dest}</strong><br><span style="color:var(--text-muted);font-size:0.7rem;">ALT: ${f.alternate}</span></td>
        <td><span class="state-pill state-${f.state}">${f.state}</span><br><span style="color:var(--text-muted);font-size:0.7rem;">${f.blockId || "AIRSPACE"}</span></td>
        <td>${f.altFt.toLocaleString()}'<br>${f.speedKt} kt</td>
        <td>${f.squawk}<br><span style="color:var(--accent-cyan);">${f.freq}</span></td>
      </tr>
    `
    )
    .join("");

  dom.flightTableBody.querySelectorAll("[data-select-flight]").forEach((row) => {
    row.addEventListener("click", () => {
      state.selectedFlightId = row.dataset.selectFlight;
      renderAll();
    });
  });
}

function renderRoleWorkstation() {
  const wx = getWeather();
  const sel = getFlight(state.selectedFlightId) || state.flights[0];

  const titles = {
    armchair: ["Armchair Mode — Autonomous AI Director", "AI AUTO: ON"],
    dispatcher: ["Flight Dispatcher — Contour / Alpine / Exec", "MANUAL DISPATCH"],
    fbo: ["FBO & Ramp Agent — Vernal Jet Center (KVEL)", "RAMP CONTROL"],
    tsa: ["TSA & Airline Ticketing — KVEL Terminal Gate 1", "CHECKPOINT LIVE"],
    pilot: ["Pilot Command — Active Flight Deck", "PILOT IN COMMAND"]
  };
  dom.rolePanelTitle.textContent = titles[state.role][0];
  dom.roleAiBadge.textContent = titles[state.role][1];

  if (state.role === "armchair") {
    dom.roleDeskBody.innerHTML = `
      <div class="role-card">
        <h3>Autonomous Basin Operations Overview</h3>
        <p style="margin:0 0 0.5rem 0; font-size:0.8rem; color:var(--text-muted);">${escapeHtml(wx.summary)}</p>
        <div style="display:flex; flex-wrap:wrap; gap:0.4rem;">
          <button type="button" class="btn btn-amber" id="armchairScenBtn">⚡ Inject Dynamic Incident</button>
          <button type="button" class="btn" id="armchairMethaneBtn">🛰️ Trigger Methane Plume Call</button>
          <button type="button" class="btn btn-crimson" id="armchair7700Btn">🚨 Inject 7700 Icing Emergency</button>
        </div>
      </div>
      <div class="role-card">
        <h3>Selected Target Telemetry: ${escapeHtml(sel.callsign)}</h3>
        <p style="margin:0; font-size:0.78rem; font-family:var(--font-mono); color:var(--text-muted);">
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
    const dispatchable = state.flights.filter((f) => ["contour", "cargo", "private_jet"].includes(f.category));
    dom.roleDeskBody.innerHTML = dispatchable
      .map(
        (f) => `
        <div class="role-card">
          <h3><span>${escapeHtml(f.callsign)} (${f.type})</span><span class="state-pill state-${f.state}">${f.state}</span></h3>
          <div style="font-size:0.76rem; font-family:var(--font-mono); color:var(--text-muted); margin-bottom:0.5rem;">
            Route: <strong>${f.origin} → ${f.dest}</strong> | Alternate: <strong>${f.alternate}</strong> | Fuel: ${f.fuelLbs} lbs<br>
            Fueled: ${f.fueled ? "✅" : "❌"} | De-Iced: ${f.deiced ? "✅" : wx.deiceRequired ? "⚠️ REQUIRED" : "✅ N/A"} | Released: ${f.dispatched ? "✅" : "⏳ PENDING"}
          </div>
          <div style="display:flex; flex-wrap:wrap; gap:0.35rem;">
            <button type="button" class="btn btn-emerald" data-disp-release="${f.id}">Release Flight Plan</button>
            <button type="button" class="btn btn-amber" data-disp-divert="${f.id}">Divert to ${f.alternate}</button>
            <button type="button" class="btn" data-disp-hold="${f.id}">Hold for Wx</button>
          </div>
        </div>
      `
      )
      .join("");

    dom.roleDeskBody.querySelectorAll("[data-disp-release]").forEach((btn) =>
      btn.addEventListener("click", () => {
        const f = getFlight(btn.dataset.dispRelease);
        if (!f) return;
        if (!f.fueled && f.origin === "KVEL") {
          emitRadioCall({ freq: "129.450", sender: "DISPATCH DESK", message: `Cannot release ${f.callsign}: fuel upload incomplete — request Vernal Jet Center (FBO) fuel truck first!` });
          return;
        }
        if (wx.deiceRequired && !f.deiced && f.origin === "KVEL") {
          emitRadioCall({ freq: "129.450", sender: "DISPATCH DESK", message: `Cannot release ${f.callsign}: KVEL temp is ${wx.tempC}°C — request FBO Type I/IV de-ice first!` });
          return;
        }
        f.dispatched = true;
        if (["BOARDING", "PARKED"].includes(f.state)) {
          f.state = "TAXI_OUT";
          f.blockId = "TWY-A-S";
        }
        emitRadioCall({ freq: "129.450", sender: "FLIGHT DISPATCH", message: `${f.callsign} release signed for ${f.origin}-${f.dest} (Alternate ${f.alternate}), fuel ${f.fuelLbs} lbs verified. Cleared for pushback and taxi.` });
        renderAll();
      })
    );
    dom.roleDeskBody.querySelectorAll("[data-disp-divert]").forEach((btn) =>
      btn.addEventListener("click", () => {
        const f = getFlight(btn.dataset.dispDivert);
        if (!f) return;
        f.dest = f.alternate;
        f.blockId = null;
        if (f.state === "APPROACH") f.state = "ENROUTE";
        emitRadioCall({ freq: "135.775", sender: "FLIGHT DISPATCH", message: `${f.callsign}, amending release due to Uinta Basin weather — divert directly to alternate ${f.alternate}.` });
        renderAll();
      })
    );
    dom.roleDeskBody.querySelectorAll("[data-disp-hold]").forEach((btn) =>
      btn.addEventListener("click", () => {
        const f = getFlight(btn.dataset.dispHold);
        if (!f) return;
        f.dispatched = false;
        emitRadioCall({ freq: "129.450", sender: "FLIGHT DISPATCH", message: `${f.callsign}, holding departure at ${f.origin} pending updated KVEL AWOS visibility report.` });
        renderAll();
      })
    );
    return;
  }

  if (state.role === "fbo") {
    const rampFlights = state.flights.filter((f) => ["GATE-1", "FBO-1", "FBO-2", "CARGO-PAD", "GA-HANGAR"].includes(f.blockId));
    dom.roleDeskBody.innerHTML = `
      <div class="role-card">
        <h3>KVEL Runway 17/35 &amp; Surface Ops</h3>
        <p style="margin:0 0 0.5rem 0; font-size:0.78rem; color:var(--text-muted);">
          Runway Status: <strong>${state.rwyClosedTicks > 0 ? "CLOSED (" + state.rwyCloseReason + ")" : "OPEN — Active Rwy " + wx.activeRwy}</strong>
        </p>
        <div style="display:flex; flex-wrap:wrap; gap:0.35rem;">
          <button type="button" class="btn btn-amber" id="fboWildlifeBtn">🦌 Run Wildlife / FOD Sweep (Close Rwy)</button>
          <button type="button" class="btn btn-emerald" id="fboOpenRwyBtn">✅ Clear &amp; Reopen Rwy 17/35</button>
        </div>
      </div>
      ${
        rampFlights.length > 0
          ? rampFlights
              .map(
                (f) => `
          <div class="role-card">
            <h3><span>${f.blockId}: ${escapeHtml(f.callsign)}</span><span style="font-size:0.72rem;color:var(--accent-cyan);">${f.type}</span></h3>
            <div style="font-size:0.75rem; font-family:var(--font-mono); color:var(--text-muted); margin-bottom:0.45rem;">
              Fuel: ${f.fueled ? "✅ Serviced" : "⛽ Needs Jet-A/100LL"} | De-Ice: ${f.deiced ? "✅ Sprayed" : wx.deiceRequired ? "❄️ Frost Present" : "✅ Clear"}
            </div>
            <div style="display:flex; flex-wrap:wrap; gap:0.35rem;">
              <button type="button" class="btn" data-fbo-fuel="${f.id}">⛽ Dispatch Fuel Truck</button>
              <button type="button" class="btn btn-amber" data-fbo-deice="${f.id}">❄️ Type I/IV De-Ice Spray</button>
              <button type="button" class="btn btn-emerald" data-fbo-marshall="${f.id}">🦺 Marshall to TWY Alpha</button>
            </div>
          </div>
        `
              )
              .join("")
          : `<div class="role-card"><p style="margin:0; font-size:0.8rem; color:var(--text-muted);">All KVEL ramp stands (Gate 1, Vernal Jet Center, Cargo Pad, GA Hangar) are currently clear — awaiting next arrival.</p></div>`
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
        <p style="margin:0; font-size:0.78rem; font-family:var(--font-mono); color:var(--accent-cyan);">
          Gate 1 Cleared Pax: ${vte ? vte.tsaClearedPax : 0} / ${vte ? vte.tsaTotalPax : 27} • Inspect ID, Checked Firearms/Hazmat, &amp; X-Ray Carry-Ons
        </p>
      </div>
      ${state.passengers
        .map(
          (p) => `
          <div class="role-card" style="opacity:${p.status === "pending" ? 1 : 0.65};">
            <h3><span>${escapeHtml(p.name)} — ${escapeHtml(p.role)}</span><span class="state-pill state-${p.status === "pending" ? "HOLD_SHORT" : "TAKEOFF"}">${p.status.toUpperCase()}</span></h3>
            <div style="font-size:0.75rem; font-family:var(--font-mono); color:var(--text-muted); margin-bottom:0.45rem;">
              ID: ${escapeHtml(p.idStatus)}<br>
              Checked: ${escapeHtml(p.checkedBag)}<br>
              X-Ray Carry-On: <span style="color:#fde68a;">${escapeHtml(p.carryOn)}</span>
            </div>
            ${
              p.status === "pending"
                ? `<div style="display:flex; flex-wrap:wrap; gap:0.35rem;">
                    <button type="button" class="btn btn-emerald" data-tsa-act="clear" data-pax="${p.id}">✅ Clear to Gate 1</button>
                    <button type="button" class="btn btn-amber" data-tsa-act="require_declaration" data-pax="${p.id}">📋 Counter Declaration / Repack</button>
                    <button type="button" class="btn btn-amber" data-tsa-act="secondary_search" data-pax="${p.id}">🔍 Confiscate Hazmat / Secondary</button>
                    <button type="button" class="btn btn-crimson" data-tsa-act="deny_boarding" data-pax="${p.id}">🚫 Deny Boarding &amp; Call LEO</button>
                  </div>`
                : `<div style="font-size:0.74rem; color:#6ee7b7;">Outcome: ${escapeHtml(p.issue)}</div>`
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
        pax.status = ok ? "cleared" : "flagged";
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
      <h3>Active Cockpit: ${escapeHtml(sel.callsign)} (${escapeHtml(sel.type)})</h3>
      <div style="font-size:0.76rem; font-family:var(--font-mono); color:var(--text-muted); margin-bottom:0.55rem;">
        Route: <strong>${sel.origin} → ${sel.dest}</strong> | State: <strong>${sel.state}</strong> | Alt: ${sel.altFt.toLocaleString()}' | Spd: ${sel.speedKt} kt | Squawk: <strong>${sel.squawk}</strong><br>
        Mission: ${escapeHtml(sel.pilotNotes)}
      </div>
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:0.4rem; margin-bottom:0.55rem;">
        <label style="font-size:0.74rem; font-family:var(--font-mono);">Destination Airport / LZ
          <select id="pilotDestSelect" class="btn" style="width:100%; margin-top:0.2rem;">
            ${Object.values(AIRPORTS)
              .map((a) => `<option value="${a.code}" ${a.code === sel.dest ? "selected" : ""}>${a.code} — ${escapeHtml(a.name.slice(0, 26))}</option>`)
              .join("")}
          </select>
        </label>
        <label style="font-size:0.74rem; font-family:var(--font-mono);">Transponder Squawk
          <select id="pilotSquawkSelect" class="btn" style="width:100%; margin-top:0.2rem;">
            <option value="1200" ${sel.squawk === "1200" ? "selected" : ""}>1200 (VFR Basin)</option>
            <option value="4215" ${sel.squawk === "4215" ? "selected" : ""}>4215 (IFR ZLC)</option>
            <option value="7700" ${sel.squawk === "7700" ? "selected" : ""}>7700 (EMERGENCY)</option>
            <option value="7600" ${sel.squawk === "7600" ? "selected" : ""}>7600 (RADIO FAIL)</option>
          </select>
        </label>
      </div>
      <div style="display:flex; flex-wrap:wrap; gap:0.35rem;">
        <button type="button" class="btn btn-emerald" id="pilotLaunchBtn">🛫 Taxi / Takeoff / Fly to Dest</button>
        <button type="button" class="btn" id="pilotPatternBtn">🔄 Fly KVEL Rwy 35 Pattern</button>
        <button type="button" class="btn btn-amber" id="pilotCtafBtn">📻 Announce Position on CTAF</button>
        <button type="button" class="btn btn-crimson" id="pilotMaydayBtn">🚨 Declare 7700 Emergency</button>
      </div>
    </div>
    <div class="role-card">
      <h3>Quick-Select Pilot Missions (All Requested Aircraft Types)</h3>
      <div style="display:flex; flex-wrap:wrap; gap:0.35rem;">
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
    if (sel.state === "PARKED" || sel.state === "BOARDING") {
      // Find nearest airport if parked away from origin
      const atKvel = Boolean(sel.blockId && ["GATE-1", "FBO-1", "FBO-2", "CARGO-PAD", "GA-HANGAR"].includes(sel.blockId));
      const currentCode = atKvel ? "KVEL" : sel.dest;
      if (sel.dest === currentCode && !atKvel) {
        emitRadioCall({
          freq: sel.freq,
          sender: sel.callsign,
          message: `Select a new destination airport or LZ before departing ${currentCode}.`
        });
        return;
      }
      if (!atKvel) sel.origin = currentCode;
    }
    sel.dispatched = true;
    const isKvelRamp = Boolean(sel.blockId && ["GATE-1", "FBO-1", "FBO-2", "CARGO-PAD", "GA-HANGAR"].includes(sel.blockId));
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
      message: `Vernal Traffic, ${sel.callsign} departing for ${sel.dest} (${AIRPORTS[sel.dest]?.name || sel.dest}).`
    });
    syncSignallingBlocks();
    renderAll();
  });
  document.getElementById("pilotPatternBtn")?.addEventListener("click", () => {
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
          <div><span class="freq-chip">${entry.freq}</span> <strong>${escapeHtml(entry.sender)}</strong> <span style="color:var(--text-muted);">[${entry.timeStr}]</span></div>
          <div style="color:#dce7f7; margin-top:2px;">"${escapeHtml(entry.message)}"</div>
        </div>
      `;
    })
    .join("");
}

function renderHeaderAndWeather() {
  const wx = getWeather();
  dom.simClock.textContent = formatSimTime(state.simMinutes);
  dom.flightCatBadge.textContent = wx.flightCategory;
  dom.flightCatBadge.className = `flight-cat-badge cat-${wx.flightCategory}`;
  dom.metarText.textContent = wx.metar;
  dom.methaneBadge.textContent = `• Basin CH4/Inversion: ${wx.methaneTrapping}`;
  dom.wxBriefingNote.textContent = `Current Active Weather Regime: ${wx.name} — ${wx.summary}`;
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
  renderKvelSvg();
  renderBasinSvg();
  renderFlightTable();
  // Avoid clobbering open <select>/<input> controls inside the role desk during background ticks
  const active = document.activeElement;
  const interactingWithDeskInput =
    fromTick &&
    active &&
    dom.roleDeskBody.contains(active) &&
    ["SELECT", "INPUT", "TEXTAREA"].includes(active.tagName);
  if (!interactingWithDeskInput) {
    renderRoleWorkstation();
  }
}

// ============================================================================
// EVENT LISTENERS & BOOTSTRAP
// ============================================================================
document.querySelectorAll("[data-speed]").forEach((btn) => {
  btn.addEventListener("click", () => {
    state.speed = Number(btn.dataset.speed);
    document.querySelectorAll("[data-speed]").forEach((b) => b.classList.toggle("active", b === btn));
  });
});

document.querySelectorAll("[data-role]").forEach((tab) => {
  tab.addEventListener("click", () => {
    state.role = tab.dataset.role;
    document.querySelectorAll("[data-role]").forEach((t) => t.setAttribute("aria-selected", String(t === tab)));
    renderRoleWorkstation();
  });
});

document.querySelectorAll("[data-view]").forEach((btn) => {
  btn.addEventListener("click", () => {
    state.view = btn.dataset.view;
    document.querySelectorAll("[data-view]").forEach((b) => b.classList.toggle("active", b === btn));
    dom.diagramsContainer.classList.toggle("split-view", state.view === "split");
    dom.kvelSchematicBox.style.display = state.view === "basin" ? "none" : "block";
    dom.basinRadarBox.style.display = state.view === "kvel" ? "none" : "block";
  });
});

dom.weatherSelect.addEventListener("change", (e) => {
  state.weatherId = e.target.value;
  const wx = getWeather();
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
  state.flights = INITIAL_FLIGHTS.map((f) => ({ ...f, pos: { ...f.pos } }));
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
  state.speed = state.speed === 0 ? 1 : 0;
  document.querySelectorAll("[data-speed]").forEach((b) =>
    b.classList.toggle("active", Number(b.dataset.speed) === state.speed)
  );
});

// MANDATORY per dialog guide: read and reset dialog.returnValue on close
dom.airportDialog.addEventListener("close", () => {
  dom.airportDialog.returnValue = "";
});

// Track last focused non-toast element for accessible focus restoration
document.addEventListener("focusin", (e) => {
  if (!dom.radioToastRegion.contains(e.target)) {
    state.lastFocusedBeforeToast = e.target;
  }
});

// Initialize
renderAirportDirectory();
syncSignallingBlocks();
renderAll();

emitRadioCall({
  freq: "122.800",
  sender: "VERNAL REGIONAL OPS (KVEL)",
  message: "Welcome to Uinta Basin Air Ops Simulator. Armchair AI Director is live — watch Ashley Valley signalling blocks, or switch roles above to take over Dispatch, FBO, TSA, or Pilot Command."
});

setInterval(stepSimulation, 900);
