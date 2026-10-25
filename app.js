(function () {
  "use strict";

  const FunctionPlot = window.FunctionPlot;
  const canvas = document.querySelector("#plot-canvas");
  const expressionError = document.querySelector("#expression-error");
  const plotButton = document.querySelector("#plot-button");
  const exampleButtons = [...document.querySelectorAll(".example-chip")];
  const zoomInButton = document.querySelector("#zoom-in");
  const zoomOutButton = document.querySelector("#zoom-out");
  const resetViewButton = document.querySelector("#reset-view");

  const COLORS = {
    background: "#fbfaf6",
    minorGrid: "#f1efe9",
    majorGrid: "#e7e4dd",
    axis: "#b8b8b0",
    tick: "#686a62",
  };

  const SERIES_COLORS = ["#ee5b38", "#2f73d8"];
  const SERIES_LABELS = ["y₁", "y₂"];
  const STORAGE_KEY = "plot.functions.v2";
  const LEGACY_STORAGE_KEY = "plot.expression.v1";
  const DEFAULT_EXPRESSIONS = ["sin(x)", "cos(x)"];
  const DEFAULT_X_RANGE = { min: -5, max: 5 };
  const DEFAULT_VIEW = { xMin: -5, xMax: 5, yMin: -3, yMax: 3 };
  const MIN_SPAN = 1e-8;
  const MAX_SPAN = 1e10;
  const MONO_FONT =
    '"SFMono-Regular", "Cascadia Code", "Roboto Mono", Consolas, monospace';

  const context = canvas?.getContext("2d");
  const pointers = new Map();
  const metrics = {
    width: 1,
    height: 1,
    dpr: 1,
  };

  const slots = [
    createSlot(0, {
      input: "#expression-1",
      row: "#formula-row-1",
      legendItem: "#legend-item-1",
      legendExpression: "#legend-expression-1",
    }),
    createSlot(1, {
      input: "#expression-2",
      row: "#formula-row-2",
      legendItem: "#legend-item-2",
      legendExpression: "#legend-expression-2",
    }),
  ];

  if (
    !canvas ||
    !context ||
    !FunctionPlot ||
    !expressionError ||
    !plotButton ||
    slots.some((slot) => !slot.input || !slot.row)
  ) {
    return;
  }

  let view = { ...DEFAULT_VIEW };
  let activeSlot = slots[0];
  let inputTimer = 0;
  let drawFrame = 0;
  let pinchState = null;

  function createSlot(index, selectors) {
    return {
      index,
      color: SERIES_COLORS[index],
      label: SERIES_LABELS[index],
      input: document.querySelector(selectors.input),
      row: document.querySelector(selectors.row),
      legendItem: document.querySelector(selectors.legendItem),
      legendExpression: document.querySelector(
        selectors.legendExpression,
      ),
      compiled: null,
      lastCompiled: null,
      error: null,
    };
  }

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function isCoarsePointer() {
    return window.matchMedia("(pointer: coarse)").matches;
  }

  function errorToMessage(error) {
    const suffix =
      error && Number.isInteger(error.position)
        ? `（第 ${error.position + 1} 个字符）`
        : "";
    return `${error?.message || "这个表达式暂时无法绘制"}${suffix}`;
  }

  function setStatus(message, invalid = true) {
    expressionError.textContent = message;
    expressionError.classList.toggle(
      "is-neutral",
      Boolean(message) && !invalid,
    );
  }

  function clearStatus() {
    expressionError.textContent = "";
    expressionError.classList.remove("is-neutral");
  }

  function readStoredExpressions() {
    try {
      const current = window.localStorage.getItem(STORAGE_KEY);

      if (current) {
        const parsed = JSON.parse(current);

        if (parsed && Array.isArray(parsed.expressions)) {
          return [
            String(parsed.expressions[0] ?? ""),
            String(parsed.expressions[1] ?? ""),
          ];
        }
      }

      const legacy = window.localStorage.getItem(LEGACY_STORAGE_KEY);

      if (legacy !== null && legacy.trim()) {
        const first = legacy.trim();
        const second =
          first.toLowerCase() === DEFAULT_EXPRESSIONS[1]
            ? DEFAULT_EXPRESSIONS[0]
            : DEFAULT_EXPRESSIONS[1];
        return [first, second];
      }
    } catch {
      // Fall through to defaults when storage is unavailable or malformed.
    }

    return [...DEFAULT_EXPRESSIONS];
  }

  function storeExpressions(expressions) {
    try {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ expressions }),
      );
      window.localStorage.removeItem(LEGACY_STORAGE_KEY);
    } catch {
      // The graph still works when storage is unavailable.
    }
  }

  function persistSlots() {
    storeExpressions(
      slots.map((slot) => {
        if (slot.compiled) {
          return slot.compiled.source;
        }

        if (!slot.input.value.trim()) {
          return "";
        }

        return slot.lastCompiled?.source || "";
      }),
    );
  }

  function activateSlot(slot) {
    activeSlot = slot;

    for (const candidate of slots) {
      candidate.row.classList.toggle(
        "is-active",
        candidate.index === activeSlot.index,
      );
    }

    updateActiveExample();
  }

  function updateActiveExample() {
    const source =
      activeSlot.compiled?.source ||
      FunctionPlot.normalizeExpression(activeSlot.input.value);

    for (const button of exampleButtons) {
      button.classList.toggle(
        "is-active",
        button.dataset.expression === source,
      );
    }
  }

  function updateLegends() {
    for (const slot of slots) {
      const source =
        slot.compiled?.source ||
        (slot.error ? slot.lastCompiled?.source : "") ||
        "";
      const hasLegend = Boolean(source);

      slot.legendItem.hidden = !hasLegend;
      slot.legendItem.classList.toggle(
        "is-stale",
        Boolean(slot.error) && Boolean(source),
      );

      if (hasLegend) {
        slot.legendExpression.textContent = `${slot.label} = ${source}`;
      }
    }
  }

  function niceStep(span, targetCount) {
    const rough = Math.abs(span) / Math.max(1, targetCount);

    if (!Number.isFinite(rough) || rough <= 0) {
      return 1;
    }

    const power = Math.pow(10, Math.floor(Math.log10(rough)));
    const fraction = rough / power;
    let niceFraction;

    if (fraction <= 1.5) {
      niceFraction = 1;
    } else if (fraction <= 3) {
      niceFraction = 2;
    } else if (fraction <= 7) {
      niceFraction = 5;
    } else {
      niceFraction = 10;
    }

    return niceFraction * power;
  }

  function formatTick(value, step) {
    if (Math.abs(value) < Math.abs(step) * 1e-8) {
      return "0";
    }

    const absolute = Math.abs(value);

    if (absolute >= 1e7 || absolute < 1e-5) {
      return value
        .toExponential(1)
        .replace("e+", "e")
        .replace(/\.0e/, "e");
    }

    const decimals = clamp(
      Math.max(0, -Math.floor(Math.log10(Math.abs(step)))),
      0,
      6,
    );

    return value
      .toFixed(decimals)
      .replace(/(\.\d*?)0+$/, "$1")
      .replace(/\.$/, "");
  }

  function xToPixel(x) {
    return (
      ((x - view.xMin) / (view.xMax - view.xMin)) * metrics.width
    );
  }

  function yToPixel(y) {
    return (
      ((view.yMax - y) / (view.yMax - view.yMin)) * metrics.height
    );
  }

  function pixelToWorld(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const ratioX = clamp((clientX - rect.left) / rect.width, 0, 1);
    const ratioY = clamp((clientY - rect.top) / rect.height, 0, 1);

    return {
      x: view.xMin + ratioX * (view.xMax - view.xMin),
      y: view.yMax - ratioY * (view.yMax - view.yMin),
      ratioX,
      ratioY,
    };
  }

  function computeAutoView(compiledFunctions) {
    const sampleCount = 351;
    const values = [];

    for (const compiledFunction of compiledFunctions) {
      for (let index = 0; index < sampleCount; index += 1) {
        const ratio = index / (sampleCount - 1);
        const x =
          DEFAULT_X_RANGE.min +
          ratio * (DEFAULT_X_RANGE.max - DEFAULT_X_RANGE.min);
        const y = compiledFunction.evaluate(x);

        if (Number.isFinite(y)) {
          values.push(y);
        }
      }
    }

    if (values.length < 4) {
      return {
        view: {
          xMin: DEFAULT_X_RANGE.min,
          xMax: DEFAULT_X_RANGE.max,
          yMin: -3,
          yMax: 3,
        },
        hasSamples: false,
      };
    }

    values.sort((a, b) => a - b);
    const trimCount = Math.floor(values.length * 0.07);
    let low = values[trimCount];
    let high = values[values.length - 1 - trimCount];

    if (!Number.isFinite(low) || !Number.isFinite(high)) {
      low = values[0];
      high = values[values.length - 1];
    }

    if (high - low < 1e-10) {
      const padding = Math.max(1, Math.abs(low) * 0.7);
      low -= padding;
      high += padding;
    } else {
      const padding = (high - low) * 0.16;
      low -= padding;
      high += padding;
    }

    return {
      view: {
        xMin: DEFAULT_X_RANGE.min,
        xMax: DEFAULT_X_RANGE.max,
        yMin: low,
        yMax: high,
      },
      hasSamples: true,
    };
  }

  function sanitizeView(nextView) {
    let xSpan = nextView.xMax - nextView.xMin;
    let ySpan = nextView.yMax - nextView.yMin;

    if (!Number.isFinite(xSpan) || xSpan <= 0) {
      xSpan = DEFAULT_VIEW.xMax - DEFAULT_VIEW.xMin;
    }
    if (!Number.isFinite(ySpan) || ySpan <= 0) {
      ySpan = DEFAULT_VIEW.yMax - DEFAULT_VIEW.yMin;
    }

    xSpan = clamp(xSpan, MIN_SPAN, MAX_SPAN);
    ySpan = clamp(ySpan, MIN_SPAN, MAX_SPAN);

    const centerX = (nextView.xMin + nextView.xMax) / 2;
    const centerY = (nextView.yMin + nextView.yMax) / 2;

    return {
      xMin: centerX - xSpan / 2,
      xMax: centerX + xSpan / 2,
      yMin: centerY - ySpan / 2,
      yMax: centerY + ySpan / 2,
    };
  }

  function scheduleDraw() {
    if (drawFrame) {
      return;
    }

    drawFrame = window.requestAnimationFrame(() => {
      drawFrame = 0;
      draw();
    });
  }

  function syncCanvasSize() {
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    const height = Math.max(1, rect.height);
    const dpr = clamp(window.devicePixelRatio || 1, 1, 2.5);
    const pixelWidth = Math.round(width * dpr);
    const pixelHeight = Math.round(height * dpr);

    metrics.width = width;
    metrics.height = height;
    metrics.dpr = dpr;

    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }

    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    scheduleDraw();
  }

  function drawGridLineSeries(step, color, lineWidth) {
    if (!Number.isFinite(step) || step <= 0) {
      return;
    }

    const startX = Math.ceil(view.xMin / step);
    const endX = Math.floor(view.xMax / step);
    const startY = Math.ceil(view.yMin / step);
    const endY = Math.floor(view.yMax / step);

    context.beginPath();

    for (let index = startX; index <= endX; index += 1) {
      const pixel = xToPixel(index * step);
      context.moveTo(pixel, 0);
      context.lineTo(pixel, metrics.height);
    }

    for (let index = startY; index <= endY; index += 1) {
      const pixel = yToPixel(index * step);
      context.moveTo(0, pixel);
      context.lineTo(metrics.width, pixel);
    }

    context.strokeStyle = color;
    context.lineWidth = lineWidth;
    context.stroke();
  }

  function drawLabels(xStep, yStep) {
    const width = metrics.width;
    const height = metrics.height;
    const xAxis = yToPixel(0);
    const yAxis = xToPixel(0);
    const xAxisVisible = xAxis >= 0 && xAxis <= height;
    const yAxisVisible = yAxis >= 0 && yAxis <= width;
    const labelY =
      xAxisVisible && xAxis < height - 24 ? xAxis + 15 : height - 8;
    const useYAxisLabels =
      yAxisVisible && yAxis > 34 && yAxis < width - 42;
    const labelX = useYAxisLabels ? yAxis - 7 : 8;

    context.font = `10px ${MONO_FONT}`;
    context.fillStyle = COLORS.tick;
    context.lineWidth = 1;

    context.textAlign = "center";
    context.textBaseline = "alphabetic";

    const startX = Math.ceil(view.xMin / xStep);
    const endX = Math.floor(view.xMax / xStep);

    for (let index = startX; index <= endX; index += 1) {
      const value = index * xStep;
      const pixel = xToPixel(value);

      if (
        pixel < 18 ||
        pixel > width - 18 ||
        Math.abs(value) < Math.abs(xStep) * 1e-8
      ) {
        continue;
      }

      context.fillText(formatTick(value, xStep), pixel, labelY);
    }

    context.textAlign = useYAxisLabels ? "right" : "left";
    const startY = Math.ceil(view.yMin / yStep);
    const endY = Math.floor(view.yMax / yStep);

    for (let index = startY; index <= endY; index += 1) {
      const value = index * yStep;
      const pixel = yToPixel(value);

      if (
        pixel < 13 ||
        pixel > height - 13 ||
        Math.abs(value) < Math.abs(yStep) * 1e-8
      ) {
        continue;
      }

      context.fillText(formatTick(value, yStep), labelX, pixel + 3);
    }

    if (xAxisVisible && yAxisVisible) {
      context.textAlign = "right";
      context.fillText("0", yAxis - 6, clamp(xAxis + 15, 15, height - 7));
    }
  }

  function drawGrid() {
    const width = metrics.width;
    const height = metrics.height;
    const xStep = niceStep(view.xMax - view.xMin, width < 500 ? 5 : 7);
    const yStep = niceStep(view.yMax - view.yMin, height < 430 ? 5 : 7);
    const xAxis = yToPixel(0);
    const yAxis = xToPixel(0);

    drawGridLineSeries(xStep / 5, COLORS.minorGrid, 0.65);
    drawGridLineSeries(xStep, COLORS.majorGrid, 1);

    context.beginPath();

    if (xAxis >= 0 && xAxis <= height) {
      context.moveTo(0, xAxis);
      context.lineTo(width, xAxis);
    }

    if (yAxis >= 0 && yAxis <= width) {
      context.moveTo(yAxis, 0);
      context.lineTo(yAxis, height);
    }

    context.strokeStyle = COLORS.axis;
    context.lineWidth = 1;
    context.stroke();

    drawLabels(xStep, yStep);
  }

  function drawCurve(compiledFunction, color, alpha) {
    const width = metrics.width;
    const height = metrics.height;
    const sampleCount = Math.max(600, Math.ceil(width * 1.6));
    const outsideLimit = height * 16;
    let previousPixelY = null;
    let shouldMove = true;

    context.save();
    context.beginPath();
    context.rect(0, 0, width, height);
    context.clip();
    context.beginPath();

    for (let index = 0; index <= sampleCount; index += 1) {
      const ratio = index / sampleCount;
      const x = view.xMin + ratio * (view.xMax - view.xMin);
      const y = compiledFunction.evaluate(x);

      if (!Number.isFinite(y)) {
        shouldMove = true;
        previousPixelY = null;
        continue;
      }

      const rawPixelY = yToPixel(y);

      if (!Number.isFinite(rawPixelY)) {
        shouldMove = true;
        previousPixelY = null;
        continue;
      }

      const pixelX = ratio * width;
      const pixelY = clamp(rawPixelY, -outsideLimit, height + outsideLimit);
      const crossesDiscontinuity =
        previousPixelY !== null &&
        ((previousPixelY < -height * 0.25 &&
          rawPixelY > height * 1.25) ||
          (previousPixelY > height * 1.25 &&
            rawPixelY < -height * 0.25));

      if (shouldMove || crossesDiscontinuity) {
        context.moveTo(pixelX, pixelY);
      } else {
        context.lineTo(pixelX, pixelY);
      }

      previousPixelY = rawPixelY;
      shouldMove = false;
    }

    context.globalAlpha = alpha;
    context.strokeStyle = color;
    context.lineWidth = 2.2;
    context.lineCap = "round";
    context.lineJoin = "round";
    context.stroke();
    context.restore();
  }

  function draw() {
    if (metrics.width <= 1 || metrics.height <= 1) {
      return;
    }

    context.setTransform(metrics.dpr, 0, 0, metrics.dpr, 0, 0);
    context.clearRect(0, 0, metrics.width, metrics.height);
    context.fillStyle = COLORS.background;
    context.fillRect(0, 0, metrics.width, metrics.height);

    drawGrid();

    for (const slot of slots) {
      if (!slot.compiled && slot.error && slot.lastCompiled) {
        drawCurve(slot.lastCompiled, slot.color, 0.22);
      }
    }

    for (const slot of slots) {
      if (slot.compiled) {
        drawCurve(slot.compiled, slot.color, 1);
      }
    }
  }

  function refreshFunctions({
    autoFit = true,
    persist = true,
    canonicalize = false,
  } = {}) {
    let firstError = null;

    for (const slot of slots) {
      const raw = slot.input.value.trim();
      slot.error = null;

      if (!raw) {
        slot.compiled = null;
        slot.lastCompiled = null;
      } else {
        try {
          const compiled = FunctionPlot.compile(raw);
          slot.compiled = compiled;
          slot.lastCompiled = compiled;
        } catch (error) {
          slot.compiled = null;
          slot.error = error;
          firstError ||= { slot, error };
        }
      }

      const hasError = Boolean(slot.error);
      slot.row.classList.toggle("has-error", hasError);

      if (hasError) {
        slot.input.setAttribute("aria-invalid", "true");
      } else {
        slot.input.removeAttribute("aria-invalid");
      }
    }

    const validFunctions = slots
      .filter((slot) => slot.compiled)
      .map((slot) => slot.compiled);
    let domainMessage = "";

    if (autoFit) {
      if (validFunctions.length > 0) {
        const fitted = computeAutoView(validFunctions);
        view = sanitizeView(fitted.view);

        if (!fitted.hasSamples) {
          domainMessage = "当前 x 范围内没有可绘制的实数点";
        }
      } else if (slots.every((slot) => !slot.input.value.trim())) {
        view = { ...DEFAULT_VIEW };
      }
    }

    if (canonicalize) {
      for (const slot of slots) {
        if (slot.compiled) {
          slot.input.value = slot.compiled.source;
        }
      }
    }

    updateLegends();

    if (firstError) {
      setStatus(
        `函数 ${firstError.slot.index + 1}：${errorToMessage(firstError.error)}`,
        true,
      );
    } else if (domainMessage) {
      setStatus(domainMessage, false);
    } else {
      clearStatus();
    }

    if (persist) {
      persistSlots();
    }

    updateActiveExample();
    scheduleDraw();
    return !firstError;
  }

  function submitFunctions({ canonicalize = true, blur = false } = {}) {
    window.clearTimeout(inputTimer);
    const applied = refreshFunctions({
      autoFit: true,
      persist: true,
      canonicalize,
    });

    if (blur && applied) {
      activeSlot.input.blur();
    }

    return applied;
  }

  function resetView() {
    const validFunctions = slots
      .filter((slot) => slot.compiled)
      .map((slot) => slot.compiled);

    if (validFunctions.length > 0) {
      view = sanitizeView(computeAutoView(validFunctions).view);
    } else {
      view = { ...DEFAULT_VIEW };
    }
    scheduleDraw();
  }

  function zoomAt(clientX, clientY, factor) {
    const anchor = pixelToWorld(clientX, clientY);
    const xSpan = clamp(
      (view.xMax - view.xMin) * factor,
      MIN_SPAN,
      MAX_SPAN,
    );
    const ySpan = clamp(
      (view.yMax - view.yMin) * factor,
      MIN_SPAN,
      MAX_SPAN,
    );

    view = {
      xMin: anchor.x - anchor.ratioX * xSpan,
      xMax: anchor.x + (1 - anchor.ratioX) * xSpan,
      yMax: anchor.y + anchor.ratioY * ySpan,
      yMin: anchor.y - (1 - anchor.ratioY) * ySpan,
    };

    scheduleDraw();
  }

  function zoomAtCenter(factor) {
    const rect = canvas.getBoundingClientRect();
    zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, factor);
  }

  function panBy(deltaX, deltaY) {
    if (metrics.width <= 0 || metrics.height <= 0) {
      return;
    }

    const worldX = (deltaX / metrics.width) * (view.xMax - view.xMin);
    const worldY = (deltaY / metrics.height) * (view.yMax - view.yMin);

    view = {
      xMin: view.xMin - worldX,
      xMax: view.xMax - worldX,
      yMin: view.yMin + worldY,
      yMax: view.yMax + worldY,
    };

    scheduleDraw();
  }

  function beginPinch() {
    const points = [...pointers.values()].slice(0, 2);

    if (points.length < 2) {
      return;
    }

    const distance = Math.hypot(
      points[1].x - points[0].x,
      points[1].y - points[0].y,
    );
    const midpoint = {
      x: (points[0].x + points[1].x) / 2,
      y: (points[0].y + points[1].y) / 2,
    };
    const anchor = pixelToWorld(midpoint.x, midpoint.y);

    pinchState = {
      distance: Math.max(distance, 1),
      anchor,
    };
  }

  function updatePinch() {
    if (!pinchState) {
      beginPinch();
    }

    const points = [...pointers.values()].slice(0, 2);

    if (!pinchState || points.length < 2) {
      return;
    }

    const distance = Math.hypot(
      points[1].x - points[0].x,
      points[1].y - points[0].y,
    );
    const midpoint = {
      x: (points[0].x + points[1].x) / 2,
      y: (points[0].y + points[1].y) / 2,
    };
    const rect = canvas.getBoundingClientRect();
    const ratioX = clamp((midpoint.x - rect.left) / rect.width, 0, 1);
    const ratioY = clamp((midpoint.y - rect.top) / rect.height, 0, 1);
    const factor = pinchState.distance / Math.max(distance, 1);
    const xSpan = clamp(
      (view.xMax - view.xMin) * factor,
      MIN_SPAN,
      MAX_SPAN,
    );
    const ySpan = clamp(
      (view.yMax - view.yMin) * factor,
      MIN_SPAN,
      MAX_SPAN,
    );

    view = {
      xMin: pinchState.anchor.x - ratioX * xSpan,
      xMax: pinchState.anchor.x + (1 - ratioX) * xSpan,
      yMax: pinchState.anchor.y + ratioY * ySpan,
      yMin: pinchState.anchor.y - (1 - ratioY) * ySpan,
    };

    pinchState.distance = Math.max(distance, 1);
    pinchState.anchor.ratioX = ratioX;
    pinchState.anchor.ratioY = ratioY;

    scheduleDraw();
  }

  function finishPointer(event) {
    if (!pointers.has(event.pointerId)) {
      return;
    }

    pointers.delete(event.pointerId);

    if (pointers.size === 0) {
      canvas.classList.remove("is-dragging");
      pinchState = null;
    } else if (pointers.size === 1) {
      pinchState = null;
    } else {
      beginPinch();
    }
  }

  for (const slot of slots) {
    slot.input.addEventListener("focus", () => {
      activateSlot(slot);
    });

    slot.input.addEventListener("pointerdown", () => {
      activateSlot(slot);
    });

    slot.input.addEventListener("input", () => {
      activateSlot(slot);
      window.clearTimeout(inputTimer);
      inputTimer = window.setTimeout(() => {
        refreshFunctions({
          autoFit: true,
          persist: true,
        });
      }, 280);
    });

    slot.input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.isComposing) {
        return;
      }

      event.preventDefault();
      submitFunctions({
        canonicalize: true,
        blur: isCoarsePointer(),
      });
    });
  }

  plotButton.addEventListener("click", () => {
    submitFunctions({ canonicalize: true, blur: false });
  });

  for (const button of exampleButtons) {
    button.addEventListener("click", () => {
      window.clearTimeout(inputTimer);
      activateSlot(activeSlot);
      activeSlot.input.value = button.dataset.expression;
      refreshFunctions({
        autoFit: true,
        persist: true,
        canonicalize: true,
      });
    });
  }

  zoomInButton.addEventListener("click", () => {
    zoomAtCenter(0.72);
  });

  zoomOutButton.addEventListener("click", () => {
    zoomAtCenter(1.38);
  });

  resetViewButton.addEventListener("click", resetView);

  canvas.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    canvas.focus?.({ preventScroll: true });

    try {
      canvas.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture can be unavailable in older embedded browsers.
    }

    pointers.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });
    canvas.classList.add("is-dragging");

    if (pointers.size === 2) {
      beginPinch();
    }
  });

  canvas.addEventListener("pointermove", (event) => {
    const point = pointers.get(event.pointerId);

    if (!point) {
      return;
    }

    event.preventDefault();
    const previousX = point.x;
    const previousY = point.y;
    point.x = event.clientX;
    point.y = event.clientY;

    if (pointers.size === 1) {
      panBy(point.x - previousX, point.y - previousY);
    } else if (pointers.size >= 2) {
      updatePinch();
    }
  });

  canvas.addEventListener("pointerup", finishPointer);
  canvas.addEventListener("pointercancel", finishPointer);

  canvas.addEventListener("lostpointercapture", (event) => {
    if (pointers.has(event.pointerId)) {
      finishPointer(event);
    }
  });

  canvas.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      const multiplier =
        event.deltaMode === 1
          ? 16
          : event.deltaMode === 2
            ? metrics.height
            : 1;
      const delta = clamp(event.deltaY * multiplier, -320, 320);
      const factor = Math.exp(delta * 0.0015);
      zoomAt(event.clientX, event.clientY, factor);
    },
    { passive: false },
  );

  canvas.addEventListener("contextmenu", (event) => {
    event.preventDefault();
  });

  const resizeObserver = new ResizeObserver(syncCanvasSize);
  resizeObserver.observe(canvas);
  window.addEventListener("resize", syncCanvasSize);

  const storedExpressions = readStoredExpressions();

  for (const slot of slots) {
    slot.input.value = storedExpressions[slot.index] || "";
  }

  const initialSlot =
    slots.find((slot) => slot.input.value.trim()) || slots[0];
  activateSlot(initialSlot);
  syncCanvasSize();
  refreshFunctions({
    autoFit: true,
    persist: false,
  });

  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(scheduleDraw);
  }
})();
