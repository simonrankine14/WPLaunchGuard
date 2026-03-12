'use strict';

(function() {
var RUNNING_STATUS = { queued: true, queued_local: true, dispatched: true, running: true };
var TERMINAL_STATUS = { completed: true, failed: true, cancelled: true, protected_stopped: true, stalled: true };

function normalizeStatus(value) {
  var normalized = String(value || '').toLowerCase().trim();
  if (normalized === 'canceled') return 'cancelled';
  return normalized || 'queued';
}

function isRunningStatus(value) {
  return !!RUNNING_STATUS[normalizeStatus(value)];
}

function isTerminalStatus(value) {
  return !!TERMINAL_STATUS[normalizeStatus(value)];
}

function clampNumber(value, min, max) {
  var parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed)) return min;
  if (parsed < min) return min;
  if (parsed > max) return max;
  return parsed;
}

function parseIsoMs(value) {
  var ms = Date.parse(String(value || '').trim());
  return Number.isFinite(ms) ? ms : 0;
}

function formatElapsedText(createdAt) {
  var startMs = parseIsoMs(createdAt);
  if (!startMs) return '--';
  var elapsedSec = Math.max(0, Math.floor((Date.now() - startMs) / 1000));
  var hours = Math.floor(elapsedSec / 3600);
  var minutes = Math.floor((elapsedSec % 3600) / 60);
  var seconds = elapsedSec % 60;
  if (hours > 0) return hours + 'h ' + minutes + 'm ' + seconds + 's';
  if (minutes > 0) return minutes + 'm ' + seconds + 's';
  return seconds + 's';
}

function emitTelemetry(eventName, detail) {
  var payload = detail && typeof detail === 'object' ? detail : {};
  try {
    window.dispatchEvent(new CustomEvent('baseline_scan_telemetry', { detail: Object.assign({ event: eventName }, payload) }));
  } catch (error) {}
}

function setLinkState(anchorEl, url) {
  if (!anchorEl) return;
  var safeUrl = String(url || '').trim();
  if (!safeUrl) {
    anchorEl.setAttribute('aria-disabled', 'true');
    anchorEl.classList.add('is-disabled');
    anchorEl.setAttribute('href', '#');
    return;
  }
  anchorEl.removeAttribute('aria-disabled');
  anchorEl.classList.remove('is-disabled');
  anchorEl.setAttribute('href', safeUrl);
}

function setButtonState(buttonEl, enabled) {
  if (!buttonEl) return;
  if (enabled) {
    buttonEl.removeAttribute('disabled');
    buttonEl.removeAttribute('aria-disabled');
    buttonEl.classList.remove('is-disabled');
    return;
  }
  buttonEl.setAttribute('disabled', 'disabled');
  buttonEl.setAttribute('aria-disabled', 'true');
  buttonEl.classList.add('is-disabled');
}

function updateDashboardSummary() {
  var root = document.querySelector('.baseline-scan-config-form');
  if (!root) return;

  var quick = root.querySelector('input[name="scan_options[quick_scan_enabled]"]:checked');
  var responsive = root.querySelector('input[name="scan_options[responsive_enabled]"]:checked');
  var evidence = root.querySelector('input[name="scan_options[evidence_enabled]"]:checked');
  var lighthouse = root.querySelector('input[name="scan_options[lighthouse_enabled]"]:checked');
  var viewport = root.querySelector('select[name="scan_options[viewport_preset]"]');
  var summary = document.getElementById('baseline-dashboard-summary-text');

  var viewportValue = 'Desktop';
  if (responsive && viewport) {
    if (viewport.value === 'mobile') viewportValue = 'Mobile';
    if (viewport.value === 'both') viewportValue = 'Desktop + Mobile';
  }

  var parts = [];
  parts.push(viewportValue);
  parts.push(evidence ? 'Evidence' : 'No Evidence');
  parts.push(lighthouse ? 'Lighthouse' : 'No Lighthouse');
  parts.push(quick ? 'Quick' : 'Standard');

  if (summary) {
    summary.textContent = parts.join(' + ');
  }
}

