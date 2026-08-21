const PROVIDER_LABELS = Object.freeze({
  steelseries: "SteelSeries GG",
  windows: "Windows Bluetooth",
  "windows-gamepad": "Windows Gamepad",
  xinput: "XInput",
  logitech: "Logitech G Hub",
  hid: "HID",
});

const TOUCH_REORDER_HOLD_MS = 500;
const TOUCH_REORDER_MOVE_PX = 8;

/**
 * Creates the single ordered list shown by the Property Inspector.
 * Configured devices remain visible even while absent from discovery.
 */
export function buildDeviceRows(discoveredDevices, selectedDevices, runtimePayload = {}) {
  const selected = uniqueDevices(selectedDevices);
  const selectedKeys = new Set(selected.map((device) => device.key));
  const discovered = uniqueDevices(discoveredDevices, selectedKeys);
  const discoveredByKey = new Map(discovered.map((device) => [device.key, device]));
  const selectedPhysicalIds = new Set(
    selected.flatMap((device) =>
      device.physicalId ? [device.physicalId] : []
    )
  );
  const runtime = normalizeRuntimePayload(runtimePayload);
  const runtimeFields = (device) => ({
    current: runtime.currentDeviceKey === device.key,
    runtimeStatus: runtime.statuses.get(device.key) ?? null,
  });
  const matchedSelectedKeys = new Set();

  const rows = selected.map((savedDevice, index) => {
    const discoveredDevice = discoveredByKey.get(savedDevice.key);
    const matched =
      discoveredDevice &&
      matchesSavedDeviceMetadata(savedDevice, discoveredDevice);
    if (matched) matchedSelectedKeys.add(savedDevice.key);
    const device = matched ? discoveredDevice : savedDevice;
    return {
      device,
      included: true,
      initial: index === 0,
      available: Boolean(matched),
      order: index,
      ...runtimeFields(device),
    };
  });

  for (const device of discovered) {
    if (matchedSelectedKeys.has(device.key)) continue;
    if (device.physicalId && selectedPhysicalIds.has(device.physicalId)) continue;
    rows.push({
      device,
      included: false,
      initial: false,
      available: true,
      order: null,
      ...runtimeFields(device),
    });
  }

  return rows;
}

export function selectedDevicesFromSettings(settings, discoveredDevices = []) {
  if (!isRecord(settings)) return [];
  const hasOrderedList = Array.isArray(settings.selectedDevices);
  const selected = hasOrderedList
    ? uniqueDevices(settings.selectedDevices)
    : legacySelectedDevice(settings);
  if (selected.length === 0) return [];

  const discoveredByKey = new Map(
    uniqueDevices(discoveredDevices).map((device) => [device.key, device])
  );
  return selected.map((saved) => {
    const current = discoveredByKey.get(saved.key);
    if (!current) return saved;
    if (
      saved.provider === "steelseries" &&
      !matchesSavedDeviceMetadata(saved, current)
    ) {
      return saved;
    }
    return current;
  });
}

function matchesSavedDeviceMetadata(saved, discovered) {
  if (saved.provider !== "steelseries") return true;
  return (
    saved.name === discovered.name &&
    (saved.deviceType === discovered.deviceType || saved.deviceType === "Device")
  );
}

export function setDeviceIncluded(selectedDevices, candidate, included) {
  const selected = uniqueDevices(selectedDevices);
  const device = normalizeDevice(candidate);
  if (!device) return selected;

  const physicalMatch = device.physicalId
    ? selected.find((entry) => entry.physicalId === device.physicalId)
    : null;
  if (included && physicalMatch && physicalMatch.key !== device.key) {
    return selected;
  }

  const withoutCandidate = selected.filter((entry) => entry.key !== device.key);
  return included ? [...withoutCandidate, device] : withoutCandidate;
}

