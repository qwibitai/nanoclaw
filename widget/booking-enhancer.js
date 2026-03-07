/**
 * Sheridan Rentals Booking Enhancer
 * Step-by-step wizard with live pricing, Square payment, and EN/ES support.
 *
 * Loaded on the /form/ page via WordPress plugin.
 */
(function () {
  'use strict';

  var SCRIPT = document.currentScript;
  var SERVER_URL =
    (SCRIPT && SCRIPT.getAttribute('data-server')) ||
    window.SR_CHAT_SERVER ||
    'https://chat.sheridantrailerrentals.us';

  var API_URL =
    (SCRIPT && SCRIPT.getAttribute('data-api')) ||
    window.SR_API_SERVER ||
    'https://chat.sheridantrailerrentals.us';

  // ── Pricing Config ──────────────────────────────────────────────
  var PRICING = {
    rv: { label: 'RV Camper', rate: 150, unit: 'night', deposit: 250 },
    carhauler: { label: 'Car Hauler', rate: 65, unit: 'day', deposit: 50 },
    landscaping: { label: 'Landscaping Trailer', rate: 50, unit: 'day', deposit: 50 },
  };

  var ADD_ONS = {
    generator: { key: 'generator', label: 'Generator', rate: 100, unit: 'night', appliesTo: ['rv'] },
    delivery: { key: 'delivery', label: 'Delivery (within 60mi of Tomball)', rate: 250, unit: 'flat', appliesTo: ['rv'] },
  };

  // ── i18n Strings ────────────────────────────────────────────────
  var I18N = {
    en: {
      stepEquipment: 'Choose Equipment',
      stepDates: 'Pick Your Dates',
      stepInfo: 'Your Information',
      stepReview: 'Review & Pay',
      rvName: 'RV Camper',
      rvDesc: 'Sleeps 4-6, full kitchen, bathroom, AC/heat',
      rvPrice: '$150/night',
      haulerName: 'Car Hauler',
      haulerDesc: 'Includes straps, ramps, winch, spare tire',
      haulerPrice: '$65/day',
      landscapeName: 'Landscaping Trailer',
      landscapeDesc: 'Includes dolly for furniture/appliances',
      landscapePrice: '$50/day',
      addOnsTitle: 'Add-Ons',
      generator: 'Generator',
      generatorDesc: '$100/night (includes 5 gal gas)',
      delivery: 'Delivery',
      deliveryDesc: '$250 flat (pickup + dropoff within 60mi of Tomball)',
      selectDates: 'Select your dates on the calendar',
      continueBtn: 'Continue',
      backBtn: 'Back',
      totalDueNow: 'Total (due now)',
      processing: 'Processing...',
      payNow: 'Pay Now',
      errName: 'Please enter your first and last name.',
      errEmail: 'Please enter a valid email address.',
      errPhone: 'Please enter your phone number.',
      errEquipment: 'Please select an equipment type.',
      errDates: 'Please select your rental dates on the calendar.',
      reviewEquipment: 'Equipment',
      reviewDates: 'Dates',
      reviewAddOns: 'Add-Ons',
      reviewTotal: 'Total',
      reviewName: 'Name',
      reviewEmail: 'Email',
      reviewPhone: 'Phone',
      reviewNone: 'None',
      depositLabel: 'Refundable Security Deposit',
      depositNote: 'Returned when equipment comes back in good condition',
    },
    es: {
      stepEquipment: 'Elige Equipo',
      stepDates: 'Elige Fechas',
      stepInfo: 'Tu Información',
      stepReview: 'Revisar y Pagar',
      rvName: 'RV Camper',
      rvDesc: 'Para 4-6 personas, cocina, baño, A/C',
      rvPrice: '$150/noche',
      haulerName: 'Car Hauler',
      haulerDesc: 'Incluye correas, rampas, winch, llanta de repuesto',
      haulerPrice: '$65/día',
      landscapeName: 'Landscaping Trailer',
      landscapeDesc: 'Incluye carretilla para muebles/electrodomésticos',
      landscapePrice: '$50/día',
      addOnsTitle: 'Extras',
      generator: 'Generador',
      generatorDesc: '$100/noche (incluye 5 gal de gas)',
      delivery: 'Entrega',
      deliveryDesc: '$250 fijo (recogida + entrega dentro de 60mi de Tomball)',
      selectDates: 'Selecciona tus fechas en el calendario',
      continueBtn: 'Continuar',
      backBtn: 'Atrás',
      totalDueNow: 'Total (pagar ahora)',
      processing: 'Procesando...',
      payNow: 'Pagar Ahora',
      errName: 'Por favor ingresa tu nombre y apellido.',
      errEmail: 'Por favor ingresa un correo electrónico válido.',
      errPhone: 'Por favor ingresa tu número de teléfono.',
      errEquipment: 'Por favor selecciona un tipo de equipo.',
      errDates: 'Por favor selecciona tus fechas de renta en el calendario.',
      reviewEquipment: 'Equipo',
      reviewDates: 'Fechas',
      reviewAddOns: 'Extras',
      reviewTotal: 'Total',
      reviewName: 'Nombre',
      reviewEmail: 'Correo',
      reviewPhone: 'Teléfono',
      reviewNone: 'Ninguno',
      depositLabel: 'Depósito de seguridad reembolsable',
      depositNote: 'Se devuelve cuando el equipo regresa en buenas condiciones',
    }
  };

  // ── State ───────────────────────────────────────────────────────
  var selectedDates = [];
  var selectedEquipment = null;
  var selectedAddOns = [];
  var currentStep = 1;
  var currentLang = 'en';
  var wizardEl = null;
  var progressEl = null;
  var priceBox = null;

  // Elements that need text updates on language change (set during build)
  var translatableEls = {};

  try {
    var saved = sessionStorage.getItem('sr_chat_lang');
    if (saved === 'es') currentLang = 'es';
  } catch (e) {}

  function t(key) { return I18N[currentLang][key] || I18N.en[key] || key; }

  // ── Wait for form to be ready ───────────────────────────────────
  function waitForForm(cb) {
    var form = document.getElementById('booking_form1');
    if (form) return cb(form);
    var observer = new MutationObserver(function () {
      form = document.getElementById('booking_form1');
      if (form) {
        observer.disconnect();
        cb(form);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function init(form) {
    hideCaptcha();
    hideOriginalForm(form);
    buildWizard(form);
    hookCalendarChanges();
    injectStyles();

    // Sync language with chat widget
    window.addEventListener('sr-lang-change', function(e) {
      if (e.detail && e.detail.lang) {
        currentLang = e.detail.lang;
        try { sessionStorage.setItem('sr_chat_lang', currentLang); } catch (e) {}
        updateLanguageStrings();
      }
    });
  }

  // ── Language ────────────────────────────────────────────────────
  function toggleLanguage() {
    currentLang = currentLang === 'en' ? 'es' : 'en';
    try { sessionStorage.setItem('sr_chat_lang', currentLang); } catch (e) {}
    updateLanguageStrings();
    // Notify chat widget
    try { window.dispatchEvent(new CustomEvent('sr-lang-change', { detail: { lang: currentLang } })); } catch (e) {}
  }

  function updateLanguageStrings() {
    // Update all translatable elements without rebuilding DOM
    Object.keys(translatableEls).forEach(function(key) {
      var el = translatableEls[key];
      if (el && el.parentNode) {
        el.textContent = t(key);
      }
    });

    // Update language toggle button text
    var langBtn = document.getElementById('sr-wiz-lang-btn');
    if (langBtn) langBtn.textContent = currentLang === 'en' ? 'ES' : 'EN';

    // Update equipment cards
    var cardData = [
      { name: 'rvName', desc: 'rvDesc', price: 'rvPrice' },
      { name: 'haulerName', desc: 'haulerDesc', price: 'haulerPrice' },
      { name: 'landscapeName', desc: 'landscapeDesc', price: 'landscapePrice' },
    ];
    var cards = wizardEl.querySelectorAll('.sr-step-card');
    for (var i = 0; i < cards.length && i < cardData.length; i++) {
      var nameEl = cards[i].querySelector('.sr-step-card-name');
      var descEl = cards[i].querySelector('.sr-step-card-desc');
      var priceEl = cards[i].querySelector('.sr-step-card-price');
      if (nameEl) nameEl.textContent = t(cardData[i].name);
      if (descEl) descEl.textContent = t(cardData[i].desc);
      if (priceEl) priceEl.textContent = t(cardData[i].price);
    }

    // Update add-ons labels
    var addOnsTitle = document.querySelector('#sr-addons-wizard .sr-addons-title');
    if (addOnsTitle) addOnsTitle.textContent = t('addOnsTitle');
    var addonSpans = document.querySelectorAll('#sr-addons-wizard .sr-addon-option span');
    if (addonSpans[0]) addonSpans[0].innerHTML = '<strong>' + t('generator') + '</strong> — ' + t('generatorDesc');
    if (addonSpans[1]) addonSpans[1].innerHTML = '<strong>' + t('delivery') + '</strong> — ' + t('deliveryDesc');

    // Update buttons stored directly on wizardEl
    if (wizardEl._reviewBtn) wizardEl._reviewBtn.textContent = t('stepReview');
    if (wizardEl._backBtn4) wizardEl._backBtn4.textContent = t('backBtn');

    // Update progress bar
    updateProgress();

    // Update price box
    updatePriceBox();
  }

  // ── Hide CAPTCHA ────────────────────────────────────────────────
  function hideCaptcha() {
    var cap = document.querySelector('.wpbc_r_captcha');
    if (cap) {
      var row = cap.closest('.wpbc__row') || cap;
      row.style.display = 'none';
    }
    var capInput = document.getElementById('captcha_input1');
    if (capInput) capInput.style.display = 'none';
  }

  // ── Hide original WPBC form sections ────────────────────────────
  function hideOriginalForm(form) {
    var rows = form.querySelectorAll('.wpbc__row');
    for (var i = 0; i < rows.length; i++) {
      rows[i].style.display = 'none';
      rows[i].setAttribute('data-sr-original', 'true');
    }
    var submitRow = form.querySelector('.wpbc_r_submit');
    if (submitRow) submitRow.style.display = 'none';
  }

  // ── Build Wizard (called once) ──────────────────────────────────
  function buildWizard(form) {
    wizardEl = document.createElement('div');
    wizardEl.id = 'sr-wizard';
    form.insertBefore(wizardEl, form.firstChild);

    // Language toggle
    var langBtn = document.createElement('button');
    langBtn.type = 'button';
    langBtn.className = 'sr-wiz-lang-toggle';
    langBtn.id = 'sr-wiz-lang-btn';
    langBtn.textContent = currentLang === 'en' ? 'ES' : 'EN';
    langBtn.addEventListener('click', toggleLanguage);
    wizardEl.appendChild(langBtn);

    // Progress indicator
    progressEl = document.createElement('div');
    progressEl.className = 'sr-progress';
    wizardEl.appendChild(progressEl);

    // ── Step 1: Equipment Cards ──────────────────────────────────
    var step1 = createStep(1, 'stepEquipment');
    var cardsDiv = document.createElement('div');
    cardsDiv.className = 'sr-equip-cards';

    var equipment = [
      { key: 'rv', cbId: 'rv1', nameKey: 'rvName', descKey: 'rvDesc', priceKey: 'rvPrice' },
      { key: 'carhauler', cbId: 'carhauler1', nameKey: 'haulerName', descKey: 'haulerDesc', priceKey: 'haulerPrice' },
      { key: 'landscaping', cbId: 'utilitytrailer1', nameKey: 'landscapeName', descKey: 'landscapeDesc', priceKey: 'landscapePrice' },
    ];

    equipment.forEach(function(eq) {
      var card = document.createElement('div');
      card.className = 'sr-step-card';
      card.innerHTML =
        '<div class="sr-step-card-name">' + escapeHtml(t(eq.nameKey)) + '</div>' +
        '<div class="sr-step-card-desc">' + escapeHtml(t(eq.descKey)) + '</div>' +
        '<div class="sr-step-card-price">' + escapeHtml(t(eq.priceKey)) + '</div>';
      card.addEventListener('click', function(e) {
        e.preventDefault();
        e.stopPropagation();
        selectEquipment(eq.key, eq.cbId, card);
      });
      cardsDiv.appendChild(card);
    });
    step1.content.appendChild(cardsDiv);
    wizardEl.appendChild(step1.el);

    // ── Step 2: Calendar + Add-ons ───────────────────────────────
    var step2 = createStep(2, 'stepDates');

    // ── Step 3: Customer info ────────────────────────────────────
    var step3 = createStep(3, 'stepInfo');

    // Move WPBC rows into the correct steps (single pass)
    var allRows = Array.prototype.slice.call(form.querySelectorAll('[data-sr-original]'));
    allRows.forEach(function(row) {
      if (row.querySelector('.wpbc_calendar') ||
          row.querySelector('.hasDatepick') ||
          row.querySelector('.wpbc_calendar_booking_unselectable') ||
          row.querySelector('#date_booking1') ||
          row.classList.contains('wpbc_r_calendar')) {
        row.style.display = '';
        step2.content.appendChild(row);
      } else if (row.querySelector('#name1') ||
          row.querySelector('#secondname1') ||
          row.querySelector('#email1') ||
          row.querySelector('#phone1') ||
          row.querySelector('#details1') ||
          row.querySelector('#rangetime1')) {
        row.style.display = '';
        step3.content.appendChild(row);
      }
    });

    // Add-ons container (RV only)
    var addOnsDiv = document.createElement('div');
    addOnsDiv.id = 'sr-addons-wizard';
    addOnsDiv.style.display = 'none';
    addOnsDiv.innerHTML =
      '<div class="sr-addons-card">' +
      '<div class="sr-addons-title">' + t('addOnsTitle') + '</div>' +
      '<label class="sr-addon-option">' +
      '<input type="checkbox" id="sr-addon-generator" value="generator"> ' +
      '<span><strong>' + t('generator') + '</strong> — ' + t('generatorDesc') + '</span>' +
      '</label>' +
      '<label class="sr-addon-option">' +
      '<input type="checkbox" id="sr-addon-delivery" value="delivery"> ' +
      '<span><strong>' + t('delivery') + '</strong> — ' + t('deliveryDesc') + '</span>' +
      '</label>' +
      '</div>';
    step2.content.appendChild(addOnsDiv);

    // Note: step2 is not yet in the document, so use querySelector on the container
    var genCb = addOnsDiv.querySelector('#sr-addon-generator');
    var delCb = addOnsDiv.querySelector('#sr-addon-delivery');
    if (genCb) genCb.addEventListener('change', updateSelectedAddOns);
    if (delCb) delCb.addEventListener('change', updateSelectedAddOns);

    // Price box
    priceBox = document.createElement('div');
    priceBox.id = 'sr-price-box';
    step2.content.appendChild(priceBox);

    // Date prompt
    var datePrompt = document.createElement('div');
    datePrompt.className = 'sr-date-prompt';
    datePrompt.id = 'sr-date-prompt';
    step2.content.appendChild(datePrompt);
    translatableEls['selectDates'] = datePrompt;

    // Continue button
    var continueBtn = document.createElement('button');
    continueBtn.type = 'button';
    continueBtn.className = 'sr-wiz-btn sr-wiz-btn-primary';
    continueBtn.id = 'sr-step2-continue';
    continueBtn.style.display = 'none';
    continueBtn.addEventListener('click', function() { goToStep(3); });
    step2.content.appendChild(continueBtn);
    translatableEls['continueBtn'] = continueBtn;

    wizardEl.appendChild(step2.el);

    // Step 3 nav buttons
    var step3Nav = document.createElement('div');
    step3Nav.className = 'sr-wizard-nav';
    var backBtn3 = document.createElement('button');
    backBtn3.type = 'button';
    backBtn3.className = 'sr-wiz-btn sr-wiz-btn-secondary';
    backBtn3.addEventListener('click', function() { goToStep(2); });
    translatableEls['backBtn'] = backBtn3;

    var reviewBtn = document.createElement('button');
    reviewBtn.type = 'button';
    reviewBtn.className = 'sr-wiz-btn sr-wiz-btn-primary';
    reviewBtn.addEventListener('click', function() { if (validateStep3()) goToStep(4); });
    // Set review button text directly (can't use translatableEls — 'stepReview' key is used by step 4 title)
    reviewBtn.textContent = t('stepReview');

    step3Nav.appendChild(backBtn3);
    step3Nav.appendChild(reviewBtn);
    step3.content.appendChild(step3Nav);
    wizardEl.appendChild(step3.el);

    // ── Step 4: Review & Pay ─────────────────────────────────────
    var step4 = createStep(4, 'stepReview');
    var reviewDiv = document.createElement('div');
    reviewDiv.id = 'sr-review-summary';
    step4.content.appendChild(reviewDiv);

    var step4Nav = document.createElement('div');
    step4Nav.className = 'sr-wizard-nav';
    var backBtn4 = document.createElement('button');
    backBtn4.type = 'button';
    backBtn4.className = 'sr-wiz-btn sr-wiz-btn-secondary';
    backBtn4.textContent = t('backBtn');
    backBtn4.addEventListener('click', function() { goToStep(3); });

    var payBtn = document.createElement('button');
    payBtn.type = 'button';
    payBtn.className = 'sr-wiz-btn sr-wiz-btn-pay';
    payBtn.id = 'sr-pay-btn';
    payBtn.addEventListener('click', handlePayment);

    step4Nav.appendChild(backBtn4);
    step4Nav.appendChild(payBtn);
    step4.content.appendChild(step4Nav);
    wizardEl.appendChild(step4.el);

    // Store extra button refs for language updates
    wizardEl._reviewBtn = reviewBtn;
    wizardEl._backBtn4 = backBtn4;

    // Apply initial text to all translatable elements
    updateLanguageStrings();

    // Set initial state
    updateProgress();
    showStep(currentStep);
    updatePriceBox();

    // Prefill form fields from session
    setTimeout(prefillFromSession, 100);
  }

  function createStep(num, titleKey) {
    var el = document.createElement('div');
    el.className = 'sr-wizard-step';
    el.setAttribute('data-step', num);

    var header = document.createElement('div');
    header.className = 'sr-step-header';

    var numSpan = document.createElement('span');
    numSpan.className = 'sr-step-num';
    numSpan.textContent = num;

    var titleSpan = document.createElement('span');
    titleSpan.className = 'sr-step-title';
    translatableEls[titleKey] = titleSpan;

    header.appendChild(numSpan);
    header.appendChild(document.createTextNode(' '));
    header.appendChild(titleSpan);

    var content = document.createElement('div');
    content.className = 'sr-step-content';

    el.appendChild(header);
    el.appendChild(content);

    return { el: el, content: content };
  }

  // ── Step Navigation ─────────────────────────────────────────────
  function goToStep(num) {
    currentStep = num;
    showStep(num);
    updateProgress();
    if (num === 4) buildReviewSummary();
    if (wizardEl) wizardEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function showStep(num) {
    var steps = wizardEl.querySelectorAll('.sr-wizard-step');
    for (var i = 0; i < steps.length; i++) {
      var stepNum = parseInt(steps[i].getAttribute('data-step'), 10);
      steps[i].classList.toggle('active', stepNum === num);
    }
  }

  function updateProgress() {
    if (!progressEl) return;
    var labelKeys = ['stepEquipment', 'stepDates', 'stepInfo', 'stepReview'];
    var html = '';
    for (var i = 0; i < 4; i++) {
      var cls = 'sr-progress-dot';
      if (i + 1 < currentStep) cls += ' completed';
      if (i + 1 === currentStep) cls += ' active';
      html += '<div class="sr-progress-item' + (i + 1 <= currentStep ? ' done' : '') + '" data-go-step="' + (i + 1) + '">';
      html += '<div class="' + cls + '">' + (i + 1 < currentStep ? '&#10003;' : (i + 1)) + '</div>';
      html += '<div class="sr-progress-label">' + escapeHtml(t(labelKeys[i])) + '</div>';
      html += '</div>';
      if (i < 3) html += '<div class="sr-progress-line' + (i + 1 < currentStep ? ' done' : '') + '"></div>';
    }
    progressEl.innerHTML = html;

    // Allow clicking back to completed steps
    var items = progressEl.querySelectorAll('.sr-progress-item');
    for (var j = 0; j < items.length; j++) {
      (function(item) {
        var stepNum = parseInt(item.getAttribute('data-go-step'), 10);
        item.style.cursor = stepNum < currentStep ? 'pointer' : 'default';
        item.addEventListener('click', function() {
          if (stepNum < currentStep) goToStep(stepNum);
        });
      })(items[j]);
    }
  }

  // ── Equipment Selection ─────────────────────────────────────────
  var bookedDatesSet = {}; // { 'YYYY-MM-DD': true } for current equipment
  var lastAvailEquipment = null;

  function selectEquipment(key, cbId, cardEl) {
    selectedEquipment = key;

    // Toggle real WPBC checkboxes
    var checkboxIds = ['rv1', 'carhauler1', 'utilitytrailer1'];
    checkboxIds.forEach(function(id) {
      var cb = document.getElementById(id);
      if (cb) cb.checked = (id === cbId);
    });

    // Reset add-ons if not RV
    if (key !== 'rv') {
      selectedAddOns = [];
      var genCb = document.getElementById('sr-addon-generator');
      var delCb = document.getElementById('sr-addon-delivery');
      if (genCb) genCb.checked = false;
      if (delCb) delCb.checked = false;
    }

    // Show/hide add-ons
    var addOnsDiv = document.getElementById('sr-addons-wizard');
    if (addOnsDiv) addOnsDiv.style.display = key === 'rv' ? 'block' : 'none';

    // Update card selection UI
    var cards = wizardEl.querySelectorAll('.sr-step-card');
    for (var i = 0; i < cards.length; i++) {
      cards[i].classList.remove('selected');
    }
    cardEl.classList.add('selected');

    // Clear any previously selected dates (they belong to old equipment)
    selectedDates = [];
    clearCalendarSelections();

    // Fetch availability for this equipment and mark booked dates
    fetchAvailability(key);

    // Auto-advance to step 2
    setTimeout(function() { goToStep(2); }, 300);
  }

  // ── Availability Fetching ─────────────────────────────────────
  function fetchAvailability(equipmentKey) {
    if (lastAvailEquipment === equipmentKey) return; // already fetched
    lastAvailEquipment = equipmentKey;
    bookedDatesSet = {};

    // Clear old booked-date markings from previous equipment
    clearBookedDateMarkers();

    // Fetch 2 months of availability
    var now = new Date();
    var startDate = now.toISOString().split('T')[0];
    var end = new Date(now);
    end.setMonth(end.getMonth() + 2);
    var endDate = end.toISOString().split('T')[0];

    fetch(API_URL + '/api/availability', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ equipment: equipmentKey, startDate: startDate, endDate: endDate }),
    })
      .then(function(res) { return res.json(); })
      .then(function(data) {
        if (data.busySlots && data.busySlots.length > 0) {
          // Convert busy slots (start/end ISO strings) to individual dates
          data.busySlots.forEach(function(slot) {
            var s = new Date(slot.start);
            var e = new Date(slot.end);
            // Walk each day in the slot
            var cur = new Date(s.getFullYear(), s.getMonth(), s.getDate());
            var endDay = new Date(e.getFullYear(), e.getMonth(), e.getDate());
            while (cur < endDay) {
              var yyyy = cur.getFullYear();
              var mm = String(cur.getMonth() + 1).padStart(2, '0');
              var dd = String(cur.getDate()).padStart(2, '0');
              bookedDatesSet[yyyy + '-' + mm + '-' + dd] = true;
              cur.setDate(cur.getDate() + 1);
            }
          });
        }
        applyAvailabilityToCalendar();
      })
      .catch(function(err) {
        console.error('[SheridanBooking] Availability fetch error:', err);
      });
  }

  function clearCalendarSelections() {
    // Deselect any WPBC selected dates
    var dateField = document.getElementById('date_booking1');
    if (dateField) dateField.value = '';

    // Remove visual selection from calendar cells
    var cells = document.querySelectorAll('.datepick-days-cell a.datepick-highlight, .datepick-days-cell a.wpbc_selected');
    cells.forEach(function(a) {
      a.classList.remove('datepick-highlight', 'wpbc_selected');
    });

    updatePriceBox();
  }

  function clearBookedDateMarkers() {
    var cells = document.querySelectorAll('.datepick-days-cell.sr-date-booked');
    cells.forEach(function(td) {
      td.classList.remove('sr-date-booked');
      td.removeAttribute('data-sr-blocked');
      // Restore span back to link if it was replaced
      var span = td.querySelector('.sr-booked-span');
      if (span) {
        var a = document.createElement('a');
        a.className = span.className.replace('sr-booked-span', '').trim();
        a.textContent = span.textContent;
        a.href = '#';
        span.parentNode.replaceChild(a, span);
      }
    });
  }

  function applyAvailabilityToCalendar() {
    // Mark booked dates as unavailable on the WPBC calendar
    var cells = document.querySelectorAll('.datepick-days-cell');
    cells.forEach(function(td) {
      var sqlMatch = td.className.match(/sql_date_(\S+)/);
      if (!sqlMatch) return;
      var dateStr = sqlMatch[1];
      if (bookedDatesSet[dateStr]) {
        td.classList.add('sr-date-booked');
      } else {
        td.classList.remove('sr-date-booked');
      }
    });
  }

  // ── Add-Ons ─────────────────────────────────────────────────────
  function updateSelectedAddOns() {
    selectedAddOns = [];
    var genCb = document.getElementById('sr-addon-generator');
    var delCb = document.getElementById('sr-addon-delivery');
    if (genCb && genCb.checked) selectedAddOns.push('generator');
    if (delCb && delCb.checked) selectedAddOns.push('delivery');
    updatePriceBox();
  }

  // ── Price Box ───────────────────────────────────────────────────
  function updatePriceBox() {
    if (!priceBox) return;

    var numDays = selectedDates.length;
    var contBtn = document.getElementById('sr-step2-continue');
    var datePrompt = document.getElementById('sr-date-prompt');

    if (numDays === 0 || !selectedEquipment) {
      priceBox.style.display = 'none';
      if (contBtn) contBtn.style.display = 'none';
      if (datePrompt) datePrompt.style.display = numDays === 0 ? 'block' : 'none';
      return;
    }

    var p = PRICING[selectedEquipment];
    if (!p) { priceBox.style.display = 'none'; return; }

    var baseTotal = p.rate * numDays;
    var sorted = selectedDates.slice().sort();
    var dateText = sorted.length === 1 ? formatDate(sorted[0]) : formatDate(sorted[0]) + ' — ' + formatDate(sorted[sorted.length - 1]);

    var linesHtml =
      '<div class="sr-eb-row">' +
      '<span>' + numDays + ' ' + p.unit + (numDays > 1 ? 's' : '') + ' × $' + p.rate + '/' + p.unit + '</span>' +
      '<span>$' + baseTotal.toFixed(2) + '</span>' +
      '</div>';

    var grandTotal = baseTotal;
    for (var i = 0; i < selectedAddOns.length; i++) {
      var addon = ADD_ONS[selectedAddOns[i]];
      if (!addon) continue;
      var addonTotal, addonDesc;
      if (addon.unit === 'flat') {
        addonTotal = addon.rate;
        addonDesc = t(addon.key);
      } else {
        addonTotal = addon.rate * numDays;
        addonDesc = t(addon.key) + ' — ' + numDays + ' ' + addon.unit + (numDays > 1 ? 's' : '') + ' × $' + addon.rate;
      }
      grandTotal += addonTotal;
      linesHtml +=
        '<div class="sr-eb-row">' +
        '<span>' + escapeHtml(addonDesc) + '</span>' +
        '<span>$' + addonTotal.toFixed(2) + '</span>' +
        '</div>';
    }

    priceBox.innerHTML =
      '<div class="sr-eb-card">' +
      '<div class="sr-eb-title">' + escapeHtml(p.label) + ' — ' + numDays + ' ' + p.unit + (numDays > 1 ? 's' : '') + '</div>' +
      '<div class="sr-eb-dates">' + escapeHtml(dateText) + '</div>' +
      '<div class="sr-eb-divider"></div>' +
      linesHtml +
      '<div class="sr-eb-divider"></div>' +
      '<div class="sr-eb-row sr-eb-total">' +
      '<span>' + t('totalDueNow') + '</span>' +
      '<span>$' + grandTotal.toFixed(2) + '</span>' +
      '</div>' +
      '<div class="sr-eb-divider"></div>' +
      '<div class="sr-eb-row sr-eb-deposit">' +
      '<span>' + t('depositLabel') + '</span>' +
      '<span>$' + p.deposit.toFixed(2) + '</span>' +
      '</div>' +
      '<div class="sr-eb-deposit-note">' + t('depositNote') + '</div>' +
      '</div>';

    priceBox.style.display = 'block';
    if (contBtn) contBtn.style.display = 'block';
    if (datePrompt) datePrompt.style.display = 'none';
  }

  // ── Calendar Polling ────────────────────────────────────────────
  function hookCalendarChanges() {
    setInterval(function () {
      // Reapply booked-date markers (handles month navigation in WPBC)
      applyAvailabilityToCalendar();

      // Block clicks on booked dates
      blockBookedDateClicks();

      var dates = [];

      if (typeof window.wpbc_get__selected_dates_sql__as_arr === 'function') {
        try { dates = window.wpbc_get__selected_dates_sql__as_arr(1) || []; } catch (e) {}
      }

      if (dates.length === 0) {
        var dateField = document.getElementById('date_booking1');
        var val = dateField ? dateField.value : '';
        if (val) {
          val.split(',').forEach(function (p) {
            var d = p.trim();
            if (!d) return;
            var parts = d.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
            if (parts) {
              dates.push(parts[3] + '-' + parts[2].padStart(2, '0') + '-' + parts[1].padStart(2, '0'));
            } else if (/^\d{4}-\d{2}-\d{2}$/.test(d)) {
              dates.push(d);
            }
          });
        }
      }

      if (dates.length === 0) {
        var cells = document.querySelectorAll('.datepick-days-cell');
        cells.forEach(function (td) {
          var a = td.querySelector('a');
          if (a && (a.classList.contains('datepick-highlight') || a.classList.contains('wpbc_selected') || td.classList.contains('datepick-current-day') || td.style.backgroundColor)) {
            var sqlMatch = td.className.match(/sql_date_(\S+)/);
            if (sqlMatch) dates.push(sqlMatch[1]);
          }
        });
      }

      // Filter out any booked dates that the user somehow selected
      dates = dates.filter(function(d) { return !bookedDatesSet[d]; });

      var newKey = dates.slice().sort().join('|');
      var oldKey = selectedDates.slice().sort().join('|');
      if (newKey !== oldKey) {
        selectedDates = dates;
        updatePriceBox();
      }
    }, 500);
  }

  function blockBookedDateClicks() {
    var cells = document.querySelectorAll('.datepick-days-cell.sr-date-booked');
    cells.forEach(function(td) {
      var a = td.querySelector('a');
      if (a && !td.hasAttribute('data-sr-blocked')) {
        td.setAttribute('data-sr-blocked', '1');
        // Replace the link with a span to prevent WPBC click handlers
        var span = document.createElement('span');
        span.className = a.className + ' sr-booked-span';
        span.textContent = a.textContent;
        a.parentNode.replaceChild(span, a);
      }
    });
  }

  // ── Validation ──────────────────────────────────────────────────
  function validateStep3() {
    var name = (document.getElementById('name1')?.value || '').trim();
    var lastName = (document.getElementById('secondname1')?.value || '').trim();
    var email = (document.getElementById('email1')?.value || '').trim();
    var phone = (document.getElementById('phone1')?.value || '').trim();

    if (!name || !lastName) { showError(t('errName')); return false; }
    if (!email || !email.includes('@')) { showError(t('errEmail')); return false; }
    if (!phone) { showError(t('errPhone')); return false; }
    if (!selectedEquipment) { showError(t('errEquipment')); return false; }
    if (selectedDates.length === 0) { showError(t('errDates')); return false; }

    try {
      sessionStorage.setItem('sr_name', name);
      sessionStorage.setItem('sr_lastname', lastName);
      sessionStorage.setItem('sr_email', email);
      sessionStorage.setItem('sr_phone', phone);
    } catch (e) {}

    return true;
  }

  // ── Review Summary ──────────────────────────────────────────────
  function buildReviewSummary() {
    var review = document.getElementById('sr-review-summary');
    if (!review) return;

    var p = PRICING[selectedEquipment];
    var numDays = selectedDates.length;
    var sorted = selectedDates.slice().sort();
    var dateText = sorted.length === 1 ? formatDate(sorted[0]) : formatDate(sorted[0]) + ' — ' + formatDate(sorted[sorted.length - 1]);

    var grandTotal = p.rate * numDays;
    var addOnLabels = [];
    for (var i = 0; i < selectedAddOns.length; i++) {
      var addon = ADD_ONS[selectedAddOns[i]];
      if (!addon) continue;
      if (addon.unit === 'flat') grandTotal += addon.rate;
      else grandTotal += addon.rate * numDays;
      addOnLabels.push(t(addon.key));
    }

    var name = (document.getElementById('name1')?.value || '').trim();
    var lastName = (document.getElementById('secondname1')?.value || '').trim();
    var email = (document.getElementById('email1')?.value || '').trim();
    var phone = (document.getElementById('phone1')?.value || '').trim();

    review.innerHTML =
      '<div class="sr-review-card">' +
      '<div class="sr-review-section">' +
      '<div class="sr-review-row"><span class="sr-review-label">' + t('reviewEquipment') + '</span><span>' + escapeHtml(p.label) + '</span></div>' +
      '<div class="sr-review-row"><span class="sr-review-label">' + t('reviewDates') + '</span><span>' + escapeHtml(dateText) + ' (' + numDays + ' ' + p.unit + (numDays > 1 ? 's' : '') + ')</span></div>' +
      '<div class="sr-review-row"><span class="sr-review-label">' + t('reviewAddOns') + '</span><span>' + (addOnLabels.length ? escapeHtml(addOnLabels.join(', ')) : t('reviewNone')) + '</span></div>' +
      '</div>' +
      '<div class="sr-review-divider"></div>' +
      '<div class="sr-review-section">' +
      '<div class="sr-review-row"><span class="sr-review-label">' + t('reviewName') + '</span><span>' + escapeHtml(name + ' ' + lastName) + '</span></div>' +
      '<div class="sr-review-row"><span class="sr-review-label">' + t('reviewEmail') + '</span><span>' + escapeHtml(email) + '</span></div>' +
      '<div class="sr-review-row"><span class="sr-review-label">' + t('reviewPhone') + '</span><span>' + escapeHtml(phone) + '</span></div>' +
      '</div>' +
      '<div class="sr-review-divider"></div>' +
      '<div class="sr-review-row sr-review-total"><span>' + t('reviewTotal') + '</span><span>$' + grandTotal.toFixed(2) + '</span></div>' +
      '<div class="sr-review-divider"></div>' +
      '<div class="sr-review-row sr-review-deposit"><span>' + t('depositLabel') + '</span><span>$' + p.deposit.toFixed(2) + '</span></div>' +
      '<div class="sr-review-deposit-note">' + t('depositNote') + '</div>' +
      '</div>';

    var payBtn = document.getElementById('sr-pay-btn');
    if (payBtn) payBtn.textContent = t('payNow') + ' — $' + grandTotal.toFixed(2);
  }

  // ── Payment Handler ─────────────────────────────────────────────
  function handlePayment() {
    var payBtn = document.getElementById('sr-pay-btn');
    if (!payBtn) return;

    payBtn.disabled = true;
    payBtn.textContent = t('processing');

    var name = (document.getElementById('name1')?.value || '').trim();
    var lastName = (document.getElementById('secondname1')?.value || '').trim();
    var email = (document.getElementById('email1')?.value || '').trim();
    var phone = (document.getElementById('phone1')?.value || '').trim();
    var details = (document.getElementById('details1')?.value || '').trim();
    var timeSlot = document.getElementById('rangetime1')?.value || '';

    var payload = {
      equipment: selectedEquipment,
      dates: selectedDates.slice().sort(),
      customer: { firstName: name, lastName: lastName, email: email, phone: phone },
      addOns: selectedAddOns,
      details: details,
      timeSlot: timeSlot,
    };

    fetch(API_URL + '/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (data.paymentUrl) {
          window.location.href = data.paymentUrl;
        } else {
          showError(data.error || 'Failed to create booking. Please try again.');
          payBtn.disabled = false;
          payBtn.textContent = t('payNow');
        }
      })
      .catch(function (err) {
        console.error('[SheridanBooking] Error:', err);
        showError('Connection error. Please try again.');
        payBtn.disabled = false;
        payBtn.textContent = t('payNow');
      });
  }

  // ── Error Display ───────────────────────────────────────────────
  function showError(msg) {
    var existing = document.getElementById('sr-booking-error');
    if (existing) existing.remove();

    var el = document.createElement('div');
    el.id = 'sr-booking-error';
    el.textContent = msg;

    // Insert at top of active step
    var activeStep = wizardEl.querySelector('.sr-wizard-step.active .sr-step-content');
    if (activeStep) {
      activeStep.insertBefore(el, activeStep.firstChild);
    } else {
      wizardEl.appendChild(el);
    }

    setTimeout(function () { el.remove(); }, 5000);
  }

  // ── Helpers ─────────────────────────────────────────────────────
  function formatDate(dateStr) {
    var parts = dateStr.split('-');
    if (parts.length === 3) {
      var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      return months[parseInt(parts[1], 10) - 1] + ' ' + parseInt(parts[2], 10) + ', ' + parts[0];
    }
    return dateStr;
  }

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
  }

  function prefillFromSession() {
    try {
      var fields = { name1: 'sr_name', secondname1: 'sr_lastname', email1: 'sr_email', phone1: 'sr_phone' };
      Object.keys(fields).forEach(function(id) {
        var el = document.getElementById(id);
        var val = sessionStorage.getItem(fields[id]);
        if (el && val && !el.value) el.value = val;
      });
    } catch (e) {}
  }

  // ── Inject Styles ───────────────────────────────────────────────
  function injectStyles() {
    var style = document.createElement('style');
    style.textContent =
      '#sr-wizard { max-width: 520px; margin: 0 auto; position: relative; }' +
      '.sr-wiz-lang-toggle { position: absolute; top: 0; right: 0; background: #1d4ed8; color: #fff; border: none; border-radius: 6px; padding: 4px 12px; font-size: 12px; font-weight: 600; cursor: pointer; z-index: 2; letter-spacing: 0.5px; }' +
      '.sr-wiz-lang-toggle:hover { background: #1e40af; }' +
      '.sr-progress { display: flex; align-items: center; justify-content: center; padding: 20px 0 24px; gap: 0; }' +
      '.sr-progress-item { display: flex; flex-direction: column; align-items: center; gap: 6px; min-width: 60px; }' +
      '.sr-progress-dot { width: 32px; height: 32px; border-radius: 50%; background: #e5e7eb; color: #9ca3af; display: flex; align-items: center; justify-content: center; font-size: 14px; font-weight: 600; transition: all 0.2s; }' +
      '.sr-progress-dot.active { background: #1d4ed8; color: #fff; box-shadow: 0 0 0 4px rgba(29,78,216,0.15); }' +
      '.sr-progress-dot.completed { background: #16a34a; color: #fff; }' +
      '.sr-progress-label { font-size: 11px; color: #6b7280; text-align: center; white-space: nowrap; }' +
      '.sr-progress-line { flex: 1; height: 3px; background: #e5e7eb; min-width: 20px; max-width: 60px; margin: 0 4px; align-self: flex-start; margin-top: 15px; }' +
      '.sr-progress-line.done { background: #16a34a; }' +
      '.sr-wizard-step { display: none; }' +
      '.sr-wizard-step.active { display: block; animation: sr-fade-in 0.25s ease; }' +
      '@keyframes sr-fade-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }' +
      '.sr-step-header { font-size: 20px; font-weight: 700; color: #1f2937; margin-bottom: 16px; display: flex; align-items: center; gap: 10px; }' +
      '.sr-step-num { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: 50%; background: #1d4ed8; color: #fff; font-size: 14px; font-weight: 700; flex-shrink: 0; }' +
      '.sr-equip-cards { display: flex; flex-direction: column; gap: 12px; }' +
      '.sr-step-card { background: #fff; border: 2px solid #e5e7eb; border-radius: 12px; padding: 20px; cursor: pointer; transition: all 0.15s; }' +
      '.sr-step-card:hover { border-color: #1d4ed8; box-shadow: 0 2px 12px rgba(29,78,216,0.1); transform: translateY(-1px); }' +
      '.sr-step-card.selected { border-color: #1d4ed8; background: #eff6ff; box-shadow: 0 0 0 3px rgba(29,78,216,0.12); }' +
      '.sr-step-card-name { font-size: 18px; font-weight: 700; color: #1f2937; margin-bottom: 4px; }' +
      '.sr-step-card-desc { font-size: 14px; color: #6b7280; margin-bottom: 8px; }' +
      '.sr-step-card-price { font-size: 16px; font-weight: 700; color: #1d4ed8; }' +
      '#sr-price-box { margin: 16px 0; }' +
      '.sr-eb-card { background: #fff; border: 2px solid #1d4ed8; border-radius: 12px; padding: 18px 20px; box-shadow: 0 2px 8px rgba(29,78,216,0.08); }' +
      '.sr-eb-title { font-weight: 700; font-size: 16px; color: #1f2937; margin-bottom: 4px; }' +
      '.sr-eb-dates { font-size: 13px; color: #6b7280; margin-bottom: 12px; }' +
      '.sr-eb-divider { height: 1px; background: #e5e7eb; margin: 8px 0; }' +
      '.sr-eb-row { display: flex; justify-content: space-between; padding: 4px 0; font-size: 14px; color: #374151; }' +
      '.sr-eb-total { font-weight: 700; font-size: 16px; color: #1d4ed8; padding-top: 6px; }' +
      '.sr-eb-deposit { font-size: 13px; color: #6b7280; font-style: italic; }' +
      '.sr-eb-deposit-note { font-size: 11px; color: #9ca3af; font-style: italic; padding: 2px 0 0; }' +
      '#sr-addons-wizard { margin: 16px 0; }' +
      '.sr-addons-card { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 10px; padding: 16px; }' +
      '.sr-addons-title { font-weight: 600; font-size: 14px; color: #374151; margin-bottom: 10px; }' +
      '.sr-addon-option { display: flex; align-items: flex-start; gap: 8px; padding: 6px 0; font-size: 14px; color: #374151; cursor: pointer; }' +
      '.sr-addon-option input { margin-top: 3px; }' +
      '.sr-date-prompt { text-align: center; color: #6b7280; font-size: 14px; padding: 12px 0; }' +
      '.sr-wizard-nav { display: flex; justify-content: space-between; gap: 12px; margin-top: 20px; }' +
      '.sr-wiz-btn { border: none !important; border-radius: 8px !important; padding: 12px 24px !important; font-size: 15px !important; font-weight: 600 !important; cursor: pointer !important; transition: all 0.15s !important; line-height: 1.4 !important; }' +
      '.sr-wiz-btn-primary { background: #1d4ed8 !important; color: #fff !important; }' +
      '.sr-wiz-btn-primary:hover { background: #1e40af !important; }' +
      '.sr-wiz-btn-secondary { background: #f3f4f6 !important; color: #374151 !important; }' +
      '.sr-wiz-btn-secondary:hover { background: #e5e7eb !important; }' +
      '.sr-wiz-btn-pay { background: #16a34a !important; color: #fff !important; flex: 1; font-size: 16px !important; padding: 14px !important; }' +
      '.sr-wiz-btn-pay:hover { background: #15803d !important; }' +
      '.sr-wiz-btn-pay:disabled { background: #9ca3af !important; cursor: not-allowed !important; }' +
      '.sr-review-card { background: #fff; border: 2px solid #e5e7eb; border-radius: 12px; padding: 20px; }' +
      '.sr-review-section { padding: 8px 0; }' +
      '.sr-review-row { display: flex; justify-content: space-between; padding: 6px 0; font-size: 14px; color: #374151; }' +
      '.sr-review-label { font-weight: 600; color: #6b7280; }' +
      '.sr-review-divider { height: 1px; background: #e5e7eb; margin: 8px 0; }' +
      '.sr-review-total { font-weight: 700; font-size: 18px; color: #1d4ed8; padding-top: 8px; }' +
      '.sr-review-deposit { font-size: 13px; color: #6b7280; font-style: italic; }' +
      '.sr-review-deposit-note { font-size: 11px; color: #9ca3af; font-style: italic; padding: 2px 0 4px; }' +
      '#sr-booking-error { background: #fef2f2; color: #dc2626; border: 1px solid #fca5a5; border-radius: 8px; padding: 12px 16px; margin: 12px 0; font-size: 14px; }' +
      '.sr-date-booked { position: relative; }' +
      '.sr-date-booked .sr-booked-span { color: #fff !important; cursor: not-allowed !important; text-decoration: none; pointer-events: none; }' +
      '.sr-date-booked { background: transparent !important; }' +
      '.sr-date-booked a { color: #fff !important; cursor: not-allowed !important; text-decoration: none; pointer-events: none; }' + '.sr-date-booked .wpbc-cell-box { background: rgba(166, 13, 13, 0.8) !important; }' +
      '@media (max-width: 480px) {' +
      '  .sr-progress-label { font-size: 9px; }' +
      '  .sr-step-card { padding: 16px; }' +
      '  .sr-step-card-name { font-size: 16px; }' +
      '  .sr-progress-dot { width: 28px; height: 28px; font-size: 12px; }' +
      '}';
    document.head.appendChild(style);
  }

  // ── Boot ────────────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      waitForForm(init);
    });
  } else {
    waitForForm(init);
  }
})();
