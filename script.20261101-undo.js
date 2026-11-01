const WORK_SPAN_MINUTES = 9 * 60 + 15;
const CHECK_IN_START = 8 * 60 + 30;
const CHECK_IN_END = 9 * 60 + 30;
const SAVED_NAME_KEY = "go-home-time-name";
const NOTIFY_KEY = "go-home-time-notify";
const NEW_PERSON_VALUE = "__new_person__";
const BASE_TITLE = "Go Home Time";
const UNDO_MS = 10 * 1000;

const form = document.querySelector("#person-form");
const personSelect = document.querySelector("#person-select");
const newPersonFields = document.querySelector("#new-person-fields");
const nameInput = document.querySelector("#person-name");
const arrivalInput = document.querySelector("#arrival");
const leaveTime = document.querySelector("#leave-time");
const statusMessage = document.querySelector("#status-message");
const answer = document.querySelector(".answer");
const nowButton = document.querySelector("#now-button");
const saveButton = document.querySelector("#save-button");
const refreshButton = document.querySelector("#refresh-button");
const presetButtons = [...document.querySelectorAll("[data-time]")];
const peopleList = document.querySelector("#people-list");
const boardStatus = document.querySelector("#board-status");
const todayDate = document.querySelector("#today-date");
const countdownOutputs = [...document.querySelectorAll("[data-countdown-output]")];
const notifyToggle = document.querySelector("#notify-toggle");
const notifyLabel = document.querySelector("#notify-label");
const notifyStatus = document.querySelector("#notify-status");
const undoBar = document.querySelector("#undo-bar");
const undoText = document.querySelector("#undo-text");
const undoButton = document.querySelector("#undo-button");

let people = [];
let today = "";

// The last deletion, while its "Hoàn tác" (undo) toast is showing.
let pendingUndo = null;
let undoTimer = null;

// Countdown + go-home notification state.
let activeLeaveMinutes = null;
let activeLeaveLabel = "--:--";
let activePersonName = "";
const NOTIFICATIONS_SUPPORTED = "Notification" in window;
let notificationsEnabled = NOTIFICATIONS_SUPPORTED && localStorage.getItem(NOTIFY_KEY) === "1";
let armedLeaveMinutes = null;
let notifiedLeaveMinutes = null;

