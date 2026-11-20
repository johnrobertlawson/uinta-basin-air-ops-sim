import { AIRPORTS } from "./data.js";
import { isDeparture, needsDeicing } from "./dispatch.js";

const needsGate = p => p.status === "pending" || p.status === "flagged";
const atRamp = f => isDeparture(f) && ["BOARDING", "PARKED"].includes(f.state);
const needsPriority = f => f.state === "EMERGENCY" && !f.priorityHandling && !f.dispatchHeld;

export function directorWorkload(state, weather) {
  const gate = state.passengers.filter(needsGate).length;
  const ramp = state.flights.filter(atRamp).reduce((n, f) => n + Number(!f.fueled) + Number(needsDeicing(f, weather)), 0);
  const incidents = state.pendingMissions.length + state.flights.filter(needsPriority).length + Number(state.rwyClosedTicks > 0);
  return [gate && `${gate} gate`, ramp && `${ramp} ramp`, incidents && `${incidents} incident${incidents === 1 ? "" : "s"}`]
    .filter(Boolean).join(" · ") || "All current calls handled";
}

// On a normal crew round, one gate agent and one ramp truck can work in parallel.
export function runGroundCrews(state, weather, radio, immediate = false) {
  const logOnly = state.role === "dispatcher" || immediate;
  for (const passenger of state.passengers.filter(needsGate)) {
    const denied = passenger.correctAction === "deny_boarding";
    passenger.status = denied ? "denied" : "cleared";
    const flight = state.flights.find(f => passenger.flight.startsWith(f.id + " "));
    if (flight && !denied && flight.tsaClearedPax < flight.tsaTotalPax) flight.tsaClearedPax++;
    radio({ freq: "129.450", sender: "KVEL GATE", logOnly,
      message: `${flight?.callsign || "Gate 1"} boarding update · ${passenger.name} ${denied ? "will not board" : "cleared"}.` });
    if (!immediate) break;
  }
  for (const flight of state.flights.filter(atRamp)) {
    if (!flight.fueled) {
      flight.fueled = true;
      flight.fuelLbs += 650;
      radio({ freq: "129.450", sender: "VERNAL JET CENTER", logOnly,
        message: `${flight.callsign} · fueling complete at ${flight.blockId}.` });
      if (!immediate) break;
    }
    if (needsDeicing(flight, weather)) {
      flight.deiced = true;
      flight.deiceRequested = false;
      radio({ freq: "129.450", sender: "VERNAL JET CENTER", logOnly,
        message: `${flight.callsign} · de-icing complete at ${flight.blockId}.` });
      if (!immediate) break;
    }
  }
}

export function clearRunway(state, radio) {
  state.rwyClosedTicks = 0;
  state.rwyCloseReason = "";
  radio({ freq: "122.800", sender: "VERNAL AIRPORT OPS (OPS-1)",
    message: "Vernal Traffic, Ops 1 clear of Runway 17/35. Sweep complete, runway open." });
}

export function assignMission(state, mission, radio) {
  const f = state.flights.find(flight => flight.id === mission.flightId);
  if (!f || f.dispatchHeld || f.state === "EMERGENCY") return false;
  const onSite = f.parkedAt === mission.dest && f.state === "PARKED";
  if (!onSite) {
    if (f.parkedAt) f.origin = f.parkedAt;
    f.parkedAt = null;
    f.dest = mission.dest;
    f.state = "ENROUTE";
    f.blockId = null;
    f.speedKt = mission.speedKt;
    f.targetAltFt = mission.targetAltFt;
  }
  radio({ freq: AIRPORTS[mission.dest].ctaf, sender: f.callsign,
    message: `${f.callsign}, ${onSite ? "on site at" : "proceeding to"} ${mission.dest} for the ${mission.task}.` });
  return true;
}

export function runDirector(state, weather, radio) {
  if (state.role !== "armchair" || state.directorPace === "off") return;
  const immediate = state.directorPace === "immediate";
  if (immediate && state.rwyClosedTicks > 0) clearRunway(state, radio);
  runGroundCrews(state, weather, radio, immediate);

  // Reserve the approach for an emergency. Aircraft still fly the route and land.
  for (const f of state.flights.filter(needsPriority)) {
    f.priorityHandling = true;
    f.dest = "KVEL";
    f.targetAltFt = 5500;
    // A Mayday can also be declared from a parked aircraft in the pilot desk.
    if (f.speedKt === 0 && f.parkedAt !== "KVEL") f.speedKt = 140;
    radio({ freq: "135.775", sender: "SALT LAKE CENTER (ZLC)",
      message: `${f.callsign}, you have priority into Vernal, Runway ${weather.activeRwy}. Rescue crews standing by.` });
    if (!immediate) return;
  }
  for (const mission of [...state.pendingMissions]) {
    if (assignMission(state, mission, radio)) {
      state.pendingMissions.splice(state.pendingMissions.indexOf(mission), 1);
      if (!immediate) break;
    }
  }
}
