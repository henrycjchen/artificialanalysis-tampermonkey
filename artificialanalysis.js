// ==UserScript==
// @name         Artificial Analysis - Frontier Chart Controls
// @namespace    https://artificialanalysis.ai/
// @version      2.5
// @description  Local controls for the Frontier chart: time range / Y-axis range. Defaults to last 12 months, Y-axis 33.5~max, chart height 600px. Built for the Recharts (v3) version.
// @match        https://artificialanalysis.ai/*
// @run-at       document-idle
// @grant        none
// @downloadURL https://update.greasyfork.org/scripts/579264/Artificial%20Analysis%20-%20Frontier%20Chart%20Controls.user.js
// @updateURL https://update.greasyfork.org/scripts/579264/Artificial%20Analysis%20-%20Frontier%20Chart%20Controls.meta.js
// ==/UserScript==

(function () {
  "use strict";

  // -------- defaults (edit here) --------
  const CHART_HEIGHT_PX = 600; // set to 0 to keep the site's default height
  const DEFAULT_RANGE_IDX = 1; // Last 12 months
  const DEFAULT_Y_MIN = 33.5; // Y-axis minimum; leave null for auto
  // --------------------------------------

  const CHART_HEIGHT = CHART_HEIGHT_PX ? CHART_HEIGHT_PX + "px" : "";

  const HEADING_TEXT = "Frontier Language Model Intelligence";
  const UI_ID = "frontier-controls";

  const RANGES = [
    { label: "All time", days: null },
    { label: "Last 12 months", days: 365 },
    { label: "Last 9 months", days: 270 },
    { label: "Last 6 months", days: 180 },
  ];

  // ---- state ----
  let originalCreators = null;
  let originalChartData = null;
  let rangeDays = RANGES[DEFAULT_RANGE_IDX].days;
  let yMin = DEFAULT_Y_MIN;
  let yMax = null;
  let dispatchWrapped = false;
  let lastAppliedPayload = null;
  let reapplyScheduled = false;
  let chartStore = null;

  // ---- DOM / fiber helpers ----
  const findHeading = () =>
    Array.from(document.querySelectorAll("h1,h2,h3,h4")).find((h) =>
      h.textContent.includes(HEADING_TEXT),
    );

  const findChartSvg = (heading) => {
    const top = heading.getBoundingClientRect().top + window.scrollY;
    return Array.from(document.querySelectorAll("svg"))
      .filter((s) => s.getBoundingClientRect().width > 800)
      .find((s) => s.getBoundingClientRect().top + window.scrollY > top);
  };

  const getFiber = (el) => {
    const key = Object.keys(el).find((k) => k.startsWith("__reactFiber"));
    return key ? el[key] : null;
  };

  const findCreatorsHook = (startFiber) => {
    let f = startFiber;
    while (f) {
      let s = f.memoizedState;
      while (s) {
        if (s.queue && typeof s.queue.dispatch === "function") {
          const ms = s.memoizedState;
          if (Array.isArray(ms) && ms[0] && Array.isArray(ms[0].models))
            return s;
        }
        s = s.next;
      }
      f = f.return;
    }
    return null;
  };

  // Recharts (v3) keeps the plotted data in its internal Redux store as a
  // pivoted array of rows ({ x: <timestamp>, [creatorId]: value, ... }) under
  // state.chartData.chartData. Dispatching filtered creators into the React
  // hook only changes how many <Line>s render, not their points, so BOTH the
  // time range and the Y-axis bound have to be applied by rewriting those store
  // rows: drop rows outside the time window, and strip any value outside
  // [yMin, yMax] so points beyond the limit are removed rather than merely
  // clipped by the axis domain.
  // Tracks the filter currently pushed into the store so we can tell our own
  // filtered output apart from the site re-pushing the full dataset.
  let appliedWindowDays = undefined;
  let appliedYMin = undefined;
  let appliedYMax = undefined;
  let appliedRowCount = -1;

  // True when any current row falls outside the time window or holds a value
  // outside [min, max] — i.e. the store is holding unfiltered data (the site
  // re-pushed the full set) and we need to re-apply.
  const rowsViolate = (rows, cutoff, min, max) => {
    for (const r of rows) {
      if (cutoff != null && !(typeof r.x === "number" && r.x >= cutoff))
        return true;
      if (min == null && max == null) continue;
      for (const k in r) {
        if (k === "x") continue;
        const v = r[k];
        if (typeof v !== "number") continue;
        if (min != null && v < min) return true;
        if (max != null && v > max) return true;
      }
    }
    return false;
  };

  // Filter the store's chartData rows to the selected time window and Y range,
  // then push the result back in. Idempotent: a no-op when the store already
  // holds exactly the current filter's output.
  const applyDataFilter = (store) => {
    if (!store) return;
    const slice = store.getState() && store.getState().chartData;
    const rows = slice && Array.isArray(slice.chartData) ? slice.chartData : null;
    if (!rows || !rows.length) return;

    // Capture the fullest (unfiltered) dataset we have seen as the source of
    // truth; the site re-pushes the complete set on re-render, our own filtered
    // output is never larger and so never overwrites it.
    if (!originalChartData || rows.length > originalChartData.length) {
      originalChartData = rows;
    }

    let cutoff = null;
    if (rangeDays != null) {
      let maxX = 0;
      for (const r of originalChartData)
        if (typeof r.x === "number" && r.x > maxX) maxX = r.x;
      cutoff = maxX - rangeDays * 24 * 3600 * 1000;
    }
    const min = typeof yMin === "number" ? yMin : null;
    const max = typeof yMax === "number" ? yMax : null;

    // Build the desired rows from the full dataset: drop out-of-window rows and
    // omit out-of-range values so those points stop rendering.
    const desired = [];
    for (const r of originalChartData) {
      if (cutoff != null && !(typeof r.x === "number" && r.x >= cutoff))
        continue;
      if (min == null && max == null) {
        desired.push(r);
        continue;
      }
      const row = { x: r.x };
      for (const k in r) {
        if (k === "x") continue;
        const v = r[k];
        if (
          typeof v === "number" &&
          ((min != null && v < min) || (max != null && v > max))
        )
          continue;
        row[k] = v;
      }
      desired.push(row);
    }

    // Skip when the store already holds our output: same filter as last applied,
    // matching row count, and no row/value violating the current limits.
    const paramsUnchanged =
      rangeDays === appliedWindowDays &&
      yMin === appliedYMin &&
      yMax === appliedYMax;
    if (
      paramsUnchanged &&
      rows.length === appliedRowCount &&
      !rowsViolate(rows, cutoff, min, max)
    )
      return;

    appliedWindowDays = rangeDays;
    appliedYMin = yMin;
    appliedYMax = yMax;
    appliedRowCount = desired.length;
    store.dispatch({ type: "chartData/setChartData", payload: desired });
  };

  // Recharts uses an internal Redux store; we patch its dispatch to inject Y-axis domain.
  const findReduxStore = (startFiber) => {
    let f = startFiber;
    while (f) {
      const p = f.memoizedProps;
      if (
        p &&
        p.store &&
        typeof p.store.dispatch === "function" &&
        typeof p.store.getState === "function"
      ) {
        // Sanity check: this store should manage cartesianAxis
        try {
          const state = p.store.getState();
          if (state && state.cartesianAxis) return p.store;
        } catch {}
      }
      f = f.return;
    }
    return null;
  };

  const patchReduxStore = (store) => {
    if (!store) return false;
    if (store.__frontierPatched) return true;
    const orig = store.dispatch;
    store.dispatch = function (action) {
      if (
        action &&
        action.type === "cartesianAxis/addYAxis" &&
        action.payload &&
        (yMin != null || yMax != null)
      ) {
        const nextDomain = [
          yMin != null ? yMin : "auto",
          yMax != null ? yMax : "auto",
        ];
        action = {
          ...action,
          payload: {
            ...action.payload,
            domain: nextDomain,
            allowDataOverflow: true,
          },
        };
      }
      return orig.call(this, action);
    };

    // Belt-and-suspenders: whenever the store's yAxis state drifts away from our
    // desired domain (e.g. Recharts re-registers via a code path that bypassed
    // our dispatch wrapper), re-dispatch to push the desired domain back in.
    let enforcing = false;
    store.subscribe(() => {
      if (enforcing) return;
      // Re-apply the filter whenever the site re-pushes the full dataset
      // (its own re-renders reset chartData back to every row).
      applyDataFilter(store);
      if (yMin == null && yMax == null) return;
      const state = store.getState();
      const yAxis =
        state &&
        state.cartesianAxis &&
        state.cartesianAxis.yAxis &&
        state.cartesianAxis.yAxis["0"];
      if (!yAxis) return;
      const desiredMin = yMin != null ? yMin : "auto";
      const desiredMax = yMax != null ? yMax : "auto";
      const cur = Array.isArray(yAxis.domain) ? yAxis.domain : null;
      if (
        cur &&
        cur[0] === desiredMin &&
        cur[1] === desiredMax &&
        yAxis.allowDataOverflow
      )
        return;
      enforcing = true;
      try {
        store.dispatch({
          type: "cartesianAxis/addYAxis",
          payload: { ...yAxis },
        });
      } finally {
        enforcing = false;
      }
    });

    store.__frontierPatched = true;
    return true;
  };

  // After data dispatch the YAxis component won't re-register on its own,
  // so re-emit an addYAxis action to push the latest domain into the store.
  const reapplyYAxisDomain = () => {
    if (!chartStore) return;
    const state = chartStore.getState();
    const current =
      state &&
      state.cartesianAxis &&
      state.cartesianAxis.yAxis &&
      state.cartesianAxis.yAxis["0"];
    if (!current) return;
    chartStore.dispatch({
      type: "cartesianAxis/addYAxis",
      payload: { ...current },
    });
  };

  // ---- chart height ----
  const findResponsiveContainer = (svg) => {
    let el = svg;
    while (el) {
      if (
        el.classList &&
        el.classList.contains("recharts-responsive-container")
      )
        return el;
      el = el.parentElement;
    }
    return null;
  };

  // The site renders <ResponsiveContainer height={320}>. Because that's a
  // number (not "100%"), Recharts uses it as a hard pixel height for the
  // inner chart regardless of the container's measured size. To grow the
  // chart we have to override that prop on the ResponsiveContainer fiber's
  // forwardRef type, then trigger a re-render.
  const findResponsiveContainerFiber = (svg) => {
    const rc =
      svg && svg.closest && svg.closest(".recharts-responsive-container");
    if (!rc) return null;
    const key = Object.keys(rc).find((k) => k.startsWith("__reactFiber"));
    let f = key ? rc[key] : null;
    while (f) {
      let s = f.memoizedState;
      while (s) {
        const ms = s.memoizedState;
        if (ms && typeof ms === "object" && "containerWidth" in ms) {
          return { fiber: f, sizesHook: s };
        }
        s = s.next;
      }
      f = f.return;
    }
    return null;
  };

  const patchResponsiveContainerType = (fiber) => {
    if (!fiber) return false;
    const type = fiber.type;
    if (!type || typeof type !== "object") return false;
    if (type.__frontierPatched) return true;
    if (typeof type.render !== "function") return false;
    const orig = type.render;
    type.render = function (props, ref) {
      if (CHART_HEIGHT_PX && props && typeof props.height === "number") {
        return orig.call(this, { ...props, height: CHART_HEIGHT_PX }, ref);
      }
      return orig.call(this, props, ref);
    };
    type.__frontierPatched = true;
    return true;
  };

  const forceRcRerender = (sizesHook) => {
    if (
      !sizesHook ||
      !sizesHook.queue ||
      typeof sizesHook.queue.dispatch !== "function"
    )
      return;
    const cur = sizesHook.memoizedState;
    if (!cur || typeof cur !== "object") return;
    try {
      sizesHook.queue.dispatch({ ...cur });
    } catch {}
  };

  // Also widen the outer frame so other layout doesn't clip; the real chart
  // height is driven by the prop patch above.
  const applyHeight = (svg) => {
    if (!CHART_HEIGHT) return;
    const rc = findResponsiveContainer(svg);
    if (rc) {
      const frame = rc.parentElement;
      if (frame) {
        frame.style.height = CHART_HEIGHT;
        frame.style.minHeight = CHART_HEIGHT;
      }
    }
    const info = findResponsiveContainerFiber(svg);
    if (!info) return;
    const wasUnpatched = !info.fiber.type || !info.fiber.type.__frontierPatched;
    patchResponsiveContainerType(info.fiber);
    if (wasUnpatched) forceRcRerender(info.sizesHook);
  };

  // ---- data filter ----
  const computeNext = () => {
    if (!originalCreators) return null;
    const source = originalCreators;

    let cutoff = null;
    if (rangeDays != null) {
      let maxMs = 0;
      source.forEach((c) =>
        (c.models || []).forEach((m) => {
          if (!m.releaseDate) return;
          const t = new Date(m.releaseDate).getTime();
          if (t > maxMs) maxMs = t;
        }),
      );
      cutoff = maxMs - rangeDays * 24 * 3600 * 1000;
    }
    const numericMin = typeof yMin === "number" ? yMin : null;
    const numericMax = typeof yMax === "number" ? yMax : null;

    return source.map((c) => ({
      ...c,
      models: (c.models || []).filter((m) => {
        if (cutoff != null) {
          if (!m.releaseDate) return false;
          if (new Date(m.releaseDate).getTime() < cutoff) return false;
        }
        if (
          numericMin != null &&
          (typeof m.intelligenceIndex !== "number" ||
            m.intelligenceIndex < numericMin)
        )
          return false;
        if (
          numericMax != null &&
          (typeof m.intelligenceIndex !== "number" ||
            m.intelligenceIndex > numericMax)
        )
          return false;
        return true;
      }),
    }));
  };

  const wrapDispatch = (hook) => {
    if (dispatchWrapped || !hook) return;
    const orig = hook.queue.dispatch;
    hook.queue.dispatch = function (action) {
      if (action !== lastAppliedPayload && !reapplyScheduled) {
        reapplyScheduled = true;
        queueMicrotask(() => {
          reapplyScheduled = false;
          if (
            Array.isArray(action) &&
            (!originalCreators ||
              action.reduce((a, c) => a + (c.models?.length || 0), 0) >
                originalCreators.reduce(
                  (a, c) => a + (c.models?.length || 0),
                  0,
                ))
          ) {
            originalCreators = action;
          }
          apply();
        });
      }
      return orig.apply(this, arguments);
    };
    dispatchWrapped = true;
  };

  const apply = () => {
    const heading = findHeading();
    if (!heading) return false;
    const svg = findChartSvg(heading);
    if (!svg) return false;
    const svgFiber = getFiber(svg);
    if (!svgFiber) return false;

    const hook = findCreatorsHook(svgFiber);
    if (!hook) return false;

    const store = findReduxStore(svgFiber);
    if (!store) return false;
    chartStore = store;
    patchReduxStore(store); // idempotent per-store
    applyDataFilter(store);

    applyHeight(svg);

    if (!originalCreators) originalCreators = hook.memoizedState;
    wrapDispatch(hook);

    const next = computeNext();
    if (!next) return false;
    try {
      lastAppliedPayload = next;
      hook.queue.dispatch(next);
      reapplyYAxisDomain();
      // If React re-mounts the chart with a fresh store, the old store's
      // subscriber is stranded. Re-find the store after commit and patch it.
      const reSync = () => {
        const h = findHeading();
        if (!h) return;
        const s = findChartSvg(h);
        if (!s) return;
        const f = getFiber(s);
        if (!f) return;
        const cur = findReduxStore(f);
        if (!cur) return;
        chartStore = cur;
        patchReduxStore(cur);
        applyDataFilter(cur);
        reapplyYAxisDomain();
        applyHeight(s);
      };
      requestAnimationFrame(() => requestAnimationFrame(reSync));
      return true;
    } catch (e) {
      console.error("[FrontierControls] dispatch failed", e);
      return false;
    }
  };

  // ---- UI ----
  const injectUI = () => {
    if (document.getElementById(UI_ID)) return true;
    const heading = findHeading();
    if (!heading) return false;

    const wrap = document.createElement("div");
    wrap.id = UI_ID;
    wrap.style.cssText = `
      display: flex; align-items: center; flex-wrap: wrap;
      gap: 10px; margin: 6px 0 4px; font-size: 12px; color: #333;
    `;

    const mkSelect = (options, onChange, initialIdx) => {
      const sel = document.createElement("select");
      sel.style.cssText = `
        padding: 4px 8px; border: 1px solid #ddd; border-radius: 8px;
        background: #f3f6ff; font-size: 12px; cursor: pointer;
      `;
      options.forEach((o, i) => {
        const opt = document.createElement("option");
        opt.value = String(i);
        opt.textContent = o.label;
        sel.appendChild(opt);
      });
      sel.value = String(initialIdx);
      sel.addEventListener("change", () =>
        onChange(parseInt(sel.value, 10), sel),
      );
      return sel;
    };

    const rangeLabel = document.createElement("span");
    rangeLabel.textContent = "Range:";
    rangeLabel.style.fontWeight = "500";
    const rangeSel = mkSelect(
      RANGES,
      (i) => {
        rangeDays = RANGES[i].days;
        apply();
      },
      DEFAULT_RANGE_IDX,
    );

    const yLabel = document.createElement("span");
    yLabel.textContent = "Y min:";
    yLabel.style.fontWeight = "500";
    const yInput = document.createElement("input");
    yInput.type = "number";
    yInput.step = "any";
    yInput.placeholder = "auto";
    yInput.value = DEFAULT_Y_MIN == null ? "" : String(DEFAULT_Y_MIN);
    yInput.style.cssText = `
      width: 72px; padding: 4px 8px; border: 1px solid #ddd; border-radius: 8px;
      background: #f3f6ff; font-size: 12px;
    `;
    const onYChange = () => {
      const v = yInput.value.trim();
      yMin = v === "" || isNaN(Number(v)) ? null : Number(v);
      apply();
    };
    yInput.addEventListener("change", onYChange);
    yInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") onYChange();
    });

    wrap.append(rangeLabel, rangeSel, yLabel, yInput);
    heading.insertAdjacentElement("afterend", wrap);
    return true;
  };

  // Poll until both UI is injected and first apply succeeds.
  let tries = 0;
  let applied = false;
  const timer = setInterval(() => {
    tries++;
    injectUI();
    if (!applied) applied = apply();
    if (applied && tries > 2) clearInterval(timer);
    if (tries > 80) clearInterval(timer);
  }, 300);

  new MutationObserver(() => {
    if (!document.getElementById(UI_ID)) {
      dispatchWrapped = false;
      chartStore = null;
      applied = false;
      tries = 0;
    }
  }).observe(document.body, { childList: true, subtree: true });
})();