function parseTime(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value || ""));
  if (!match) return null;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function formatTime(totalMinutes) {
  const minutesInDay = 24 * 60;
  const normalized = ((totalMinutes % minutesInDay) + minutesInDay) % minutesInDay;
  const hours = Math.floor(normalized / 60);
  const minutes = normalized % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function formatCountdown(milliseconds) {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function targetDateForMinutes(minutes) {
  const target = new Date();
  target.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
  return target;
}

function setCountdownText(value) {
  countdownOutputs.forEach((output) => {
    output.textContent = value;
  });
}

function setActiveCountdown(leaveMinutes) {
  activeLeaveMinutes = Number.isFinite(leaveMinutes) ? leaveMinutes : null;
  updateCountdown();
}

function updateCountdown() {
  if (activeLeaveMinutes === null) {
    setCountdownText("--:--:--");
    document.title = BASE_TITLE;
    return;
  }

  const target = targetDateForMinutes(activeLeaveMinutes);
  const remaining = target.getTime() - Date.now();

  if (remaining > 0) {
    // Arm only while enabled, so we never ping for a go-home time that had
    // already passed before notifications were turned on.
    if (notificationsEnabled) armedLeaveMinutes = activeLeaveMinutes;
    // A positive countdown means a fresh target (new day or new schedule),
    // so allow notifying again when it reaches zero.
    notifiedLeaveMinutes = null;
    const countdown = formatCountdown(remaining);
    setCountdownText(countdown);
    document.title = `${countdown} - ${BASE_TITLE}`;
    return;
  }

  setCountdownText("Time to go");
  document.title = `Time to go - ${BASE_TITLE}`;

  if (
    notificationsEnabled &&
    armedLeaveMinutes === activeLeaveMinutes &&
    notifiedLeaveMinutes !== activeLeaveMinutes
  ) {
    notifiedLeaveMinutes = activeLeaveMinutes;
    showGoHomeNotification();
  }
}

async function showGoHomeNotification() {
  if (!NOTIFICATIONS_SUPPORTED || Notification.permission !== "granted") return;

  const who = activePersonName || "You";
  const at = activeLeaveLabel || leaveTime.textContent || "now";
  const title = "Time to go home";
  const options = {
    body: `${who}: it's ${at}. You can head home.`,
    tag: "go-home-time",
    icon: "/favicon.20260611-glass.svg",
    badge: "/favicon.20260611-glass.svg",
  };

  // Mobile browsers (Android Chrome) throw on the Notification constructor
  // and only allow notifications through a service worker registration.
  if ("serviceWorker" in navigator) {
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      if (registration) {
        await registration.showNotification(title, options);
        return;
      }
    } catch (error) {
      // Fall through to the constructor path.
    }
  }

  try {
    const note = new Notification(title, options);
    note.onclick = () => {
      window.focus();
      note.close();
    };
  } catch (error) {
    // No service worker and no constructor support; nothing else to try.
  }
}

function setNotifyStatus(message, isError = false) {
  if (!notifyStatus) return;
  notifyStatus.textContent = message;
  notifyStatus.classList.toggle("is-error", isError);
}

function refreshNotifyUI() {
  if (!notifyToggle) return;

  if (!NOTIFICATIONS_SUPPORTED) {
    notifyToggle.disabled = true;
    notifyToggle.setAttribute("aria-pressed", "false");
    if (notifyLabel) notifyLabel.textContent = "Notify me";
    setNotifyStatus("Notifications are not supported in this browser.");
    return;
  }

  const denied = Notification.permission === "denied";
  notifyToggle.disabled = denied;
  notifyToggle.setAttribute("aria-pressed", String(notificationsEnabled));
  if (notifyLabel) notifyLabel.textContent = notificationsEnabled ? "Notifications on" : "Notify me";

  if (denied) {
    setNotifyStatus("Notifications are blocked in your browser settings.", true);
  } else if (notificationsEnabled) {
    setNotifyStatus("You'll get a ping at go-home time.");
  } else {
    setNotifyStatus("");
  }
}

async function toggleNotifications() {
  if (!NOTIFICATIONS_SUPPORTED) return;

  if (notificationsEnabled) {
    notificationsEnabled = false;
    armedLeaveMinutes = null;
    localStorage.removeItem(NOTIFY_KEY);
    refreshNotifyUI();
    return;
  }

  let permission = Notification.permission;
  if (permission === "default") {
    try {
      permission = await Notification.requestPermission();
    } catch (error) {
      permission = Notification.permission;
    }
  }

  if (permission !== "granted") {
    notificationsEnabled = false;
    localStorage.removeItem(NOTIFY_KEY);
    refreshNotifyUI();
    if (permission === "default") {
      setNotifyStatus("Allow notifications in your browser to get the ping.", true);
    }
    return;
  }

  notificationsEnabled = true;
  localStorage.setItem(NOTIFY_KEY, "1");
  refreshNotifyUI();
  updateCountdown();
}

function keyForName(name) {
  return String(name || "").trim().toLocaleLowerCase("en-US");
}

function findPerson(name) {
  const key = keyForName(name);
  return people.find((person) => keyForName(person.name) === key) || null;
}

function getSelectedName() {
  if (personSelect.value === NEW_PERSON_VALUE) return nameInput.value.trim();
  return personSelect.value.trim();
}

// Go-home time = come-in (clamped into the flexible window) + a 9h15m day,
// which already includes the noon break. No break-time math.
function calculateLeave(arrivalValue) {
  const arrival = parseTime(arrivalValue);
  if (arrival === null) return null;

  const effectiveArrival = clamp(arrival, CHECK_IN_START, CHECK_IN_END);
  const leave = effectiveArrival + WORK_SPAN_MINUTES;
  return { arrival, effectiveArrival, leave, leaveLabel: formatTime(leave) };
}

function setActivePreset(value) {
  presetButtons.forEach((button) => {
    button.classList.toggle("is-active", button.dataset.time === value);
  });
}

function renderCalculator() {
  const name = getSelectedName() || "This";
  answer.classList.remove("is-warning", "is-error");

  const schedule = calculateLeave(arrivalInput.value);
  if (!schedule) {
    leaveTime.textContent = "--:--";
    statusMessage.textContent = "Enter a valid time.";
    answer.classList.add("is-error");
    setActiveCountdown(null);
    setActivePreset("");
    return;
  }

  leaveTime.textContent = schedule.leaveLabel;
  activeLeaveLabel = schedule.leaveLabel;
  activePersonName = getSelectedName();
  setActiveCountdown(schedule.leave);
  setActivePreset(arrivalInput.value);

  if (schedule.arrival < CHECK_IN_START) {
    answer.classList.add("is-warning");
    statusMessage.textContent = "Before the window, so 08:30 is used.";
  } else if (schedule.arrival > CHECK_IN_END) {
    answer.classList.add("is-warning");
    statusMessage.textContent = "After the window, so 09:30 is used.";
  } else {
    statusMessage.textContent = `${name} comes in at ${formatTime(schedule.arrival)}.`;
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[char]
  ));
}