export function reorderSelectedDevice(selectedDevices, key, targetIndex) {
  const selected = uniqueDevices(selectedDevices);
  const currentIndex = selected.findIndex((device) => device.key === key);
  if (
    currentIndex < 0 ||
    !Number.isInteger(targetIndex) ||
    targetIndex < 0 ||
    targetIndex >= selected.length
  ) {
    return selected;
  }

  const reordered = [...selected];
  const [device] = reordered.splice(currentIndex, 1);
  reordered.splice(targetIndex, 0, device);
  return reordered;
}

// Directional movement remains only as the keyboard adapter.
export function moveSelectedDevice(selectedDevices, key, direction) {
  const selected = uniqueDevices(selectedDevices);
  const currentIndex = selected.findIndex((device) => device.key === key);
  if (currentIndex < 0 || (direction !== "up" && direction !== "down")) {
    return selected;
  }
  const offset = direction === "up" ? -1 : 1;
  return reorderSelectedDevice(selected, key, currentIndex + offset);
}

export function mergeSettings(current, patch) {
  return { ...(isRecord(current) ? current : {}), ...(isRecord(patch) ? patch : {}) };
}

export function displaySettingsPatch(id, value, checked) {
  if (id === "pollInterval" || id === "deviceTypeFontSize") {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? { [id]: parsed } : {};
  }
  if (
    id === "showPercentage" ||
    id === "showDeviceType" ||
    id === "showDeviceName" ||
    id === "showStatusText"
  ) {
    return { [id]: checked };
  }
  if (id === "backgroundColor") return { backgroundColor: value };
  return {};
}

export function buildSetSettingsMessage({ action, context, settings }) {
  return {
    event: "setSettings",
    action,
    context,
    payload: settings,
  };
}

export function buildPluginMessage({ action, context, payload }) {
  return {
    event: "sendToPlugin",
    action,
    context,
    payload,
  };
}

export function createInspectorController({ send, view }) {
  let action = "";
  let context = "";
  let settings = {};
  let discoveredDevices = [];
  let runtimePayload = {};
  let recoveryMessage = "";
  let announcementMessage = "";

  const selectedDevices = () =>
    selectedDevicesFromSettings(settings, discoveredDevices);

  const render = () => {
    view.renderRows(
      buildDeviceRows(discoveredDevices, selectedDevices(), runtimePayload),
      settings
    );
  };

  const sendPluginEvent = (event) => {
    send(buildPluginMessage({ action, context, payload: { event } }));
  };

  const persist = (patch) => {
    settings = mergeSettings(settings, patch);
    view.applySettings(settings);
    render();
    send(buildSetSettingsMessage({ action, context, settings }));
  };

  const announce = (text) => {
    announcementMessage = text;
    view.announce?.(text);
  };

  const dismissRecoveryMessage = () => {
    if (!recoveryMessage) return;
    recoveryMessage = "";
    view.showRecovery?.("");
  };

  const dismissAnnouncement = () => {
    if (!announcementMessage) return;
    announcementMessage = "";
    view.announce?.("");
  };

  const dismissTransientMessages = () => {
    dismissRecoveryMessage();
    dismissAnnouncement();
  };

  const reorder = (key, targetIndex) => {
    dismissTransientMessages();
    const selected = selectedDevices();
    const reordered = reorderSelectedDevice(selected, key, targetIndex);
    const device = selected.find((entry) => entry.key === key);
    if (!device || reordered.every((entry, index) => entry.key === selected[index]?.key)) {
      return;
    }
    persist({ schemaVersion: 2, selectedDevices: reordered });
    announce(
      `Moved ${device.name} to position ${targetIndex + 1} of ${reordered.length}`
    );
  };

  return {
    open(connection) {
      dismissTransientMessages();
      action = connection.action;
      context = connection.context;
      settings = mergeSettings({}, connection.settings);
      discoveredDevices = [];
      runtimePayload = {};
      view.applySettings(settings);
      render();
      view.showStatus(describeDiscoveryState({ state: "loading" }));
      sendPluginEvent("getDevices");
    },

    receiveSettings(nextSettings) {
      dismissTransientMessages();
      settings = mergeSettings({}, nextSettings);
      view.applySettings(settings);
      render();
    },

    receiveDeviceList(payload) {
      view.showStatus(describeDiscoveryState(payload));
      const recovered = Array.isArray(payload?.notices)
        ? payload.notices.find(
            (notice) =>
              isRecord(notice) &&
              Object.hasOwn(PROVIDER_LABELS, notice.provider) &&
              notice.kind === "recovered" &&
              typeof notice.message === "string" &&
              notice.message.trim()
          )
        : null;
      if (recovered) {
        recoveryMessage = recovered.message.trim();
        view.showRecovery?.(recoveryMessage);
      }
      if (Array.isArray(payload?.devices)) {
        discoveredDevices = payload.devices;
        render();
      }
    },

    receiveRuntimeStatus(payload) {
      runtimePayload = payload;
      render();
    },

    include(device, included) {
      dismissTransientMessages();
      persist({
        schemaVersion: 2,
        selectedDevices: setDeviceIncluded(
          selectedDevices(),
          device,
          included
        ),
      });
    },

    move(key, direction) {
      const selected = selectedDevices();
      const currentIndex = selected.findIndex((device) => device.key === key);
      if (currentIndex < 0 || (direction !== "up" && direction !== "down")) return;
      reorder(key, currentIndex + (direction === "up" ? -1 : 1));
    },

    reorder(key, targetIndex) {
      reorder(key, targetIndex);
    },

    changeSettings(patch) {
      dismissTransientMessages();
      persist(patch);
    },

    refresh() {
      dismissTransientMessages();
      view.showStatus(describeDiscoveryState({ state: "loading" }));
      sendPluginEvent("refreshDevices");
    },
  };
}

