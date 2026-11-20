# Working on Uinta Basin Air Ops Sim

Keep the simulator a zero-build, offline-capable set of browser ES modules. Use the existing dark dispatch theme, bundled fonts, SVG schematics, native controls, and Python standard-library launcher.

## Where changes belong

| File | Responsibility |
| --- | --- |
| `data.js` | Airports, facilities, fleet, passengers, weather regimes, and incident scripts. |
| `simulation.js` | One-second state transitions, arrivals, event injection, and quiet-period forecasts. |
| `armchair.js` / `dispatch.js` | Director pacing, gate/ramp jobs, manual holds, relief deadlines, and runway priority. |
| `app.js` / `dispatch-desk.js` | Browser clock, radio transcript/popups, SVG traffic, role desks, and flight strips. |
| `weather-map.js` / `sound.js` | Scenario overlays, simulated radar drift, voice playback, effects, and ambience. |
| `index.html` / `styles.css` | Layout, persistent controls, dialogs, focus, reflow, and reduced motion. |
| `scripts/` | Local launcher and macOS/Debian packaging. Register new runtime files in the package manifest. |

## Rules to preserve

- Keep KVEL and Ashley Valley detailed. Cover Roosevelt, Duchesne, Dutch John, Rangely, basin helipads/LZs, and the four outer-ring airports schematically. KSLC, KDEN, and KPHX are border portals.
- Use the selected weather regime for the active runway, AWOS, station categories, and overlays. Derive approach, hold-short, and pattern blocks from the active runway.
- Advance simulated time independently of frame rate. The real-time, unpaused play clock owns dispatch relief. Skip uses the same state transitions as ordinary play and stops at the first operational event. Forecasts must be silent and isolated from live state.
- Start Armchair in gradual mode. An explicit dispatch hold survives every pace and role change until the dispatcher releases it. A ready flight requests release once per readiness period. Preserve the written strip and transcript updates.
- Background ticks must preserve focused desk inputs. Keep the shared radar interactive in its full-window dialog and restore the previous view and keyboard focus on exit.
- Use native modal dialogs and a local fallback for invoker commands. Keep radio toasts as manual popovers, suppress new ones during a modal, pause dismissal on focus, and retain the transcript. Respect reduced motion and keyboard access.
- Sound starts by user action, speech plays at normal speed, and authored clips ship with the installers. Device voices and audio failures must leave text-based play available.

## Verification and release

1. Run the module and regression checks from the repository root.

   ```sh
   for module in *.js; do node --experimental-default-type=module --check "$module" || exit 1; done
   node --experimental-default-type=module --test tests/*.test.mjs
   ```

2. Use `python3 scripts/launcher.py` to check the normal start and `/#dispatch`. Exercise pace, pause/reset, a quiet skip, a held departure, weather layers, full-screen exit, and both sound previews.
3. For a release, update `VERSION` and the header version in `index.html`. Build with `python3 scripts/build_packages.py` on macOS and inspect both installer payloads.
4. Tag the verified commit `v<VERSION>`. The release workflow checks the version and tests, builds both installers, and attaches them to the GitHub release.
