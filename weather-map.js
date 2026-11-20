// Weather footprints are drawn in the same 1000 × 620 schematic as the aircraft.
const definitions = `
  <defs>
    <pattern id="ice-hatch" width="9" height="9" patternUnits="userSpaceOnUse">
      <path d="M-2 2l4-4 M0 9l9-9 M7 11l4-4" stroke="#9edbff" stroke-width="1.3" opacity=".6"/>
    </pattern>
    <pattern id="chart-grid" width="50" height="50" patternUnits="userSpaceOnUse">
      <path d="M0 5V0h5 M47 50h3v-3" fill="none" stroke="#294047" stroke-width="1"/>
    </pattern>
    <path id="snow-cell" d="M-103 -5C-102 -28 -75 -33 -57 -43S-19 -57 6 -42
      C30 -49 48 -31 58 -29S98 -27 103 -5C111 17 77 22 56 36
      S17 49 -6 40C-29 54 -52 37 -68 35S-110 19 -103 -5Z"/>
  </defs>`;

// Each fill and its isoline use the same footprint, intensity and motion.
function snowCells() {
  return ["translate(288 290) rotate(-29) scale(1.22 .94)", "translate(563 168) rotate(-21) scale(1.38 .90)"]
    .map(transform => `<g transform="${transform}">${[
      ["light", 1], ["moderate", .68], ["strong", .36]
    ].map(([intensity, scale]) => `<g transform="scale(${scale})">
        <use href="#snow-cell" class="wx-returns echo-fill-${intensity}"/>
        <use href="#snow-cell" class="wx-contours echo-line-${intensity}"/>
      </g>`).join("")}</g>`).join("");
}

function icingArea(path, x, y, name) {
  return `<g class="wx-icing"><path class="ice-footprint" d="${path}"/>
    <text class="wx-label" x="${x}" y="${y}">${name}</text></g>`;
}

function hazardArea(path, x, y, name) {
  return `<g class="wx-hazards"><path class="hazard-footprint" d="${path}"/>
    <text class="wx-label" x="${x}" y="${y}">${name}</text></g>`;
}

export function radarWeather(weather) {
  let scenario = "";
  switch (weather.id) {
    case "inversion_fog":
      scenario = hazardArea("M258 371Q313 312 414 304T550 253Q615 230 675 265Q707 315 624 358T481 394Q334 433 258 398Z",
        315, 393, "Valley fog") + icingArea("M505 313Q535 256 608 260Q652 264 661 300Q634 333 574 345Q540 349 505 333Z",
        526, 264, "Freezing fog");
      break;
    case "uinta_cold_front":
      scenario = `<g class="front-drift">${snowCells()}</g>` +
        hazardArea("M364 339Q401 301 506 280T665 291Q653 333 562 367T403 376Z", 490, 345, "Gusts 35 kt") +
        icingArea("M130 280Q199 204 300 215T448 251Q421 291 330 300T186 346Z", 157, 255, "In-cloud icing");
      break;
    case "crisp_high_pressure":
      scenario = icingArea("M552 308Q558 282 588 280Q618 282 621 305Q609 331 580 334Q553 332 552 308Z",
        582, 348, "Surface frost");
      break;
  }
  const pilotReport = icingArea("M99 305Q123 274 169 273Q211 272 229 300Q210 332 174 337Q126 341 99 321Z",
    82, 354, "Severe icing · pilot report");
  return definitions + `<rect width="1000" height="620" fill="url(#chart-grid)"/>
    <g class="weather-overlay">${scenario}<g class="reported-icing">${pilotReport}</g></g>`;
}

export function updateWeatherPosition(svg, elapsedMs, icingEmergency) {
  svg.classList.toggle("has-icing-report", icingEmergency);
  const front = svg.querySelector(".front-drift");
  if (front) {
    const phase = elapsedMs / (18 * 60_000);
    front.setAttribute("transform", `translate(${(24 * Math.sin(phase)).toFixed(2)} ${(8 * Math.sin(phase * .75)).toFixed(2)})`);
  }
}
