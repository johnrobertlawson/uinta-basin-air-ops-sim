import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { AIRPORTS, DYNAMIC_SCENARIOS, INITIAL_FLIGHTS, PASSENGER_QUEUE, WEATHER_REGIMES, airportCategory } from "../data.js";
import { holdDeparture } from "../dispatch.js";
import { advanceSecond, forecastActivity, injectScenario, processCrews, skipToActivity, START_TIME_MS } from "../simulation.js";

const fog = WEATHER_REGIMES[0];
const silence = () => {};
function shift() {
  return { role: "armchair", directorPace: "gradual", simTimeMs: START_TIME_MS, tickCount: 0,
    scenarioIndex: 0, pendingMissions: [], rwyClosedTicks: 0, rwyCloseReason: "",
    passengers: structuredClone(PASSENGER_QUEUE), flights: structuredClone(INITIAL_FLIGHTS) };
}

test("forecast is silent and skipping to a crew report matches normal flight and ground progress", () => {
  const live = shift();
  const regular = structuredClone(live);
  const next = forecastActivity(live, fog, 0);
  assert.equal(next.until, START_TIME_MS + 60_000);
  assert.deepEqual(live, regular);
  const heard = [], expected = [];
  for (let s = 0; s < 60; s++) advanceSecond(regular, fog, 0, call => expected.push(call));
  skipToActivity(live, fog, 0, next.until + 200_000, call => heard.push(call));
  assert.deepEqual(live, regular);
  assert.deepEqual(heard, expected);
  assert.equal(live.passengers.filter(p => p.status === "pending").length, 4);
  assert.equal(live.flights.find(f => f.id === "N604XJ").fueled, false);
});

test("a quiet skip stops for a silent pattern turn and protects real-time decisions", () => {
  const state = shift();
  state.role = "dispatcher";
  state.flights = [state.flights.find(f => f.state === "PATTERN")];
  state.passengers = [];
  const next = forecastActivity(state, fog, 0);
  assert.match(next.event, /pattern leg/);
  skipToActivity(state, fog, 0, next.until, () => assert.fail("unexpected radio call"));
  assert.equal(state.flights[0].blockId, "PAT-BASE");
  state.flights[0].releaseDue = 60_000;
  assert.equal(forecastActivity(state, fog, 0), null);
  skipToActivity(state, fog, 0, next.until + 60_000, silence);
  assert.equal(state.simTimeMs, next.until);
});

test("off leaves work pending and immediate clears it without overriding a hold or moving aircraft in time", () => {
  const state = shift();
  state.directorPace = "off";
  const flight = state.flights.find(f => f.id === "VTE3101");
  holdDeparture(flight);
  state.scenarioIndex = 1;
  for (let i = 0; i < 4; i++) injectScenario(state, silence);
  for (let i = 0; i < 60; i++) advanceSecond(state, fog, 0, silence);
  assert.ok(state.passengers.every(p => p.status === "pending"));
  assert.equal(state.rwyClosedTicks, 5);
  assert.equal(state.pendingMissions.length, 2);
  state.directorPace = "immediate";
  const emergency = state.flights.find(f => f.id === "N842K");
  const before = { ...emergency.pos };
  processCrews(state, fog, 0, silence);
  assert.deepEqual(emergency.pos, before);
  assert.ok(emergency.priorityHandling);
  assert.equal(state.rwyClosedTicks, 0);
  assert.equal(state.pendingMissions.length, 0);
  assert.equal(state.flights.find(f => f.id === "RESCUE1").state, "ENROUTE");
  assert.equal(state.passengers.filter(p => p.status === "denied").length, 1);
  assert.ok(flight.dispatchHeld && flight.deiced && !flight.dispatched);
  processCrews(state, fog, 0, () => assert.fail("duplicate work"));
});

test("every on-map airport has a category and every scripted voice has a packaged clip", () => {
  for (const wx of WEATHER_REGIMES) {
    for (const apt of Object.values(AIRPORTS).filter(a => ["hub", "basin", "regional"].includes(a.type))) {
      assert.match(airportCategory(wx, apt.code), /^(VFR|MVFR|IFR|LIFR)$/);
    }
  }
  for (const name of [...WEATHER_REGIMES.map(w => w.id), ...DYNAMIC_SCENARIOS.map(s => s.voiceClip), "gate-room"]) {
    assert.ok(existsSync(new URL(`../assets/audio/${name}.mp3`, import.meta.url)), name);
  }
});
