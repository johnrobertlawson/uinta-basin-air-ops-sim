import {
  AIRPORTS,
  airportCategory,
  KVEL_BLOCKS,
  WEATHER_REGIMES,
  INITIAL_FLIGHTS,
  PASSENGER_QUEUE
} from "./data.js";
import { PlayClock, departureNeeds, divertFlight, holdDeparture, needsDeicing, releaseFlight } from "./dispatch.js";
import { renderDispatchDesk } from "./dispatch-desk.js";
import { clearRunway, directorWorkload } from "./armchair.js";
import { advanceSecond, dispatchCall, forecastActivity, injectScenario, processCrews, QUIET_GAP_MS, skipToActivity, START_TIME_MS } from "./simulation.js";
import { radarWeather, updateWeatherPosition } from "./weather-map.js";
import { GameSound } from "./sound.js";

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
  simTimeMs: START_TIME_MS,
  speed: 1,
  role: "armchair", // armchair | dispatcher | fbo | tsa | pilot
  directorPace: "gradual",
  pendingMissions: [],
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
  lastFocusedBeforeToast: null
};

const activeToasts = [];
let toastIdSeq = 0;

// ============================================================================
// DOM REFERENCES
// ============================================================================
const dom = {
  simClock: document.getElementById("simClock"),
  radarClock: document.getElementById("radarClock"),
  directorPanel: document.getElementById("directorPanel"),
  directorStatus: document.getElementById("directorStatus"),
  quietPrompt: document.getElementById("quietPrompt"),
  quietDetail: document.getElementById("quietDetail"),
  airportConditions: document.getElementById("airportConditions"),
  metarText: document.getElementById("metarText"),
  methaneBadge: document.getElementById("methaneBadge"),
  weatherSelect: document.getElementById("weatherSelect"),
  radarWeatherSelect: document.getElementById("radarWeatherSelect"),
  radarOutlook: document.getElementById("radarOutlook"),
  radarDialog: document.getElementById("radarDialog"),
  openRadarMap: document.getElementById("openRadarMap"),
  closeRadarMap: document.getElementById("closeRadarMap"),
  radarZoom: document.getElementById("radarZoom"),
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

function formatSimTime(totalMs) {
  const s = Math.floor(totalMs / 1000) % 86_400;
  return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60]
    .map(part => String(part).padStart(2, "0")).join(":") + " MST";
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
const sound = new GameSound(message => { document.getElementById("soundStatus").textContent = message; });

function emitRadioCall({ freq, sender, message, isGuard = false, logOnly = false, voiceClip }) {
  const timeStr = formatSimTime(state.simTimeMs);
  const entry = { id: ++toastIdSeq, timeStr, freq, sender, message, isGuard };
  state.radioLog.unshift(entry);
  if (state.radioLog.length > 50) state.radioLog.pop();
  renderRadioLog();
  sound.receive({ freq, sender, message, isGuard: isGuard || freq === "121.500", logOnly, voiceClip });

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
let lastPlayedMs = playClock.read();
let fractionalMs = 0;
let quietWindow = null;
let dismissedUntil = 0;
let lastRunningSpeed = 1;

function stepSimulation() {
  const played = playClock.read();
  fractionalMs += (played - lastPlayedMs) * state.speed;
  lastPlayedMs = played;
  const seconds = Math.floor(fractionalMs / 1000);
  if (!seconds) {
    if (state.speed && state.role === "dispatcher") {
      if (state.flights.some(f => f.releaseDue != null && f.releaseDue <= played)) {
        processCrews(state, getWeather(), played, emitRadioCall, true);
        syncSignallingBlocks();
        renderAll({ fromTick: true });
      } else renderDispatchDesk(dom.dispatchPanel, state, getWeather(), played);
    }
    return;
  }
  fractionalMs %= 1000;
  const wx = getWeather();
  for (let i = 0; i < seconds; i++) advanceSecond(state, wx, played, emitRadioCall);
  syncSignallingBlocks();
  renderAll({ fromTick: true });
}

function renderQuietPrompt(recheck = false) {
  if (recheck || !quietWindow || quietWindow.until <= state.simTimeMs) {
    quietWindow = forecastActivity(state, getWeather(), playClock.read());
    if (quietWindow) quietWindow.offer = quietWindow.until - state.simTimeMs >= QUIET_GAP_MS;
  }
  const show = state.speed > 0 && quietWindow?.offer && quietWindow.until > dismissedUntil &&
    playClock.read() >= 6000 && !isAnyModalOpen();
  dom.quietPrompt.hidden = !show;
  if (show) dom.quietDetail.textContent = `${quietWindow.event} at ${formatSimTime(quietWindow.until)}.`;
}

document.getElementById("stayQuiet").addEventListener("click", () => {
  if (quietWindow) dismissedUntil = quietWindow.until;
  dom.quietPrompt.hidden = true;
});
document.getElementById("skipQuiet").addEventListener("click", () => {
  if (!quietWindow || !state.speed) return;
  skipToActivity(state, getWeather(), playClock.read(), quietWindow.until, emitRadioCall);
  fractionalMs = 0;
  lastPlayedMs = playClock.read();
  syncSignallingBlocks();
  renderAll();
});

function reportDispatch(flight, sender, decision) {
  emitRadioCall(dispatchCall(flight, sender, decision));
}

function refreshCrewDecisions() {
  processCrews(state, getWeather(), playClock.read(), emitRadioCall);
}

function triggerNextDynamicScenario() {
  injectScenario(state, emitRadioCall);
  refreshCrewDecisions();
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
function renderBasinBackground(wx) {
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
    ${radarWeather(wx)}
    <g transform="translate(953 46)" fill="#a2b6bd" text-anchor="middle">
      <text y="-10" font-size="14" font-weight="700">N</text>
      <path d="M0 -3L6 16 0 12 -6 16Z" fill="none" stroke="currentColor" stroke-width="1.6"/>
    </g>
  `;

  // Render Airports, Helipads & Portals
  for (const apt of Object.values(AIRPORTS)) {
    const { x, y } = apt.coords;
    if (apt.type === "portal") {
      svg += `
        <rect x="${x - 32}" y="${y - 14}" width="64" height="28" fill="var(--chart)" stroke="#6f919a" stroke-width="1.5"/>
        <text x="${x}" y="${y + 4}" text-anchor="middle" fill="#b9cdd1" font-size="15" font-weight="650">${apt.code}</text>
      `;
    } else if (apt.type === "helipad" || apt.type === "patrol" || apt.type === "sar") {
      const color = "#9ebac0";
      svg += `
        <polygon points="${x},${y - 7} ${x + 7},${y + 6} ${x - 7},${y + 6}" fill="var(--chart)" stroke="${color}" stroke-width="1.8"/>
        <text x="${x + 10}" y="${y + 4}" fill="${color}" font-size="14" font-weight="600">${apt.code}</text>
      `;
    } else {
      const category = airportCategory(wx, apt.code);
      const r = apt.type === "hub" ? 11 : 7;
      svg += `<g class="airport-marker cat-${category}" data-airport="${apt.code}">
        <title>${escapeHtml(apt.name)} · ${category}</title>
        <circle cx="${x}" cy="${y}" r="${r}" fill="var(--chart)" stroke="currentColor" stroke-width="2.5"/>
        <circle cx="${x}" cy="${y}" r="2.5" fill="currentColor"/>
        <text class="radar-label" x="${x + r + 5}" y="${y + 3}" fill="currentColor" font-size="15" font-weight="700">${apt.code} · ${category}</text>
        <text class="radar-label" x="${x + r + 5}" y="${y + 19}" fill="var(--text-muted)" font-size="14">${apt.shortName}</text>
      </g>`;
    }
  }

  dom.basinSvg.innerHTML = svg + '<g class="radar-traffic"></g>';
  dom.basinSvg.dataset.weather = wx.id;
  // Protect weather annotations as well as the station labels from aircraft tags.
  weatherLabelBoxes = [...dom.basinSvg.querySelectorAll(".wx-label")].map(label => {
    const { x, y, width, height } = label.getBBox();
    return { x: x - 3, y: y - 2, w: width + 6, h: height + 4 };
  });
}

// Reserve room around fixed map symbols before placing movable aircraft labels.
let weatherLabelBoxes = [];
const radarFacilities = Object.values(AIRPORTS).map(({ code, type, coords: { x, y } }) => ({
  x: x - (type === "portal" ? 35 : 10), y: y - 17,
  w: ["hub", "regional", "basin"].includes(type) ? 134 : type === "portal" ? 70 : 24 + code.length * 10, h: 40
}));

function placeRadarLabel(point, used) {
  const width = 126, height = 36;
  for (const offset of [0, -38, 38, -76, 76, -114, 114, -152, 152, -190, 190, -228, 228, -266, 266]) {
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
  const wx = getWeather();
  if (dom.basinSvg.dataset.weather !== wx.id) renderBasinBackground(wx);
  updateWeatherPosition(dom.basinSvg, state.simTimeMs - START_TIME_MS, getFlight("N842K")?.state === "EMERGENCY");
  const used = [...radarFacilities, ...weatherLabelBoxes,
    { x: 338, y: 75, w: 302, h: 20 }, { x: 368, y: 493, w: 233, h: 22 },
    ...state.flights.map(f => ({ x: f.pos.x - 7, y: f.pos.y - 7, w: 14, h: 14 }))];
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
              Fuel: ${f.fueled ? "Serviced" : "Needs Jet-A/100LL"} | De-Ice: ${f.deiced ? "Sprayed" : needsDeicing(f, wx) ? "Service required" : "Clear"}
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
      clearRunway(state, emitRadioCall);
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
        f.deiceRequested = false;
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
  const time = formatSimTime(state.simTimeMs);
  dom.simClock.textContent = dom.radarClock.textContent = time;
  if (state.role === "armchair") {
    const explanation = {
      off: "Director off duty.",
      gradual: "Crews respond each simulated minute.",
      immediate: "Crews handle requests as they arrive."
    }[state.directorPace];
    dom.directorStatus.textContent = explanation + " " + directorWorkload(state, wx) + ".";
  }
  if (state.role === "dispatcher") {
    const label = "Vernal " + (state.surfaceDetail ? "airfield" : "and Ashley Valley") +
      " · " + (state.rwyClosedTicks > 0 ? "Runway closed" : "Runway " + wx.activeRwy + " active");
    if (label !== dom.dispatchMapLabel.textContent) dom.dispatchMapLabel.textContent = label;
  }
  const outlook = wx.radarOutlook + (getFlight("N842K")?.state === "EMERGENCY" ? " Pilot report of severe icing over Daniels Summit." : "");
  if (dom.radarOutlook.textContent !== outlook) dom.radarOutlook.textContent = outlook;
  if (dom.airportConditions.dataset.weather === wx.id) return;
  dom.airportConditions.dataset.weather = wx.id;
  dom.weatherSelect.value = dom.radarWeatherSelect.value = wx.id;
  dom.airportConditions.innerHTML = ["KVEL", ...Object.keys(wx.nearbyCategories)].map(code => {
    const airport = AIRPORTS[code];
    const category = airportCategory(wx, code);
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
  renderQuietPrompt(!fromTick);
  if (state.view !== "basin") renderKvelSvg();
  if (state.view !== "kvel" || dom.radarDialog.open) renderBasinSvg();
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
  stepSimulation();
  playClock.setRunning(speed !== 0);
  lastPlayedMs = playClock.read();
  state.speed = speed;
  if (speed) lastRunningSpeed = speed;
  document.querySelectorAll("[data-speed]").forEach(button => {
    const active = Number(button.dataset.speed) === speed;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  if (state.role === "dispatcher") renderDispatchDesk(dom.dispatchPanel, state, getWeather(), playClock.read());
  renderQuietPrompt(true);
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
  dom.basinRadarBox.hidden = view === "kvel" && !dom.radarDialog.open;
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
  if (state.role !== role) sound.cue();
  state.role = sound.role = role;
  sound.mix();
  dom.directorPanel.hidden = role !== "armchair";
  setSurfaceExtent();
  for (const tab of document.querySelectorAll("[data-role]")) {
    const active = tab.dataset.role === role;
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
  }
  refreshCrewDecisions();
  renderAll();
}

const roleTabs = [...document.querySelectorAll("[data-role]")];
window.addEventListener("hashchange", event => {
  if (location.hash === "#dispatch") setRole("dispatcher");
  else if (!location.hash && new URL(event.oldURL).hash === "#dispatch") setRole("armchair");
});
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

function selectTraffic(event) {
  const target = event.target.closest("[data-dispatch-flight],[data-select-flight],[data-flight-id]");
  if (!target) return;
  state.selectedFlightId = target.dataset.dispatchFlight || target.dataset.selectFlight || target.dataset.flightId;
  renderAll();
}
dom.workspace.addEventListener("click", selectTraffic);
dom.radarDialog.addEventListener("click", selectTraffic);

dom.directorPanel.addEventListener("change", event => {
  if (event.target.name !== "directorPace") return;
  state.directorPace = event.target.value;
  refreshCrewDecisions();
  syncSignallingBlocks();
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

function changeWeather(e) {
  state.weatherId = e.target.value;
  const wx = getWeather();
  for (const f of state.flights) {
    if (["FINAL-17", "RNAV-35-FINAL"].includes(f.blockId)) f.blockId = wx.activeRwy === "17" ? "FINAL-17" : "RNAV-35-FINAL";
  }
  refreshCrewDecisions();
  syncSignallingBlocks();
  emitRadioCall({
    freq: "135.225",
    sender: "KVEL AWOS-3PT",
    voiceClip: wx.id,
    message: `Special Weather Update — ${wx.name}. ${wx.metar}`
  });
  renderAll();
}
dom.radarWeatherSelect.replaceChildren(...[...dom.weatherSelect.options].map(option => option.cloneNode(true)));
dom.weatherSelect.addEventListener("change", changeWeather);
dom.radarWeatherSelect.addEventListener("change", changeWeather);

dom.basinRadarBox.addEventListener("change", event => {
  const { layer } = event.target.dataset;
  if (layer) dom.basinSvg.classList.toggle("hide-" + layer, !event.target.checked);
});

// The dialog also fills the browser window when native fullscreen is unavailable.
let nativeRadarFullscreen = false;
function setRadarZoom(zoomed) {
  dom.basinRadarBox.classList.toggle("radar-zoomed", zoomed);
  dom.radarZoom.textContent = zoomed ? "Fit basin" : "Zoom in";
  dom.radarZoom.setAttribute("aria-pressed", String(zoomed));
  const viewport = dom.basinSvg.parentElement;
  viewport.scrollLeft = zoomed ? viewport.scrollWidth * .58 - viewport.clientWidth / 2 : 0;
  viewport.scrollTop = zoomed ? (viewport.scrollHeight - viewport.clientHeight) / 2 : 0;
}
dom.radarZoom.addEventListener("click", () => setRadarZoom(!dom.basinRadarBox.classList.contains("radar-zoomed")));
dom.openRadarMap.addEventListener("click", () => {
  dom.radarDialog.append(dom.basinRadarBox);
  dom.basinRadarBox.hidden = false;
  dom.radarDialog.showModal();
  renderBasinSvg();
  setRadarZoom(matchMedia("(max-width: 720px) and (orientation: portrait)").matches);
  dom.closeRadarMap.focus();
  if (document.fullscreenEnabled) {
    dom.basinRadarBox.requestFullscreen().then(() => {
      nativeRadarFullscreen = document.fullscreenElement === dom.basinRadarBox;
    }).catch(() => {});
  }
});
dom.closeRadarMap.addEventListener("click", () => dom.radarDialog.close());
document.addEventListener("fullscreenchange", () => {
  const active = document.fullscreenElement === dom.basinRadarBox;
  if (nativeRadarFullscreen && !active && dom.radarDialog.open) dom.radarDialog.close();
  nativeRadarFullscreen = active;
});
dom.radarDialog.addEventListener("close", () => {
  nativeRadarFullscreen = false;
  if (document.fullscreenElement === dom.basinRadarBox) document.exitFullscreen().catch(() => {});
  dom.radarDialog.returnValue = "";
  setRadarZoom(false);
  dom.diagramsContainer.append(dom.basinRadarBox);
  dom.basinRadarBox.hidden = state.view === "kvel";
  dom.openRadarMap.focus({ preventScroll: true });
});

const soundDialog = document.getElementById("soundDialog");
document.getElementById("openSoundBtn").addEventListener("click", () => soundDialog.showModal());
soundDialog.addEventListener("close", () => { soundDialog.returnValue = ""; });
document.getElementById("previewPilot").addEventListener("click", () => sound.preview("pilot", "Bonanza 842 Kilo"));
document.getElementById("previewWeather").addEventListener("click", () => sound.preview(getWeather().id, "Vernal automated weather"));
document.getElementById("stopVoice").addEventListener("click", () => sound.stopVoice());
document.getElementById("voiceToggle").addEventListener("change", event => {
  sound.voices = event.target.checked;
  if (sound.voices) {
    window.speechSynthesis?.getVoices();
    sound.unlock().catch(error => sound.status(error.message));
  } else sound.stopVoice();
});
document.getElementById("cueToggle").addEventListener("change", async event => {
  sound.effects = event.target.checked;
  if (sound.effects) {
    try { await sound.unlock(); sound.cue(); } catch (error) { sound.status(error.message); }
  }
});
document.getElementById("roomToggle").addEventListener("change", event => sound.setRoom(event.target.checked));
document.getElementById("soundLevel").addEventListener("input", event => {
  sound.level = Number(event.target.value) / 100;
  sound.mix();
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
  sound.stopVoice();
  state.simTimeMs = START_TIME_MS;
  state.blocks = KVEL_BLOCKS.map((b) => ({ ...b }));
  state.flights = initialFleet(getWeather().activeRwy);
  playClock.reset(state.speed !== 0);
  lastPlayedMs = fractionalMs = dismissedUntil = 0;
  quietWindow = null;
  state.directorPace = "gradual";
  dom.directorPanel.querySelector('[value="gradual"]').checked = true;
  state.pendingMissions = [];
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

// Space resumes the most recent running speed outside interactive controls.
document.addEventListener("keydown", (e) => {
  if (e.code !== "Space" || isAnyModalOpen()) return;
  const tag = document.activeElement?.tagName;
  if (["INPUT", "SELECT", "TEXTAREA", "BUTTON"].includes(tag)) return;
  e.preventDefault();
  setSpeed(state.speed === 0 ? lastRunningSpeed : 0);
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
