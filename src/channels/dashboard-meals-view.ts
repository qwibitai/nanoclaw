/**
 * Meal plan view — day cards + shopping list with checkboxes.
 * Migrated to the shared dashboard vocabulary in devtask #60 (Unit 5).
 *
 * Today's day card gets a hierarchy beat — locked to "typographic
 * emphasis" (Sketch C) after side-by-side review with Boris:
 *
 *   - "TODAY" eyebrow above the day name
 *   - dish name jumps to display weight (24px / 800)
 *   - accent left border (4px)
 *   - non-today day names recede to --text-secondary so today reads loudest
 */

export function getMealsViewHTML(): string {
  return `
<div class="view-shell">
  <header class="page-header">
    <div class="page-header__title-block">
      <h1 class="page-header__title" id="meals-title">Meal Plan</h1>
      <div class="page-header__meta" id="meals-subtitle"></div>
    </div>
    <div class="page-header__tools">
      <div id="meals-tabs" class="meals-tabs">
        <button class="meals-tab is-active" type="button" data-tab="plan">Meal Plan</button>
        <button class="meals-tab" type="button" data-tab="shopping">Shopping List</button>
      </div>
    </div>
  </header>
  <div class="view-body">
    <div id="meals-plan" class="meals-panel"></div>
    <div id="meals-shopping" class="meals-panel" hidden></div>
  </div>
</div>

<style>
.meals-tabs {
  display: inline-flex;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface);
  padding: 2px;
  gap: 2px;
}
.meals-tab {
  padding: 6px 14px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary);
  background: transparent;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-family: inherit;
  transition: background 0.15s, color 0.15s;
}
.meals-tab:hover { color: var(--text); }
.meals-tab.is-active { background: var(--accent-light); color: var(--accent); }

.meals-panel { padding-bottom: var(--spacing-xl); }

/* --- Day cards --- */
.day-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: var(--spacing-lg) var(--spacing-xl);
  margin-bottom: var(--spacing-md);
  border-left: 4px solid transparent;
  box-shadow: var(--shadow-card);
  transition: border-color 0.2s, background 0.2s;
}
.day-card__day {
  font-size: 18px;
  font-weight: 800;
  margin-bottom: 10px;
  display: flex;
  align-items: center;
  gap: 8px;
  letter-spacing: -0.3px;
  color: var(--text);
}
.day-card .new-badge {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  background: var(--accent-light);
  color: var(--accent);
  padding: 2px 8px;
  border-radius: 6px;
}
.meal { margin-top: 8px; }
.meal-label {
  font-size: 10px;
  font-weight: 800;
  text-transform: uppercase;
  letter-spacing: 1.2px;
  color: var(--text-tertiary);
  margin-right: 10px;
}
.meal-name {
  font-size: 18px;
  font-weight: 700;
  letter-spacing: -0.2px;
  color: var(--text);
}
.meal-details { list-style: none; padding: 4px 0 0; }
.meal-details li {
  font-size: 13px;
  color: var(--text-secondary);
  padding: 1px 0 1px 16px;
  position: relative;
}
.meal-details li::before {
  content: '\\00b7';
  position: absolute;
  left: 4px;
  color: var(--border);
  font-weight: bold;
}
.recipe-links { margin-top: 8px; display: flex; flex-wrap: wrap; gap: 6px; }
.recipe-link {
  font-size: 12px;
  color: var(--accent);
  text-decoration: none;
  background: var(--accent-light);
  padding: 4px 10px;
  border-radius: 8px;
  transition: opacity 0.2s;
}
.recipe-link:hover { opacity: 0.8; }

/* --- Today (Sketch C: Typographic emphasis — locked after Boris pick) --- */
.day-card.is-today {
  border-left-color: var(--accent);
  border-left-width: 4px;
}
.day-card.is-today .day-card__eyebrow {
  display: block;
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 1.2px;
  text-transform: uppercase;
  color: var(--accent);
  margin-bottom: 4px;
}
.day-card:not(.is-today) .day-card__eyebrow { display: none; }
.day-card.is-today .day-card__day {
  font-size: 22px;
  letter-spacing: -0.4px;
}
.day-card.is-today .meal-name {
  font-size: 24px;
  font-weight: 800;
  letter-spacing: -0.5px;
  line-height: 1.15;
}
/* Non-today day names recede so today reads loudest. */
.day-card:not(.is-today) .day-card__day {
  color: var(--text-secondary);
  font-weight: 700;
}

/* --- Shopping list --- */
.ingredient-section { margin-top: var(--spacing-xl); }
.ingredient-section h4 {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.8px;
  color: var(--text-secondary);
  margin-bottom: 8px;
}
.ingredient-section ul { list-style: none; padding: 0; }
.ingredient-section li {
  font-size: 14px;
  padding: 10px 0;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  gap: 12px;
  cursor: pointer;
  user-select: none;
  color: var(--text);
}
.ingredient-section li:last-child { border-bottom: none; }
.ingredient-section li::before {
  content: '';
  width: 20px;
  height: 20px;
  border-radius: 6px;
  border: 2px solid var(--border);
  flex-shrink: 0;
  transition: all 0.15s;
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

@media (max-width: 768px) {
  .day-card { padding: var(--spacing-md) var(--spacing-lg); }
  .day-card.is-today .meal-name { font-size: 20px; }
  .day-card.is-today .day-card__day { font-size: 18px; }
  .meal-name { font-size: 16px; }
  .meals-tabs { width: 100%; }
  .meals-tab { flex: 1; padding: 8px 14px; }
}
</style>
`;
}

