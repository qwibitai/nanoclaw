---
name: chart
description: Create charts and data visualizations (bar, line, pie, doughnut, radar, scatter). Use when asked to visualize data, make a graph, plot metrics, or compare values visually.
allowed-tools: Bash(agent-browser:*)
---

# Chart & Data Visualization with Chart.js

## Workflow

1. Write `/workspace/group/chart.html` with a Chart.js config tailored to the user's data
2. Open it with agent-browser and screenshot to `/workspace/group/chart.png`
3. Send the PNG via `mcp__nanoclaw__send_files`

## HTML Template

Always start from this base template:

```html
<!DOCTYPE html>
<html>
<head>
<style>
  body { margin: 0; background: #111; display: flex; align-items: center; justify-content: center; height: 100vh; }
  canvas { max-width: 800px; max-height: 500px; }
</style>
</head>
<body>
<canvas id="chart" width="800" height="500"></canvas>
<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
<script>
new Chart(document.getElementById('chart'), {
  // CHART CONFIG HERE
});
</script>
</body>
</html>
```

## Rendering Commands

```bash
mkdir -p /workspace/group
# (write chart.html to /workspace/group/chart.html first)
agent-browser open file:///workspace/group/chart.html
agent-browser wait 2000
agent-browser screenshot /workspace/group/chart.png
agent-browser close
```

Then call `mcp__nanoclaw__send_files` with:
- files: `[{path: "/workspace/group/chart.png", name: "chart.png"}]`
- caption: describing the chart

## Dark Theme Style Guide

Always use these style defaults for a polished dark look:

| Element | Value |
|---------|-------|
| Background | `#111` or `#0d0d0d` |
| Grid lines | `#333` |
| Tick/label text | `#ffffff` |
| Accent 1 (blue) | `#0074D9` |
| Accent 2 (red) | `#FF4136` |
| Accent 3 (green) | `#2ECC40` |
| Accent 4 (orange) | `#FF851B` |
| Accent 5 (purple) | `#B10DC9` |

Global options to always include:

```js
options: {
  responsive: false,
  plugins: {
    legend: {
      labels: { color: '#ffffff' },
      display: true
    },
    title: {
      display: true,
      text: 'Chart Title',
      color: '#ffffff',
      font: { size: 18 }
    }
  },
  scales: {  // only for cartesian charts (bar, line, scatter)
    x: {
      ticks: { color: '#ffffff' },
      grid: { color: '#333' }
    },
    y: {
      ticks: { color: '#ffffff' },
      grid: { color: '#333' }
    }
  }
}
```

## Chart Type Examples

### Vertical Bar Chart

```js
{
  type: 'bar',
  data: {
    labels: ['Jan', 'Feb', 'Mar', 'Apr', 'May'],
    datasets: [{
      label: 'Revenue ($k)',
      data: [42, 58, 35, 71, 63],
      backgroundColor: '#0074D9',
      borderRadius: 6
    }]
  },
  options: {
    responsive: false,
    plugins: {
      legend: { labels: { color: '#ffffff' } },
      title: { display: true, text: 'Monthly Revenue', color: '#ffffff', font: { size: 18 } }
    },
    scales: {
      x: { ticks: { color: '#ffffff' }, grid: { color: '#333' } },
      y: { ticks: { color: '#ffffff' }, grid: { color: '#333' } }
    }
  }
}
```

### Horizontal Bar Chart

```js
{
  type: 'bar',
  data: {
    labels: ['Product A', 'Product B', 'Product C', 'Product D'],
    datasets: [{
      label: 'Units Sold',
      data: [120, 85, 200, 65],
      backgroundColor: ['#0074D9', '#FF4136', '#2ECC40', '#FF851B'],
      borderRadius: 6
    }]
  },
  options: {
    indexAxis: 'y',  // makes it horizontal
    responsive: false,
    plugins: {
      legend: { labels: { color: '#ffffff' } },
      title: { display: true, text: 'Sales by Product', color: '#ffffff', font: { size: 18 } }
    },
    scales: {
      x: { ticks: { color: '#ffffff' }, grid: { color: '#333' } },
      y: { ticks: { color: '#ffffff' }, grid: { color: '#333' } }
    }
  }
}
```

### Line Chart

