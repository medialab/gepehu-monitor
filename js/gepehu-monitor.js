/* TODO
 * - add some cron data backup
 * - fix no GPU selected breaks app
 * - fix wheelzoom on split view
 * - optimize more by moving also csv parsing to worker
 * - find better ways to handle hoverProcesses
 * - add help modal with links to sourcecode etc
 * - make README
 * - split CSVs by month
*/
d3.formatDefaultLocale({
  "decimal": ",",
  "thousands": " ",
  "grouping": [3],
  "currency": [""],
});

d3.defaultColors = [
  "#9FA8DA", "#A5D6A7", "#CE93D8", "#FFE082",
  "#FFAB91", "#E0E0E0", "#40C4FF", "#F48FB1",
  "#FFCC80", "#64FFDA", "#B39DDB", "#E6EE9C",
  "#8C9EFF", "#EF9A9A", "#B0BEC5", "#9FA8DA",
  "#81D4FA", "#80CBC4", "#C5E1A5", "#FFF59D",
  "#BCAAA4", "#EA80FC", "#FF8A80", "#FFE57F",
  "#AFEEEE", "#48D1CC"
];

d3.intFormat = d3.format(",d");
d3.percentFormat = d3.format(".1%");
d3.axisFormat = unit => {
  if (unit === "%")
    return d3.format(".0%");
  else if (unit === "Mo")
    return d => d3.format(",d")(d).replace(" 000", " Go");
  return d => d3.intFormat(d) + " " + unit;
};
d3.minutize = d => d.toLocaleString('sv').replace(' ', 'T').slice(0, 16);
d3.deminutize = d => new Date(d + ":00");

d3.combinations = (arr, n, prefix=[]) => {
  if (n == 0) return [prefix];
  return arr.flatMap((v, i) =>
    d3.combinations(arr.slice(i+1), n-1, [...prefix, v])
  );
};
d3.allCombinations = (arr) => {
  let result = [arr];
  for (let i = 2; i < arr.length; i++) {
    result = result.concat(d3.combinations(arr, i))
  }
  return result;
};

function useWebWorker(script, inputData, callback) {
  const worker_blob = new Blob([script], { type: "application/javascript" });
  const worker_url = URL.createObjectURL(worker_blob);
  const worker = new Worker(worker_url);
  worker.onmessage = ({ data }) => {
    callback(data);
    worker.terminate();
  };
  worker.postMessage(inputData);
};

function uncompress(compressed, callback) {
  useWebWorker(`
    let rootUrl = "${window.location.href}".replace(/#.*$/, "");
    importScripts(rootUrl + "/js/pako.min.js");
    self.onmessage = async (evt) => {
      const file = evt.data;
      const decompressed = pako.ungzip(file, {to: "string"});
      self.postMessage(decompressed);
    };
  `, compressed, callback);
};

function buildAggregatedData(gpus, callback) {
  useWebWorker(`
    self.onmessage = async (evt) => {
      const {gpus, users, minutes, combinations} = evt.data;
      const aggregatedGPU = {};
      const sum = arr => arr.reduce((partial, next) => partial + next, 0);
      const mean = arr => sum(arr) / arr.length;
      const minutize = d => d.toLocaleString('sv').replace(' ', 'T').slice(0, 16);
      // Build aggregated data for all combinations of selected GPUs
      combinations.forEach(combo => {
        const comboKey = combo.join(",");
        aggregatedGPU[comboKey] = {rows: [], rowsMap: []};
        minutes.forEach(dat => {
          const minute = minutize(dat);
          const values = combo
            .filter(idx => gpus[idx].rowsMap[minute] !== undefined)
            .map(idx => gpus[idx].rowsMap[minute]);
          if (!values.length) return;
          row = {
            datetime: dat,
            minute: minute,
            usage_percent: mean(values.map(x => x.usage_percent)),
            memory_percent: mean(values.map(x => x.memory_percent)),
            memory: sum(values.map(x => x.memory)),
            energy: sum(values.map(x => x.energy)),
            temperature: mean(values.map(x => x.temperature)),
            fan_speed_percent: mean(values.map(x => x.fan_speed_percent)),
            n_processes: sum(values.map(x => x.n_processes))
          };
          users.forEach(user =>
            row["processes_by_" + user] = sum(values.map(x => x["processes_by_" + user]))
          );
          aggregatedGPU[comboKey].rows.push(row);
          aggregatedGPU[comboKey].rowsMap[row.minute] = row;
        });
      });
      self.postMessage(aggregatedGPU);
    };
  `, gpus, callback);
};

