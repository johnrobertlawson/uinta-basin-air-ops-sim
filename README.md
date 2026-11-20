# Uinta Basin Air Ops Sim

Watch the morning shift at Vernal Regional Airport (KVEL), or take the dispatch, ramp, ticketing, or pilot desk yourself. Flights, crews, weather, and radio calls share one simulated basin.

## Install and play

Download the installer for your platform from the [latest release](https://github.com/johnrobertlawson/uinta-basin-air-ops-sim/releases/latest).

- **macOS** — Open the `.pkg`, then launch **Uinta Basin Air Ops Sim** from Applications. The app uses Python 3 to serve the game locally and opens your browser.
- **Ubuntu or Debian** — Open the `.deb` in your software installer, then launch **Uinta Basin Air Ops Sim** from the applications menu.

To play from a checkout, run `python3 scripts/launcher.py`. The launcher uses the loopback address and prefers port 8742. The simulator, weather map, and bundled sounds work offline.

## First shift

- **Clock and pace.** The shift starts at 07:05:00 MST. Play at 0.5×, real time (1×), or 5×. Space pauses and resumes your chosen speed. When the sim predicts at least 45 quiet simulated seconds, **Skip ahead** advances flights and crews to the next activity. **Keep watching** dismisses that offer.
- **Armchair Director.** **Fix gradually** starts on by default. The gate and ramp crews each take one job per simulated minute, and the Director coordinates incident calls. **Fix immediately** handles the backlog and new requests as they arrive. **Off** leaves the Director off duty. Aircraft fly their routes, and explicit dispatch holds stay in force. Reset starts a fresh shift with gradual handling.
- **Weather map.** Open **Full-screen map** from any desk. Switch between four weather scenarios and toggle precipitation returns, storm contours, icing, other hazards, and aircraft. All nine on-map airports have a color and a written flight category. Try **Gusty cold front** to see the moving snow bands. Escape or **Exit full screen** returns to your previous map view.
- **Sound.** Open **Sound** and try **Play pilot call** and **Play METAR**. Enable radio voices, soft cues, and terminal ambience independently. The gate murmur is strongest at the ticketing desk and fades beneath speech. Voices always speak at normal speed.

## Take a desk

| Desk | What you control |
| --- | --- |
| Flight Dispatch | Select a flight strip to release, hold, or divert. Crews request release once ready. After 60 seconds of unpaused playing time, relief can handle an unanswered request. Open `/#dispatch` for this starting view. |
| FBO & Ramp | Fuel, de-ice, marshal aircraft, and inspect or reopen the runway. |
| TSA & Ticketing | Work the passenger queue and resolve declarations, screening, and boarding decisions. |
| Pilot Command | Choose an aircraft, destination, or squawk, fly the pattern, and make radio calls. |

**Basin briefing** contains the airport directory, frequencies, and Vernal weather report. The regional map covers the basin and its outer airfields. Salt Lake City, Denver, and Phoenix appear as off-map portals.

## Radio and ambience

Scripted incidents use bundled, lightly filtered generated voices. Each weather regime has its own robotic AWOS reading. Variable calls use an English speech voice supplied by the browser when available, so their timbre varies by device. During bursts of traffic, Guard calls take priority in the short playback queue. The transcript keeps the latest 50 entries. The voice recordings and layered terminal ambience were made with the [Piper LJ Speech model](https://huggingface.co/rhasspy/piper-voices/tree/main/en/en_US/ljspeech/high) and the [public-domain LJ Speech dataset](https://keithito.com/LJ-Speech-Dataset/).

## Verify and package

With Node 22 and Python 3 installed, run the following from the repository root.

```sh
node --experimental-default-type=module --test tests/*.test.mjs
python3 scripts/build_packages.py
```

Installers are written to `dist/`. Building the macOS package requires macOS and `pkgbuild`. The Python packager can build the Debian package on either platform.