function setBoardStatus(message, isError = false) {
  boardStatus.textContent = message;
  boardStatus.classList.toggle("is-error", isError);
}

function renderPersonOptions(preferredName = "") {
  const selectedName = preferredName || getSelectedName() || localStorage.getItem(SAVED_NAME_KEY) || "";
  const selectedPerson = findPerson(selectedName);

  personSelect.innerHTML = "";
  people.forEach((person) => {
    const option = document.createElement("option");
    option.value = person.name;
    option.textContent = person.hasToday ? person.name : `${person.name} (not today)`;
    personSelect.append(option);
  });

  const addOption = document.createElement("option");
  addOption.value = NEW_PERSON_VALUE;
  addOption.textContent = "+ Add new person";
  personSelect.append(addOption);

  if (selectedPerson) {
    personSelect.value = selectedPerson.name;
  } else if (!selectedName && people.length) {
    personSelect.value = people[0].name;
  } else {
    personSelect.value = NEW_PERSON_VALUE;
    if (selectedName && selectedName !== NEW_PERSON_VALUE) nameInput.value = selectedName;
  }
}

function updatePersonMode(loadRecord = true) {
  const isNew = personSelect.value === NEW_PERSON_VALUE;
  newPersonFields.hidden = !isNew;
  nameInput.disabled = !isNew;
  nameInput.required = isNew;

  if (loadRecord) {
    const selectedPerson = findPerson(personSelect.value);
    if (selectedPerson?.hasToday) {
      arrivalInput.value = selectedPerson.arrival || "09:00";
    } else if (selectedPerson?.lastRecord) {
      arrivalInput.value = selectedPerson.lastRecord.arrival || "09:00";
    }
  }

  renderCalculator();
}

function renderPeople(nextPeople, preferredName = "") {
  people = nextPeople;
  renderPersonOptions(preferredName);
  updatePersonMode(Boolean(nextPeople.length || preferredName));
  peopleList.innerHTML = "";

  if (!people.length) {
    setBoardStatus("No one has added their time yet.");
    return;
  }

  people.forEach((person) => {
    const item = document.createElement("li");
    item.className = `person-card${person.hasToday ? "" : " is-stale"}`;

    const sub = person.hasToday
      ? `Come in ${escapeHtml(person.arrival)}`
      : person.lastRecord
        ? `Last ${escapeHtml(person.lastRecord.date)}: ${escapeHtml(person.lastRecord.leave)}`
        : "Not updated today";

    item.innerHTML = `
      <button class="person-main" type="button" data-action="select" data-name="${escapeHtml(person.name)}">
        <span class="person-title">
          <span class="person-icon" aria-hidden="true"></span>
          <span>
            <span class="person-name">${escapeHtml(person.name)}</span>
            <span class="person-sub">${sub}</span>
          </span>
        </span>
        <span class="leave-pill${person.hasToday ? "" : " is-muted"}">${escapeHtml(person.hasToday ? person.leave : "No update")}</span>
      </button>
      <button class="delete-person" type="button" data-action="delete" data-name="${escapeHtml(person.name)}" aria-label="Remove ${escapeHtml(person.name)}" title="Remove">&times;</button>
    `;
    peopleList.append(item);
  });

  const updatedCount = people.filter((person) => person.hasToday).length;
  const waitingCount = people.length - updatedCount;
  setBoardStatus(`${updatedCount} updated today. ${waitingCount} waiting.`);
}

