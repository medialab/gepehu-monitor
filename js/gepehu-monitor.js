d3.formatDefaultLocale({
  "decimal": ",",
  "thousands": " ",
  "grouping": [3],
  "currency": [""],
});
d3.defaultColors = ["#FFAB91", "#FFE082", "#A5D6A7", "#80DEEA"]

d3.intFormat = d3.format(",d");
d3.percentFormat = d3.format(".1%");
d3.datize = function(d) {
  return new Date(d);
}
d3.startDate = function(gpus){
  return d3.min(gpus.map(function(a) {
    if (a.rows.length)
      return new Date(a.rows[0].datetime);
     return new Date();
  }));
}

new Vue({
  el: "#dashboard",
  data: {
    gpus: [],
    tmpgpus: [],
    gpus_done: [],
    metricChoice: "usage_percent",
    metrics: [
      {id: "usage_percent",  selected: true,  name: "GPU use (%)",       color: "deepskyblue"},
      {id: "memory_percent", selected: false, name: "Memory use (%)",        color: "lawngreen"},
      {id: "memory",         selected: false, name: "Memory use (Mo)",       color: "lawngreen"},
      {id: "energy",         selected: false, name: "Energy (W)",        color: "gold"},
      {id: "temperature",    selected: false, name: "Temperature (°C)",  color: "crimson"},
      {id: "fan_speed",      selected: false, name: "Fan speed (R/min)", color: "mediumorchid"}
    ],
    processes: {},
    hoverProcesses: [],
    hoverDate: null,
    hiddenLeft: 0,
    hiddenRight: 0
  },
  computed: {
    url: function() {
      return this.metrics.filter(function(a) { return a.selected; })[0].id;
    }
  },
  watch: {
    url: function(newValue) {
      window.location.hash = newValue;
    },
    gpus_done: function(newValue) {
      if (newValue.length && newValue.length === this.tmpgpus.length)
        this.prepareData();
    }
  },
  mounted: function() {
    this.readUrl();
    window.addEventListener("hashchange", this.readUrl);
    window.addEventListener("resize", this.draw);
    this.download_data();
    setInterval(this.download_data, 10000);
  },
  methods: {
    readUrl: function() {
      this.selectMetric(window.location.hash.slice(1));
      this.$nextTick(this.draw);
    },
    selectMetric: function(newMetric) {
      if (!newMetric || !~this.metrics.map(x => x.id).indexOf(newMetric))
        newMetric = "usage_percent";
      this.metricChoice = newMetric;
      this.metrics.forEach(function(m) {
        m.selected = (m.id === newMetric);
      });
    },
    download_data: function() {
      var gpus = this.tmpgpus,
        gpus_done = this.gpus_done,
        processes = this.processes,
        cacheBypass = new Date().getTime();
      if (gpus.length) {
        if (gpus.length !== gpus_done.length) return;
        while (gpus.pop()) {};
      }
      while (gpus_done.pop()) {};

      d3.request("data/list").mimeType("text/plain").get(function(error, list_gpus) {
        if (error) throw error;
        list_gpus.responseText.trim().split("\n").forEach(function(gpu_id, idx) {
          var gpu = {
            id: gpu_id,
            color: d3.defaultColors[idx]
          };
          gpus.push(gpu);
          fetch("data/" + gpu_id + ".csv.gz?" + cacheBypass)
          .then(res => res.arrayBuffer())
          .then((body) => {
            var res = pako.ungzip(body, {to: "string"})
            gpu.rows = d3.csvParse(res, function(d) {
              d.datetime = d3.datize(d.datetime);
              d.usage_percent = parseFloat(d.usage_percent) / 100;
              d.memory_percent = parseFloat(d.memory_percent) / 100;
              d.memory = parseInt(d.memory);
              d.energy = parseInt(d.energy);
              d.temperature = parseInt(d.temperature);
              d.fan_speed = parseInt(d.fan_speed);
              d.users = d.users.split("|").filter(x => x);
              d.processes = d.processes.replace(/\//g, "/&#8203;").split("|").filter(x => x);
              d.processes.forEach((p, i) => {
                if (!processes[d.datetime])
                  processes[d.datetime] = [];
                processes[d.datetime].push({
                  gpu: d.gpu_name,
                  color: gpu.color,
                  user: d.users[i],
                  command: p
                });
              });
              return d;
            });
            gpu.name = gpu.rows[0].gpu_name;
            gpus_done.push(gpu.id);
          });
        });
      });
    },
    prepareData: function() {
      while (this.gpus.pop()) {};
      var tmpgpu;
      while (tmpgpu = this.tmpgpus.pop()) {
        var prevDatetime = null;
        for (var i = 0; i < tmpgpu.rows.length; i++) {
          tmpgpu.rows[i].prevDatetime = prevDatetime;
          prevDatetime = tmpgpu.rows[i].datetime;
        }
        this.gpus.push(tmpgpu);
      }
      this.draw();
    },
    draw: function() {
      var gpus = this.gpus;
      if (!gpus.length) return;

      d3.select(".svg").selectAll("svg").remove();
    
      var metricChoice = this.metricChoice,
        metric = this.metrics.filter(x => x.id == metricChoice)[0],
        percent = ~metricChoice.indexOf("_percent");

      var start = d3.startDate(gpus),
        end = new Date(),
        data = [];
      this.extent = Math.round((end - start) / 1000);

/*
      // TODO: Zoom in timeline
      start.setDate(start.getDate() + this.hiddenLeft);
      end.setDate(end.getDate() - this.hiddenRight);
      this.data.slice(this.hiddenLeft, this.data.length - this.hiddenRight)
      .forEach(function(d) {
        if (d.datetime < start || d.datetime > end) return;
        data.push(d);
      });
      this.curView = Math.round((end - start) / (1000*60*60*24));
*/

      // Setup dimensions
      var margin = {top: 20, right: 70, bottom: 20, left: 40, middle: 30},
        mainH = window.innerHeight - document.querySelector("nav").getBoundingClientRect().height,
        svgH = Math.max(140, mainH),
        svgW = window.innerWidth - document.querySelector("aside").getBoundingClientRect().width,
        height = (svgH - margin.top - margin.bottom - (gpus.length - 1) * margin.middle) / gpus.length,
        width = svgW - margin.left - margin.right;

      // Position legend
      gpus.forEach(function(gpu, idx) {
        var xPos = margin.left + 10,
          yPos = margin.top + idx * (height + margin.middle);
        gpu.style = {
          "font-size": "14px",
          "background-color": gpu.color,
          top:  yPos + "px",
          left: xPos + "px"
        };
      });

      // Compute X range
      var xScale = d3.scaleTime().range([0, width]).domain([start, end]),
        xPosition = key => function(d) { return xScale(d3.min([end, d3.max([start, d[key] ])])); },
        xWidth = function(d) { return xPosition("datetime")(d) - xPosition("prevDatetime")(d); };

      // Compute Y range
      var yMin = 0, yMax = 1;
      if (!percent) gpus.forEach(g => {
        var gpuMax = d3.max(g.rows.map(d => d[metricChoice]));
        yMax = d3.max([yMax, gpuMax]);
      });
      yMax *= 1.08;
      var yScale = d3.scaleLinear().range([height, 0]).domain([yMin, yMax]);
  
      // Prepare svg
      var svg = d3.select(".svg")
      .style("height", mainH + "px")
      .append("svg")
        .attr("width", svgW)
        .attr("height", svgH);

      gpus.forEach((gpu, idx) => {
        var data = gpu.rows;
        // TODO: filter zoomed data here

        var g = svg.append("g")
          .attr("transform", "translate(" + margin.left + "," + (margin.top + idx * (height + margin.middle)) + ")");

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
          .call(d3.axisRight(yScale).ticks(8, d3[(percent ? "percent" : "int") + "Format"]).tickSizeOuter(0));
  
        // Draw X axis
        g.append("g")
          .attr("class", "axis axis--x")
          .attr("transform", "translate(0, " + (height) + ")")
          .call(d3.axisBottom(xScale).ticks(Math.floor(width / 175), d3.timeFormat("%d %b %y")).tickSizeOuter(0));
  
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
            .on("mouseover", this.hover)
            .on("mousemove", this.displayTooltip)
            .on("mouseleave", this.clearTooltip)
            //.on("wheel", this.zoom)
            //.on("dblclick", this.zoom); */
        this.clearTooltip();

      });
    },
    hover: function(d, i) {
      d3.selectAll('rect[did="' + i + '"]').style("fill-opacity", 1);
    },
    displayTooltip: function(d, i, rects) {
      this.hoverDate = d3.timeFormat("%d %b %y %H:%M")(d.datetime);
      this.hoverProcesses = this.processes[d.datetime].sort((a, b) => a.gpu.localeCompare(b.gpu));
      d3.select(".tooltipBox")
      .style("left", d3.event.pageX - 60 + "px")
      .style("top", d3.event.pageY + 20 + "px")
      .style("display", "block");
    },
    clearTooltip: function(d, i) {
      this.hoverProcesses = [];
      this.hoverDate = null;
      if (i) d3.selectAll('rect[did="' + i + '"]').style("fill-opacity", 0);
      d3.select(".tooltipBox").style("display", "none");
    },
    zoom: function(d, i, rects) {
      var direction = (d3.event.deltaY && d3.event.deltaY > 0 ? -1 : 1),
        days = this.curView / 3,
        gauge = (i + 1) / rects.length,
        gaugeLeft = (gauge > 0.05 ? gauge : 0),
        gaugeRight = (gauge < 0.95 ? 1 - gauge : 0);
      if (direction == 1 && this.extent - this.hiddenLeft - this.hiddenRight < 35) return;
      this.hiddenLeft += Math.floor(gaugeLeft * days * direction);
      this.hiddenRight += Math.floor(gaugeRight * days * direction);
      if (this.hiddenLeft < 0) this.hiddenLeft = 0;
      if (this.hiddenRight < 0) this.hiddenRight = 0;
      this.draw();
      this.displayTooltip(d, i, rects);
    }
  }
});