new Vue({
  el: "#dashboard",
  data: {
    loading: 1,
    reloading: false,
    resizing: false,
    gpus: [],
    gpusToDo: [],
    gpusDone: [],
    aggregateGPUs: true,
    metrics: [
      {id: "usage_percent",     selected: false, name: "GPU use",      unit: "%",  color: "deepskyblue"},
      {id: "memory",            selected: false, name: "Memory use",   unit: "Mo", color: "lawngreen"},
      {id: "memory_percent",    selected: false, name: "Memory use",   unit: "%",  color: "lawngreen"},
      {id: "energy",            selected: false, name: "Energy",       unit: "W",  color: "gold"},
      {id: "temperature",       selected: false, name: "Temperature",  unit: "°C", color: "crimson"},
      {id: "fan_speed_percent", selected: false, name: "Fan speed",    unit: "%",  color: "mediumorchid"},
      {id: "n_processes",       selected: false, name: "Processes",    unit: "",   color: "grey"}
    ],
    users: [],
    usersColors: {},
    processes: {},
    hoverProcesses: [],
    hoverDate: null,
    hoverText: [],
    brushing: null,
    brushX: 0,
    minDate: null,
    maxDate: null,
    calendarBrushing: false
  },
  computed: {
    // List of user toggled GPUs
    gpusChoices: function() {
      return this.gpus.filter(g => g.selected).map(g => g.index).sort();
    },
    // List of user toggled metrics
    metricsChoices: function() {
      return this.metrics.filter(g => g.selected).map(g => g.id);
    },
    // Build URL's hash value following user settings
    url: function() {
      return "gpus=" + this.gpusChoices.join(",") +
        (this.aggregateGPUs ? "&aggregated" : "") +
        (this.minDate ? "&from=" + d3.minutize(this.minDate) : "") +
        (this.maxDate ? "&to=" + d3.minutize(this.maxDate) : "") +
        "&metrics=" + this.metricsChoices.join(",");
    }
  },
  watch: {
    // Update URL's hash according to settings and refresh plots
    url: function(val) {
      window.location.hash = val;
      this.draw();
    },
    // Run post processing of data whenever a download run is complete
    gpusDone: function(val) {
      if (val.length && val.length === this.gpusToDo.length)
        this.prepareData();
    }
  },
  // Initialize app
  mounted: function() {
    // Initialize URL with default parameters if not already a permalink
    if (!window.location.hash)
      window.location.hash = this.url;

    // Download list of GPUs IDs and prepare data structure
    d3.text("data/list").then(listGPUs => {
      listGPUs.trim().split("\n").forEach((gpuID, idx) => {
        this.gpus.push({
          id: gpuID,
          index: idx,
          name: null,
          selected: false,
          color: d3.defaultColors[idx],
          rows: [],
          rowsMap: {}
        });
      });

      // Start downloading individual GPUs metrics data
      this.downloadData();
      // Refresh metrics data every minute
      setInterval(this.downloadData, 60_000);

      // Initialize app with permalink settings
      this.readUrl();
      // Select by default all GPUs if none set
      if (!this.gpusChoices.length)
        for (let i = 0; i < this.gpus.length; i++)
          this.toggleGPU(i, true);
      // Select default metrics if none set
      if (!this.metricsChoices.length)
        ["usage_percent", "memory", "energy", "temperature", "n_processes"].forEach(m => this.toggleMetric(m, true));
      // Defaults to only the last 15 days
      if (!this.minDate && !this.maxDate) {
        const start = new Date();
        start.setDate(start.getDate() - 15);
        this.minDate = start;
      }

      // Follow URL changes to refresh plots
      window.addEventListener("hashchange", this.readUrl);
      // Redraw app whenever window's dimensions changed
      window.addEventListener("resize", this.resize);
    });
  },
  methods: {
    // Read settings values from URL query arguments
    readUrl: function() {
      const url = window.location.hash.slice(1);
      let aggregate = false;
      if (url && ~url.indexOf("&")) url.split("&").forEach(urlPiece => {
        const [key, values] = urlPiece.split("=");
        if (key == "gpus" && values != "")
          values.split(",").forEach(v => this.toggleGPU(parseInt(v), true));
        else if (key == "aggregated")
          aggregate = true;
        else if (key == "from")
          this.minDate = d3.deminutize(values);
        else if (key == "to")
          this.maxDate = d3.deminutize(values);
        else if (key == "metrics" && values != "")
          values.split(",").forEach(v => this.toggleMetric(v, true));
      });
      this.aggregateGPUs = aggregate;
    },
    // Redraw plots when window resized
    resize: function() {
      if (this.resizing)
        clearTimeout(this.resizing);
      this.resizing = setTimeout(() => {
        this.resizing = false;
        this.draw();
      }, 25);
    },
    // Toggle a GPU choice
    toggleGPU: function(idx, force) {
      this.gpus[idx].selected = force || !this.gpus[idx].selected;
    },
    // Toggle a metric choice
    toggleMetric: function(metricID, force) {
      this.metrics.forEach(m => {
        if (m.id === metricID)
          m.selected = force || !m.selected;
      });
    },
    // Download individual GPUs metrics data
    downloadData: function() {
      // Do not refresh data if current zooming action
      if (this.brushing != null) return;

      if (!this.loading) this.reloading = true;

      if (!this.loading && !this.maxDate) this.loading = 0.2;

      // Cleanup preexisting data
      if (this.gpusToDo.length) {
        if (this.gpusToDo.length !== this.gpusDone.length) return;
        while (this.gpusToDo.pop()) {};
      }
      while (this.gpusDone.pop()) {};
      this.processes = {};

      this.gpus.forEach(gpu => {
        this.gpusToDo.push(gpu.id)
        fetch("data/" + gpu.id + ".csv.gz?" + (new Date().getTime()))
        .then(res => res.arrayBuffer())
        .then(body =>
          // Decompress gzipped data
          uncompress(body, res => {

            gpu.rows = d3.csvParse(res, d => {
              d.datetime = new Date(d.datetime);
              d.minute = d3.minutize(d.datetime);
              d.usage_percent = +d.usage_percent / 100;
              d.memory_percent = +d.memory_percent / 100;
              d.memory = +d.memory;
              d.energy = +d.energy;
              d.temperature = +d.temperature;
              d.fan_speed_percent = +d.fan_speed / 100;
              d.users = d.users.split("§").filter(x => x);
              d.users.forEach(u => {
                if (!~this.users.indexOf(u))
                  this.users.push(u);
              });

              // Keep maps of processes and metrics at each timestamp
              const row_processes = d.processes.replace(/\//g, "/&#8203;").split("§").filter(x => x);
              d.n_processes = row_processes.length;
              row_processes.forEach((p, i) => {
                if (!this.processes[d.minute])
                  this.processes[d.minute] = [];
                this.processes[d.minute].push({
                  gpu: d.gpu_name,
                  gpu_index: gpu.index,
                  gpu_color: gpu.color,
                  user: d.users[i],
                  command: p
                });
              });
              gpu.rowsMap[d.minute] = d;

              return d;
            });

            gpu.name = gpu.rows[0].gpu_name;
            this.gpusDone.push(gpu.id);
          })
        );
      });
    },
    // Post process data when all GPUs' metrics collected
    prepareData: function() {
      // Evaluate complete time range
      this.fullStart = d3.min(this.gpus.map(g =>
        g.rows && g.rows.length ? new Date(g.rows[0].datetime) : new Date()
      ));
      this.fullEnd = new Date();

      // Prepare list of all users
      this.users.sort();
      this.users.forEach((user, idx) =>
        this.usersColors[user] = d3.defaultColors[idx + this.gpus.length]
      );

      this.gpus.forEach(gpu =>
        gpu.rows.forEach(row =>
          this.users.forEach(user =>
            row["processes_by_" + user] = row.users.filter(u => u === user).length
          )
        )
      );

      buildAggregatedData({
        gpus: this.gpus,
        users: this.users,
        minutes: d3.timeMinutes(this.fullStart, this.fullEnd),
        combinations: d3.allCombinations(this.gpus.map(g => g.index)),
      }, aggregatedData => {
        this.aggregatedGPU = aggregatedData;
        // Always draw plots on first load or refresh them if required
        this.draw(1 - this.loading);
      });
    },
    // Refresh plots if required
    draw: function(lazy) {
      // Do nothing if post-processing never happened yet
      if (!Object.keys(this.usersColors).length) return this.reloading = false;
      // Do not refresh plots with latest data if zoomed in the past
      if (this.maxDate && lazy) return this.reloading = false;
      if (!this.loading) this.loading = 0.5;
      setTimeout(this.reallyDraw, 50);
    },
    // Actually draw plots
    reallyDraw: function() {
      // Remove previous plots
      d3.selectAll("svg").remove();

      // Setup current time window
      this.start = new Date(this.minDate || this.fullStart);
      this.end = new Date(this.maxDate || this.fullEnd);

      // Setup dimensions
      const nbPlots = this.aggregateGPUs ? 1 : this.gpusChoices.length,
        margin = {top: 20, right: 70, bottom: 30, left: 40, horiz: 70, vert: 30},
        calendarH = document.querySelector("nav").getBoundingClientRect().height,
        mainH = window.innerHeight - calendarH,
        svgH = Math.max(140, mainH),
        svgW = window.innerWidth - document.querySelector("aside").getBoundingClientRect().width,
        height = (svgH - margin.top - margin.bottom - (this.metricsChoices.length - 1) * margin.vert) / this.metricsChoices.length;
      this.width = (svgW - margin.left - margin.right - (nbPlots - 1) * margin.horiz) / nbPlots;
      this.svgX = document.querySelector(".svg").getBoundingClientRect().x + margin.left;
      this.gapX = this.width + margin.horiz;

      // Prepare svg
      const svg = d3.select(".svg")
        .style("height", mainH + "px")
        .append("svg")
          .attr("width", svgW)
          .attr("height", svgH);

      // Position GPU labels on each column
      this.gpusChoices.forEach(idx => {
        this.gpus[idx].style = {
          "font-size": "14px",
          "background-color": this.gpus[idx].color,
          top: margin.top + "px",
          left: (margin.left + idx * (this.width + margin.horiz)) + "px"
        };
      });

      // Compute X range
      this.xScale = d3.scaleTime().range([0, this.width]).domain([this.start, this.end]);

      // Prepare X axis
      const xAxis = d3.axisBottom(this.xScale);
      // Use days if the period covered is at least a day and a half
      if (this.end - this.start > 129_600_000)
        xAxis.tickFormat(d3.timeFormat("%d %b %y"))
          .ticks(d3.unixDay.every(Math.max(1, Math.trunc(
            175 * d3.timeDay.range(this.start, this.end).length / this.width
          ))));
      // Use hour:minutes otherwise
      else xAxis.tickFormat(d3.timeFormat("%H:%M"))
        .tickValues(d3.utcTicks(this.start, this.end, Math.trunc(this.width / 100)));

      // Draw zoom-brushable calendar
      this.calendarWidth = svgW - margin.left - margin.right;
      this.calendarScale = d3.scaleTime().range([0, this.calendarWidth]).domain([this.fullStart, this.fullEnd]);

      const calendar = d3.select(".calendar").append("svg")
        .attr("width", svgW)
        .attr("height", calendarH)
        .append("g")
          .attr("width", this.calendarWidth)
          .attr("height", 32)
          .attr("transform", "translate(" + margin.left + ", 13)");
      calendar.append("rect")
        .attr("width", this.calendarWidth)
        .attr("height", 32)
        .attr("fill", "#333");
      calendar.append("text")
        .attr("class", "date-tooltip")
        .attr("text-anchor", "middle")
        .attr("fill", "#008F11")
        .attr("y", 48);

      const calStart = new Date(this.fullStart),
        calEnd = new Date(this.fullEnd);
      calStart.setDate(calStart.getDate() + 1);
      calEnd.setDate(calEnd.getDate() - 1);
      calendar.append("g")
        .attr("class", "calendar-axis")
        .attr("transform", "translate(0, 28)")
        .call(d3.axisTop(this.calendarScale)
          .tickFormat(d3.timeFormat("%d %b %y"))
          .tickValues(d3.unixDay.every(Math.round(
            (d3.unixDay.range(this.fullStart, this.fullEnd).length + 1) / (Math.trunc(this.calendarWidth / 120) - 1)
          )).range(calStart, calEnd))
        );

      calendar.append("rect")
        .attr("class", "calendar-brush")
        .attr("x", this.calendarScale(this.start))
        .attr("y", 1)
        .attr("width", this.calendarScale(this.end) - this.calendarScale(this.start))
        .attr("height", 30);

      calendar.append("rect")
        .attr("class", "interactions")
        .attr("x", -margin.left)
        .attr("y", -13)
        .attr("width", svgW)
        .attr("height", calendarH)
        .on("mouseover", this.hoverCalendar)
        .on("mousedown", this.startCalendarBrush)
        .on("mousemove", this.hoverCalendar)
        .on("mouseup", this.stopCalendarBrush)
        .on("mouseleave", this.clearCalendarTooltip)
        .on("dblclick", this.resetZoom);

      // Prepare datasets to plot
      const datasets = []
      if (this.aggregateGPUs && this.gpusChoices.length > 1)
        datasets.push(this.aggregatedGPU[this.gpusChoices.join(",")]);
      else this.gpusChoices.forEach(idx => datasets.push(this.gpus[idx]));

      // Plot individual metrics as rows
      this.metricsChoices.forEach((metricChoice, metric_idx) => {

        const metric = this.metrics.filter(x => x.id == metricChoice)[0];

        // Compute Y range
        let yMax = 1;
        if (!~metricChoice.indexOf("_percent")) datasets.forEach(gpu =>
          yMax = d3.max([yMax, d3.max(gpu.rows.map(d => d[metricChoice]))])
        );
        yMax *= 1.08;
        const yScale = d3.scaleLinear().range([height, 0]).domain([0, yMax]);

        // Plot each GPU as a column
        datasets.forEach((gpu, gpu_idx) => {
          // Filter zoomed out data
          const data = gpu.rows.filter(d => d.datetime >= this.start && d.datetime <= this.end);

          // Create SVG group for current plot and position it in the whole SVG
          const g = svg.append("g")
            .attr("transform", "translate(" + (margin.left + gpu_idx * (this.width + margin.horiz)) + "," + (margin.top + metric_idx * (height + margin.vert)) + ")");

          // Plot processes as a stacked histogram
          if (metricChoice === "n_processes") {
            g.append("g")
              .selectAll("users")
              .data(d3.stack()
                .order(d3.stackOrderAscending)
                .keys(this.users.map(u => "processes_by_" + u))
                .value((d, key) => d[key])
                (data)
              ).enter().append("path")
                .attr("fill", d => this.usersColors[d.key.replace(/processes_by_/, "")])
                .attr("d", d3.area()
                  .x(d => this.xScale(d3.min([this.end, d3.max([this.start, d.data["datetime"]])])))
                  .y0(d => yScale(d[0]))
                  .y1(d => yScale(d[1]))
                );

          // Draw other metrics as area plots with a line and a surface
          } else {

            g.append("path")
              .datum(d3.timeMinutes(this.start, this.end))
              .attr("class", "line")
              .attr("fill", "none")
              .attr("stroke", metric.color)
              .attr("stroke-width", 0.5)
              .attr("d", d3.line()
                .x(d => this.xScale(d))
                .y(d => yScale((gpu.rowsMap[d3.minutize(d)] || {})[metricChoice] || 0))
              );

            g.append("path")
              .datum(data)
              .attr("class", "area")
              .attr("fill", metric.color)
              .attr("fill-opacity", 0.35)
              .attr("d", d3.area()
                .x(d => this.xScale(d.datetime))
                .y0((height))
                .y1(d => yScale(d[metricChoice]))
              );
          }

          // Draw Y axis
          const yAxis = d3.axisRight(yScale)
            .tickFormat(d3.axisFormat(metric.unit));
          if (metricChoice === "n_processes")
            yAxis.tickValues(d3.range(0, yMax));
          else yAxis.ticks(height > 200 ? 8 : 4);
          g.append("g")
            .attr("class", "axis axis--y")
            .attr("transform", "translate(" + (this.width) + ", 0)")
            .call(yAxis);

          // Draw X axis
          g.append("g")
            .attr("class", "axis axis--x")
            .attr("transform", "translate(0, " + (height) + ")")
            .call(xAxis);

          // Draw hoverable and brushable surfaces
          const interactions = g.append("g");

          interactions.append("rect")
            .attr("class", "brush")
            .attr("x", 0)
            .attr("y", 0)
            .attr("width", 0)
            .attr("height", height);

          interactions.append("rect")
            .attr("class", "interactions")
            .attr("gpu_idx", gpu_idx)
            .attr("x", -margin.left)
            .attr("y", -margin.top)
            .attr("width", margin.left + this.width + margin.horiz)
            .attr("height", margin.top + height + margin.vert)
            .on("mouseover", this.hover)
            .on("mouseleave", this.clearTooltip)
            .on("mousedown", this.startBrush)
            .on("mousemove", this.hover)
            .on("mouseup", this.stopBrush)
            .on("dblclick", this.resetZoom)
            .on("wheel", this.wheelZoom);

        });
      });

      this.clearTooltip();
      this.loading = 0;
      this.reloading = false;
    },
    // Remove hover tooltip when the mouse is leaving the plot
    clearTooltip: function() {
      this.hoverDate = null;
      this.hoverText = null;
      this.hoverProcesses = [];

      d3.select(".tooltipBox").style("display", "none");

      if (this.brushing == null)
        d3.selectAll("rect.brush").attr("width", 0);
      d3.selectAll("rect.interactions").style("cursor", "unset");
    },
    // Handle tooltip on hovering the plots & movements when zoom-brushing
    hover: function(event) {
      if (!event) return;

      const gpu_idx = event.target.attributes.gpu_idx.value,
        brushX = event.pageX - this.svgX - gpu_idx * this.gapX;

      // Handle movements while zoom-brushing
      if (this.brushing != null) {
        let width;
        if (this.brushing === gpu_idx) {
          width = brushX - this.brushX;
          if (width > this.width - this.brushX)
            width = this.width - this.brushX
          else if (width < -this.brushX)
            width = -this.brushX;
          d3.selectAll("rect.interactions").style("cursor", (width >= 0 ? "e" : "w") + "-resize");
        } else if (this.brushing < gpu_idx)
          width = this.width - this.brushX;
        else width = -this.brushX;

        // Update brush position on all plots
        d3.selectAll("rect.brush")
          .attr("x", width >= 0 ? this.brushX : this.brushX + width)
          .attr("width", Math.abs(width));

        // Update calendar brush position
        const calBrushX = this.calendarScale(this.xScale.invert(this.brushX)),
          calWidth = this.calendarScale(this.xScale.invert(this.brushX + width)) - calBrushX;
        d3.select("rect.calendar-brush")
          .attr("x", calWidth >= 0 ? calBrushX : calBrushX + calWidth)
          .attr("width", Math.abs(calWidth));

      // Display hover line otherwise
      } else if (brushX >= 0 && brushX <= this.width) {
        this.brushX = brushX;
        d3.selectAll("rect.brush")
          .attr("x", this.brushX)
          .attr("width", 1);
        d3.selectAll("rect.interactions").style("cursor", "crosshair");
      }

      if (brushX < 0 || brushX > this.width)
        return this.clearTooltip();

      // Display tooltip
      const dat = this.xScale.invert(brushX),
        minute = d3.minutize(dat),
        row = (this.aggregateGPUs && this.gpusChoices.length > 1 ? this.aggregatedGPU[this.gpusChoices.join(",")] : this.gpus[this.gpusChoices[gpu_idx]]).rowsMap[minute];

      this.hoverDate = d3.timeFormat("%b %d %Y %H:%M")(dat);
      this.hoverText = [];
      this.metricsChoices.forEach(metricChoice => {
        const metric = this.metrics.filter(x => x.id == metricChoice)[0],
          percent = ~metricChoice.indexOf("_percent");
        this.hoverText.push({
          metric: metric.name,
          color: metric.color,
          value: (row ? d3[(percent ? "percent" : "int") + "Format"](row[metricChoice]) + (percent ? "" : " " + metric.unit) : "n/a")
        });
      });
      this.hoverProcesses = (this.processes[minute] || []).filter(p => ~this.gpusChoices.indexOf(p.gpu_index)).sort((a, b) => a.gpu.localeCompare(b.gpu));

      const boxHeight = 45 + 21 * this.metricsChoices.length;
      d3.select(".tooltipBox")
        .style("left", event.pageX - 120 + "px")
        .style("top", event.pageY + (window.innerHeight - event.pageY > (30 + boxHeight) ? 30 : -(30 + boxHeight)) + "px")
        .style("display", "block");
    },
    // Initiate zoom-brushing on click down
    startBrush: function(event) {
      this.brushing = event.target.attributes.gpu_idx.value;
      const brushX = event.pageX - this.svgX - this.brushing * this.gapX;
      if (brushX < 0 || brushX > this.width) return this.brushing = null;
      this.brushX = brushX;
      d3.selectAll("rect.interactions").style("cursor", "e-resize");
    },
    // Complete zoom-brushing on click up
    stopBrush: function() {
      if (!this.brushing) return;
      const brush = document.querySelector("rect.brush"),
        x = parseFloat(brush.getAttribute("x")),
        width = parseFloat(brush.getAttribute("width"));

      // Evaluate zoom period datetimes from recorded positions
      let minDate = this.xScale.invert(x);
      if (minDate <= this.start)
        minDate = this.start;
      let maxDate = this.xScale.invert(x + parseFloat(brush.getAttribute("width")));
      if (maxDate >= this.end)
        maxDate = this.end;
      if (maxDate >= this.fullEnd)
        maxDate = null;

      // Do not zoom when selection is too small (<5px) or too short (<30min)
      const duration = (maxDate || this.end) - (minDate || this.start);
      if (width < 5 || duration < 1_800_000) {
        d3.selectAll("rect.brush").attr("width", 1);
      } else {
        d3.selectAll("rect.brush").attr("width", 0);
        if (!this.loading) this.loading = 0.2;
        this.minDate = minDate;
        this.maxDate = maxDate;
      }

      d3.selectAll("rect.interactions").style("cursor", x > 0 && x < this.width ? "crosshair" : "unset");
      this.brushing = null;
    },
    // Use mouse wheel to zoom-focus or unfocus
    wheelZoom: function(event) {
      const zoomRatio = 1.5,
        direction = (event.deltaY && event.deltaY > 0 ? -1 : 1),
        zoomFactor = (direction === 1 ? 1 / zoomRatio : zoomRatio),
        zoomCenter = event.pageX - this.svgX - this.brushing * this.gapX;
      if ((direction == 1 && this.end - this.start < 1_800_000) || (direction == -1 && this.start == this.fullStart && this.end == this.fullEnd )) return;

      if (direction === 1)
        d3.selectAll("rect.brush")
          .attr("x", zoomCenter * (1 - zoomFactor))
          .attr("width", this.width * zoomFactor);

      this.minDate = this.xScale.invert(zoomCenter * (1 - zoomFactor));
      this.maxDate = this.xScale.invert(this.width * zoomFactor + zoomCenter * (1 - zoomFactor));
      if (this.minDate < this.fullStart)
        this.minDate = this.fullStart;
      if (this.maxDate > this.fullEnd)
        this.maxDate = null;
    },
    // Initiate zoom-brushing from calendar bar on click down
    startCalendarBrush: function(event) {
      const calBrush = document.querySelector("rect.calendar-brush"),
        x = parseFloat(calBrush.getAttribute("x")),
        w = parseFloat(calBrush.getAttribute("width")),
        brushX = event.pageX - this.svgX;
      if (brushX < 0 || brushX > this.calendarWidth) return;
      this.calendarBrushing = true;
      // Adjust brush zone from its left edge if the mouse is close to it
      if (Math.abs(brushX - x) < 8)
        this.calendarBrushX = x + w;
      // Adjust brush zone from its right edge if the mouse is close to it
      else if (Math.abs(brushX - x - w) < 8)
        this.calendarBrushX = x;
      // Or initiate a new brush zone otherwise
      else this.calendarBrushX = brushX;
      d3.selectAll("rect.interactions").style("cursor", "e-resize");
    },
    // Handle movements when zoom-brushing from calendar bar
    hoverCalendar: function(event) {
      if (!event) return;

      const brushX = event.pageX - this.svgX;

      // Handle movements while zoom-brushing
      if (this.calendarBrushing) {
        let width = brushX - this.calendarBrushX;
        if (width > this.calendarWidth - this.calendarBrushX)
          width = this.calendarWidth - this.calendarBrushX
        else if (width < -this.calendarBrushX)
          width = -this.calendarBrushX;
        d3.selectAll("rect.interactions").style("cursor", (width >= 0 ? "e" : "w") + "-resize");

        // Update calendar brush position
        d3.select("rect.calendar-brush")
          .attr("x", width >= 0 ? this.calendarBrushX : this.calendarBrushX + width)
          .attr("width", Math.abs(width));

        // Update brush position on all plots as well
        const regBrushX = this.xScale(this.calendarScale.invert(this.calendarBrushX)),
          regBrushEnd = this.xScale(this.calendarScale.invert(brushX)),
          regWidth = regBrushEnd - regBrushX;
        d3.selectAll("rect.brush")
          .attr("x", Math.max(0,
            Math.min(this.width,
              regWidth >= 0 ? regBrushX : regBrushX + regWidth
            )
          ))
          .attr("width", Math.max(0,
            Math.min(this.width,
              regWidth >= 0
              ? (regBrushX < 0 ? regBrushEnd : Math.min(regBrushEnd, this.width) - regBrushX)
              : (regBrushX > this.width ? this.width - regBrushEnd : Math.min(-regWidth, regBrushX))
            )
          ));

      // Adjust cursor's icon otherwise when getting close to brush's edges
      } else {
        const calBrush = document.querySelector("rect.calendar-brush"),
          x = parseFloat(calBrush.getAttribute("x")),
          w = parseFloat(calBrush.getAttribute("width")),
          y = event.pageY;
        d3.selectAll("rect.interactions").style("cursor",
          (Math.abs(brushX - x) < 8 || Math.abs(brushX - x - w) < 8
          ? "ew-resize"
          : (brushX >= 0 && brushX <= this.calendarWidth && y >= 13 && y <= 45
            ? "crosshair"
            : "unset"
            )
          )
        );
      }
      if (brushX >= 0 && brushX <= this.calendarWidth)
        d3.select("text.date-tooltip")
          .attr("x", brushX)
          .text(d3.timeFormat("%d %b %y %Hh")(this.calendarScale.invert(brushX)));
      else this.clearCalendarTooltip();
    },
    // Complete zoom-brushing from calendar bar on click up
    stopCalendarBrush: function() {
      if (!this.calendarBrushing) return;
      const brush = document.querySelector("rect.calendar-brush"),
        x = parseFloat(brush.getAttribute("x")),
        width = parseFloat(brush.getAttribute("width"));

      // Evaluate zoom period datetimes from recorded positions
      let minDate = this.calendarScale.invert(x);
      if (minDate <= this.fullStart)
        minDate = this.fullStart;
      let maxDate = this.calendarScale.invert(x + parseFloat(brush.getAttribute("width")));
      if (maxDate >= this.fullEnd)
        maxDate = null;

      // Do not zoom when selection is too small (<5px) or too short (<30min)
      const duration = (maxDate || this.fullEnd) - (minDate || this.fullStart);
      if (width >= 5 && duration >= 1_800_000) {
        d3.selectAll("rect.brush").attr("width", 0);
        if (!this.loading) this.loading = 0.2;
        this.minDate = minDate;
        this.maxDate = maxDate;
      }

      d3.selectAll("rect.interactions").style("cursor", x > 0 && x < this.calendarWidth ? "crosshair" : "unset");
      this.calendarBrushing = false;
    },
    clearCalendarTooltip: function() {
      d3.select("text.date-tooltip").text("");
    },
    // Double click to reinitialize zoom to whole period
    resetZoom: function() {
      if ((!this.minDate || this.mindate === this.fullStart) && !this.maxDate) return;
      if (!this.loading) this.loading = 0.2;
      this.minDate = this.fullStart;
      this.maxDate = null;
    }
  }
});
