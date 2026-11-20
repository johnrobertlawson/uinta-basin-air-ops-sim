# AGENTS.md — KVEL & Uinta Basin Air Operations Simulator

## Scope & Domain Boundaries
- **Home hub (high detail):** Vernal Regional Airport (`KVEL`, 5,281' MSL, RWY 17/35, CTAF `122.800`, AWOS `135.225`, FBO `129.450`) and Ashley Valley landmarks (Asphalt Ridge, Steinaker/Red Fleet Reservoirs, Split Mountain, US-40, Ashley Creek, closed RWY 07/25).
- **Uinta Basin (semi-detailed):** `74V` Roosevelt, `U69` Duchesne, `33U` Dutch John, `4V0` Rangely, plus helipads/LZs (`UT18` Ashley Regional, `UT09` Uintah Basin Medical Center, `LZ-OURAY` methane patrol, `LZ-DINO` SAR).
- **Outer-ring minor airports:** `KPUC` (Price), `KRKS` (Rock Springs), `KGJT` (Grand Junction), `KSPK` (Spanish Fork).
- **Off-map portals:** `KSLC`, `KDEN`, `KPHX`. Do **not** expand map geometry into the Wasatch Front or Denver metro; route those flights through border portals.
- **Roles:** `armchair` (autonomous AI Director), `dispatcher`, `fbo`, `tsa`, `pilot`.

## Architecture (Zero-Build Vanilla ES Modules)
| File | Responsibility |
| --- | --- |
| `index.html` | Semantic layout, role/view switchers, dual SVG containers, `<dialog id="airportDialog" closedby="any">`, `#radioToastRegion`. |
| `styles.css` | Dark DLR signalling theme, popover toast transitions, `content-visibility: auto` board columns, modal styles, WCAG reflow/reduced-motion. |
| `data.js` | Static domain data: `AIRPORTS`, `KVEL_BLOCKS`, `WEATHER_REGIMES`, `INITIAL_FLIGHTS`, `PASSENGER_QUEUE`, `DYNAMIC_SCENARIOS`. |
| `app.js` | Simulation loop (`900ms` tick), DLR block sync, Armchair AI Director, radio popover toast manager, dual SVG renderers, 5 role workstations. |
| `dispatch.js` / `dispatch-desk.js` | Shared departure decisions and unpaused relief clock / keyboard-selectable flight strips and crew reports. |
| `VERSION` | Single source of truth (`MAJOR.MINOR.PATCH`) read by `scripts/build_packages.py` and mirrored in `index.html`. |
| `scripts/launcher.py` | Zero-dependency Python 3 stdlib local server (`127.0.0.1:8742` or free port) + browser opener. |
| `scripts/build_packages.py` | Builds `dist/Uinta-Basin-Air-Ops-Sim-<VER>-macOS.pkg` and `dist/uinta-basin-air-ops-sim_<VER>_all.deb`. |

## Engineering Invariants
1. **No build step / no npm runtime deps:** Keep browser code plain ES modules so it runs offline from any static HTTP server or desktop package.
2. **Focus-safe ticks:** `stepSimulation()` calls `renderAll({ fromTick: true })`, which MUST NOT clobber focused `<select>`, `<input>`, or `<textarea>` controls inside `#roleDeskBody`.
3. **Modern Web platform patterns:**
   - Radio toasts use `setAttribute("popover", "manual")` (never IDL `.popover`), `:is(:popover-open, .\:popover-open)`, separate `transition-behavior: allow-discrete`, focus-pause auto-dismiss, modal suppression, and persistent `#radioLogFeed`.
   - Modal uses native `<dialog closedby="any">`, `command="show-modal"`, `getBoundingClientRect()` fallback, and `dialog.returnValue = ""` reset on `close`.
   - Never use volatile/experimental CSS `scroll-axis-lock` without explicit user opt-in.
4. **Runway consistency:** Always derive active runway (`17` or `35`) from `getWeather().activeRwy`; never hardcode `35` in hold-short, pattern, or missed-approach logic.
5. **Versioning:** When bumping a release, update `VERSION` and the header badge in `index.html`, then tag `v<VERSION>`.
6. **Dispatch:** A ready flight requests release once per readiness period. Use unpaused real milliseconds for relief in every speed mode. An explicit hold survives role changes until the dispatcher releases it. Requests go to the strip and written log.

## Verification & Packaging
```bash
# 1. Check browser modules and run Dispatch tests (Node 20.10+)
for module in data.js app.js dispatch.js dispatch-desk.js; do
  node --experimental-default-type=module --check "$module" || exit 1
done
node --experimental-default-type=module --test tests/dispatch.test.mjs

# 2. Run locally
python3 scripts/launcher.py

# 3. Build macOS (.pkg) and Ubuntu (.deb) installers
python3 scripts/build_packages.py
```