function legacySelectedDevice(settings) {
  const rawName =
    typeof settings.deviceName === "string" && settings.deviceName.trim()
      ? settings.deviceName.trim()
      : "Configured device";

  if (
    settings.deviceBrand === "steelseries" &&
    typeof settings.deviceId === "number" &&
    Number.isSafeInteger(settings.deviceId) &&
    settings.deviceId >= 0
  ) {
    return [normalizeDevice({
      provider: "steelseries",
      nativeId: String(settings.deviceId),
      name: stripLegacyPrefix(rawName, "steelseries"),
      deviceType: "Device",
    })].filter(Boolean);
  }
  if (
    settings.deviceBrand === "logitech" &&
    typeof settings.logiDeviceId === "string" &&
    settings.logiDeviceId.trim()
  ) {
    return [normalizeDevice({
      provider: "logitech",
      nativeId: `session:${settings.logiDeviceId.trim()}`,
      name: stripLegacyPrefix(rawName, "logitech"),
      deviceType: "Device",
    })].filter(Boolean);
  }
  if (
    settings.deviceBrand === "xbox" &&
    typeof settings.xboxIndex === "number" &&
    Number.isInteger(settings.xboxIndex) &&
    settings.xboxIndex >= 0 &&
    settings.xboxIndex <= 3
  ) {
    return [normalizeDevice({
      provider: "xinput",
      nativeId: `slot:${settings.xboxIndex}`,
      name: stripLegacyPrefix(rawName, "xinput"),
      deviceType: "Controller",
    })].filter(Boolean);
  }
  return [];
}

function stripLegacyPrefix(name, provider) {
  const pattern =
    provider === "steelseries"
      ? /^\[SS\]\s*/
      : provider === "logitech"
        ? /^\[Logi\]\s*/
        : provider === "xinput"
          ? /^\[Xbox\]\s*/
          : null;
  return pattern ? name.replace(pattern, "") || "Configured device" : name;
}

