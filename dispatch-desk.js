import { AIRPORTS } from "./data.js";
import { canDivert, departureNeeds, isDeparture, isManagedFlight } from "./dispatch.js";

const phaseNames = {
  BOARDING: "Boarding", PARKED: "Parked", TAXI_OUT: "Taxiing", HOLD_SHORT: "At the runway",
  TAKEOFF: "Taking off", ENROUTE: "En route", APPROACH: "On approach", EMERGENCY: "Emergency"
};

function airportName(code) {
  return AIRPORTS[code]?.shortName || code;
}

function text(node, value) {
  if (node.textContent !== value) node.textContent = value;
}

function statusLabel(flight, needs) {
  if (flight.dispatchHeld) return flight.state === "TAXI_OUT" || flight.state === "HOLD_SHORT" ? "Held on taxiway" : "Held at the stand";
  if (flight.releaseDue != null) return "Release requested";
  if (flight.divertedFrom && flight.state !== "PARKED") return "Diverting to " + airportName(flight.dest);
  if (isDeparture(flight) && needs.length) return needs.join(" · ");
  return phaseNames[flight.state] || flight.state;
}

export function renderDispatchDesk(panel, state, weather, playedMs) {
  const roster = panel.querySelector(".dispatch-roster");
  const managed = state.flights.filter(isManagedFlight);
  const eventTime = f => (f.origin === "KVEL" ? f.schedDep : f.schedArr) || "";
  if (!roster.childElementCount) managed.sort((a, b) => eventTime(a).localeCompare(eventTime(b)));
  const selected = state.flights.find(f => f.id === state.selectedFlightId) || managed[0];
  if (!selected) return;
  for (const flight of managed) {
    let strip = roster.querySelector(`[data-dispatch-flight="${flight.id}"]`);
    if (!strip) {
      strip = document.createElement("button");
      strip.type = "button";
      strip.className = "dispatch-strip";
      strip.dataset.dispatchFlight = flight.id;
      strip.innerHTML = '<strong></strong><time></time><span class="strip-route"></span><span class="strip-state"></span><span class="strip-clock" aria-hidden="true"></span>';
      strip.querySelector(".strip-clock").id = "relief-clock-" + flight.id;
      roster.append(strip);
    }
    const needs = departureNeeds(flight, weather, state.passengers);
    const awaiting = flight.releaseDue != null;
    const pressed = String(flight.id === selected.id);
    if (strip.getAttribute("aria-pressed") !== pressed) strip.setAttribute("aria-pressed", pressed);
    strip.classList.toggle("awaiting-release", awaiting);
    text(strip.querySelector("strong"), flight.callsign);
    text(strip.querySelector("time"), eventTime(flight) || "Turnaround");
    text(strip.querySelector(".strip-route"), airportName(flight.origin) + " → " + airportName(flight.dest));
    text(strip.querySelector(".strip-state"), statusLabel(flight, needs));
    const clock = strip.querySelector(".strip-clock");
    clock.hidden = !awaiting;
    if (awaiting) {
      if (!strip.hasAttribute("aria-describedby")) strip.setAttribute("aria-describedby", clock.id);
      const seconds = Math.max(0, Math.ceil((flight.releaseDue - playedMs) / 1000));
      text(clock, `Relief in ${seconds}s${state.speed === 0 ? " · paused" : ""}`);
    } else if (strip.hasAttribute("aria-describedby")) strip.removeAttribute("aria-describedby");
  }

  const needs = departureNeeds(selected, weather, state.passengers);
  const departure = isDeparture(selected);
  const status = statusLabel(selected, needs);
  text(panel.querySelector(".dispatch-flight-title"), selected.callsign);
  text(panel.querySelector(".dispatch-decision-state"), status);
  text(panel.querySelector(".dispatch-route-detail"), `${selected.origin} → ${selected.dest} · ${selected.type} · Alternate ${selected.alternate}`);
  let report = `${selected.callsign} is ${status.toLowerCase()}.`;
  if (selected.dispatchHeld) report = "Your hold is in force. Only a new dispatch release can lift it." + (needs.length ? " Waiting on " + needs.join(" and ").toLowerCase() + "." : "");
  else if (departure && needs.length) report = "Crews are working on " + needs.join(" and ").toLowerCase() + ".";
  else if (selected.releaseDue != null) report = "The gate and ramp report ready. The pilot has requested release.";
  else if (selected.releasedBy && selected.dispatched) report = `Released by ${selected.releasedBy === "You" ? "you" : selected.releasedBy.toLowerCase()}. ${status}.`;
  else if (canDivert(selected)) report = `Monitoring the flight to ${airportName(selected.dest)}. ${airportName(selected.alternate)} is the filed alternate.`;
  text(panel.querySelector(".dispatch-report"), report);

  const release = panel.querySelector('[data-dispatch-action="release"]');
  const hold = panel.querySelector('[data-dispatch-action="hold"]');
  const divert = panel.querySelector('[data-dispatch-action="divert"]');
  const activeAction = panel.contains(document.activeElement) && document.activeElement.closest("[data-dispatch-action]");
  release.hidden = hold.hidden = !departure;
  release.setAttribute("aria-disabled", String(selected.dispatched || needs.length > 0));
  hold.setAttribute("aria-disabled", String(Boolean(selected.dispatchHeld)));
  divert.hidden = !canDivert(selected);
  text(divert, "Divert to " + airportName(selected.alternate));
  if (activeAction && activeAction.hidden) roster.querySelector('[aria-pressed="true"]')?.focus({ preventScroll: true });
}
