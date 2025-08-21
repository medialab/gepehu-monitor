/* TODO
 * - handle time period / zoom in urls
 * - when refresh, do not redraw if zoomed not on endtime
 * - tooltipboxes for whole screen drawn first
 * - add timeslider/selecter
 * - use subprocess for processing data
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

d3.datize = function(d) {
  return new Date(d);
}
d3.startDate = function(gpus){
  return d3.min(gpus.map(function(g) {
    if (g.rows && g.rows.length)
      return new Date(g.rows[0].datetime);
     return new Date();
  }));
}

new Vue({
  el: "#dashboard",
  data: {
    loading: 1,
    gpus: [],
    gpusToDo: [],
    gpusDone: [],
    aggregateGPUs: true,
    aggregatedGPU: {},
    metrics: [
      {id: "usage_percent",     selected: false, name: "GPU",          unit: "%",  color: "deepskyblue"},
      {id: "memory_percent",    selected: false, name: "Memory use",   unit: "%",  color: "lawngreen"},
      {id: "memory",            selected: false, name: "Memory use",   unit: "Mo", color: "lawngreen"},
      {id: "energy",            selected: false, name: "Energy",       unit: "W",  color: "gold"},
      {id: "temperature",       selected: false, name: "Temperature",  unit: "°C", color: "crimson"},
      {id: "fan_speed_percent", selected: false, name: "Fan speed",    unit: "%",  color: "mediumorchid"},
      {id: "n_processes",       selected: false, name: "Processes",    unit: "", color: "grey"}
    ],
    users: [],
    usersColors: {},
    //minutes: {},
    processes: {},
    hoverProcesses: [],
    hoverDate: null,
    hoverText: [],
    svgX: 340,
    gapX: 40,
    brushing: null,
    brushX: 0,
    minDate: null,
    maxDate: null
  },
  computed: {
    gpusChoices: function() {
      return this.gpus.filter(g => g.selected).map(g => g.index);
    },
    metricsChoices: function() {
      return this.metrics.filter(g => g.selected).map(g => g.id);
    },
    url: function() {
      return "gpus=" + this.gpusChoices.join(",") + "&metrics=" + this.metricsChoices.join(",") + "&" + "aggregated=" + this.aggregateGPUs;
    }
  },
  watch: {
    url: function(val) {
      window.location.hash = val;
      this.draw();
    },
    gpusDone: function(val) {
      if (val.length && val.length === this.gpusToDo.length)
        this.prepareData();
    }
  },
  mounted: function() {
    if (!window.location.hash)
      window.location.hash = this.url;
    var gpus = this.gpus,
      init = this.init;
    d3.request("data/list").mimeType("text/plain").get(function(error, listGPUs) {
      if (error) throw error;
      listGPUs.responseText.trim().split("\n").forEach(function(gpuID, idx) {
        gpus.push({
          id: gpuID,
          index: idx,
          name: null,
          selected: false,
          color: d3.defaultColors[idx],
          rows: [],
          rowsMap: {}
        });
      });
      init();
    });
  },
  methods: {
    init: function() {
      this.readUrl(true);
      if (!this.gpusChoices.length)
        for (var i = 0; i < this.gpus.length; i++)
          this.toggleGPU(i, true);
      if (!this.metricsChoices.length) {
        this.toggleMetric("usage_percent", true);
        this.toggleMetric("memory_percent", true);
        this.toggleMetric("n_processes", true);
      }
      window.addEventListener("hashchange", this.readUrl);
      window.addEventListener("resize", this.draw);
      this.downloadData();
      setInterval(this.downloadData, 300_000);
    },
    readUrl: function(init) {
      var url = window.location.hash.slice(1);
      if (url && ~url.indexOf("&")) url.split("&").forEach(urlPiece => {
        var [key, values] = urlPiece.split("=");
        if (key == "gpus" && values != "") values.split(",").forEach(v => this.toggleGPU(parseInt(v), true));
        else if (key == "metrics" && values != "") values.split(",").forEach(v => this.toggleMetric(v, true));
        else if (key == "aggregated") this.aggregateGPUs = (values === "true");
      });
    },
    toggleGPU: function(idx, force) {
      this.gpus[idx].selected = force || !this.gpus[idx].selected;
    },
    toggleMetric: function(metricID, force) {
      this.metrics.forEach(function(m) {
        if (m.id === metricID)
          m.selected = force || !m.selected;
      });
    },
    downloadData: function() {
      if (this.brushing != null) return;
      var users = this.users,
        //minutes = this.minutes,
        processes = this.processes,
        cacheBypass = new Date().getTime();
      if (this.gpusToDo.length) {
        if (this.gpusToDo.length !== this.gpusDone.length) return;
        while (this.gpusToDo.pop()) {};
      }
      while (this.gpusDone.pop()) {};
      Object.keys(processes).forEach(d => { processes[d] = []; });

      this.gpus.forEach(gpu => {
        this.gpusToDo.push(gpu.id)
        fetch("data/" + gpu.id + ".csv.gz?" + cacheBypass)
        .then(res => res.arrayBuffer())
        .then((body) => {
          var res = pako.ungzip(body, {to: "string"}),
            prevDatetime = null;
          gpu.rows = d3.csvParse(res, function(d, idx) {
            d.datetime = d3.datize(d.datetime);
            d.minute = d.datetime.toISOString().slice(0,16);
            //if (!minutes[d.minute])
            //  minutes[d.minute] = true;
            d.prevDatetime = prevDatetime;
            prevDatetime = d.datetime;
            d.usage_percent = parseFloat(d.usage_percent) / 100;
            d.memory_percent = parseFloat(d.memory_percent) / 100;
            d.memory = parseInt(d.memory);
            d.energy = parseInt(d.energy);
            d.temperature = parseInt(d.temperature);
            d.fan_speed_percent = parseInt(d.fan_speed) / 100;
            d.users = d.users.split("§").filter(x => x);
            d.users.forEach(u => {
              if (!~users.indexOf(u))
                users.push(u);
            });
            var row_processes = d.processes.replace(/\//g, "/&#8203;").split("§").filter(x => x);
            d.n_processes = row_processes.length;
            row_processes.forEach((p, i) => {
              if (!processes[d.minute])
                processes[d.minute] = [];
              processes[d.minute].push({
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
    prepareData: function() {
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
      this.draw();
    },
    draw: function() {
      if (!this.gpusChoices.length || !this.gpusDone.length || this.gpusToDo.length != this.gpusDone.length) return;
      if (!this.loading) this.loading = 0.5;
      setTimeout(this.reallyDraw, 50);
    },
    reallyDraw: function() {
      var self = this;

      d3.select(".svg").selectAll("svg").remove();

      var fullStart = d3.startDate(this.gpus),
        fullEnd = new Date();
      this.extent = Math.round((fullEnd - fullStart) / 60_000);

      // Zoom in timeline
      this.start = new Date(this.minDate || fullStart);
      this.end = new Date(this.maxDate || fullEnd);
      this.curView = Math.round((this.end - this.start) / 60_000);

      // Setup dimensions
      var nbPlots = this.aggregateGPUs ? 1 : this.gpusChoices.length,
        margin = {top: 20, right: 70, bottom: 30, left: 40, horiz: 70, vert: 30},
        mainH = window.innerHeight - document.querySelector("nav").getBoundingClientRect().height,
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

      // Position legend
      this.gpusChoices.forEach(idx => {
        var xPos = margin.left + idx * (this.width + margin.horiz),
          yPos = margin.top;
        self.gpus[idx].style = {
          "font-size": "14px",
          "background-color": self.gpus[idx].color,
          top:  yPos + "px",
          left: xPos + "px"
        };
      });

      // Compute X range
      this.xScale = d3.scaleTime().range([0, this.width]).domain([this.start, this.end]);
      var xPosition = key => function(d) {
          return self.xScale(d3.min([
            self.end,
            d3.max([self.start, d.data ? d.data[key] : d[key]])
          ]));
        },
        xWidth = function(d) {
          return xPosition("datetime")(d) - xPosition("prevDatetime")(d);
        };

      // Prepare aggregated data
      var datasets = []
      if (self.aggregateGPUs && self.gpusChoices.length > 1) {
        this.aggregatedGPU = {rows: [], rowsMap: []};
        for (var rowIdx = 0; rowIdx < self.gpus[0].rows.length; rowIdx++) {
          row = {
            minute: self.gpus[0].rows[rowIdx].minute,
            datetime: self.gpus[0].rows[rowIdx].datetime,
            prevDatetime: self.gpus[0].rows[rowIdx].prevDatetime,
            usage_percent: d3.mean(self.gpusChoices.map(idx => self.gpus[idx].rows[rowIdx].usage_percent)),
            memory_percent: d3.mean(self.gpusChoices.map(idx => self.gpus[idx].rows[rowIdx].memory_percent)),
            memory: d3.sum(self.gpusChoices.map(idx => self.gpus[idx].rows[rowIdx].memory)),
            energy: d3.sum(self.gpusChoices.map(idx => self.gpus[idx].rows[rowIdx].energy)),
            temperature: d3.mean(self.gpusChoices.map(idx => self.gpus[idx].rows[rowIdx].temperature)),
            fan_speed_percent: d3.mean(self.gpusChoices.map(idx => self.gpus[idx].rows[rowIdx].fan_speed_percent)),
            n_processes: d3.sum(self.gpusChoices.map(idx => self.gpus[idx].rows[rowIdx].n_processes))
          };
          self.users.forEach(user => {
            row["processes_by_" + user] = d3.sum(self.gpusChoices.map(idx => self.gpus[idx].rows[rowIdx]["processes_by_" + user]));
          });
          this.aggregatedGPU.rows.push(row);
          this.aggregatedGPU.rowsMap[row.minute] = row;
        }
        datasets.push(this.aggregatedGPU.rows);
      } else {
        self.gpusChoices.forEach((idx) => {
          datasets.push(self.gpus[idx].rows);
        });
      }

      this.metricsChoices.forEach((metricChoice, metric_idx) => {

        var metric = self.metrics.filter(x => x.id == metricChoice)[0],
          percent = ~metricChoice.indexOf("_percent");

        // Compute Y range
        var yMin = 0, yMax = (metricChoice === "n_processes" && this.aggregateGPUs ? this.gpusChoices.length : 1);
        if (!percent) datasets.forEach(rows => {
          var gpuMax = d3.max(rows.map(d => d[metricChoice]));
          yMax = d3.max([yMax, gpuMax]);
        });
        yMax *= 1.08;
        var yScale = d3.scaleLinear().range([height, 0]).domain([yMin, yMax]);

        datasets.forEach((rows, gpu_idx) => {

          // Filter zoomed out data
          var data = [];
          rows.forEach(function(d) {
            if (d.datetime < self.start || d.datetime > self.end) return;
            data.push(d);
          });
  
          var g = svg.append("g")
            .attr("transform", "translate(" + (margin.left + gpu_idx * (this.width + margin.horiz)) + "," + (margin.top + metric_idx * (height + margin.vert)) + ")");

          if (metricChoice === "n_processes") {
            g.append("g")
              .selectAll("users")
              .data(d3.stack()
                .keys(self.users.map(u => "processes_by_" + u))
                .value((d, key) => d[key])
                (data)
              ).enter().append("path")
                .attr("fill", d => self.usersColors[self.users[d.index]])
                .attr("d", d3.area()
                  .x(xPosition("datetime"))
                  .y0(d => yScale(d[0]))
                  .y1(d => yScale(d[1]))
                );

          } else {

            g.append("path")
              .datum(data)
              .attr("class", "line")
              .attr("fill", "none")
              .attr("stroke", metric.color)
              .attr("stroke-width", 1)
              .attr("d", d3.line()
                .x(function(d) { return self.xScale(d.datetime); })
                .y(function(d) { return yScale(d[metricChoice]); })
              );
  
            g.append("path")
              .datum(data)
              .attr("class", "area")
              .attr("fill", metric.color)
              .attr("fill-opacity", 0.25)
              .attr("d", d3.area()
                .x(function(d) { return self.xScale(d.datetime); })
                .y0((height))
                .y1(function(d) { return yScale(d[metricChoice]); })
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
          var dates = d3.timeDay.range(self.start, self.end),
            xAxis = d3.axisBottom(self.xScale)
            .tickFormat(d3.timeFormat("%d %b %y"))
            .tickSizeOuter(0);
          if (this.width / dates.length < 175)
            xAxis.ticks(this.width / 175);
          else xAxis.tickValues(dates);

          g.append("g")
            .attr("class", "axis axis--x")
            .attr("transform", "translate(0, " + (height) + ")")
            .call(xAxis);
    
          // Draw hoverable and brushable surface
          var interactions = g.append("g");

          interactions.append("rect")
            .attr("class", "mask")
            .attr("gpu_idx", gpu_idx)
            .attr("x", -margin.left)
            .attr("y", -margin.top)
            .attr("width", margin.left + this.width + margin.right + margin.horiz)
            .attr("height", margin.top + height + margin.bottom + margin.vert)
            .on("mouseleave", self.clearTooltip)
            .on("mouseup", self.stopBrush);

          interactions.append("rect")
            .attr("class", "brush")
            .attr("x", 0)
            .attr("y", 0)
            .attr("width", 0)
            .attr("height", height);

          interactions.append("rect")
            .attr("class", "interactions")
            .attr("gpu_idx", gpu_idx)
            .attr("x", 0)
            .attr("y", 0)
            .attr("width", this.width)
            .attr("height", height)
            .on("mouseover", self.hover)
            .on("mouseleave", self.clearTooltip)
            .on("mousemove", self.hover)
            .on("mousedown", self.startBrush)
            .on("mouseup", self.stopBrush)
            .on("dblclick", self.resetZoom);

        });
      });

      this.clearTooltip();
      this.loading = 0;
    },
    clearTooltip: function() {
      this.hoverDate = null;
      this.hoverText = null;
      this.hoverProcesses = [];

      d3.select(".tooltipBox").style("display", "none");

      if (this.brushing == null)
        d3.selectAll("rect.brush").attr("width", 0);
    },
    hover: function() {
      if (!d3.event) return;

      var gpu_idx = d3.event.target.attributes.gpu_idx.value,
        brushX = d3.event.pageX - this.svgX - gpu_idx * this.gapX;

      if (this.brushing != null) {
        // Display brush
        var width;
        if (this.brushing === gpu_idx) {
          width = brushX - this.brushX;
          d3.selectAll("rect.interactions").style("cursor", (width >= 0 ? "e" : "w") + "-resize");
        } else if (this.brushing < gpu_idx) {
          width = this.width - this.brushX;
          d3.selectAll("rect.interactions").style("cursor", "unset");
        } else {
          width = -this.brushX;
          d3.selectAll("rect.interactions").style("cursor", "unset");
        }

        d3.selectAll("rect.brush")
          .attr("x", width >= 0 ? this.brushX : this.brushX + width)
          .attr("width", Math.abs(width));
      } else {
        // Display hover line
        this.brushX = brushX;
        d3.selectAll("rect.interactions").style("cursor", "crosshair");
        d3.selectAll("rect.brush")
          .attr("x", this.brushX)
          .attr("width", 2);
      }

      // Display tooltip
      var dat = this.xScale.invert(brushX),
        minute = dat.toISOString().slice(0,16),
      // TODO: find closest minute if (!this.minutes[minute])
        row = (this.aggregateGPUs ? this.aggregatedGPU : this.gpus[gpu_idx]).rowsMap[minute];

      var boxHeight = 45 + 21 * this.metricsChoices.length;
      d3.select(".tooltipBox")
        .style("left", d3.event.pageX - 120 + "px")
        .style("top", d3.event.pageY + (window.innerHeight - d3.event.pageY > (30 + boxHeight) ? 30 : -(30 + boxHeight)) + "px")
        .style("display", "block");

      this.hoverDate = d3.timeFormat("%d %b %y %H:%M")(dat);
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
    },
    startBrush: function() {
      this.brushing = d3.event.target.attributes.gpu_idx.value;
      this.brushX = d3.event.pageX - this.svgX - this.brushing * this.gapX;
      d3.selectAll("rect.interactions").style("cursor", "e-resize");
    },
    stopBrush: function() {
      var brush = document.querySelector("rect.brush"),
        x = parseInt(brush.getAttribute("x"));
        width = parseInt(brush.getAttribute("width"));
      if (width < 5) {
        this.brushing = null;
        return;
      }
      this.minDate = this.xScale.invert(x),
      this.maxDate = this.xScale.invert(x + parseInt(brush.getAttribute("width")));
      if (!this.loading) this.loading = 0.2;
      setTimeout(() => {
        d3.selectAll("rect.interactions").style("cursor", "crosshair");
        d3.selectAll("rect.brush").attr("width", 0);
        this.brushing = null;
        this.reallyDraw();
        setTimeout(() => this.hover(), 10);
      }, 50);
    },
    resetZoom: function() {
      this.minDate = null;
      this.maxDate = null;
      if (!this.loading) this.loading = 0.2;
      setTimeout(() => {
        this.reallyDraw();
        setTimeout(() => this.hover(), 10);
      }, 50);
    }
  }
});
