# Chart Creation

Create data visualizations using Apache ECharts. Charts are rendered on the host and sent as PNG images.

## How to create a chart

Call `mcp__nanoclaw__send_chart` with:
- `chart_option`: ECharts option as a JSON string
- `caption` (optional): Caption for the image
- `width` (optional): Width in pixels (default 800)
- `height` (optional): Height in pixels (default 600)
- `background` (optional): Background color (default white)

The host renders the chart using Chrome and sends the PNG to the user automatically.

## Example

```
mcp__nanoclaw__send_chart({
  chart_option: JSON.stringify({
    "title": { "text": "Revenue by Quarter", "left": "center" },
    "tooltip": { "trigger": "axis" },
    "xAxis": { "type": "category", "data": ["Q1", "Q2", "Q3", "Q4"] },
    "yAxis": { "type": "value", "name": "Revenue ($M)" },
    "series": [{ "type": "bar", "data": [120, 200, 150, 250], "itemStyle": { "color": "#5470c6" } }]
  }),
  caption: "Revenue by Quarter"
})
```

## Chart types reference

### Line
```json
{
  "xAxis": { "type": "category", "data": ["Mon", "Tue", "Wed", "Thu", "Fri"] },
  "yAxis": { "type": "value" },
  "series": [{ "type": "line", "data": [150, 230, 224, 218, 135], "smooth": true }]
}
```

### Pie
```json
{
  "series": [{
    "type": "pie", "radius": "60%",
    "data": [
      { "value": 1048, "name": "Search" },
      { "value": 735, "name": "Direct" },
      { "value": 580, "name": "Email" }
    ]
  }]
}
```

### Candlestick (financial)
```json
{
  "xAxis": { "type": "category", "data": ["2024-01", "2024-02", "2024-03"] },
  "yAxis": { "type": "value" },
  "series": [{ "type": "candlestick", "data": [[20, 34, 10, 38], [40, 35, 30, 50], [31, 38, 33, 44]] }]
}
```

### Multi-series line (comparison)
```json
{
  "legend": { "data": ["HIMS", "COHR"] },
  "xAxis": { "type": "category", "data": ["Jan", "Feb", "Mar", "Apr"] },
  "yAxis": { "type": "value" },
  "series": [
    { "name": "HIMS", "type": "line", "data": [22, 28, 25, 31] },
    { "name": "COHR", "type": "line", "data": [85, 82, 90, 88] }
  ]
}
```

### Scatter
```json
{
  "xAxis": { "type": "value" },
  "yAxis": { "type": "value" },
  "series": [{ "type": "scatter", "data": [[10, 8.04], [8, 6.95], [13, 7.58], [9, 8.81]] }]
}
```

## Tips

- Always set `"title"` for context
- Use `"tooltip": { "trigger": "axis" }` for polished charts
- For dark theme: set `"backgroundColor": "#1a1a2e"` and use `"textStyle": { "color": "#eee" }`, and pass `background: "#1a1a2e"`
- Use width 1000 / height 500 for wider charts (timeseries)
- Use width 600 / height 600 for square charts (pie, radar)
- Full ECharts docs: https://echarts.apache.org/en/option.html
