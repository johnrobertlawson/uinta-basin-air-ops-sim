import { AIRPORTS, DYNAMIC_SCENARIOS } from "./data.js";
import { advanceSurfaceDeparture, isDeparture, needsDeicing, priorityOnFinal, updateReleases } from "./dispatch.js";
import { assignMission, clearRunway, runDirector, runGroundCrews } from "./armchair.js";

export const START_TIME_MS = (7 * 60 + 5) * 60_000;
export const QUIET_GAP_MS = 45_000;

function decisionPending(state, wx) {
  if (state.flights.some(f => f.releaseDue != null || f.state === "EMERGENCY")) return true;
  const manualDirector = state.role === "armchair" && state.directorPace === "off";
  if ((manualDirector || state.role === "tsa") && state.passengers.some(p => ["pending", "flagged"].includes(p.status))) return true;
  if ((manualDirector || state.role === "fbo") && (state.rwyClosedTicks > 0 ||
    state.flights.some(f => isDeparture(f) && (!f.fueled || needsDeicing(f, wx))))) return true;
  return manualDirector && state.pendingMissions.length > 0;
}

// Forecast and skip use the live simulation rules. Only committed steps reach the radio.
function advanceToActivity(state, wx, playedMs, until, radio) {
  let event = "";
  const hear = call => {
    event ||= "Next call from " + call.sender;
    if (radio) radio(call);
  };
  while (state.simTimeMs < until && !event) {
    const movement = advanceSecond(state, wx, playedMs, hear);
    event ||= movement;
  }
  return { until: state.simTimeMs, event: event || "Next quiet-period check" };
}

export function forecastActivity(state, wx, playedMs) {
  if (decisionPending(state, wx)) return null;
  const forecast = { ...state, flights: structuredClone(state.flights),
    passengers: state.passengers.map(p => ({ ...p })), pendingMissions: [...state.pendingMissions] };
  return advanceToActivity(forecast, wx, playedMs, state.simTimeMs + 5 * 60_000);
}

export function skipToActivity(state, wx, playedMs, until, radio) {
  if (decisionPending(state, wx) || until <= state.simTimeMs) return;
  return advanceToActivity(state, wx, playedMs, until, radio);
}

export function dispatchCall(flight, sender, decision) {
  return { freq: "129.450", sender, message: `${flight.callsign} · ${decision}.`, logOnly: true };
}

export function processCrews(state, wx, playedMs, radio, allowAutomatic = false) {
  const immediate = state.role === "armchair" && state.directorPace === "immediate";
  if (immediate) runDirector(state, wx, radio);
  updateReleases(state, wx, playedMs, (f, sender, decision) => radio(dispatchCall(f, sender, decision)), immediate || allowAutomatic);
}