function bindViewportToggle(namePrefix) {
  var responsive = document.getElementById(namePrefix + '_responsive_enabled');
  var viewportWrap = document.querySelector('[data-baseline-viewport-wrap="' + namePrefix + '"]');
  var viewportSelect = document.querySelector('[data-baseline-viewport-select="' + namePrefix + '"]');

  if (!responsive || !viewportWrap || !viewportSelect) {
    return;
  }

  function sync() {
    if (responsive.checked) {
      viewportWrap.classList.remove('is-hidden');
      return;
    }
    viewportWrap.classList.add('is-hidden');
    viewportSelect.value = 'desktop';
  }

  responsive.addEventListener('change', function() {
    sync();
    updateDashboardSummary();
  });

  viewportSelect.addEventListener('change', updateDashboardSummary);
  sync();
}

function getBranchState(payload) {
  var status = normalizeStatus(payload.status || payload.status_label || '');
  var hasWorkflow = String(payload.workflow_url || '').trim() !== '';
  var hasReport = String(payload.report_url || '').trim() !== '';
  var hasArtifact = String(payload.artifact_url || '').trim() !== '';
  var errorCode = String(payload.error_code || '').trim();
  var safety = payload.safety && typeof payload.safety === 'object' ? payload.safety : {};
  var safetyDetail = String(safety.reason_detail || '').trim();
  var errorSuffix = errorCode ? ' (Error code: ' + errorCode + ')' : '';

  if (status === 'queued' || status === 'queued_local') {
    return {
      key: 'queued',
      message: 'Scan queued. We are preparing a safe cloud run.'
    };
  }
  if (status === 'dispatched' || status === 'running') {
    return {
      key: 'running',
      message: 'Scan is running in the cloud. GitHub QA execution can take 5 to 20 minutes on larger sites.'
    };
  }
  if (status === 'stalled') {
    return {
      key: 'stalled',
      message: (safetyDetail || 'Scan stalled due to missing progress updates. Retry with a safe profile.') + errorSuffix,
      primary: 'retry_safe',
      secondary: hasWorkflow ? 'open_workflow' : null
    };
  }
  if (status === 'protected_stopped') {
    return {
      key: 'protected_stopped',
      message: (safetyDetail || 'Site under stress; scan auto-stopped to protect uptime.') + errorSuffix,
      primary: 'retry_safe',
      secondary: hasWorkflow ? 'open_workflow' : null
    };
  }
  if (status === 'failed' && !hasWorkflow) {
    return {
      key: 'dispatch_failed',
      message: 'Scan dispatch failed before workflow start. Retry in safe mode.' + errorSuffix,
      primary: 'retry_safe'
    };
  }
  if (status === 'failed') {
    return {
      key: 'failed',
      message: 'Scan failed. Open the GitHub run for details and retry with safe scan.' + errorSuffix,
      primary: hasWorkflow ? 'open_workflow' : 'retry_safe',
      secondary: 'retry_safe'
    };
  }
  if (status === 'cancelled') {
    return {
      key: 'cancelled',
      message: 'Scan cancelled by administrator.',
      primary: 'retry_safe',
      secondary: hasWorkflow ? 'open_workflow' : null
    };
  }
  if (status === 'completed' && !hasReport) {
    return {
      key: 'report_publishing',
      message: 'Scan completed. Report is still publishing. Retrying automatically.',
      primary: hasWorkflow ? 'open_workflow' : null,
      secondary: hasArtifact ? 'download_zip' : null
    };
  }
  if (status === 'completed' && safety && safety.triggered) {
    return {
      key: 'completed_with_warnings',
      message: 'Scan completed with warnings. Review transient infrastructure checks in the report.',
      primary: hasReport ? 'view_report' : null,
      secondary: hasWorkflow ? 'open_workflow' : null
    };
  }
  if (status === 'completed') {
    return {
      key: 'completed',
      message: 'Scan complete. Open the HTML report directly.',
      primary: hasReport ? 'view_report' : null,
      secondary: hasWorkflow ? 'open_workflow' : null
    };
  }
  return {
    key: 'unknown',
    message: 'Scan status update received.'
  };
}