export function describeDiscoveryState(payload) {
  const state = isRecord(payload) ? payload.state : "error";
  if (state === "loading") {
    return { tone: "loading", text: "Loading devices…" };
  }
  if (state === "success") {
    const count = Array.isArray(payload.devices) ? payload.devices.length : 0;
    return {
      tone: "success",
      text:
        typeof payload.message === "string" && payload.message.trim()
          ? payload.message.trim()
          : `${count} device${count === 1 ? "" : "s"} found`,
    };
  }
  if (state === "empty") {
    return {
      tone: "empty",
      text: "No battery devices found. Refresh after connecting a device.",
    };
  }
  if (state === "partial") {
    const count = Array.isArray(payload.devices) ? payload.devices.length : 0;
    return {
      tone: "partial",
      text:
        typeof payload.message === "string" && payload.message.trim()
          ? payload.message.trim()
          : `${count} device${count === 1 ? "" : "s"} found; some providers failed`,
    };
  }
  return {
    tone: "error",
    text:
      typeof payload?.message === "string" && payload.message.trim()
        ? payload.message.trim()
        : "Device discovery failed. Try refreshing.",
  };
}

/**
 * Renders rows using textContent only so provider data never becomes markup.
 */
export function renderDeviceList(container, rows, handlers) {
  const document = container.ownerDocument;
  const selectedCount = rows.filter((row) => row.included).length;
  let draggedKey = null;
  const items = rows.map((row, index) => {
    const item = document.createElement("li");
    item.className = `device-row${row.available ? "" : " device-row-missing"}${
      row.included ? " device-row-selected" : ""
    }${row.current ? " device-row-current" : ""}`;

    const line = document.createElement("div");
    line.className = "device-line";

    const identity = document.createElement(row.included ? "div" : "label");
    identity.className = "device-identity";

    const name = document.createElement("span");
    name.className = "device-name";
    name.textContent = row.device.name;

    const metadata = document.createElement("span");
    metadata.className = "device-metadata";

    const provider = document.createElement("span");
    provider.className = "provider-label";
    provider.textContent = row.device.providerLabel;
    metadata.append(provider);

    if (row.current) {
      const current = document.createElement("span");
      current.className = "current-label";
      current.textContent = "Current";
      metadata.append(current);
    }

    if (row.runtimeStatus) {
      const connection = document.createElement("span");
      connection.className = `connection-label connection-${row.runtimeStatus.state}`;
      connection.textContent = connectionLabel(row.runtimeStatus.state);
      metadata.append(connection);

      if (row.runtimeStatus.batteryText !== connection.textContent) {
        const battery = document.createElement("span");
        battery.className = "battery-value";
        battery.textContent = row.runtimeStatus.batteryText;
        metadata.append(battery);
      }
    } else if (!row.available) {
      const unavailable = document.createElement("span");
      unavailable.className = "availability-label";
      unavailable.textContent = "Unavailable";
      metadata.append(unavailable);
    }

    if (row.included) {
      const summary = document.createElement("div");
      summary.className = "device-summary";
      summary.append(name, metadata);

      const remove = document.createElement("button");
      remove.className = "remove-device";
      remove.type = "button";
      remove.textContent = "Remove";
      remove.setAttribute(
        "aria-label",
        `Remove ${row.device.name} from cycle`
      );
      remove.addEventListener("click", () => {
        handlers.onIncluded(row.device, false);
      });
      identity.append(summary, remove);

      const position = document.createElement("span");
      position.className = "cycle-position";
      position.textContent = String((row.order ?? 0) + 1);
      position.setAttribute(
        "aria-label",
        `Cycle position ${(row.order ?? 0) + 1} of ${selectedCount}`
      );

      const grip = document.createElement("span");
      grip.className = "drag-grip";
      grip.textContent = "↕";
      grip.setAttribute("draggable", "true");
      grip.setAttribute("aria-label", `Drag ${row.device.name} to reorder`);
      grip.setAttribute("aria-grabbed", "false");
      grip.addEventListener("dragstart", () => {
        draggedKey = row.device.key;
        grip.setAttribute("aria-grabbed", "true");
      });
      grip.addEventListener("dragend", () => {
        draggedKey = null;
        grip.setAttribute("aria-grabbed", "false");
      });

      const targetIndex = row.order ?? 0;
      let pointerState = null;
      let pointerTimer = null;
      const resetPointer = () => {
        if (pointerTimer !== null) clearTimeout(pointerTimer);
        pointerTimer = null;
        if (pointerState && grip.hasPointerCapture?.(pointerState.id)) {
          grip.releasePointerCapture(pointerState.id);
        }
        pointerState = null;
        grip.setAttribute("aria-grabbed", "false");
      };
      grip.addEventListener("pointerdown", (event) => {
        if (
          (event.pointerType !== "touch" && event.pointerType !== "pen") ||
          event.isPrimary === false
        ) {
          return;
        }
        resetPointer();
        pointerState = {
          id: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          active: false,
          scrolling: false,
          moved: false,
          lastY: event.clientY,
          targetIndex,
        };
        grip.setPointerCapture?.(event.pointerId);
        pointerTimer = setTimeout(() => {
          if (!pointerState || pointerState.id !== event.pointerId) return;
          pointerTimer = null;
          pointerState.active = true;
          grip.setAttribute("aria-grabbed", "true");
        }, TOUCH_REORDER_HOLD_MS);
      });
      grip.addEventListener("pointermove", (event) => {
        if (!pointerState || pointerState.id !== event.pointerId) return;
        const movement = Math.hypot(
          event.clientX - pointerState.startX,
          event.clientY - pointerState.startY
        );
        if (!pointerState.active) {
          if (!pointerState.scrolling && movement >= TOUCH_REORDER_MOVE_PX) {
            if (pointerTimer !== null) clearTimeout(pointerTimer);
            pointerTimer = null;
            pointerState.scrolling = true;
          }
          if (pointerState.scrolling) {
            event.preventDefault();
            document.defaultView?.scrollBy(0, pointerState.lastY - event.clientY);
            pointerState.lastY = event.clientY;
          }
          return;
        }
        if (movement < TOUCH_REORDER_MOVE_PX) return;
        event.preventDefault();
        pointerState.moved = true;
        const pointedRow = document
          .elementFromPoint?.(event.clientX, event.clientY)
          ?.closest?.(".device-row-selected");
        if (!pointedRow) return;
        const pointedIndex = [...container.children]
          .filter((child) => child.matches?.(".device-row-selected"))
          .indexOf(pointedRow);
        if (pointedIndex >= 0) pointerState.targetIndex = pointedIndex;
      });
      grip.addEventListener("pointerup", (event) => {
        if (!pointerState || pointerState.id !== event.pointerId) return;
        const completed = pointerState;
        if (completed.active) event.preventDefault();
        resetPointer();
        if (completed.active && completed.moved) {
          handlers.onReorder(row.device.key, completed.targetIndex);
        }
      });
      grip.addEventListener("pointercancel", resetPointer);
      item.setAttribute("tabindex", "0");
      item.setAttribute(
        "aria-label",
        `${row.device.name}, position ${targetIndex + 1} of ${selectedCount}. Use Alt+Arrow keys to reorder.`
      );
      item.addEventListener("dragover", (event) => {
        if (draggedKey) event.preventDefault();
      });
      item.addEventListener("drop", () => {
        if (!draggedKey) return;
        handlers.onReorder(draggedKey, targetIndex);
        draggedKey = null;
        grip.setAttribute("aria-grabbed", "false");
      });
      item.addEventListener("keydown", (event) => {
        if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) {
          return;
        }
        const nextIndex = targetIndex + (event.key === "ArrowUp" ? -1 : 1);
        if (nextIndex < 0 || nextIndex >= selectedCount) return;
        event.preventDefault();
        handlers.onReorder(row.device.key, nextIndex);
        const movedRow = [...container.children]
          .filter((candidate) => candidate.matches?.(".device-row-selected"))
          [nextIndex];
        movedRow?.focus?.();
      });
      line.append(position, identity, grip);
      item.append(line);
    } else {
      identity.append(name, metadata);
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.id = `include-device-${index}`;
      checkbox.checked = false;
      checkbox.setAttribute("aria-label", `Include ${row.device.name} in cycle`);
      checkbox.addEventListener("change", () => {
        handlers.onIncluded(row.device, checkbox.checked);
      });
      identity.setAttribute("for", checkbox.id);
      line.append(checkbox, identity);
      item.append(line);
    }

    return item;
  });

  container.replaceChildren(...items);
}

