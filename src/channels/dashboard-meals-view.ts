/**
 * Meal plan view — day cards + shopping list with checkboxes.
 * Ported from meal-plan-page.ts, client-side rendered.
 */

export function getMealsViewHTML(): string {
  return `
<div id="meals-tabs" style="display:flex;gap:0;border-bottom:1px solid var(--border);margin-bottom:var(--spacing-lg);">
  <button class="meals-tab active" data-tab="plan" style="flex:1;text-align:center;padding:12px 0;font-size:15px;font-weight:600;color:var(--text-secondary);background:none;border:none;border-bottom:2px solid transparent;cursor:pointer;transition:color 0.2s,border-color 0.2s;">Meal Plan</button>
  <button class="meals-tab" data-tab="shopping" style="flex:1;text-align:center;padding:12px 0;font-size:15px;font-weight:600;color:var(--text-secondary);background:none;border:none;border-bottom:2px solid transparent;cursor:pointer;transition:color 0.2s,border-color 0.2s;">Shopping List</button>
</div>
<div id="meals-plan" class="meals-panel"></div>
<div id="meals-shopping" class="meals-panel" style="display:none;"></div>

<style>
.meals-tab.active { color:var(--accent); border-bottom-color:var(--accent); }
.day-card { background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-md);padding:var(--spacing-lg);margin-bottom:var(--spacing-md); }
.day-card h3 { font-size:17px;font-weight:700;margin-bottom:8px;display:flex;align-items:center;gap:8px; }
.day-card .new-badge { font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;background:var(--accent-light);color:var(--accent);padding:2px 8px;border-radius:6px; }
.meal { margin-top:6px; }
.meal-label { font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-secondary);margin-right:6px; }
.meal-name { font-size:16px;font-weight:600; }
.meal-details { list-style:none;padding:4px 0 0; }
.meal-details li { font-size:14px;color:var(--text-secondary);padding:1px 0 1px 16px;position:relative; }
.meal-details li::before { content:'\\00b7';position:absolute;left:4px;color:var(--border);font-weight:bold; }
.recipe-links { margin-top:8px;display:flex;flex-wrap:wrap;gap:6px; }
.recipe-link { font-size:13px;color:var(--accent);text-decoration:none;background:var(--accent-light);padding:4px 10px;border-radius:8px;transition:opacity 0.2s; }
.recipe-link:hover { opacity:0.8; }
.ingredient-section { margin-top:var(--spacing-lg); }
.ingredient-section h4 { font-size:14px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--accent);margin-bottom:8px; }
.ingredient-section ul { list-style:none;padding:0; }
.ingredient-section li { font-size:15px;padding:8px 0;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:12px;cursor:pointer;user-select:none; }
.ingredient-section li:last-child { border-bottom:none; }
.ingredient-section li::before { content:'';width:20px;height:20px;border-radius:6px;border:2px solid var(--border);flex-shrink:0;transition:all 0.15s; }
.ingredient-section li.checked::before { background:var(--green);border-color:var(--green);background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20' fill='white'%3E%3Cpath d='M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z'/%3E%3C/svg%3E");background-size:14px;background-position:center;background-repeat:no-repeat; }
.ingredient-section li.checked { color:var(--text-secondary);text-decoration:line-through; }
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
    d.textContent = s;
    return d.innerHTML;
  }

  function loadChecked() {
    try { return new Set(JSON.parse(localStorage.getItem(CHECKED_KEY) || '[]')); }
    catch { return new Set(); }
  }
  function saveChecked(checked) {
    localStorage.setItem(CHECKED_KEY, JSON.stringify(Array.from(checked)));
  }

  // Tab switching
  document.querySelectorAll('.meals-tab').forEach(function(tab) {
    tab.addEventListener('click', function() {
      document.querySelectorAll('.meals-tab').forEach(function(t) { t.classList.remove('active'); });
      tab.classList.add('active');
      activeTab = tab.dataset.tab;
      document.getElementById('meals-plan').style.display = activeTab === 'plan' ? 'block' : 'none';
      document.getElementById('meals-shopping').style.display = activeTab === 'shopping' ? 'block' : 'none';
    });
  });

  function renderMeals(data) {
    var planEl = document.getElementById('meals-plan');
    var shopEl = document.getElementById('meals-shopping');

    if (!data.plan && !data.ingredients) {
      planEl.innerHTML = '<div class="empty-state"><h3>No meal plan yet</h3><p>Pickle is cooking up something. Check back Saturday morning.</p></div>';
      shopEl.innerHTML = '';
      return;
    }

    // Render plan
    if (data.plan) {
      var html = '<h2 style="font-size:22px;font-weight:700;letter-spacing:-0.3px;margin-bottom:4px;">' + esc(data.plan.title) + '</h2>';
      if (data.plan.subtitle) html += '<p style="font-size:14px;color:var(--text-secondary);font-style:italic;margin-bottom:var(--spacing-lg);">' + esc(data.plan.subtitle) + '</p>';
      data.plan.days.forEach(function(day) {
        var isNew = day.name.includes('\\u2728');
        var dayName = day.name.replace(/\\s*\\u2728.*/, '');
        var badge = isNew ? '<span class="new-badge">New</span>' : '';
        var mealsHtml = day.meals.map(function(meal) {
          var details = meal.details.length ? '<ul class="meal-details">' + meal.details.map(function(d) { return '<li>' + esc(d) + '</li>'; }).join('') + '</ul>' : '';
          var recipes = meal.recipes.length ? '<div class="recipe-links">' + meal.recipes.map(function(r) { return '<a href="' + esc(r.url) + '" class="recipe-link" target="_blank" rel="noopener">\\ud83d\\udcd6 ' + esc(r.title) + '</a>'; }).join('') + '</div>' : '';
          return '<div class="meal"><span class="meal-label">' + esc(meal.label) + '</span><span class="meal-name">' + esc(meal.desc) + '</span>' + details + recipes + '</div>';
        }).join('');
        html += '<div class="day-card"><h3>' + esc(dayName) + badge + '</h3>' + mealsHtml + '</div>';
      });
      planEl.innerHTML = html;
    }

    // Render shopping list
    if (data.ingredients && data.ingredients.sections.length > 0) {
      var checked = loadChecked();
      var sHtml = '<h2 style="font-size:22px;font-weight:700;letter-spacing:-0.3px;margin-bottom:var(--spacing-lg);">Shopping List</h2>';
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

      // Checkbox click handlers
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

  // Load when meals view becomes active
  var mealsLoaded = false;
  window.addEventListener('viewchange', function(e) {
    if (e.detail.view === 'meals' && !mealsLoaded) {
      loadMeals();
      mealsLoaded = true;
    }
  });

  // Re-fetch on SSE update
  window.addEventListener('dashboard-meals_updated', loadMeals);

  // Load if meals is active on page load
  if (location.hash === '#meals') { loadMeals(); mealsLoaded = true; }
})();
`;
}
