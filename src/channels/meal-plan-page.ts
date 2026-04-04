/**
 * Serves a mobile-first HTML page for the current meal plan and shopping list.
 * No auth — Tailscale is the access layer.
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { GROUPS_DIR } from '../config.js';

const PICKLE_GROUP = 'telegram_pickle';
const PLAN_FILE = path.join(GROUPS_DIR, PICKLE_GROUP, 'current-plan.md');
const INGREDIENTS_FILE = path.join(GROUPS_DIR, PICKLE_GROUP, 'ingredients.md');

// SSE clients waiting for file-change notifications
const sseClients = new Set<http.ServerResponse>();
let fileWatcherStarted = false;

function startFileWatcher(): void {
  if (fileWatcherStarted) return;
  fileWatcherStarted = true;

  let debounce: ReturnType<typeof setTimeout> | null = null;
  const notify = () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      for (const client of sseClients) {
        try {
          client.write('data: updated\n\n');
        } catch {
          sseClients.delete(client);
        }
      }
    }, 300);
  };

  for (const file of [PLAN_FILE, INGREDIENTS_FILE]) {
    try {
      fs.watch(file, notify);
    } catch {
      // File might not exist yet — watch the directory instead
      try {
        fs.watch(path.dirname(file), (_, filename) => {
          if (filename === path.basename(file)) notify();
        });
      } catch {
        // ignore
      }
    }
  }
}

/** Handle GET /pickle/meal-plan and /pickle/meal-plan/events. Returns true if matched. */
export function handleMealPlanPage(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): boolean {
  if (req.method !== 'GET') return false;

  const url = req.url?.split('?')[0] || '';

  // SSE endpoint for live updates
  if (url === '/pickle/meal-plan/events') {
    startFileWatcher();
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('data: connected\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return true;
  }

  if (url !== '/pickle/meal-plan') return false;

  const plan = readFileSafe(PLAN_FILE);
  const ingredients = readFileSafe(INGREDIENTS_FILE);
  const html = renderPage(plan, ingredients);

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
  return true;
}

function readFileSafe(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

// --- Markdown → HTML (minimal, purpose-built) ---

interface RecipeLink {
  title: string;
  url: string;
}

export function parsePlan(md: string): {
  title: string;
  subtitle: string | null;
  days: {
    name: string;
    meals: {
      label: string;
      desc: string;
      details: string[];
      recipes: RecipeLink[];
    }[];
  }[];
} {
  const lines = md.split('\n');
  let title = '';
  let subtitle: string | null = null;
  const days: {
    name: string;
    meals: {
      label: string;
      desc: string;
      details: string[];
      recipes: RecipeLink[];
    }[];
  }[] = [];
  let currentDay: (typeof days)[number] | null = null;
  let currentMeal: {
    label: string;
    desc: string;
    details: string[];
    recipes: RecipeLink[];
  } | null = null;

  for (const line of lines) {
    const trimmed = line.trim();

    // # Week of ...
    if (trimmed.startsWith('# ') && !trimmed.startsWith('## ')) {
      title = trimmed.replace(/^# /, '');
      continue;
    }

    // Italic subtitle like *School holidays — no school lunches*
    if (
      trimmed.startsWith('*') &&
      trimmed.endsWith('*') &&
      !trimmed.startsWith('*Dinner') &&
      !trimmed.startsWith('*School lunch')
    ) {
      subtitle = trimmed.replace(/^\*/, '').replace(/\*$/, '');
      continue;
    }

    // ## Monday, ## Tuesday ✨ New, etc.
    if (trimmed.startsWith('## ')) {
      if (currentDay) days.push(currentDay);
      const dayName = trimmed.replace(/^## /, '');
      currentDay = { name: dayName, meals: [] };
      currentMeal = null;
      continue;
    }

    // *Dinner:* or *School lunch:*
    const mealMatch = trimmed.match(/^\*([^*]+):\*\s*(.*)/);
    if (mealMatch && currentDay) {
      currentMeal = {
        label: mealMatch[1],
        desc: mealMatch[2],
        details: [],
        recipes: [],
      };
      currentDay.meals.push(currentMeal);
      continue;
    }

    // 📖 [Title](url) — recipe links
    const recipeMatch = trimmed.match(/^📖\s*\[([^\]]+)\]\(([^)]+)\)/);
    if (recipeMatch && currentMeal) {
      currentMeal.recipes.push({ title: recipeMatch[1], url: recipeMatch[2] });
      continue;
    }

    // • bullet details
    if ((trimmed.startsWith('•') || trimmed.startsWith('-')) && currentMeal) {
      currentMeal.details.push(trimmed.replace(/^[•-]\s*/, ''));
      continue;
    }
  }
  if (currentDay) days.push(currentDay);

  return { title, subtitle, days };
}

export function parseIngredients(md: string): {
  title: string;
  sections: { name: string; items: string[] }[];
} {
  const lines = md.split('\n');
  let title = '';
  const sections: { name: string; items: string[] }[] = [];
  let currentSection: (typeof sections)[number] | null = null;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith('# ') && !trimmed.startsWith('## ')) {
      title = trimmed.replace(/^# /, '');
      continue;
    }

    if (trimmed.startsWith('## ')) {
      if (currentSection) sections.push(currentSection);
      currentSection = { name: trimmed.replace(/^## /, ''), items: [] };
      continue;
    }

    if (
      (trimmed.startsWith('•') || trimmed.startsWith('-')) &&
      currentSection
    ) {
      currentSection.items.push(trimmed.replace(/^[•-]\s*/, ''));
      continue;
    }
  }
  if (currentSection) sections.push(currentSection);

  return { title, sections };
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderPage(
  planMd: string | null,
  ingredientsMd: string | null,
): string {
  const plan = planMd ? parsePlan(planMd) : null;
  const ingredients = ingredientsMd ? parseIngredients(ingredientsMd) : null;

  let planHtml = '';
  if (plan) {
    const dayCards = plan.days
      .map((day) => {
        const isNew = day.name.includes('✨');
        const dayName = day.name.replace(/\s*✨.*/, '');
        const badge = isNew ? '<span class="badge">New</span>' : '';
        const mealsHtml = day.meals
          .map((meal) => {
            const detailsHtml = meal.details.length
              ? `<ul>${meal.details.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>`
              : '';
            const recipesHtml = meal.recipes.length
              ? `<div class="recipes">${meal.recipes.map((r) => `<a href="${esc(r.url)}" class="recipe-link" target="_blank" rel="noopener">📖 ${esc(r.title)}</a>`).join('')}</div>`
              : '';
            return `<div class="meal"><span class="meal-label">${esc(meal.label)}</span><span class="meal-name">${esc(meal.desc)}</span>${detailsHtml}${recipesHtml}</div>`;
          })
          .join('');
        return `<div class="day-card"><h3>${esc(dayName)}${badge}</h3>${mealsHtml}</div>`;
      })
      .join('');

    const subtitleHtml = plan.subtitle
      ? `<p class="subtitle">${esc(plan.subtitle)}</p>`
      : '';

    planHtml = `<section id="plan"><h2>${esc(plan.title)}</h2>${subtitleHtml}${dayCards}</section>`;
  }

  let ingredientsHtml = '';
  if (ingredients && ingredients.sections.length > 0) {
    const sectionsHtml = ingredients.sections
      .map((section) => {
        const items = section.items
          .map((item) => `<li>${esc(item)}</li>`)
          .join('');
        return `<div class="ingredient-section"><h4>${esc(section.name)}</h4><ul>${items}</ul></div>`;
      })
      .join('');
    ingredientsHtml = `<section id="ingredients"><h2>Shopping List</h2>${sectionsHtml}</section>`;
  }

  const emptyState =
    !plan && !ingredients
      ? '<div class="empty"><p>No meal plan yet.</p><p>Pickle will post one soon.</p></div>'
      : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Meal Plan — Pickle</title>
<style>
:root {
  --bg: #FAF9F6;
  --surface: #FFFFFF;
  --text: #1A1A1A;
  --text-secondary: #6B6B6B;
  --accent: #E8743B;
  --accent-light: #FFF3ED;
  --border: #E8E5E0;
  --green: #2D8A4E;
  --green-light: #EBF5EE;
  --radius: 12px;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #1A1A1A;
    --surface: #2A2A2A;
    --text: #F0EFED;
    --text-secondary: #999;
    --accent: #F0924C;
    --accent-light: #3A2820;
    --border: #3A3A3A;
    --green: #4CAF72;
    --green-light: #1E3028;
  }
}

* { margin: 0; padding: 0; box-sizing: border-box; }

body {
  font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif;
  background: var(--bg);
  color: var(--text);
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
  padding: 0 0 4rem;
}

.tabs {
  position: sticky;
  top: 0;
  z-index: 10;
  display: flex;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  padding: 0;
}

.tab {
  flex: 1;
  text-align: center;
  padding: 14px 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--text-secondary);
  text-decoration: none;
  border-bottom: 2px solid transparent;
  transition: color 0.2s, border-color 0.2s;
  cursor: pointer;
  background: none;
  border-top: none;
  border-left: none;
  border-right: none;
}

.tab.active {
  color: var(--accent);
  border-bottom-color: var(--accent);
}

header {
  padding: 24px 20px 0;
}

header h2 {
  font-size: 22px;
  font-weight: 700;
  letter-spacing: -0.3px;
}

.subtitle {
  font-size: 14px;
  color: var(--text-secondary);
  font-style: italic;
  margin-top: 4px;
}

section {
  padding: 0 20px;
  display: none;
}

section.visible {
  display: block;
}

section h2 {
  font-size: 22px;
  font-weight: 700;
  letter-spacing: -0.3px;
  padding: 24px 0 4px;
}

.day-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 16px;
  margin-top: 12px;
}

.day-card h3 {
  font-size: 17px;
  font-weight: 700;
  margin-bottom: 8px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.badge {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  background: var(--accent-light);
  color: var(--accent);
  padding: 2px 8px;
  border-radius: 6px;
}

.meal {
  margin-top: 6px;
}

.meal-label {
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-secondary);
  margin-right: 6px;
}

.meal-name {
  font-size: 16px;
  font-weight: 600;
}

.meal ul {
  list-style: none;
  padding: 4px 0 0;
}

.meal li {
  font-size: 14px;
  color: var(--text-secondary);
  padding: 1px 0;
  padding-left: 16px;
  position: relative;
}

.meal li::before {
  content: '·';
  position: absolute;
  left: 4px;
  color: var(--border);
  font-weight: bold;
}

/* --- Recipe links --- */

.recipes {
  margin-top: 8px;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.recipe-link {
  font-size: 13px;
  color: var(--accent);
  text-decoration: none;
  background: var(--accent-light);
  padding: 4px 10px;
  border-radius: 8px;
  transition: opacity 0.2s;
}

.recipe-link:hover {
  opacity: 0.8;
}

/* --- Shopping list --- */

.ingredient-section {
  margin-top: 16px;
}

.ingredient-section h4 {
  font-size: 14px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--accent);
  margin-bottom: 8px;
}

.ingredient-section ul {
  list-style: none;
  padding: 0;
}

.ingredient-section li {
  font-size: 15px;
  padding: 8px 0;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  gap: 12px;
}

.ingredient-section li:last-child {
  border-bottom: none;
}

.ingredient-section li::before {
  content: '';
  width: 20px;
  height: 20px;
  border-radius: 6px;
  border: 2px solid var(--border);
  flex-shrink: 0;
}

.ingredient-section li.checked::before {
  background: var(--green);
  border-color: var(--green);
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20' fill='white'%3E%3Cpath d='M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z'/%3E%3C/svg%3E");
  background-size: 14px;
  background-position: center;
  background-repeat: no-repeat;
}

.ingredient-section li.checked {
  color: var(--text-secondary);
  text-decoration: line-through;
}

/* --- Empty state --- */

.empty {
  text-align: center;
  padding: 80px 20px;
  color: var(--text-secondary);
}

.empty p:first-child {
  font-size: 18px;
  font-weight: 600;
  color: var(--text);
}

.empty p:last-child {
  margin-top: 4px;
  font-size: 15px;
}
</style>
</head>
<body>

<div class="tabs">
  <button class="tab active" data-target="plan">Meal Plan</button>
  <button class="tab" data-target="ingredients">Shopping List</button>
</div>

${planHtml}
${ingredientsHtml}
${emptyState}

<script>
// Tab switching
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('section').forEach(s => s.classList.remove('visible'));
    tab.classList.add('active');
    const target = document.getElementById(tab.dataset.target);
    if (target) target.classList.add('visible');
  });
});