function buildProgressLine(payload) {
  var progress = payload.progress && typeof payload.progress === 'object' ? payload.progress : {};
  var total = clampNumber(progress.total_urls, 0, 50000);
  var completed = clampNumber(progress.completed_urls, 0, 50000);
  var currentIndex = clampNumber(progress.current_index, 0, 50000);
  var parts = [];
  if (total > 0) {
    var activeIndex = currentIndex > 0 ? currentIndex : Math.max(1, completed);
    parts.push('URL ' + Math.min(activeIndex, total) + ' of ' + total);
  }
  var eta = String(payload.eta_text || '').trim();
  if (eta) {
    parts.push(eta);
  }
  return parts.join(' | ');
}

function readCurrentUrl(payload) {
  var progress = payload && payload.progress && typeof payload.progress === 'object' ? payload.progress : {};
  return String(payload.current_url || progress.current_url || progress.last_completed_url || payload.target_url || '').trim();
}

function buildNotice(status, payload) {
  var hasReport = String(payload && payload.report_url || '').trim() !== '';
  var message = 'Scan update received.';
  if (status === 'completed' && hasReport) message = 'Scan completed successfully.';
  if (status === 'completed' && !hasReport) message = 'Scan completed. Report is still publishing.';
  if (status === 'failed') message = 'Scan failed.';
  if (status === 'cancelled') message = 'Scan was cancelled.';
  if (status === 'protected_stopped') message = 'Site protection triggered. Scan auto-stopped.';
  if (status === 'stalled') message = 'Scan stalled due to missing telemetry updates.';
  return message;
}

function showCompletionNotice(status, payload) {
  var root = document.querySelector('.wrap.baseline-wrap') || document.querySelector('.wrap');
  if (!root) return;
  var existing = document.getElementById('baseline-runtime-scan-notice');
  if (existing && existing.parentNode) {
    existing.parentNode.removeChild(existing);
  }

  var isOk = status === 'completed';
  var notice = document.createElement('div');
  notice.id = 'baseline-runtime-scan-notice';
  notice.className = 'notice ' + (isOk ? 'notice-success' : 'notice-warning') + ' is-dismissible';

  var paragraph = document.createElement('p');
  paragraph.appendChild(document.createTextNode(buildNotice(status, payload) + ' '));
  var reportUrl = String(payload && payload.report_url || '').trim();
  if (reportUrl) {
    var link = document.createElement('a');
    link.href = reportUrl;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = 'View Report';
    paragraph.appendChild(link);
  }
  notice.appendChild(paragraph);
  root.insertBefore(notice, root.firstChild);
}

(function bindDashboardViewport() {
  var responsive = document.getElementById('baseline_responsive_scan');
  var viewportWrap = document.querySelector('[data-baseline-viewport-wrap="dashboard"]');
  var viewportSelect = document.querySelector('[data-baseline-viewport-select="dashboard"]');
  if (!responsive || !viewportWrap || !viewportSelect) return;

  function sync() {
    if (responsive.checked) {
      viewportWrap.classList.remove('is-hidden');
      return;
    }
    viewportWrap.classList.add('is-hidden');
    viewportSelect.value = 'desktop';
  }

  responsive.addEventListener('change', function() {
    sync();
    updateDashboardSummary();
  });
  viewportSelect.addEventListener('change', updateDashboardSummary);
  sync();
})();

bindViewportToggle('baseline_scan_options');

document.querySelectorAll('.baseline-scan-config-form input, .baseline-scan-config-form select').forEach(function(field) {
  field.addEventListener('change', updateDashboardSummary);
});
updateDashboardSummary();

