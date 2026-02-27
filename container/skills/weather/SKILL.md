---
name: weather
description: Check current weather conditions and forecasts using Tomorrow.io. Use when the user asks about weather, temperature, rain, wind, or forecasts.
allowed-tools: Bash(curl:*)
---

# Weather (Tomorrow.io)

Default location: **137 Flamingo Rd, Cotati CA, 94931**

Use `$TOMORROW_IO_API_KEY` for authentication. Always pass `units=imperial` for Fahrenheit/mph.

## Current conditions

```bash
curl -s "https://api.tomorrow.io/v4/weather/realtime?location=137+Flamingo+Rd+Cotati+CA+94931&units=imperial&apikey=$TOMORROW_IO_API_KEY"
```

## Hourly forecast (next 24h)

```bash
curl -s "https://api.tomorrow.io/v4/weather/forecast?location=137+Flamingo+Rd+Cotati+CA+94931&timesteps=1h&units=imperial&apikey=$TOMORROW_IO_API_KEY"
```

## Daily forecast (next 5 days)

```bash
curl -s "https://api.tomorrow.io/v4/weather/forecast?location=137+Flamingo+Rd+Cotati+CA+94931&timesteps=1d&units=imperial&apikey=$TOMORROW_IO_API_KEY"
```

## Custom location

Replace the `location` parameter with any address, city, or lat/lng coordinates:
- `location=New+York+NY`
- `location=38.5,-122.7`

## Key data fields

| Field | Description |
|-------|-------------|
| `temperature` | Temperature (F) |
| `temperatureApparent` | Feels-like temperature (F) |
| `humidity` | Relative humidity (%) |
| `windSpeed` | Wind speed (mph) |
| `windGust` | Wind gust speed (mph) |
| `precipitationProbability` | Chance of precipitation (%) |
| `rainIntensity` | Rain intensity (in/hr) |
| `uvIndex` | UV index (0-11+) |
| `visibility` | Visibility (mi) |
| `cloudCover` | Cloud cover (%) |
| `weatherCode` | Condition code (see below) |

## Weather codes

| Code | Condition |
|------|-----------|
| 1000 | Clear |
| 1100 | Mostly Clear |
| 1101 | Partly Cloudy |
| 1102 | Mostly Cloudy |
| 1001 | Cloudy |
| 2000 | Fog |
| 2100 | Light Fog |
| 4000 | Drizzle |
| 4001 | Rain |
| 4200 | Light Rain |
| 4201 | Heavy Rain |
| 5000 | Snow |
| 5001 | Flurries |
| 5100 | Light Snow |
| 5101 | Heavy Snow |
| 8000 | Thunderstorm |

## Rate limits

- 500 requests/day (free tier)
- Cache results when possible; avoid redundant requests