export function advanceSecond(state, wx, playedMs, emitRadioCall) {
  let activity = "";

  const previousMinute = Math.floor(state.simTimeMs / 60_000);
  state.simTimeMs += 1000;
  const beat = Math.floor((state.simTimeMs - START_TIME_MS) / 4800);
  const onBeat = beat !== state.tickCount;
  state.tickCount = beat;

  if (state.rwyClosedTicks > 0 && !(state.role === "armchair" && state.directorPace === "off")) {
    state.rwyClosedTicks = Math.max(0, Math.round(state.rwyClosedTicks * 60) - 1) / 60;
    if (state.rwyClosedTicks === 0) clearRunway(state, emitRadioCall);
  }

  for (const f of state.flights) {
    // 1. Move enroute / approaching aircraft on Basin Radar
    if (["ENROUTE", "APPROACH", "EMERGENCY"].includes(f.state)) {
      const targetApt = AIRPORTS[f.dest] || AIRPORTS.KVEL;
      const dx = targetApt.coords.x - f.pos.x;
      const dy = targetApt.coords.y - f.pos.y;
      const dist = Math.hypot(dx, dy);
      const stepPx = (f.speedKt / 145) * 1.4 / 4.8;

      if (dist > 8) {
        f.pos.x += (dx / dist) * stepPx;
        f.pos.y += (dy / dist) * stepPx;
        f.heading = Math.round(((Math.atan2(dy, dx) * 180) / Math.PI + 450) % 360);
        // Smooth altitude transition
        if (Math.abs(f.altFt - f.targetAltFt) > 150) {
          f.altFt += Math.sign(f.targetAltFt - f.altFt) * 29;
        }
      } else {
        handleArrival(state, f, wx, emitRadioCall);
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
    if (onBeat && f.state === "PATTERN") {
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
        if (cycle[nextIdx] === activeThr && (state.rwyClosedTicks > 0 || priorityOnFinal(state.flights, f))) {
          f.blockId = "PAT-UPWIND";
          emitRadioCall({
            freq: "122.800",
            sender: f.callsign,
            message: `Vernal Traffic, ${f.callsign} going around Runway ${wx.activeRwy} for ${state.rwyClosedTicks > 0 ? "runway closure" : "priority traffic"}, climbing upwind to 6,300.`
          });
        } else {
          f.blockId = cycle[nextIdx];
          activity = f.callsign + " changes pattern leg";
        }
      }
    }

    const beforeBlock = f.blockId;
    if (onBeat) advanceSurfaceDeparture(f, state, wx, emitRadioCall);
    if (f.blockId !== beforeBlock) activity = f.callsign + " moves on the airfield";
  }

  if (Math.floor(state.simTimeMs / 60_000) !== previousMinute) {
    if (state.role === "dispatcher") runGroundCrews(state, wx, emitRadioCall);
    else if (state.directorPace === "gradual") runDirector(state, wx, emitRadioCall);
  }
  if (onBeat && state.role === "armchair" && beat % 66 === 0) injectScenario(state, emitRadioCall);
  processCrews(state, wx, playedMs, emitRadioCall, true);
  return activity;
}

function handleArrival(state, f, wx, emitRadioCall) {
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
    if (state.rwyClosedTicks > 0 || (f.state !== "EMERGENCY" && priorityOnFinal(state.flights, f))) {
      // Go-around!
      f.pos.y += 45;
      f.blockId = "PAT-UPWIND";
      emitRadioCall({
        freq: "122.800",
        sender: f.callsign,
        message: `Vernal Traffic, ${f.callsign} going around Runway ${wx.activeRwy} for ${state.rwyClosedTicks > 0 ? "a runway closure" : "priority traffic"}.`
      });
      return;
    }

    // Check LIFR fog minimums for VFR-only GA
    if (f.state !== "EMERGENCY" && wx.flightCategory === "LIFR" && (f.category === "ga_student" || f.category === "ga_patrol")) {
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
    f.priorityHandling = false;
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

export function injectScenario(state, emitRadioCall) {
  const scen = DYNAMIC_SCENARIOS[state.scenarioIndex % DYNAMIC_SCENARIOS.length];
  state.scenarioIndex++;

  emitRadioCall({
    freq: scen.freq,
    sender: scen.sender,
    message: scen.radioCall,
    voiceClip: scen.voiceClip,
    isGuard: scen.freq === "121.500"
  });

  if (scen.id === "SCEN-DEER-RWY") {
    state.rwyClosedTicks = 5;
    state.rwyCloseReason = "DEER SWEEP";
  } else if (scen.id === "SCEN-7700-ICING") {
    const previous = state.flights.find(f => f.id === "N842K");
    if (!previous || previous.state !== "EMERGENCY") {
      const emergency = {
        id: "N842K",
        callsign: "BONANZA 842K",
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
        pilotNotes: "Severe icing reported over Daniels Summit. Requested priority into Vernal."
      };
      if (previous) Object.assign(previous, emergency, { parkedAt: null, priorityHandling: false });
      else state.flights.unshift(emergency);
    }
  } else if (scen.mission) {
    if (state.role !== "armchair") assignMission(state, scen.mission, emitRadioCall);
    else if (!state.pendingMissions.includes(scen.mission)) state.pendingMissions.push(scen.mission);
  } else if (scen.id === "SCEN-CONTOUR-DEICE") {
    const vte = state.flights.find(f => f.id === "VTE3101");
    if (vte && ["BOARDING", "PARKED"].includes(vte.state)) {
      vte.deiced = false;
      vte.deiceRequested = true;
    }
  }
}
