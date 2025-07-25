/* TODO
 * - fix single not working
 * - add timeslider/selecter
 * - handle time period / zoom in urls
 * - add a metric of processes/users
 * - think whether to keep or not full processed commands within sidebar
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
    metrics: [
      {id: "usage_percent",     selected: false, name: "GPU",          unit: "%",  color: "deepskyblue"},
      {id: "memory_percent",    selected: false, name: "Memory use",   unit: "%",  color: "lawngreen"},
      {id: "memory",            selected: false, name: "Memory use",   unit: "Mo", color: "lawngreen"},
      {id: "energy",            selected: false, name: "Energy",       unit: "W",  color: "gold"},
      {id: "temperature",       selected: false, name: "Temperature",  unit: "°C", color: "crimson"},
      {id: "fan_speed_percent", selected: false, name: "Fan speed",    unit: "%",  color: "mediumorchid"}
    ],
    processes: {},
    hoverProcesses: [],
    hoverDate: null,
    hoverText: [],
    hiddenLeft: 0,
    hiddenRight: 0
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
        this.draw();
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
          rows: []
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
      }
      window.addEventListener("hashchange", this.readUrl);
      window.addEventListener("resize", this.draw);
      this.downloadData();
      setInterval(this.downloadData, 20_000);
    },
    readUrl: function(init) {
      var self = this,
        url = window.location.hash.slice(1);
      if (url && ~url.indexOf("&")) url.split("&").forEach(urlPiece => {
        var [key, values] = urlPiece.split("=");
        if (key == "gpus" && values != "") values.split(",").forEach(v => self.toggleGPU(parseInt(v), true));
        else if (key == "metrics" && values != "") values.split(",").forEach(v => self.toggleMetric(v, true));
        else if (key == "aggregated") self.aggregateGPUs = (values === "true");
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
      var gpusToDo = this.gpusToDo,
        gpusDone = this.gpusDone,
        processes = this.processes,
        cacheBypass = new Date().getTime();
      if (gpusToDo.length) {
        if (gpusToDo.length !== gpusDone.length) return;
        while (gpusToDo.pop()) {};
      }
      while (gpusDone.pop()) {};
      Object.keys(processes).forEach(d => { processes[d] = [] });

      this.gpus.forEach(gpu => {
        gpusToDo.push(gpu.id)
        fetch("data/" + gpu.id + ".csv.gz?" + cacheBypass)
        .then(res => res.arrayBuffer())
        .then((body) => {
          var res = pako.ungzip(body, {to: "string"}),
            prevDatetime = null;
          gpu.rows = d3.csvParse(res, function(d, idx) {
            d.datetime = d3.datize(d.datetime);
            d.prevDatetime = prevDatetime;
            prevDatetime = d.datetime;
            d.usage_percent = parseFloat(d.usage_percent) / 100;
            d.memory_percent = parseFloat(d.memory_percent) / 100;
            d.memory = parseInt(d.memory);
            d.energy = parseInt(d.energy);
            d.temperature = parseInt(d.temperature);
            d.fan_speed_percent = parseInt(d.fan_speed) / 100;
            d.users = d.users.split("§").filter(x => x);
            d.processes = d.processes.replace(/\//g, "/&#8203;").split("§").filter(x => x);
            d.processes.forEach((p, i) => {
              if (!processes[d.datetime])
                processes[d.datetime] = [];
              processes[d.datetime].push({
                gpu: d.gpu_name,
                gpu_index: gpu.index,
                color: gpu.color,
                user: d.users[i],
                command: p
              });
            });
            return d;
          });
          gpu.name = gpu.rows[0].gpu_name;
          gpusDone.push(gpu.id);
        });
      });
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
      var start = new Date(fullStart.getTime() + this.hiddenLeft * 60_000),
        end = new Date(fullEnd.getTime() - this.hiddenRight * 60_000);
      this.curView = Math.round((end - start) / 60_000);

      // Setup dimensions
      var nbPlots = this.aggregateGPUs ? 1 : this.gpusChoices.length,
        margin = {top: 20, right: 70, bottom: 30, left: 40, horiz: 70, vert: 30},
        mainH = window.innerHeight - document.querySelector("nav").getBoundingClientRect().height,
        svgH = Math.max(140, mainH),
        svgW = window.innerWidth - document.querySelector("aside").getBoundingClientRect().width,
        height = (svgH - margin.top - margin.bottom - (this.metricsChoices.length - 1) * margin.vert) / this.metricsChoices.length,
        width = (svgW - margin.left - margin.right - (nbPlots - 1) * margin.horiz) / nbPlots;

      // Prepare svg
      var svg = d3.select(".svg")
      .style("height", mainH + "px")
      .append("svg")
        .attr("width", svgW)
        .attr("height", svgH);
  
      // Position legend
      this.gpusChoices.forEach(idx => {
        var xPos = margin.left + idx * (width + margin.horiz),
          yPos = margin.top;
        self.gpus[idx].style = {
          "font-size": "14px",
          "background-color": self.gpus[idx].color,
          top:  yPos + "px",
          left: xPos + "px"
        };
      });

      // Compute X range
      var xScale = d3.scaleTime().range([0, width]).domain([start, end]),
        xPosition = key => function(d) { return xScale(d3.min([end, d3.max([start, d[key] ])])); },
        xWidth = function(d) { return xPosition("datetime")(d) - xPosition("prevDatetime")(d); };

      // Prepare aggregated data
      var datasets = []
      if (self.aggregateGPUs && self.gpusChoices.length > 1) {
        var aggregatedGPU = [];
        for (var rowIdx = 0; rowIdx < self.gpus[0].rows.length; rowIdx++) {
          aggregatedGPU.push({
            datetime: self.gpus[0].rows[rowIdx].datetime,
            prevDatetime: self.gpus[0].rows[rowIdx].prevDatetime,
            usage_percent: d3.mean(self.gpusChoices.map(idx => self.gpus[idx].rows[rowIdx].usage_percent)),
            memory_percent: d3.mean(self.gpusChoices.map(idx => self.gpus[idx].rows[rowIdx].memory_percent)),
            memory: d3.sum(self.gpusChoices.map(idx => self.gpus[idx].rows[rowIdx].memory)),
            energy: d3.sum(self.gpusChoices.map(idx => self.gpus[idx].rows[rowIdx].energy)),
            temperature: d3.mean(self.gpusChoices.map(idx => self.gpus[idx].rows[rowIdx].temperature)),
            fan_speed_percent: d3.mean(self.gpusChoices.map(idx => self.gpus[idx].rows[rowIdx].fan_speed_percent)),
          });
        }
        datasets.push(aggregatedGPU);
      } else {
        self.gpusChoices.forEach((idx) => {
          datasets.push(self.gpus[idx].rows);
        });
      }

      this.metricsChoices.forEach((metricChoice, metric_idx) => {

        var metric = self.metrics.filter(x => x.id == metricChoice)[0],
          percent = ~metricChoice.indexOf("_percent");

        // Compute Y range
        var yMin = 0, yMax = 1;
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
            if (d.datetime < start || d.datetime > end) return;
            data.push(d);
          });
  
          var g = svg.append("g")
            .attr("transform", "translate(" + (margin.left + gpu_idx * (width + margin.horiz)) + "," + (margin.top + metric_idx * (height + margin.vert)) + ")");
  
          // Draw Filled plot using line + area
          g.append("path")
            .datum(data)
            .attr("class", "line")
            .attr("fill", "none")
            .attr("stroke", metric.color)
            .attr("stroke-width", 1)
            .attr("d", d3.line()
              .x(function(d) { return xScale(d.datetime); })
              .y(function(d) { return yScale(d[metricChoice]); })
            );
          g.append("path")
            .datum(data)
            .attr("class", "area")
            .attr("fill", metric.color)
            .attr("fill-opacity", 0.25)
            .attr("d", d3.area()
              .x(function(d) { return xScale(d.datetime); })
              .y0((height))
              .y1(function(d) { return yScale(d[metricChoice]); })
            );
    
          // Draw Y axis
          g.append("g")
            .attr("class", "axis axis--y")
            .attr("transform", "translate(" + (width) + ", 0)")
            .call(d3.axisRight(yScale)
              .ticks(height > 200 ? 8 : 4)
              .tickFormat(d3.axisFormat(metric.unit))
              .tickSizeOuter(0)
            );
    
          // Draw X axis
          var dates = d3.timeDay.range(start, end),
            xAxis = d3.axisBottom(xScale)
            .tickFormat(d3.timeFormat("%d %b %y"))
            .tickSizeOuter(0);
          if (width / dates.length < 175)
            xAxis.ticks(width / 175);
          else xAxis.tickValues(dates);

          g.append("g")
            .attr("class", "axis axis--x")
            .attr("transform", "translate(0, " + (height) + ")")
            .call(xAxis);
    
          // Draw tooltips surfaces
          g.append("g")
            .selectAll("rect.tooltip")
            .data(data.slice(1)).enter().append("rect")
              .classed("tooltip", true)
              .attr("did", function(d, i) { return i; })
              .attr("x", xPosition("prevDatetime"))
              .attr("y", yScale.range()[1])
              .attr("width", xWidth)
              .attr("height", yScale.range()[0] - yScale.range()[1])
              .on("mouseover", self.hover)
              .on("mousemove", self.displayTooltip)
              .on("mouseleave", self.clearTooltip)
              .on("wheel", self.zoom)
              .on("dblclick", self.zoom);
        });
      });

      this.clearTooltip();
      this.loading = 0;
    },
    hover: function(d, i) {
      d3.selectAll('rect[did="' + i + '"]').style("fill-opacity", 1);
    },
    displayTooltip: function(d, i, rects) {
      if (!d3.event) return;
      this.hoverDate = d3.timeFormat("%d %b %y %H:%M")(d.datetime);
      this.hoverText = [];
      this.metricsChoices.forEach((metricChoice, metric_idx) => {
        var metric = this.metrics.filter(x => x.id == metricChoice)[0],
          percent = ~metricChoice.indexOf("_percent");
        this.hoverText.push({
          metric: metric.name,
          color: metric.color,
          value: d3[(percent ? "percent" : "int") + "Format"](d[metricChoice]) + (percent ? "" : " " + metric.unit)
        });
      });
      this.hoverProcesses = (this.processes[d.datetime] || []).filter(p => ~this.gpusChoices.indexOf(p.gpu_index)).sort((a, b) => a.gpu.localeCompare(b.gpu));
      d3.select(".tooltipBox")
      .style("left", d3.event.pageX - 120 + "px")
      .style("top", d3.event.pageY + 20 + "px")
      .style("display", "block");
    },
    clearTooltip: function(d, i) {
      this.hoverProcesses = [];
      this.hoverDate = null;
      this.hoverText = null;
      if (i) d3.selectAll('rect[did="' + i + '"]').style("fill-opacity", 0);
      d3.select(".tooltipBox").style("display", "none");
    },
    zoom: function(d, i, rects) {
      var direction = (d3.event.deltaY && d3.event.deltaY > 0 ? -1 : 1),
        minutes = this.curView / 3,
        gauge = (i + 1) / rects.length,
        gaugeLeft = (gauge > 0.05 ? gauge : 0),
        gaugeRight = (gauge < 0.95 ? 1 - gauge : 0);
      if ((direction == 1 && this.extent - this.hiddenLeft - this.hiddenRight < 1_440) || (direction == -1 && this.hiddenLeft + this.hiddenRight == 0)) return;
      this.hiddenLeft += Math.floor(gaugeLeft * minutes * direction);
      this.hiddenRight += Math.floor(gaugeRight * minutes * direction);
      if (this.hiddenLeft < 0) this.hiddenLeft = 0;
      if (this.hiddenRight < 0) this.hiddenRight = 0;
      if (!this.loading) this.loading = 0.2;
      setTimeout(() => {
        this.reallyDraw();
        setTimeout(() => this.displayTooltip(d, i, rects), 10);
      }, 0);
    }
  }
});