export function renderInspectorStatus(statusElement, refreshElement, status) {
  statusElement.className = `status-bar status-${status.tone}`;
  statusElement.textContent = status.text;
  const loading = status.tone === "loading";
  refreshElement.disabled = loading;
  refreshElement.setAttribute("aria-busy", String(loading));
}

export function renderInspectorAnnouncement(element, text) {
  element.textContent = text;
}

export function renderInspectorRecovery(element, text) {
  element.textContent = text;
  element.hidden = !text;
}

export function routeInspectorMessage(controller, message) {
  if (!isRecord(message)) return false;
  if (message.event === "sendToPropertyInspector" && isRecord(message.payload)) {
    if (message.payload.event === "deviceList") {
      controller.receiveDeviceList(message.payload);
      return true;
    }
    if (message.payload.event === "deviceRuntimeStatus") {
      controller.receiveRuntimeStatus(message.payload);
      return true;
    }
  }
  if (message.event === "didReceiveSettings") {
    controller.receiveSettings(
      isRecord(message.payload?.settings) ? message.payload.settings : {}
    );
    return true;
  }
  return false;
}

export function normalizeDevice(value) {
  if (!isRecord(value) || !Object.hasOwn(PROVIDER_LABELS, value.provider)) {
    return null;
  }
  if (typeof value.nativeId !== "string" || !value.nativeId.trim()) return null;

  const provider = value.provider;
  const nativeId = value.nativeId.trim();
  return {
    key: `${provider}:${encodeURIComponent(nativeId)}`,
    provider,
    providerLabel: PROVIDER_LABELS[provider],
    nativeId,
    name:
      typeof value.name === "string" && value.name.trim()
        ? value.name.trim()
        : "Unknown device",
    deviceType:
      typeof value.deviceType === "string" && value.deviceType.trim()
        ? value.deviceType.trim()
        : "Device",
    ...(typeof value.physicalId === "string" && value.physicalId.trim()
      ? { physicalId: value.physicalId.trim() }
      : {}),
  };
}