(function initScanProgressModal() {
  var modal = document.getElementById('baseline-scan-progress-modal');
  if (!modal) return;

  var state = {
    scanId: String(modal.getAttribute('data-scan-id') || '').trim(),
    pollUrl: String(modal.getAttribute('data-poll-url') || '').trim(),
    pollNonce: String(modal.getAttribute('data-poll-nonce') || '').trim(),
    cancelNonce: String(modal.getAttribute('data-cancel-nonce') || '').trim(),
    autoOpen: modal.getAttribute('data-auto-open') === '1',
    lastCompletedReportUrl: String(modal.getAttribute('data-last-report-url') || '').trim(),
    pollTimer: null,
    tipTimer: null,
    elapsedTimer: null,
    lastProgress: 0,
    lastStatus: '',
    createdAt: '',
    branchKey: ''
  };

  var tips = [
    'Start with top-conversion pages first: homepage, service page, contact page.',
    'Fix missing form labels first. They are fast wins for accessibility and UX.',
    'Broken internal links on nav/footer often cause the largest trust drop.',
    'Above-the-fold overflow on mobile can hide call-to-action buttons.',
    'Lighthouse regressions are easier to fix early than after launch.',
    'Use screenshot evidence in client reports to speed up sign-off.'
  ];
  var tipIndex = 0;

  var titleEl = document.getElementById('baseline-modal-title');
  var scanIdEl = document.getElementById('baseline-modal-scan-id');
  var statusEl = document.getElementById('baseline-modal-status');
  var progressTextEl = document.getElementById('baseline-modal-progress-text');
  var progressBarEl = document.getElementById('baseline-modal-progress-bar');
  var progressWrapEl = modal.querySelector('.baseline-modal__progress');
  var currentUrlEl = document.getElementById('baseline-modal-current-url');
  var elapsedEl = document.getElementById('baseline-modal-elapsed');
  var statusMessageEl = document.getElementById('baseline-modal-status-message');
  var tipTextEl = document.getElementById('baseline-modal-tip-text');
  var etaTextEl = document.getElementById('baseline-modal-eta-text');
  var viewReportEl = document.getElementById('baseline-modal-view-report');
  var openWorkflowEl = document.getElementById('baseline-modal-open-workflow');
  var downloadArtifactEl = document.getElementById('baseline-modal-download-artifact');
  var lastReportEl = document.getElementById('baseline-modal-last-report');
  var retrySafeBtn = document.getElementById('baseline-modal-retry-safe');
  var stopBtn = document.getElementById('baseline-modal-stop');
  var retrySafeForm = document.getElementById('baseline-modal-retry-safe-form');

  function updateElapsedLabel() {
    if (!elapsedEl) return;
    elapsedEl.textContent = formatElapsedText(state.createdAt);
  }

  function setModalOpen(isOpen) {
    if (isOpen) {
      modal.classList.add('is-open');
      modal.setAttribute('aria-hidden', 'false');
      document.body.classList.add('baseline-modal-open');
      return;
    }
    modal.classList.remove('is-open');
    modal.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('baseline-modal-open');
  }

  function updateTitle(status) {
    if (!titleEl) return;
    if (status === 'completed') {
      titleEl.textContent = 'Scan Complete';
      return;
    }
    if (status === 'failed') {
      titleEl.textContent = 'Scan Failed';
      return;
    }
    if (status === 'cancelled') {
      titleEl.textContent = 'Scan Cancelled';
      return;
    }
    if (status === 'protected_stopped') {
      titleEl.textContent = 'Scan Auto-Stopped';
      return;
    }
    if (status === 'stalled') {
      titleEl.textContent = 'Scan Stalled';
      return;
    }
    titleEl.textContent = 'Scan In Progress';
  }

  function updateTip() {
    if (!tipTextEl || tips.length === 0) return;
    tipTextEl.textContent = tips[tipIndex % tips.length];
    tipIndex += 1;
  }

  function schedulePoll(delayMs) {
    if (state.pollTimer) {
      clearTimeout(state.pollTimer);
    }
    state.pollTimer = setTimeout(pollScanStatus, delayMs);
  }

  function requestCancel(callback) {
    if (!state.pollUrl || !state.cancelNonce || !state.scanId) {
      callback(false);
      return;
    }

    var body = new URLSearchParams();
    body.set('action', 'baseline_cancel_scan');
    body.set('scan_id', state.scanId);
    body.set('nonce', state.cancelNonce);

    fetch(state.pollUrl, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
      },
      body: body.toString()
    })
      .then(function(response) { return response.json(); })
      .then(function(payload) {
        if (payload && payload.success) {
emitTelemetry('scan_manual_cancel', { scan_id: state.scanId, surface: 'scan_modal' });
callback(true);
return;
        }
        callback(false);
      })
      .catch(function() {
        callback(false);
      });
  }

  function renderModalState(payload) {
    if (!payload || typeof payload !== 'object') return;
    var status = normalizeStatus(payload.status || payload.status_label || 'queued');
    var previousStatus = normalizeStatus(state.lastStatus);
    var progress = clampNumber(payload.progress_percent, 0, 100);

    if (isRunningStatus(status)) {
      var syntheticCap = status === 'dispatched' ? 85 : 95;
      if (progress <= state.lastProgress && state.lastProgress < syntheticCap) {
        progress = state.lastProgress + 1;
      }
      state.lastProgress = Math.max(state.lastProgress, progress);
      progress = state.lastProgress;
    } else {
      state.lastProgress = progress;
    }

    if (isTerminalStatus(status) && progress < 100) {
      progress = 100;
      state.lastProgress = 100;
    }

    var scanId = String(payload.scan_id || state.scanId || '').trim();
    if (scanId) {
      state.scanId = scanId;
    }
    if (scanIdEl) {
      scanIdEl.textContent = state.scanId || '--';
    }

    if (!state.createdAt) {
      state.createdAt = String(payload.created_at || '').trim();
    }
    updateElapsedLabel();

    if (statusEl) statusEl.textContent = status;
    if (progressTextEl) progressTextEl.textContent = progress + '%';
    if (progressBarEl) progressBarEl.style.width = progress + '%';
    if (progressWrapEl) progressWrapEl.setAttribute('aria-valuenow', String(progress));
    if (currentUrlEl) {
      var currentUrl = readCurrentUrl(payload);
      currentUrlEl.textContent = currentUrl || 'Waiting for live scan telemetry...';
    }
    if (etaTextEl) etaTextEl.textContent = buildProgressLine(payload);

    var branch = getBranchState(payload);
    if (statusMessageEl) statusMessageEl.textContent = branch.message;
    if (branch.key !== state.branchKey) {
      state.branchKey = branch.key;
      emitTelemetry('scan_branch_state', {
        scan_id: state.scanId,
        status: status,
        branch: branch.key,
        surface: 'scan_modal'
      });
    }

    updateTitle(status);
    setLinkState(viewReportEl, payload.report_url);
    setLinkState(openWorkflowEl, payload.workflow_url);
    setLinkState(downloadArtifactEl, payload.artifact_url);
    setLinkState(lastReportEl, state.lastCompletedReportUrl);

    var canStop = isRunningStatus(status);
    setButtonState(stopBtn, canStop);

    var canRetrySafe = status === 'failed' || status === 'cancelled' || status === 'stalled' || status === 'protected_stopped';
    setButtonState(retrySafeBtn, canRetrySafe);

    if (isRunningStatus(previousStatus) && isTerminalStatus(status)) {
      showCompletionNotice(status, payload);
    }
    state.lastStatus = status;
  }

  function pollScanStatus() {
    if (!state.pollUrl || !state.pollNonce || !state.scanId) {
      return;
    }
    var params = new URLSearchParams();
    params.set('action', 'baseline_poll_scan');
    params.set('scan_id', state.scanId);
    params.set('nonce', state.pollNonce);

    fetch(state.pollUrl + '?' + params.toString(), { method: 'GET', credentials: 'same-origin' })
      .then(function(response) { return response.json(); })
      .then(function(payload) {
        if (!payload || !payload.success || !payload.data) {
emitTelemetry('scan_poll_error', { scan_id: state.scanId, surface: 'scan_modal', reason: 'invalid_payload' });
schedulePoll(9000);
return;
        }

        renderModalState(payload.data);
        var status = normalizeStatus(payload.data.status);
        var hasReport = String(payload.data.report_url || '').trim() !== '';
        if (isRunningStatus(status)) {
schedulePoll(5000);
return;
        }
        if (status === 'completed' && !hasReport) {
schedulePoll(6000);
        }
      })
      .catch(function() {
        emitTelemetry('scan_poll_error', { scan_id: state.scanId, surface: 'scan_modal', reason: 'network_error' });
        schedulePoll(9000);
      });
  }

  document.querySelectorAll('[data-baseline-open-scan-modal]').forEach(function(buttonEl) {
    buttonEl.addEventListener('click', function(event) {
      event.preventDefault();
      setModalOpen(true);
      pollScanStatus();
    });
  });

  modal.querySelectorAll('[data-baseline-modal-close]').forEach(function(closeEl) {
    closeEl.addEventListener('click', function(event) {
      event.preventDefault();
      setModalOpen(false);
    });
  });

  if (stopBtn) {
    stopBtn.addEventListener('click', function(event) {
      event.preventDefault();
      setButtonState(stopBtn, false);
      requestCancel(function(ok) {
        if (!ok) {
setButtonState(stopBtn, true);
        }
        pollScanStatus();
      });
    });
  }

  if (retrySafeBtn && retrySafeForm) {
    retrySafeBtn.addEventListener('click', function(event) {
      event.preventDefault();
      retrySafeForm.submit();
    });
  }

  document.addEventListener('keydown', function(event) {
    if (event.key === 'Escape') {
      setModalOpen(false);
    }
  });

  updateTip();
  state.tipTimer = setInterval(updateTip, 9000);
  state.elapsedTimer = setInterval(updateElapsedLabel, 1000);
  pollScanStatus();
  if (state.autoOpen) {
    setModalOpen(true);
  }
})();

