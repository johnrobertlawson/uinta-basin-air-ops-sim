import { test } from "node:test";
import assert from "node:assert/strict";
import { INITIAL_FLIGHTS, PASSENGER_QUEUE, WEATHER_REGIMES } from "../data.js";
import { PlayClock, RELIEF_MS, advanceSurfaceDeparture, departureNeeds, divertFlight, holdDeparture, releaseFlight, updateReleases } from "../dispatch.js";

const fog = WEATHER_REGIMES[0];
function phoenix() {
  return { ...INITIAL_FLIGHTS.find(f => f.id === "VTE3101"), deiced: true, parkedAt: "KVEL" };
}

test("a ready flight flags once and relief uses 60 seconds of unpaused playing time", () => {
  let now = 1000;
  const clock = new PlayClock(() => now);
  const flight = phoenix();
  const state = { role: "dispatcher", flights: [flight], passengers: [], speed: 1 };
  const reports = [];
  const check = () => updateReleases(state, fog, clock.read(), (_, sender) => reports.push(sender));
  check();
  now += 12_000;
  check();
  clock.setRunning(false);
  now += 90_000;
  assert.equal(clock.read(), 12_000);
  check();
  state.speed = 15;
  clock.setRunning(true);
  now += 47_999;
  check();
  assert.equal(flight.dispatched, false);
  assert.equal(flight.releaseDue, RELIEF_MS);
  now++;
  check();
  check();
  assert.deepEqual(reports, [flight.callsign, "Relief dispatcher"]);
  assert.equal(flight.state, "TAXI_OUT");
  assert.equal(flight.releaseDue, null);
  clock.reset(false);
  assert.equal(clock.read(), 0);
});

test("gate decisions, fuel and frost readiness are shared by personal and relief releases", () => {
  const flight = { ...phoenix(), fueled: false, deiced: false };
  const passengers = structuredClone(PASSENGER_QUEUE);
  const state = { role: "dispatcher", flights: [flight], passengers };
  assert.equal(departureNeeds(flight, fog, passengers).length, 3);
  assert.equal(releaseFlight(flight, departureNeeds(flight, fog, passengers), "You"), false);
  flight.fueled = flight.deiced = true;
  for (const p of passengers) p.status = p.correctAction === "deny_boarding" ? "denied" : "cleared";
  updateReleases(state, fog, 0, () => {});
  flight.deiced = false;
  updateReleases(state, fog, RELIEF_MS, () => {});
  assert.equal(flight.releaseDue, null);
  assert.equal(flight.dispatched, false);
  flight.deiced = true;
  updateReleases(state, fog, RELIEF_MS + 100, () => {});
  assert.equal(flight.releaseDue, 2 * RELIEF_MS + 100);
});

test("a manual hold survives role changes and relief deadlines, including while taxiing", () => {
  const flight = phoenix();
  const state = { role: "dispatcher", flights: [flight], passengers: [] };
  updateReleases(state, fog, 0, () => {});
  assert.ok(releaseFlight(flight, [], "You"));
  assert.ok(holdDeparture(flight));
  const block = flight.blockId;
  state.role = "armchair";
  updateReleases(state, fog, RELIEF_MS * 2, () => assert.fail("hold was overridden"));
  assert.equal(releaseFlight(flight, [], "Relief dispatcher"), false);
  state.rwyClosedTicks = 0;
  for (state.tickCount = 1; state.tickCount <= 120; state.tickCount++) {
    advanceSurfaceDeparture(flight, state, fog, () => assert.fail("held flight moved"));
  }
  assert.equal(flight.dispatched, false);
  assert.equal(flight.blockId, block);
  assert.ok(releaseFlight(flight, [], "You"));
  assert.equal(flight.dispatchHeld, false);
  assert.equal(flight.blockId, block);
  for (; state.tickCount <= 160; state.tickCount++) advanceSurfaceDeparture(flight, state, fog, () => {});
  assert.equal(flight.state, "ENROUTE");
});

test("only an airborne managed flight can divert, once, to its filed alternate", () => {
  const inbound = { ...INITIAL_FLIGHTS.find(f => f.id === "AIP408") };
  assert.equal(divertFlight(phoenix()), false);
  assert.ok(divertFlight(inbound));
  assert.equal(inbound.dest, "74V");
  assert.equal(inbound.state, "ENROUTE");
  assert.equal(inbound.blockId, null);
  assert.equal(divertFlight(inbound), false);
});