export function getMealsViewJS(): string {
  return `
(function() {
  var activeTab = 'plan';
  var CHECKED_KEY = 'dashboard-pickle-checked';

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  function loadChecked() {
    try { return new Set(JSON.parse(localStorage.getItem(CHECKED_KEY) || '[]')); }
    catch { return new Set(); }
  }
  function saveChecked(checked) {
    localStorage.setItem(CHECKED_KEY, JSON.stringify(Array.from(checked)));
  }

  // Today detection — uses the STRIPPED day name (sparkle removed),
  // forces en-US weekday format because the meal plan day names are
  // English regardless of viewer locale, and accepts a prefix match
  // (e.g. 'Mon' === 'Monday'.slice(0,3)) for safety. Re-evaluated on
  // every render so SSE refresh and midnight rollover work.
  function isToday(strippedDayName) {
    if (!strippedDayName) return false;
    try {
      var todayWeekday = new Date().toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase();
      var d = strippedDayName.trim().toLowerCase();
      return d === todayWeekday || todayWeekday.indexOf(d) === 0 || d.indexOf(todayWeekday) === 0;
    } catch (e) {
      return false;
    }
  }

  // Tab switching
  document.querySelectorAll('.meals-tab').forEach(function(tab) {
    tab.addEventListener('click', function() {
      document.querySelectorAll('.meals-tab').forEach(function(t) { t.classList.remove('is-active'); });
      tab.classList.add('is-active');
      activeTab = tab.dataset.tab;
      var planEl = document.getElementById('meals-plan');
      var shopEl = document.getElementById('meals-shopping');
      if (activeTab === 'plan') { planEl.removeAttribute('hidden'); shopEl.setAttribute('hidden', ''); }
      else { planEl.setAttribute('hidden', ''); shopEl.removeAttribute('hidden'); }
    });
  });

  function renderMeals(data) {
    var planEl = document.getElementById('meals-plan');
    var shopEl = document.getElementById('meals-shopping');
    var titleEl = document.getElementById('meals-title');
    var subtitleEl = document.getElementById('meals-subtitle');

    if (!data.plan && !data.ingredients) {
      planEl.innerHTML = '<div class="empty-state"><h3>No meal plan yet</h3><p>Pickle is cooking up something. Check back Saturday morning.</p></div>';
      shopEl.innerHTML = '';
      return;
    }

    if (data.plan) {
      if (titleEl && data.plan.title) titleEl.textContent = data.plan.title;
      if (subtitleEl) subtitleEl.textContent = data.plan.subtitle || '';

      var todayMatched = false;
      var html = '';
      data.plan.days.forEach(function(day) {
        var isNew = day.name.includes('\\u2728');
        var dayName = day.name.replace(/\\s*\\u2728.*/, '');
        var today = isToday(dayName);
        if (today) todayMatched = true;
        var badge = isNew ? '<span class="new-badge">New</span>' : '';
        var todayCls = today ? ' is-today' : '';
        var eyebrow = today ? '<div class="day-card__eyebrow">Today</div>' : '';
        var mealsHtml = day.meals.map(function(meal) {
          var details = meal.details.length
            ? '<ul class="meal-details">' + meal.details.map(function(d) { return '<li>' + esc(d) + '</li>'; }).join('') + '</ul>'
            : '';
          var recipes = meal.recipes.length
            ? '<div class="recipe-links">' + meal.recipes.map(function(r) { return '<a href="' + esc(r.url) + '" class="recipe-link" target="_blank" rel="noopener">\\ud83d\\udcd6 ' + esc(r.title) + '</a>'; }).join('') + '</div>'
            : '';
          return '<div class="meal"><span class="meal-label">' + esc(meal.label) + '</span><span class="meal-name">' + esc(meal.desc) + '</span>' + details + recipes + '</div>';
        }).join('');
        html += '<div class="day-card' + todayCls + '">' +
          eyebrow +
          '<h3 class="day-card__day">' + esc(dayName) + badge + '</h3>' +
          mealsHtml +
        '</div>';
      });
      if (!todayMatched) {
        // Visible during dev so the fall-through is debuggable. The
        // hierarchy beat is simply absent — see plan Unit 5.
        console.log('[meals] no day matched today (' + new Date().toLocaleDateString('en-US', { weekday: 'long' }) + ')');
      }
      planEl.innerHTML = html;
    }

    if (data.ingredients && data.ingredients.sections.length > 0) {
      var checked = loadChecked();
      var sHtml = '';
      var idx = 0;
      data.ingredients.sections.forEach(function(section) {
        sHtml += '<div class="ingredient-section"><h4>' + esc(section.name) + '</h4><ul>';
        section.items.forEach(function(item) {
          var cls = checked.has(idx) ? ' checked' : '';
          sHtml += '<li class="ingredient-item' + cls + '" data-idx="' + idx + '">' + esc(item) + '</li>';
          idx++;
        });
        sHtml += '</ul></div>';
      });
      shopEl.innerHTML = sHtml;

      shopEl.querySelectorAll('.ingredient-item').forEach(function(li) {
        li.addEventListener('click', function() {
          li.classList.toggle('checked');
          var i = parseInt(li.dataset.idx);
          if (li.classList.contains('checked')) checked.add(i); else checked.delete(i);
          saveChecked(checked);
        });
      });
    } else {
      shopEl.innerHTML = '';
    }
  }

  function loadMeals() {
    fetch('/dashboard/api/meals')
      .then(function(r) { return r.json(); })
      .then(renderMeals)
      .catch(function(err) { console.error('Failed to load meals:', err); });
  }

  var mealsLoaded = false;
  window.addEventListener('viewchange', function(e) {
    if (e.detail.view === 'meals' && !mealsLoaded) {
      loadMeals();
      mealsLoaded = true;
    }
  });

  window.addEventListener('dashboard-meals_updated', loadMeals);

  if (location.hash === '#meals') { loadMeals(); mealsLoaded = true; }
})();
`;
}