// Show first tab by default
const first = document.querySelector('.tab.active');
if (first) {
  const target = document.getElementById(first.dataset.target);
  if (target) target.classList.add('visible');
}

// Shopping list checkboxes (local state via localStorage)
const KEY = 'pickle-checked';
function loadChecked() {
  try { return new Set(JSON.parse(localStorage.getItem(KEY) || '[]')); } catch { return new Set(); }
}
function saveChecked(checked) {
  localStorage.setItem(KEY, JSON.stringify([...checked]));
}
const checked = loadChecked();
document.querySelectorAll('.ingredient-section li').forEach((li, i) => {
  if (checked.has(i)) li.classList.add('checked');
  li.addEventListener('click', () => {
    li.classList.toggle('checked');
    if (li.classList.contains('checked')) checked.add(i); else checked.delete(i);
    saveChecked(checked);
  });
});

// Live updates via SSE — reload content when Pickle updates the plan
(function() {
  let es;
  function connect() {
    es = new EventSource('/pickle/meal-plan/events');
    es.onmessage = function(e) {
      if (e.data === 'updated') {
        // Preserve active tab across reload
        const active = document.querySelector('.tab.active');
        if (active) location.hash = active.dataset.target;
        location.reload();
      }
    };
    es.onerror = function() {
      es.close();
      setTimeout(connect, 5000);
    };
  }
  // Restore tab from hash after reload
  if (location.hash) {
    const tabName = location.hash.slice(1);
    const tab = document.querySelector('.tab[data-target="' + tabName + '"]');
    if (tab) tab.click();
    history.replaceState(null, '', location.pathname);
  }
  connect();
})();
</script>

</body>
</html>`;
}