function uniqueDevices(values, preferredKeys = new Set()) {
  if (!Array.isArray(values)) return [];
  const devices = [];
  const seenKeys = new Set();
  const physicalIndexes = new Map();
  for (const value of values) {
    const device = normalizeDevice(value);
    if (!device || seenKeys.has(device.key)) continue;
    seenKeys.add(device.key);
    if (device.physicalId) {
      const existingIndex = physicalIndexes.get(device.physicalId);
      if (existingIndex !== undefined) {
        const existing = devices[existingIndex];
        if (
          preferredKeys.has(device.key) &&
          !preferredKeys.has(existing.key)
        ) {
          devices[existingIndex] = device;
        }
        continue;
      }
      physicalIndexes.set(device.physicalId, devices.length);
    }
    devices.push(device);
  }
  return devices;
}

function normalizeRuntimePayload(payload) {
  const statuses = new Map();
  if (Array.isArray(payload?.statuses)) {
    for (const value of payload.statuses) {
      if (
        !isRecord(value) ||
        typeof value.deviceKey !== "string" ||
        !value.deviceKey ||
        !["connected", "disconnected", "unavailable"].includes(value.state) ||
        typeof value.batteryText !== "string"
      ) {
        continue;
      }
      statuses.set(value.deviceKey, {
        state: value.state,
        batteryText: value.batteryText,
      });
    }
  }
  return {
    currentDeviceKey:
      typeof payload?.currentDeviceKey === "string"
        ? payload.currentDeviceKey
        : null,
    statuses,
  };
}

function connectionLabel(state) {
  if (state === "connected") return "Connected";
  if (state === "disconnected") return "Disconnected";
  return "Unavailable";
}

function isRecord(value) {
  return typeof value === "object" && value !== null;
}