```js
{
  type: 'line',
  data: {
    labels: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
    datasets: [{
      label: 'Active Users',
      data: [320, 450, 380, 510, 490, 620, 580],
      borderColor: '#0074D9',
      backgroundColor: 'rgba(0, 116, 217, 0.15)',
      fill: true,
      tension: 0.4,
      pointBackgroundColor: '#0074D9',
      pointRadius: 5
    }, {
      label: 'New Signups',
      data: [45, 62, 38, 71, 55, 88, 76],
      borderColor: '#2ECC40',
      backgroundColor: 'rgba(46, 204, 64, 0.1)',
      fill: true,
      tension: 0.4,
      pointBackgroundColor: '#2ECC40',
      pointRadius: 5
    }]
  },
  options: {
    responsive: false,
    plugins: {
      legend: { labels: { color: '#ffffff' } },
      title: { display: true, text: 'Weekly Activity', color: '#ffffff', font: { size: 18 } }
    },
    scales: {
      x: { ticks: { color: '#ffffff' }, grid: { color: '#333' } },
      y: { ticks: { color: '#ffffff' }, grid: { color: '#333' } }
    }
  }
}
```

### Pie Chart

```js
{
  type: 'pie',
  data: {
    labels: ['Direct', 'Organic Search', 'Social', 'Email', 'Referral'],
    datasets: [{
      data: [30, 25, 20, 15, 10],
      backgroundColor: ['#0074D9', '#2ECC40', '#FF851B', '#FF4136', '#B10DC9'],
      borderColor: '#111',
      borderWidth: 2
    }]
  },
  options: {
    responsive: false,
    plugins: {
      legend: { labels: { color: '#ffffff' }, position: 'right' },
      title: { display: true, text: 'Traffic Sources', color: '#ffffff', font: { size: 18 } }
    }
  }
}
```

### Doughnut Chart

```js
{
  type: 'doughnut',
  data: {
    labels: ['Frontend', 'Backend', 'DevOps', 'Design'],
    datasets: [{
      data: [35, 30, 20, 15],
      backgroundColor: ['#0074D9', '#FF4136', '#2ECC40', '#FF851B'],
      borderColor: '#111',
      borderWidth: 3,
      hoverOffset: 8
    }]
  },
  options: {
    responsive: false,
    cutout: '65%',
    plugins: {
      legend: { labels: { color: '#ffffff' }, position: 'right' },
      title: { display: true, text: 'Team Breakdown', color: '#ffffff', font: { size: 18 } }
    }
  }
}
```

### Radar Chart

```js
{
  type: 'radar',
  data: {
    labels: ['Speed', 'Reliability', 'Scalability', 'Security', 'UX', 'Cost'],
    datasets: [{
      label: 'System A',
      data: [85, 90, 75, 88, 70, 60],
      borderColor: '#0074D9',
      backgroundColor: 'rgba(0, 116, 217, 0.2)',
      pointBackgroundColor: '#0074D9'
    }, {
      label: 'System B',
      data: [70, 80, 90, 75, 85, 80],
      borderColor: '#FF851B',
      backgroundColor: 'rgba(255, 133, 27, 0.2)',
      pointBackgroundColor: '#FF851B'
    }]
  },
  options: {
    responsive: false,
    plugins: {
      legend: { labels: { color: '#ffffff' } },
      title: { display: true, text: 'System Comparison', color: '#ffffff', font: { size: 18 } }
    },
    scales: {
      r: {
        ticks: { color: '#ffffff', backdropColor: 'transparent' },
        grid: { color: '#333' },
        pointLabels: { color: '#ffffff', font: { size: 13 } },
        angleLines: { color: '#333' }
      }
    }
  }
}
```

### Scatter Chart

```js
{
  type: 'scatter',
  data: {
    datasets: [{
      label: 'Cluster A',
      data: [{x: 2, y: 3}, {x: 3, y: 5}, {x: 4, y: 4}, {x: 5, y: 6}, {x: 3, y: 4}],
      backgroundColor: '#0074D9',
      pointRadius: 7
    }, {
      label: 'Cluster B',
      data: [{x: 8, y: 2}, {x: 9, y: 4}, {x: 10, y: 3}, {x: 8, y: 5}, {x: 11, y: 2}],
      backgroundColor: '#FF4136',
      pointRadius: 7
    }]
  },
  options: {
    responsive: false,
    plugins: {
      legend: { labels: { color: '#ffffff' } },
      title: { display: true, text: 'Scatter Plot', color: '#ffffff', font: { size: 18 } }
    },
    scales: {
      x: { ticks: { color: '#ffffff' }, grid: { color: '#333' } },
      y: { ticks: { color: '#ffffff' }, grid: { color: '#333' } }
    }
  }
}
```

## Tips

- For multi-dataset charts, cycle through the accent colors: `#0074D9`, `#FF4136`, `#2ECC40`, `#FF851B`, `#B10DC9`
- Always set `responsive: false` so the canvas size is respected exactly
- Use `tension: 0.4` on line charts for smooth curves
- Use `borderRadius: 6` on bar charts for a modern rounded look
- Radar charts need `scales.r` instead of `scales.x` / `scales.y`
- Pie and doughnut charts do not use `scales` at all
- If Chart.js CDN fails to load (offline environment), note this in chat and ask the user to confirm network access