async function loadPeople() {
  setBoardStatus("Loading board...");
  try {
    const response = await fetch("/api/people", { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Could not load board.");

    today = payload.today || "";
    todayDate.textContent = today ? `Today ${today}` : "Today";
    renderPeople(payload.people || []);
  } catch (error) {
    setBoardStatus(error.message || "Could not load board.", true);
  }
}

async function savePerson() {
  const name = getSelectedName();
  const arrival = arrivalInput.value;

  if (!name) {
    nameInput.focus();
    setBoardStatus("Name is required.", true);
    return;
  }
  if (parseTime(arrival) === null) {
    arrivalInput.focus();
    setBoardStatus("Come in time must use HH:MM.", true);
    return;
  }

  saveButton.disabled = true;
  saveButton.textContent = "Saving...";
  try {
    const response = await fetch("/api/people", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, arrival }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Could not save time.");

    today = payload.today || today;
    todayDate.textContent = today ? `Today ${today}` : "Today";
    localStorage.setItem(SAVED_NAME_KEY, name);
    renderPeople(payload.people || [], name);
  } catch (error) {
    setBoardStatus(error.message || "Could not save time.", true);
  } finally {
    saveButton.disabled = false;
    saveButton.textContent = "Save today";
  }
}

function hideUndo() {
  clearTimeout(undoTimer);
  undoTimer = null;
  pendingUndo = null;
  undoBar.hidden = true;
}

function showUndo(name, wasSavedName) {
  clearTimeout(undoTimer);
  pendingUndo = { name, wasSavedName };
  undoText.textContent = `Đã xóa ${name}.`;
  undoButton.disabled = false;
  undoBar.hidden = false;
  undoTimer = setTimeout(hideUndo, UNDO_MS);
}

async function removePerson(name) {
  if (!window.confirm(`Xóa ${name} và toàn bộ lịch sử giờ vào khỏi bảng?`)) return;

  setBoardStatus("Updating board...");
  try {
    const response = await fetch(`/api/people/${encodeURIComponent(name)}`, { method: "DELETE" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Could not remove person.");
    const wasSavedName = keyForName(localStorage.getItem(SAVED_NAME_KEY)) === keyForName(name);
    if (wasSavedName) localStorage.removeItem(SAVED_NAME_KEY);
    renderPeople(payload.people || []);
    if (payload.deleted) showUndo(payload.deleted.name, wasSavedName);
  } catch (error) {
    setBoardStatus(error.message || "Could not remove person.", true);
  }
}

async function undoRemove() {
  if (!pendingUndo) return;
  const { name, wasSavedName } = pendingUndo;
  clearTimeout(undoTimer);
  undoButton.disabled = true;
  try {
    const response = await fetch(`/api/people/${encodeURIComponent(name)}/restore`, { method: "POST" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Could not restore person.");
    if (wasSavedName) localStorage.setItem(SAVED_NAME_KEY, name);
    hideUndo();
    renderPeople(payload.people || [], wasSavedName ? name : "");
    setBoardStatus(`Đã khôi phục ${name}.`);
  } catch (error) {
    hideUndo();
    setBoardStatus(error.message || "Could not restore person.", true);
  }
}

function useCurrentTime() {
  const now = new Date();
  arrivalInput.value = formatTime(now.getHours() * 60 + now.getMinutes());
  renderCalculator();
}

presetButtons.forEach((button) => {
  button.addEventListener("click", () => {
    arrivalInput.value = button.dataset.time;
    renderCalculator();
  });
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  savePerson();
});

personSelect.addEventListener("change", () => updatePersonMode(true));

peopleList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-action][data-name]");
  if (!button) return;

  if (button.dataset.action === "select") {
    personSelect.value = button.dataset.name;
    updatePersonMode(true);
    form.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }

  if (button.dataset.action === "delete") {
    removePerson(button.dataset.name);
  }
});

nameInput.addEventListener("input", renderCalculator);
arrivalInput.addEventListener("input", renderCalculator);
nowButton.addEventListener("click", useCurrentTime);
refreshButton.addEventListener("click", loadPeople);
undoButton.addEventListener("click", undoRemove);
if (notifyToggle) notifyToggle.addEventListener("click", toggleNotifications);

if (notificationsEnabled && Notification.permission !== "granted") {
  notificationsEnabled = false;
  localStorage.removeItem(NOTIFY_KEY);
}
refreshNotifyUI();

if (NOTIFICATIONS_SUPPORTED && "serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

// Timers are throttled in background tabs; refresh as soon as the tab is
// visible again so the title and any due notification do not lag.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) updateCountdown();
});

nameInput.value = localStorage.getItem(SAVED_NAME_KEY) || "";
renderPersonOptions(nameInput.value);
updatePersonMode(false);
renderCalculator();
loadPeople();
setInterval(updateCountdown, 1000);