function installPropertyInspector(window, document) {
  const elements = {
    status: document.getElementById("status"),
    recovery: document.getElementById("recoveryNotice"),
    announcement: document.getElementById("reorderAnnouncement"),
    refresh: document.getElementById("refreshBtn"),
    list: document.getElementById("deviceList"),
    empty: document.getElementById("deviceEmpty"),
    backgroundColor: document.getElementById("backgroundColor"),
    backgroundColorLabel: document.getElementById("bgColorLabel"),
  };
  let websocket = null;
  let controller;

  const view = {
    applySettings(settings) {
      setControlValue(document, "pollInterval", settings.pollInterval ?? 30);
      setControlChecked(document, "showPercentage", settings.showPercentage !== false);
      setControlChecked(document, "showDeviceType", settings.showDeviceType === true);
      setControlChecked(document, "showDeviceName", settings.showDeviceName === true);
      setControlChecked(document, "showStatusText", settings.showStatusText === true);
      setControlValue(document, "deviceTypeFontSize", settings.deviceTypeFontSize ?? 13);
      const backgroundColor =
        typeof settings.backgroundColor === "string"
          ? settings.backgroundColor
          : "#0d1117";
      setControlValue(document, "backgroundColor", backgroundColor);
      elements.backgroundColorLabel.textContent = backgroundColor;
    },

    renderRows(rows) {
      renderDeviceList(elements.list, rows, {
        onIncluded(device, included) {
          controller.include(device, included);
        },
        onReorder(key, targetIndex) {
          controller.reorder(key, targetIndex);
        },
      });
      elements.empty.hidden = rows.length !== 0;
    },

    showStatus(status) {
      renderInspectorStatus(elements.status, elements.refresh, status);
    },

    showRecovery(text) {
      renderInspectorRecovery(elements.recovery, text);
    },

    announce(text) {
      renderInspectorAnnouncement(elements.announcement, text);
    },
  };

  controller = createInspectorController({
    view,
    send(message) {
      if (websocket?.readyState === 1) websocket.send(JSON.stringify(message));
    },
  });

  for (const id of [
    "pollInterval",
    "showPercentage",
    "showDeviceType",
    "showDeviceName",
    "showStatusText",
    "backgroundColor",
  ]) {
    const control = document.getElementById(id);
    control.addEventListener("change", () => {
      controller.changeSettings(
        displaySettingsPatch(id, control.value, control.checked)
      );
    });
  }

  const fontSize = document.getElementById("deviceTypeFontSize");
  fontSize.addEventListener("input", () => {
    controller.changeSettings(
      displaySettingsPatch(fontSize.id, fontSize.value, fontSize.checked)
    );
  });
  elements.backgroundColor.addEventListener("input", () => {
    elements.backgroundColorLabel.textContent = elements.backgroundColor.value;
  });
  elements.refresh.addEventListener("click", () => controller.refresh());

  window.connectElgatoStreamDeckSocket = function (
    inPort,
    inPropertyInspectorUUID,
    inRegisterEvent,
    _inInfo,
    inActionInfo
  ) {
    const actionInfo = parseJson(inActionInfo, {});
    websocket = new window.WebSocket(`ws://127.0.0.1:${inPort}`);

    websocket.addEventListener("open", () => {
      websocket.send(
        JSON.stringify({
          event: inRegisterEvent,
          uuid: inPropertyInspectorUUID,
        })
      );
      controller.open({
        action: typeof actionInfo.action === "string" ? actionInfo.action : "",
        context: inPropertyInspectorUUID,
        settings: isRecord(actionInfo.payload?.settings)
          ? actionInfo.payload.settings
          : {},
      });
    });

    websocket.addEventListener("message", (event) => {
      const message = parseJson(event.data, null);
      routeInspectorMessage(controller, message);
    });

    websocket.addEventListener("close", () => {
      view.showStatus({
        tone: "error",
        text: "Stream Deck connection closed. Reopen settings to retry.",
      });
    });
    websocket.addEventListener("error", () => {
      view.showStatus({
        tone: "error",
        text: "Could not connect to Stream Deck.",
      });
    });
  };
}

function setControlValue(document, id, value) {
  document.getElementById(id).value = String(value);
}

function setControlChecked(document, id, checked) {
  document.getElementById(id).checked = checked;
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  installPropertyInspector(window, document);
}
