/**
 * The primary clock of the forecaster (see ops/CLOCK.md).
 *
 * A Google Apps Script time trigger runs startTick() every 15 minutes. It asks
 * GitHub to start the tick workflow (workflow_dispatch) on main with profile
 * "live". GitHub's own schedule is too slow for young public repositories.
 *
 * A second trigger runs checkTicks() every hour. It reads the tick's recent
 * runs and fails when no tick has finished well for 2 hours.
 *
 * Both functions THROW when something is wrong. Google then emails the owner
 * a failure summary (Triggers -> the trigger -> "Failure notification
 * settings": keep it on, "Notify me daily" or "immediately"). This is the
 * warning that still works when no tick runs at all.
 *
 * Script Properties (Project Settings -> Script Properties), set by the owner:
 *   TICK_DISPATCH_TOKEN  the fine-grained dispatch token (never written in this file)
 *   FORECASTER_REPO      OWNER_GITHUB_USER/forecaster
 *
 * It logs only HTTP status codes and times, never the token.
 */

var WORKFLOW_FILE = 'tick.yml';
var MAX_QUIET_HOURS = 2;

function readSetup() {
  var props = PropertiesService.getScriptProperties();
  var token = props.getProperty('TICK_DISPATCH_TOKEN');
  var repo = props.getProperty('FORECASTER_REPO');
  if (!token || !repo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || repo.indexOf('..') !== -1) {
    console.log('setup missing: set TICK_DISPATCH_TOKEN and FORECASTER_REPO in Script Properties');
    throw new Error('forecaster clock: setup missing (Script Properties)');
  }
  return { token: token, repo: repo };
}

function headersFor(token) {
  return {
    Authorization: 'Bearer ' + token,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  };
}

function startTick() {
  var setup = readSetup();
  var url = 'https://api.github.com/repos/' + setup.repo + '/actions/workflows/' + WORKFLOW_FILE + '/dispatches';
  var response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: headersFor(setup.token),
    payload: JSON.stringify({ ref: 'main', inputs: { profile: 'live' } }),
    muteHttpExceptions: true
  });
  var code = response.getResponseCode();
  console.log('tick dispatch: HTTP ' + code);
  if (code !== 204) throw new Error('tick dispatch failed: HTTP ' + code + ' (see ops/CLOCK.md)');
}

/** Hourly: fails when no tick run finished well in the last MAX_QUIET_HOURS hours. */
function checkTicks() {
  var setup = readSetup();
  var url = 'https://api.github.com/repos/' + setup.repo + '/actions/workflows/' + WORKFLOW_FILE + '/runs?status=success&per_page=1';
  var response = UrlFetchApp.fetch(url, { method: 'get', headers: headersFor(setup.token), muteHttpExceptions: true });
  var code = response.getResponseCode();
  if (code !== 200) {
    console.log('tick check: HTTP ' + code);
    throw new Error('tick check failed: HTTP ' + code + ' (see ops/CLOCK.md)');
  }
  var runs = JSON.parse(response.getContentText()).workflow_runs || [];
  var last = runs.length ? Date.parse(runs[0].updated_at || runs[0].created_at) : NaN;
  var quietHours = (Date.now() - last) / 3600000;
  console.log('tick check: last good tick ' + (runs.length ? new Date(last).toISOString() : 'none'));
  if (!(quietHours <= MAX_QUIET_HOURS)) {
    throw new Error('no good tick for more than ' + MAX_QUIET_HOURS + ' hours: open forecaster -> Actions -> tick');
  }
}

/** Run once by hand: makes the two triggers (and removes old ones). */
function installClock() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    var fn = triggers[i].getHandlerFunction();
    if (fn === 'startTick' || fn === 'checkTicks') ScriptApp.deleteTrigger(triggers[i]);
  }
  ScriptApp.newTrigger('startTick').timeBased().everyMinutes(15).create();
  ScriptApp.newTrigger('checkTicks').timeBased().everyHours(1).create();
  console.log('clock installed: startTick every 15 minutes, checkTicks every hour');
}
