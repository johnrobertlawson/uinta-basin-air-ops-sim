# KVEL & Uinta Basin Air Operations Simulator

A lightweight, DLR train signalling–inspired multi-role aviation operations simulator centered on **Vernal Regional Airport (`KVEL`)** and the **Ashley Valley**, extending across the **Uinta Basin** (`74V` Roosevelt, `U69` Duchesne, `33U` Dutch John, `4V0` Rangely, hospital/gas-field/SAR helipads), outer-ring regional airports (`KPUC`, `KRKS`, `KGJT`, `KSPK`), and off-map portals (`KSLC`, `KDEN`, `KPHX`).

## One-Click Install (macOS & Ubuntu)

Download the latest versioned installer from the [GitHub Releases](https://github.com/johnrobertlawson/uinta-basin-air-ops-sim/releases) page:

- **macOS (`Uinta-Basin-Air-Ops-Sim-<version>-macOS.pkg`):** Double-click the `.pkg` to install **Uinta Basin Air Ops Sim.app** into `/Applications`, then launch from Applications or Spotlight.
- **Ubuntu / Debian (`uinta-basin-air-ops-sim_<version>_all.deb`):** Double-click the `.deb` in Ubuntu Software / App Center, or run:
  ```bash
  sudo apt install ./uinta-basin-air-ops-sim_0.1.0_all.deb
  ```
  Then launch **Uinta Basin Air Ops Sim** from your application menu (or run `uinta-basin-air-ops-sim`).

## Run From Source

Because the app uses ES modules (`type="module"`), launch with the bundled zero-dependency server:

```bash
python3 scripts/launcher.py
```

Or serve manually:

```bash
python3 -m http.server 8080
```

## Build Installers Locally

```bash
python3 scripts/build_packages.py
```

Artifacts are written to `dist/` using the version in `VERSION`.

## Included Roles & Modes

- **Armchair AI Director**: Full autonomous AI characters across Dispatch, FBO/Ramp, TSA/Ticketing, Pilots, Salt Lake Center (`135.775`), CTAF (`122.800`), Vernal Jet Center (`129.450`), and Guard (`121.500`), with unobtrusive written radio call popups and a permanent transcript log.
- **Flight Dispatcher**: Select **Flight Dispatcher** or open `/#dispatch` on the local server. Flight strips lead the desk with the Vernal airfield alongside. Gate and ramp crews handle passenger processing, fuel, and de-icing. A ready departure marks its strip and calls once in the written log. After 60 seconds of unpaused play, a relief dispatcher can release an unanswered flight at any simulation speed. A hold stays in force until you release it. Select an airborne flight to divert it to its filed alternate.
- **FBO & Ramp Agent (Vernal Jet Center)**: Jet-A/100LL fueling, Type I/IV glycol de-icing, marshalling to Taxiway Alpha, and Runway 17/35 wildlife/FOD sweeps.
- **TSA & Airline Ticketing**: Screen realistic Uinta Basin passengers (Book Cliffs hunters, USU Bingham Research Center snow-depth sensor gear, directional drillers, river guides, and late/unmanifested hazmat edge cases).
- **Pilot Command**: Fly Contour jets, private light jets, Alpine cargo turboprops, Classic Air Medevac (`UT18`/`UT09`), Uintah SAR (`LZ-DINO`), methane leak survey patrols (`LZ-OURAY`), or CNCC/USU student patterns.
