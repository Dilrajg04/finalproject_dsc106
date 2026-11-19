// San Diego Temperature vs The World (D3 v7)
// Data: data/cities.json, produced by pipeline/fetch_cmip6.py

const SD = "San Diego";
const GLOBAL = "Global average";
const tip = d3.select("#tooltip");
const fmt1 = (v) => (v >= 0 ? "+" : "−") + Math.abs(v).toFixed(1) + " °C";
const fmt2 = (v) => (v >= 0 ? "+" : "−") + Math.abs(v).toFixed(2) + " °C";

const state = { scen: "ssp245", year: 2100, city: null, revealed: false };

Promise.all([d3.json("data/cities.json"), d3.json("data/countries-110m.json")])
  .then(([data, world]) => init(data, world))
  .catch((err) => {
    console.error(err);
    d3.select("#map").append("p").attr("class", "todo")
      .text("Data file not found. Run pipeline/fetch_cmip6.py to create data/cities.json.");
  });

function init(data, world) {
  const models = data.models;
  const years = data.years_hist.concat(data.years_ssp);
  const y0 = years[0];
  const yi = (y) => y - y0;

  // ---------- prepare series: full 1850-2100 per city, scenario, model
  data.cities.forEach((c) => {
    c.full = {};
    for (const s of ["ssp245", "ssp585"]) {
      c.full[s] = models.map((m) => c.historical[m].concat(c[s][m]).map((v) => (v == null ? NaN : v)));
    }
  });
  const byName = new Map(data.cities.map((c) => [c.name, c]));
  const sd = byName.get(SD);
  const realCities = data.cities.filter((c) => c.lat != null);

  // 20-year trailing mean ending in `year`, averaged over models
  function warming(c, scen, year) {
    const end = yi(year), start = Math.max(0, end - 19);
    const perModel = c.full[scen].map((arr) => d3.mean(arr.slice(start, end + 1)));
    return d3.mean(perModel);
  }
  function warmingRange(c, scen, year) {
    const end = yi(year), start = Math.max(0, end - 19);
    return d3.extent(c.full[scen].map((arr) => d3.mean(arr.slice(start, end + 1))));
  }

  // ---------- hook sentence (computed from the data)
  function updateHook() {
    const ranked = realCities.map((c) => ({ c, v: warming(c, state.scen, 2100) })).sort((a, b) => a.v - b.v);
    const rank = ranked.findIndex((d) => d.c === sd) + 1;
    const glob = byName.get(GLOBAL);
    const g = glob ? warming(glob, state.scen, 2100) : null;
    const sdv = warming(sd, state.scen, 2100);
    d3.select("#hook").html(
      `Climate change is warming every city on Earth, but not equally. Out of ${ranked.length} major cities, ` +
      `<strong>San Diego ranks #${rank} for the least warming</strong> by 2100 (${fmt1(sdv)}` +
      (g != null ? `, versus ${fmt1(g)} for the planet as a whole` : "") +
      `). How does your city compare?`);
  }

  // ================= MAP =================
  const MW = 860, MH = 440;
  const projection = d3.geoNaturalEarth1().fitExtent([[4, 4], [MW - 4, MH - 4]], { type: "Sphere" });
  const path = d3.geoPath(projection);
  const mapSvg = d3.select("#map").append("svg").attr("viewBox", [0, 0, MW, MH])
    .attr("role", "img").attr("aria-label", "World map of projected warming by city");
  mapSvg.append("path").datum({ type: "Sphere" }).attr("class", "sphere").attr("d", path);
  mapSvg.append("g").selectAll("path")
    .data(topojson.feature(world, world.objects.countries).features)
    .join("path").attr("class", "land").attr("d", path);

  const allW = [];
  for (const c of realCities) for (const s of ["ssp245", "ssp585"]) allW.push(warming(c, s, 2100));
  const color = d3.scaleSequential(d3.interpolateOrRd).domain([0, Math.max(2, d3.max(allW))]).clamp(true);

  const dotsG = mapSvg.append("g");
  const labelsG = mapSvg.append("g");
  const dots = dotsG.selectAll("circle").data(realCities, (d) => d.name).join("circle")
    .attr("class", (d) => "city-dot" + (d.name === SD ? " sd" : ""))
    .attr("r", (d) => (d.name === SD ? 8 : 7))
    .attr("cx", (d) => projection([d.lon, d.lat])[0])
    .attr("cy", (d) => projection([d.lon, d.lat])[1])
    .on("pointermove", (event, d) => {
      const v = warming(d, state.scen, state.year), r = warmingRange(d, state.scen, state.year);
      const diff = v - warming(sd, state.scen, state.year);
      showTip(event, `<b>${d.name}</b> <span class="muted">${d.country}</span><br>
        Warming (${state.year - 19}–${state.year}): <b>${fmt1(v)}</b><br>
        <span class="muted">Model range: ${fmt1(r[0])} to ${fmt1(r[1])}</span>` +
        (d.name !== SD ? `<br>vs San Diego: <b>${fmt1(diff)}</b><br><span class="muted">Click to compare</span>` : ""));
    })
    .on("pointerleave", hideTip)
    .on("click", (_, d) => { if (d.name !== SD) selectCity(d.name, true); });

  const labels = labelsG.selectAll("text").data(realCities, (d) => d.name).join("text")
    .attr("class", (d) => "city-label" + (d.name === SD ? " sd" : ""))
    .attr("x", (d) => projection([d.lon, d.lat])[0] + 10)
    .attr("y", (d) => projection([d.lon, d.lat])[1] + 4)
    .text((d) => d.name);

  // legend
  const legendSvg = d3.select("#legend").append("svg").attr("viewBox", [0, 0, 380, 40]);
  (function drawLegend() {
    const x = d3.scaleLinear().domain(color.domain()).range([16, 360]);
    const grad = legendSvg.append("defs").append("linearGradient").attr("id", "lg");
    d3.range(0, 1.01, 0.1).forEach((t) => grad.append("stop").attr("offset", t).attr("stop-color", color(x.invert(16 + t * 344))));
    legendSvg.append("rect").attr("x", 16).attr("y", 4).attr("width", 344).attr("height", 10).attr("rx", 2).attr("fill", "url(#lg)");
    legendSvg.append("g").attr("class", "axis").attr("transform", "translate(0,15)")
      .call(d3.axisBottom(x).ticks(5).tickSize(3).tickFormat((v) => "+" + v + "°C"))
      .call((g) => g.select(".domain").remove());
  })();

  // ================= RANKING =================
  const RW = 260, rowH = 15, rm = { t: 18, l: 92, r: 46 };
  const rankData = () => data.cities.map((c) => ({ c, v: warming(c, state.scen, state.year) })).sort((a, b) => b.v - a.v);
  const RH = rm.t + data.cities.length * rowH + 4;
  const rankSvg = d3.select("#rank").append("svg").attr("viewBox", [0, 0, RW, RH]);
  const rx = d3.scaleLinear().range([rm.l, RW - rm.r]);
  const rankAxis = rankSvg.append("g").attr("class", "axis").attr("transform", `translate(0,${rm.t - 4})`);
  const rankG = rankSvg.append("g");

  function drawRank() {
    const d = rankData();
    rx.domain([Math.min(0, d3.min(d, (e) => e.v)), Math.max(1, d3.max(d, (e) => e.v))]).nice();
    rankAxis.call(d3.axisTop(rx).ticks(3).tickSize(3).tickFormat((v) => "+" + v + "°")).call((g) => g.select(".domain").remove());
    const rows = rankG.selectAll("g.rank-row").data(d, (e) => e.c.name).join((enter) => {
      const g = enter.append("g").attr("class", "rank-row");
      g.append("rect").attr("class", "rank-bg").attr("x", 0).attr("width", RW).attr("height", rowH).attr("y", -rowH / 2);
      g.append("text").attr("class", "rank-name").attr("x", rm.l - 6).attr("dy", "0.35em").attr("text-anchor", "end");
      g.append("rect").attr("class", "rank-bar").attr("height", rowH - 5).attr("y", -(rowH - 5) / 2).attr("rx", 2);
      g.append("text").attr("class", "lbl rank-val").attr("dy", "0.35em");
      return g;
    });
    rows.attr("class", (e) => "rank-row" + (e.c.name === SD ? " sd" : "") + (e.c.name === state.city ? " sel" : "") + (e.c.name === GLOBAL ? " global" : ""))
      .on("click", (_, e) => { if (e.c.name !== SD && e.c.name !== GLOBAL) selectCity(e.c.name, true); })
      .on("pointermove", (event, e) => showTip(event, `<b>${e.c.name}</b><br>Warming: <b>${fmt2(e.v)}</b>`))
      .on("pointerleave", hideTip)
      .transition().duration(350).attr("transform", (e, i) => `translate(0,${rm.t + i * rowH + rowH / 2})`);
    rows.select(".rank-name").text((e) => e.c.name);
    rows.select(".rank-bar").transition().duration(350)
      .attr("x", rx(0)).attr("width", (e) => Math.max(1, rx(e.v) - rx(0)))
      .attr("fill", (e) => (e.c.name === SD ? "var(--sd)" : e.c.name === state.city ? "var(--city)" : e.c.name === GLOBAL ? "var(--ink-3)" : color(e.v)));
    rows.select(".rank-val").transition().duration(350).attr("x", (e) => rx(e.v) + 4).text((e) => fmt1(e.v));
  }

  function updateMap() {
    dots.transition().duration(300).attr("fill", (d) => color(warming(d, state.scen, state.year)));
    dots.classed("sel", (d) => d.name === state.city);
    labels.classed("sel", (d) => d.name === state.city)
      .style("display", (d) => (d.name === SD || d.name === state.city ? null : "none"));
    d3.select("#map-title").text(`How much warmer each city gets by ${state.year}`);
    d3.select("#year-out").text(state.year);
    drawRank();
  }

  // ================= GUESS + LINE CHART =================
  const select = d3.select("#city-select");
  select.selectAll("option").data([{ name: "" }].concat(realCities.filter((c) => c.name !== SD).sort((a, b) => d3.ascending(a.name, b.name))))
    .join("option").attr("value", (d) => d.name).text((d) => (d.name ? `${d.name}, ${d.country}` : "Choose a city…"));
  select.on("change", function () { selectCity(this.value || null, false); });
  const guessInput = d3.select("#guess-input");
  guessInput.on("input", function () {
    d3.select("#guess-out").text(`${fmt1(+this.value)} vs San Diego`);
  });
  d3.select("#reveal").on("click", () => { if (state.city) { state.revealed = true; drawLines(); } });

  const LW = 1100, LH = 340, lm = { t: 20, r: 120, b: 28, l: 48 };
  const lx = d3.scaleLinear().domain([1900, 2100]).range([lm.l, LW - lm.r]);
  const ly = d3.scaleLinear().range([LH - lm.b, lm.t]);
  const lineSvg = d3.select("#lines").append("svg").attr("viewBox", [0, 0, LW, LH]);
  const gridG = lineSvg.append("g").attr("class", "axis grid").attr("transform", `translate(${lm.l},0)`);
  lineSvg.append("g").attr("class", "axis").attr("transform", `translate(0,${LH - lm.b})`)
    .call(d3.axisBottom(lx).ticks(10).tickFormat(d3.format("d")).tickSizeOuter(0));
  const plotG = lineSvg.append("g");
  const coverG = lineSvg.append("g");
  const annoG = lineSvg.append("g");

  // 10-year centered smoothing per model, then mean + min/max across models
  function smoothSeries(c, scen) {
    const per = c.full[scen].map((arr) => arr.map((_, i) => d3.mean(arr.slice(Math.max(0, i - 5), i + 5))));
    return years.map((y, i) => {
      const v = per.map((a) => a[i]);
      return { y, mean: d3.mean(v), lo: d3.min(v), hi: d3.max(v) };
    }).filter((d) => d.y >= 1900);
  }

  function drawLines() {
    plotG.selectAll("*").remove(); coverG.selectAll("*").remove(); annoG.selectAll("*").remove();
    const s = smoothSeries(sd, state.scen);
    const c = state.city ? smoothSeries(byName.get(state.city), state.scen) : null;
    const all = s.concat(c || []);
    ly.domain([Math.min(-0.5, d3.min(all, (d) => d.lo)), Math.max(2, d3.max(all, (d) => d.hi))]).nice();
    gridG.call(d3.axisLeft(ly).ticks(6).tickSize(-(LW - lm.l - lm.r)).tickFormat((v) => (v > 0 ? "+" : "") + v + "°C"))
      .call((g) => g.select(".domain").remove());

    const area = d3.area().x((d) => lx(d.y)).y0((d) => ly(d.lo)).y1((d) => ly(d.hi));
    const line = d3.line().x((d) => lx(d.y)).y((d) => ly(d.mean));
    const draw = (series, cls) => {
      plotG.append("path").datum(series).attr("class", "band-" + cls).attr("d", area);
      plotG.append("path").datum(series).attr("class", "line-" + cls).attr("d", line);
    };
    draw(s, "sd");
    // before the reveal, only draw the comparison city's past
    if (c) draw(state.revealed ? c : c.filter((d) => d.y <= 2025), "city");

    plotG.append("line").attr("class", "today").attr("x1", lx(2025)).attr("x2", lx(2025)).attr("y1", lm.t).attr("y2", LH - lm.b);
    plotG.append("text").attr("class", "lbl").attr("x", lx(2025) + 4).attr("y", lm.t + 10).text("today");

    const endLabel = (series, cls, name) => {
      const last = series[series.length - 1];
      annoG.append("text").attr("class", "lbl").attr("x", lx(2100) + 6).attr("y", ly(last.mean)).attr("dy", "0.35em")
        .style("fill", `var(--${cls})`).style("font-weight", 700).text(name);
    };

    if (c && !state.revealed) {
      // the city's future stays hidden until the reader commits to a guess
      endLabel(s, "sd", "San Diego");
      const now = c.find((d) => d.y === 2025);
      coverG.append("text").attr("class", "lbl").attr("x", lx(2025) + 10).attr("y", ly(now.mean) - 10)
        .style("fill", "var(--city)").style("font-size", "14px").style("font-weight", 700)
        .text(`${state.city}: ? Make your guess, then press Reveal`);
      d3.select("#result").html("");
    } else {
      endLabel(s, "sd", "San Diego");
      if (c) endLabel(c, "city", state.city);
    }

    if (c && state.revealed) {
      const actual = warming(byName.get(state.city), state.scen, 2100) - warming(sd, state.scen, 2100);
      const guess = +guessInput.property("value");
      const sdEnd = warming(sd, state.scen, 2100);
      // dashed marker where the reader's guess would put the city
      annoG.append("line").attr("class", "guess-mark").attr("x1", lx(2088)).attr("x2", lx(2100))
        .attr("y1", ly(sdEnd + guess)).attr("y2", ly(sdEnd + guess));
      annoG.append("text").attr("class", "lbl").attr("x", lx(2088) - 4).attr("y", ly(sdEnd + guess)).attr("dy", "0.35em")
        .attr("text-anchor", "end").text("your guess");
      const err = Math.abs(guess - actual);
      const verdict = err <= 0.3 ? "Spot on!" : err <= 0.8 ? "Close." : guess < actual ? "It warms more than you thought." : "It warms less than you thought.";
      d3.select("#result").html(`${verdict} By 2081–2100, <strong>${state.city}</strong> warms <strong>${fmt1(actual)}</strong> compared with San Diego. You guessed ${fmt1(guess)}.`);
    }
    if (!c) {
      endLabel(s, "sd", "San Diego");
      d3.select("#result").html("Pick a city to compare with San Diego.");
    }
    d3.select("#reveal").property("disabled", !c || state.revealed);
  }

  function selectCity(name, scroll) {
    state.city = name;
    state.revealed = false;
    select.property("value", name || "");
    updateMap();
    drawLines();
    if (scroll && name) document.getElementById("guess").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // ---------- controls
  d3.selectAll(".seg button").on("click", function () {
    state.scen = this.dataset.scen;
    d3.selectAll(".seg button").attr("aria-checked", function () { return this.dataset.scen === state.scen; });
    updateHook(); updateMap(); drawLines();
  });
  d3.select("#year").on("input", function () { state.year = +this.value; updateMap(); });

  updateHook();
  updateMap();
  drawLines();
}

function showTip(event, html) {
  tip.html(html).attr("hidden", null);
  const { width, height } = tip.node().getBoundingClientRect();
  let x = event.clientX + 14, y = event.clientY + 14;
  if (x + width > window.innerWidth - 8) x = event.clientX - width - 14;
  if (y + height > window.innerHeight - 8) y = event.clientY - height - 14;
  tip.style("left", x + "px").style("top", y + "px");
}
function hideTip() { tip.attr("hidden", true); }