(function initInlineTrackers() {
  var trackers = document.querySelectorAll('[data-baseline-inline-tracker="1"]');
  if (!trackers.length) return;

  trackers.forEach(function(root) {
    var state = {
      scanId: String(root.getAttribute('data-scan-id') || '').trim(),
      pollUrl: String(root.getAttribute('data-poll-url') || '').trim(),
      pollNonce: String(root.getAttribute('data-poll-nonce') || '').trim(),
      cancelNonce: String(root.getAttribute('data-cancel-nonce') || '').trim(),
      createdAt: String(root.getAttribute('data-created-at') || '').trim(),
      pollTimer: null,
      elapsedTimer: null,
      lastProgress: 0,
      branchKey: ''
    };
    if (!state.scanId || !state.pollUrl || !state.pollNonce) return;

    var statusEl = root.querySelector('[data-baseline-inline-status]');
    var progressTextEl = root.querySelector('[data-baseline-inline-progress-text]');
    var progressBarEl = root.querySelector('[data-baseline-inline-progress-bar]');
    var progressWrapEl = root.querySelector('[data-baseline-inline-progress-wrap]');
    var currentUrlEl = root.querySelector('[data-baseline-inline-current-url]');
    var messageEl = root.querySelector('[data-baseline-inline-message]');
    var elapsedEl = root.querySelector('[data-baseline-inline-elapsed]');
    var viewReportEl = root.querySelector('[data-baseline-inline-view-report]');
    var openRunEl = root.querySelector('[data-baseline-inline-open-run]');
    var stopBtn = root.querySelector('[data-baseline-inline-stop]');

    function updateElapsed() {
      if (!elapsedEl) return;
      elapsedEl.textContent = formatElapsedText(state.createdAt);
    }

    function schedulePoll(delayMs) {
      if (state.pollTimer) clearTimeout(state.pollTimer);
      state.pollTimer = setTimeout(poll, delayMs);
    }

    function cancelInline() {
      if (!state.cancelNonce || !state.pollUrl || !state.scanId) return;
      var body = new URLSearchParams();
      body.set('action', 'baseline_cancel_scan');
      body.set('scan_id', state.scanId);
      body.set('nonce', state.cancelNonce);
      fetch(state.pollUrl, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        body: body.toString()
      })
        .then(function(response) { return response.json(); })
        .then(function(payload) {
if (!payload || !payload.success) {
  setButtonState(stopBtn, true);
}
poll();
        })
        .catch(function() {
setButtonState(stopBtn, true);
        });
    }

    function render(payload) {
      if (!payload || typeof payload !== 'object') return;
      var status = normalizeStatus(payload.status || payload.status_label || 'queued');
      var progress = clampNumber(payload.progress_percent, 0, 100);
      if (isRunningStatus(status)) {
        var syntheticCap = status === 'dispatched' ? 85 : 95;
        if (progress <= state.lastProgress && state.lastProgress < syntheticCap) {
progress = state.lastProgress + 1;
        }
        state.lastProgress = Math.max(state.lastProgress, progress);
        progress = state.lastProgress;
      } else {
        state.lastProgress = progress;
      }
      if (isTerminalStatus(status) && progress < 100) {
        progress = 100;
        state.lastProgress = 100;
      }

      if (!state.createdAt) {
        state.createdAt = String(payload.created_at || '').trim();
      }
      updateElapsed();

      if (statusEl) statusEl.textContent = status;
      if (progressTextEl) progressTextEl.textContent = progress + '%';
      if (progressBarEl) progressBarEl.style.width = progress + '%';
      if (progressWrapEl) progressWrapEl.setAttribute('aria-valuenow', String(progress));
      if (currentUrlEl) {
        var currentUrl = readCurrentUrl(payload);
        currentUrlEl.textContent = currentUrl || 'Waiting for live scan telemetry...';
      }
      setLinkState(viewReportEl, payload.report_url);
      setLinkState(openRunEl, payload.workflow_url);
      setButtonState(stopBtn, isRunningStatus(status));

      var branch = getBranchState(payload);
      if (messageEl) messageEl.textContent = branch.message;
      if (branch.key !== state.branchKey) {
        state.branchKey = branch.key;
        emitTelemetry('scan_branch_state', {
scan_id: state.scanId,
status: status,
branch: branch.key,
surface: 'metabox'
        });
      }
    }

    function poll() {
      var params = new URLSearchParams();
      params.set('action', 'baseline_poll_scan');
      params.set('scan_id', state.scanId);
      params.set('nonce', state.pollNonce);

      fetch(state.pollUrl + '?' + params.toString(), { method: 'GET', credentials: 'same-origin' })
        .then(function(response) { return response.json(); })
        .then(function(payload) {
if (!payload || !payload.success || !payload.data) {
  schedulePoll(9000);
  return;
}
render(payload.data);
var status = normalizeStatus(payload.data.status);
var hasReport = String(payload.data.report_url || '').trim() !== '';
if (isRunningStatus(status)) {
  schedulePoll(5000);
  return;
}
if (status === 'completed' && !hasReport) {
  schedulePoll(6000);
}
        })
        .catch(function() {
schedulePoll(9000);
        });
    }

    if (stopBtn) {
      stopBtn.addEventListener('click', function(event) {
        event.preventDefault();
        if (stopBtn.classList.contains('is-disabled')) return;
        setButtonState(stopBtn, false);
        cancelInline();
      });
    }

    state.elapsedTimer = setInterval(updateElapsed, 1000);
    poll();
  });
})();
})();
