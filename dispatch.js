// Dispatch decisions and relief deadlines use the same rules for every crew.
export const RELIEF_MS = 60_000;

const managedCategories = new Set(["contour", "cargo", "private_jet"]);
const groundStates = new Set(["BOARDING", "PARKED", "TAXI_OUT", "HOLD_SHORT"]);
const airborneStates = new Set(["ENROUTE", "APPROACH", "EMERGENCY"]);

export function isManagedFlight(flight) {
  return managedCategories.has(flight.category);
}

export function isDeparture(flight) {
  return isManagedFlight(flight) && groundStates.has(flight.state)
    && (flight.parkedAt || flight.origin) === "KVEL" && flight.dest !== "KVEL";
}

export function canDivert(flight) {
  return isManagedFlight(flight) && airborneStates.has(flight.state)
    && Boolean(flight.alternate) && flight.dest !== flight.alternate;
}

export function gateCases(flight, passengers) {
  return passengers.filter(p => p.flight.startsWith(flight.id + " ")
    && (p.status === "pending" || p.status === "flagged")).length;
}

export function departureNeeds(flight, weather, passengers) {
  const needs = [];
  const count = gateCases(flight, passengers);
  if (count) needs.push(`Gate processing ${count} passenger${count === 1 ? "" : "s"}`);
  if (!flight.fueled) needs.push("Fuel truck");
  if (weather.deiceRequired && !flight.deiced) needs.push("De-icing");
  return needs;
}

// Store deadlines in elapsed, unpaused milliseconds. Speed changes cannot move them.
export class PlayClock {
  constructor(now = () => performance.now()) {
    this.now = now;
    this.reset(true);
  }
  reset(running) {
    this.elapsed = 0;
    this.started = running ? this.now() : null;
  }
  read() {
    return this.elapsed + (this.started === null ? 0 : this.now() - this.started);
  }
  setRunning(running) {
    if (running === (this.started !== null)) return;
    this.elapsed = this.read();
    this.started = running ? this.now() : null;
  }
}

export function releaseFlight(flight, needs, by) {
  if (!isDeparture(flight) || needs.length || flight.dispatched || (flight.dispatchHeld && by !== "You")) return false;
  flight.dispatchHeld = false;
  flight.releaseDue = null;
  flight.dispatched = true;
  flight.releasedBy = by;
  if (flight.state === "BOARDING" || flight.state === "PARKED") {
    flight.origin = "KVEL";
    flight.parkedAt = null;
    flight.state = "TAXI_OUT";
    flight.blockId = "TWY-A-S";
  }
  return true;
}

export function holdDeparture(flight) {
  if (!isDeparture(flight) || flight.dispatchHeld) return false;
  flight.dispatchHeld = true;
  flight.dispatched = false;
  flight.releasedBy = null;
  flight.releaseDue = null;
  return true;
}

export function divertFlight(flight) {
  if (!canDivert(flight)) return false;
  flight.divertedFrom = flight.dest;
  flight.dest = flight.alternate;
  flight.blockId = null;
  if (flight.state === "APPROACH") flight.state = "ENROUTE";
  return true;
}

export function updateReleases(state, weather, playedMs, report, allowAutomatic = true) {
  for (const flight of state.flights) {
    if (!isDeparture(flight) || flight.dispatchHeld || flight.dispatched) {
      flight.releaseDue = null;
      continue;
    }
    const needs = departureNeeds(flight, weather, state.passengers);
    if (needs.length) {
      flight.releaseDue = null;
      continue;
    }
    if (flight.releaseDue != null) {
      if (allowAutomatic && playedMs >= flight.releaseDue && releaseFlight(flight, needs, "Relief dispatcher")) {
        report(flight, "Relief dispatcher", "covered the unanswered request and released the flight");
      }
    } else if (state.role === "dispatcher") {
      flight.releaseDue = playedMs + RELIEF_MS;
      report(flight, flight.callsign, "ready for departure, requesting dispatch release");
    } else if (allowAutomatic && state.role === "armchair" && releaseFlight(flight, needs, "Dispatch")) {
      report(flight, "Dispatch", "released the flight for taxi");
    }
  }
}

// A recalled release leaves the aircraft on its current surface block.
export function advanceSurfaceDeparture(f, state, wx, emitRadioCall) {
  if (f.dispatchHeld) return;
  if (f.state === "HOLD_SHORT" && f.blockId !== "HS-" + wx.activeRwy) {
    f.state = "TAXI_OUT";
    f.blockId = "TWY-A-MID";
  }
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
