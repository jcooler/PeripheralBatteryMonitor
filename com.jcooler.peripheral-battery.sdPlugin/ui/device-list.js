const PROVIDER_LABELS = Object.freeze({
  steelseries: "SteelSeries GG",
  windows: "Windows Bluetooth",
  xinput: "XInput",
  logitech: "Logitech G Hub",
  hid: "HID",
});

/**
 * Creates the single ordered list shown by the Property Inspector.
 * Configured devices remain visible even while absent from discovery.
 */
export function buildDeviceRows(discoveredDevices, selectedDevices) {
  const selected = uniqueDevices(selectedDevices);
  const selectedKeys = new Set(selected.map((device) => device.key));
  const discovered = uniqueDevices(discoveredDevices, selectedKeys);
  const discoveredByKey = new Map(discovered.map((device) => [device.key, device]));
  const selectedPhysicalIds = new Set(
    selected.flatMap((device) =>
      device.physicalId ? [device.physicalId] : []
    )
  );

  const rows = selected.map((savedDevice, index) => ({
    device: discoveredByKey.get(savedDevice.key) ?? savedDevice,
    included: true,
    initial: index === 0,
    available: discoveredByKey.has(savedDevice.key),
    order: index,
  }));

  for (const device of discovered) {
    if (selectedKeys.has(device.key)) continue;
    if (device.physicalId && selectedPhysicalIds.has(device.physicalId)) continue;
    rows.push({
      device,
      included: false,
      initial: false,
      available: true,
      order: null,
    });
  }

  return rows;
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

export function moveSelectedDevice(selectedDevices, key, direction) {
  const selected = uniqueDevices(selectedDevices);
  const currentIndex = selected.findIndex((device) => device.key === key);
  if (currentIndex < 0) return selected;

  const offset = direction === "up" ? -1 : direction === "down" ? 1 : 0;
  const nextIndex = currentIndex + offset;
  if (nextIndex < 0 || nextIndex >= selected.length) return selected;

  const reordered = [...selected];
  [reordered[currentIndex], reordered[nextIndex]] = [
    reordered[nextIndex],
    reordered[currentIndex],
  ];
  return reordered;
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

  const render = () => {
    view.renderRows(
      buildDeviceRows(discoveredDevices, settings.selectedDevices),
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

  return {
    open(connection) {
      action = connection.action;
      context = connection.context;
      settings = mergeSettings({}, connection.settings);
      view.applySettings(settings);
      render();
      view.showStatus(describeDiscoveryState({ state: "loading" }));
      sendPluginEvent("getDevices");
    },

    receiveSettings(nextSettings) {
      settings = mergeSettings({}, nextSettings);
      view.applySettings(settings);
      render();
    },

    receiveDeviceList(payload) {
      view.showStatus(describeDiscoveryState(payload));
      if (Array.isArray(payload?.devices)) {
        discoveredDevices = payload.devices;
        render();
      }
    },

    include(device, included) {
      persist({
        schemaVersion: 2,
        selectedDevices: setDeviceIncluded(
          settings.selectedDevices,
          device,
          included
        ),
      });
    },

    move(key, direction) {
      persist({
        schemaVersion: 2,
        selectedDevices: moveSelectedDevice(
          settings.selectedDevices,
          key,
          direction
        ),
      });
    },

    changeSettings(patch) {
      persist(patch);
    },

    refresh() {
      view.showStatus(describeDiscoveryState({ state: "loading" }));
      sendPluginEvent("refreshDevices");
    },
  };
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
  const items = rows.map((row, index) => {
    const item = document.createElement("li");
    item.className = `device-row${row.available ? "" : " device-row-missing"}`;

    const line = document.createElement("div");
    line.className = "device-line";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.id = `include-device-${index}`;
    checkbox.checked = row.included;
    checkbox.setAttribute("aria-label", `Include ${row.device.name} in cycle`);
    checkbox.addEventListener("change", () => {
      handlers.onIncluded(row.device, checkbox.checked);
    });

    const identity = document.createElement("label");
    identity.className = "device-identity";
    identity.setAttribute("for", checkbox.id);

    const name = document.createElement("span");
    name.className = "device-name";
    name.textContent = row.device.name;

    const metadata = document.createElement("span");
    metadata.className = "device-metadata";

    const provider = document.createElement("span");
    provider.className = "provider-label";
    provider.textContent = row.device.providerLabel;
    metadata.append(provider);

    if (!row.available) {
      const unavailable = document.createElement("span");
      unavailable.className = "availability-label";
      unavailable.textContent = "Unavailable";
      metadata.append(unavailable);
    }

    identity.append(name, metadata);
    line.append(checkbox, identity);

    if (row.included) {
      const order = document.createElement("div");
      order.className = "order-controls";

      const position = document.createElement("span");
      position.className = "cycle-position";
      position.textContent = String((row.order ?? 0) + 1);
      position.setAttribute(
        "aria-label",
        `Cycle position ${(row.order ?? 0) + 1} of ${selectedCount}`
      );
      order.append(position);

      if (row.initial) {
        const initial = document.createElement("span");
        initial.className = "initial-label";
        initial.textContent = "Initial";
        order.append(initial);
      }

      const up = createMoveButton(document, row, "up", "↑", handlers.onMove);
      const down = createMoveButton(document, row, "down", "↓", handlers.onMove);
      up.disabled = row.order === 0;
      down.disabled = row.order === selectedCount - 1;
      order.append(up, down);
      item.append(line, order);
    } else {
      item.append(line);
    }

    return item;
  });

  container.replaceChildren(...items);
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

function createMoveButton(document, row, direction, glyph, onMove) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "order-button";
  button.textContent = glyph;
  button.setAttribute("aria-label", `Move ${row.device.name} ${direction}`);
  button.setAttribute("title", `Move ${direction}`);
  button.addEventListener("click", () => onMove(row.device.key, direction));
  return button;
}

function isRecord(value) {
  return typeof value === "object" && value !== null;
}

function installPropertyInspector(window, document) {
  const elements = {
    status: document.getElementById("status"),
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
        onMove(key, direction) {
          controller.move(key, direction);
        },
      });
      elements.empty.hidden = rows.length !== 0;
    },

    showStatus(status) {
      elements.status.className = `status-bar status-${status.tone}`;
      elements.status.textContent = status.text;
      const loading = status.tone === "loading";
      elements.refresh.disabled = loading;
      elements.refresh.setAttribute("aria-busy", String(loading));
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
      if (!isRecord(message)) return;
      if (
        message.event === "sendToPropertyInspector" &&
        isRecord(message.payload) &&
        message.payload.event === "deviceList"
      ) {
        controller.receiveDeviceList(message.payload);
      } else if (message.event === "didReceiveSettings") {
        controller.receiveSettings(
          isRecord(message.payload?.settings) ? message.payload.settings : {}
        );
      }
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
