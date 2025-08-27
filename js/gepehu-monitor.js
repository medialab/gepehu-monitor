/* TODO
 * - move calendar at the bottom instead and add a visual marker of the triangle corresponding to the scale?
 * - use subprocess for processing data
 * - find better ways to handle hoverProcesses
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
d3.axisFormat = (unit) => {
  if (unit === "%")
    return d3.format(".0%");
  else if (unit === "Mo")
    return d => d3.format(",d")(d).replace(" 000", " Go");
  return d => d3.intFormat(d) + " " + unit;
};
d3.minutize = (d) => d.toLocaleString('sv').replace(' ', 'T').slice(0, 16);
d3.deminutize = (d) => new Date(d + ":00");

new Vue({
  el: "#dashboard",
  data: {
    loading: 1,
    resizing: false,
    gpus: [],
    gpusToDo: [],
    gpusDone: [],
    aggregateGPUs: true,
    metrics: [
      {id: "usage_percent",     selected: true,  name: "GPU",          unit: "%",  color: "deepskyblue"},
      {id: "memory",            selected: true,  name: "Memory use",   unit: "Mo", color: "lawngreen"},
      {id: "memory_percent",    selected: false, name: "Memory use",   unit: "%",  color: "lawngreen"},
      {id: "energy",            selected: true,  name: "Energy",       unit: "W",  color: "gold"},
      {id: "temperature",       selected: true,  name: "Temperature",  unit: "°C", color: "crimson"},
      {id: "fan_speed_percent", selected: false, name: "Fan speed",    unit: "%",  color: "mediumorchid"},
      {id: "n_processes",       selected: true,  name: "Processes",    unit: "", color: "grey"}
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
      return this.gpus.filter(g => g.selected).map(g => g.index);
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
        console.log("INIT APP")
    // Initialize URL with default parameters if not already a permalink
    if (!window.location.hash)
      window.location.hash = this.url;

    // Download list of GPUs IDs and prepare data structure
    d3.text("data/list").then((listGPUs) => {
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
      // Refresh metrics data every 30s
      setInterval(this.downloadData, 30_000);

      // Initialize app with permalink settings
      this.readUrl();
      // Select by default all GPUs if none set
      if (!this.gpusChoices.length)
        for (var i = 0; i < this.gpus.length; i++)
          this.toggleGPU(i, true);
      // Defaults to only the last 15 days
      if (!this.minDate && !this.maxDate) {
        var start = new Date();
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
      var url = window.location.hash.slice(1),
        aggregate = false,
        d = new Date();
      if (url && ~url.indexOf("&")) url.split("&").forEach(urlPiece => {
        var [key, values] = urlPiece.split("=");
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
      this.metrics.forEach((m) => {
        if (m.id === metricID)
          m.selected = force || !m.selected;
      });
    },
    // Download individual GPUs metrics data
    downloadData: function() {
      // Do not refresh data if current zooming action
      if (this.brushing != null) return;

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
        .then((body) => {
          // Decompress gzipped data
          var res = pako.ungzip(body, {to: "string"});

          gpu.rows = d3.csvParse(res, (d, idx) => {
            d.datetime = new Date(d.datetime);
            d.minute = d3.minutize(d.datetime);
            d.usage_percent = parseFloat(d.usage_percent) / 100;
            d.memory_percent = parseFloat(d.memory_percent) / 100;
            d.memory = parseInt(d.memory);
            d.energy = parseInt(d.energy);
            d.temperature = parseInt(d.temperature);
            d.fan_speed_percent = parseInt(d.fan_speed) / 100;
            d.users = d.users.split("§").filter(x => x);
            d.users.forEach(u => {
              if (!~this.users.indexOf(u))
                this.users.push(u);
            });

            // Keep maps of processes and metrics at each timestamp
            var row_processes = d.processes.replace(/\//g, "/&#8203;").split("§").filter(x => x);
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
        });
      });
    },
    // Post process data when all GPUs' metrics collected
    prepareData: function() {
      // Evaluate complete time range
      this.fullStart = d3.min(this.gpus.map((g) =>
        g.rows && g.rows.length ? new Date(g.rows[0].datetime) : new Date()
      ));
      this.fullEnd = new Date();

      // Prepare list of all users
      this.users.sort();
      this.gpus.forEach(gpu =>
        gpu.rows.forEach(row =>
          this.users.forEach(user => {
            row["processes_by_" + user] = row.users.filter(u => (u === user)).length;
          })
        )
      );
      this.users.forEach((user, idx) =>
        this.usersColors[user] = d3.defaultColors[idx + this.gpus.length]
      );

      // Always draw plots on first load or refresh them if required
      this.draw(1 - this.loading);
    },
    // Refresh plots if required
    draw: function(lazy) {
      // Do nothing if post-processing never happened yet
      if (!Object.keys(this.usersColors).length) return;
      // Do not refresh plots with latest data if zoomed in the past
      if (this.maxDate && lazy) return;
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
      var nbPlots = this.aggregateGPUs ? 1 : this.gpusChoices.length,
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
      var svg = d3.select(".svg")
        .style("height", mainH + "px")
        .append("svg")
          .attr("width", svgW)
          .attr("height", svgH);

      // Position GPU labels on each column
      this.gpusChoices.forEach(idx => {
        var xPos = margin.left + idx * (this.width + margin.horiz),
          yPos = margin.top;
        this.gpus[idx].style = {
          "font-size": "14px",
          "background-color": this.gpus[idx].color,
          top:  yPos + "px",
          left: xPos + "px"
        };
      });

      // Compute X range
      this.xScale = d3.scaleTime().range([0, this.width]).domain([this.start, this.end]);
      var xPosition = (d) => this.xScale(d3.min(
        [this.end, d3.max([this.start, d.data ? d.data["datetime"] : d[key]])]
      ));

      // Prepare X axis
      var xAxis = d3.axisBottom(this.xScale)
        .tickSizeOuter(0);
      // Use days if the period covered is at least a day and a half
      if (this.end - this.start > 129_600_000)
        xAxis.tickFormat(d3.timeFormat("%d %b %y"))
          .ticks(d3.unixDay.every(Math.max(1, Math.trunc(
            150 * d3.timeDay.range(this.start, this.end).length / this.width
          ))));
      // Use hour:minutes otherwise
      else xAxis.tickFormat(d3.timeFormat("%H:%M"))
        .tickValues(d3.utcTicks(this.start, this.end, Math.trunc(this.width / 100)));

      // Draw zoom-brushable calendar
      this.calendarWidth = svgW - margin.left - margin.right;
      this.calendarScale = d3.scaleTime().range([0, this.calendarWidth]).domain([this.fullStart, this.fullEnd]);

      var calendar = d3.select(".calendar").append("svg")
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

      calendar.append("g")
        .attr("class", "calendar-axis")
        .attr("transform", "translate(0, 28)")
        .call(d3.axisTop(this.calendarScale)
          .tickFormat(d3.timeFormat("%d %b %y"))
          .tickSizeOuter(0)
          .ticks(d3.unixDay.every(Math.trunc(
            100 * d3.timeDay.range(this.fullStart, this.fullEnd).length / this.calendarWidth
          )))
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
      var datasets = []
      if (this.aggregateGPUs && this.gpusChoices.length > 1) {
        // Build aggregated data if required
        this.aggregatedGPU = {rows: [], rowsMap: []};
        for (var rowIdx = 0; rowIdx < this.gpus[0].rows.length; rowIdx++) {
          row = {
            minute: this.gpus[0].rows[rowIdx].minute,
            datetime: this.gpus[0].rows[rowIdx].datetime,
            usage_percent: d3.mean(this.gpusChoices.map(idx => this.gpus[idx].rows[rowIdx].usage_percent)),
            memory_percent: d3.mean(this.gpusChoices.map(idx => this.gpus[idx].rows[rowIdx].memory_percent)),
            memory: d3.sum(this.gpusChoices.map(idx => this.gpus[idx].rows[rowIdx].memory)),
            energy: d3.sum(this.gpusChoices.map(idx => this.gpus[idx].rows[rowIdx].energy)),
            temperature: d3.mean(this.gpusChoices.map(idx => this.gpus[idx].rows[rowIdx].temperature)),
            fan_speed_percent: d3.mean(this.gpusChoices.map(idx => this.gpus[idx].rows[rowIdx].fan_speed_percent)),
            n_processes: d3.sum(this.gpusChoices.map(idx => this.gpus[idx].rows[rowIdx].n_processes))
          };
          this.users.forEach(user => {
            row["processes_by_" + user] = d3.sum(this.gpusChoices.map(idx => this.gpus[idx].rows[rowIdx]["processes_by_" + user]));
          });
          this.aggregatedGPU.rows.push(row);
          this.aggregatedGPU.rowsMap[row.minute] = row;
        }
        datasets.push(this.aggregatedGPU.rows);
      } else {
        this.gpusChoices.forEach((idx) => {
          datasets.push(this.gpus[idx].rows);
        });
      }

      // Plot individual metrics as rows
      this.metricsChoices.forEach((metricChoice, metric_idx) => {

        var metric = this.metrics.filter(x => x.id == metricChoice)[0],
          percent = ~metricChoice.indexOf("_percent");

        // Compute Y range
        var yMin = 0, yMax = 1;
        if (!percent) datasets.forEach(rows => {
          var gpuMax = d3.max(rows.map(d => d[metricChoice]));
          yMax = d3.max([yMax, gpuMax]);
        });
        yMax *= 1.08;
        var yScale = d3.scaleLinear().range([height, 0]).domain([yMin, yMax]);

        // Plot each GPU as a column
        datasets.forEach((rows, gpu_idx) => {

          var rowsMap = this.aggregateGPUs ? this.aggregatedGPU.rowsMap : this.gpus[gpu_idx].rowsMap;

          // Filter zoomed out data
          var data = rows.filter((d) => d.datetime >= this.start && d.datetime <= this.end);

          // Create SVG group for current plot and position it in the whole SVG
          var g = svg.append("g")
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
                  .x(xPosition)
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
                .x((d) => this.xScale(d))
                .y((d) => yScale((rowsMap[d3.minutize(d)] || {})[metricChoice] || 0))
              );

            g.append("path")
              .datum(data)
              .attr("class", "area")
              .attr("fill", metric.color)
              .attr("fill-opacity", 0.25)
              .attr("d", d3.area()
                .x((d) => this.xScale(d.datetime))
                .y0((height))
                .y1((d) => yScale(d[metricChoice]))
              );
          }

          // Draw Y axis
          var yAxis = d3.axisRight(yScale)
            .tickFormat(d3.axisFormat(metric.unit))
            .tickSizeOuter(0);
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
          var interactions = g.append("g");

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
            .on("dblclick", this.resetZoom);

        });
      });

      this.clearTooltip();
      this.loading = 0;
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

      var gpu_idx = event.target.attributes.gpu_idx.value,
        brushX = event.pageX - this.svgX - gpu_idx * this.gapX;

      // Handle movements while zoom-brushing
      if (this.brushing != null) {
        var width;
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
        var calBrushX = this.calendarScale(this.xScale.invert(this.brushX)),
          calWidth = this.calendarScale(this.xScale.invert(this.brushX + width)) - calBrushX;
        d3.select("rect.calendar-brush")
          .attr("x", calWidth >= 0 ? calBrushX : calBrushX + calWidth)
          .attr("width", Math.abs(calWidth));

      // Display hover line otherwise
      } else if (brushX >= 0 && brushX <= this.width) {
        this.brushX = brushX;
        d3.selectAll("rect.brush")
          .attr("x", this.brushX)
          .attr("width", 2);
        d3.selectAll("rect.interactions").style("cursor", "crosshair");
      }

      if (brushX < 0 || brushX > this.width)
        return this.clearTooltip();

      // Display tooltip
      var dat = this.xScale.invert(brushX),
        minute = d3.minutize(dat),
        row = (this.aggregateGPUs ? this.aggregatedGPU : this.gpus[gpu_idx]).rowsMap[minute];

      this.hoverDate = d3.timeFormat("%b %d %Y %H:%M")(dat);
      this.hoverText = [];
      this.metricsChoices.forEach((metricChoice, metric_idx) => {
        var metric = this.metrics.filter(x => x.id == metricChoice)[0],
          percent = ~metricChoice.indexOf("_percent");
        this.hoverText.push({
          metric: metric.name,
          color: metric.color,
          value: (row ? d3[(percent ? "percent" : "int") + "Format"](row[metricChoice]) + (percent ? "" : " " + metric.unit) : "n/a")
        });
      });
      this.hoverProcesses = (this.processes[minute] || []).filter(p => ~this.gpusChoices.indexOf(p.gpu_index)).sort((a, b) => a.gpu.localeCompare(b.gpu));

      var boxHeight = 45 + 21 * this.metricsChoices.length;
      d3.select(".tooltipBox")
        .style("left", event.pageX - 120 + "px")
        .style("top", event.pageY + (window.innerHeight - event.pageY > (30 + boxHeight) ? 30 : -(30 + boxHeight)) + "px")
        .style("display", "block");
    },
    // Initiate zoom-brushing on click down
    startBrush: function(event) {
      this.brushing = event.target.attributes.gpu_idx.value;
      var brushX = event.pageX - this.svgX - this.brushing * this.gapX;
      if (brushX < 0 || brushX > this.width) return this.brushing = null;
      this.brushX = brushX;
      d3.selectAll("rect.interactions").style("cursor", "e-resize");
    },
    // Complete zoom-brushing on click up
    stopBrush: function() {
      if (!this.brushing) return;
      var brush = document.querySelector("rect.brush"),
        x = parseFloat(brush.getAttribute("x")),
        width = parseFloat(brush.getAttribute("width"));

      // Evaluate zoom period datetimes from recorded positions
      var minDate = this.xScale.invert(x);
      if (minDate <= this.start)
        minDate = this.start;
      var maxDate = this.xScale.invert(x + parseFloat(brush.getAttribute("width")));
      if (maxDate >= this.end)
        maxDate = this.end;
      if (maxDate >= this.fullEnd)
        maxDate = null;

      // Do not zoom when selection is too small (<5px) or too short (<30min)
      var duration = (maxDate || this.end) - (minDate || this.start);
      if (width < 5 || duration < 1_800_000) {
        d3.selectAll("rect.brush").attr("width", 2);
      } else {
        d3.selectAll("rect.brush").attr("width", 0);
        if (!this.loading) this.loading = 0.2;
        this.minDate = minDate;
        this.maxDate = maxDate;
      }

      d3.selectAll("rect.interactions").style("cursor", x > 0 && x < this.width ? "crosshair" : "unset");
      this.brushing = null;
    },
    // Initiate zoom-brushing from calendar bar on click down
    startCalendarBrush: function(event) {
      var calBrush = document.querySelector("rect.calendar-brush"),
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

      var brushX = event.pageX - this.svgX;

      // Handle movements while zoom-brushing
      if (this.calendarBrushing) {
        var width = brushX - this.calendarBrushX;
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
        var regBrushX = this.xScale(this.calendarScale.invert(this.calendarBrushX)),
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
        var calBrush = document.querySelector("rect.calendar-brush"),
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
      var brush = document.querySelector("rect.calendar-brush"),
        x = parseFloat(brush.getAttribute("x")),
        width = parseFloat(brush.getAttribute("width"));

      // Evaluate zoom period datetimes from recorded positions
      var minDate = this.calendarScale.invert(x);
      if (minDate <= this.fullStart)
        minDate = this.fullStart;
      var maxDate = this.calendarScale.invert(x + parseFloat(brush.getAttribute("width")));
      if (maxDate >= this.fullEnd)
        maxDate = null;

      // Do not zoom when selection is too small (<5px) or too short (<30min)
      var duration = (maxDate || this.fullEnd) - (minDate || this.fullStart);
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
