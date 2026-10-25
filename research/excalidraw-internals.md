# Excalidraw internals — reading & modifying the live scene from injected JavaScript

**Target app:** <https://excalidraw.com/> (the user's "extrodinary draw").
**Consumer:** a Chrome MV3 extension — content script (isolated world) + MAIN-world page script — that must
(a) read the drawing, (b) know the current selection, (c) create/update/delete elements, (d) grab a PNG of the canvas or a region — **without Excalidraw's cooperation**.

**How this was researched:** source reading of `github.com/excalidraw/excalidraw` @ `master` (raw.githubusercontent + GitHub REST), plus npm registry/release metadata. **No JavaScript was executed in the page**; every runtime claim is either (i) read straight out of the source with a citation, or (ii) labelled *probe* / *unknown* where it must be confirmed live.

**Snapshot of what the code looked like when this was written:** npm `@excalidraw/excalidraw@0.18.1` (published 2026‑04‑20) is the newest *release*; `master` is well ahead of it (package split into `@excalidraw/{element,common,math}`, `Scene`/`Store`/`History` classes, `ExcalidrawAPIProvider`, `exportScene()` replacing `exportToBlob()`/`exportToSvg()`). excalidraw.com is deployed from the repo, so **treat `master` as authoritative but verify the handful of version-sensitive names at runtime** (see §9 and the probes in §1.8).

---

## 0. TL;DR — ranked strategy

| # | Strategy | Read | Modify | Undo preserved | Reliability | Notes |
|---|----------|------|--------|----------------|-------------|-------|
| **1** | **Reach the `App` instance / `ExcalidrawImperativeAPI` through the React fiber of `canvas.excalidraw__canvas.interactive`**, then use `app.api` (`updateScene`, `mutateElement`, `selection.select`, `history`) | ✅ full fidelity | ✅ full fidelity | ✅ yes (`captureUpdate: "IMMEDIATELY"`) | **High** — this is the same object the React tree and Excalidraw+ use | Nothing in the DOM is obfuscated; only local variable names are minified. Survives minification because we probe *method names on instance objects*. |
| 2 | Same fiber probe, but only to read state; write via `localStorage` + synthetic `focus` event (the app's own cross-tab sync path) | ✅ (from storage) | ⚠️ whole-scene replace, no undo entry (`captureUpdate: NEVER`), 50 ms debounce, races with the app's own 300 ms save | ❌ | Medium | Useful fallback if instantiating calls on `app` ever looks risky, and as a cross-tab channel. |
| 3 | Synthetic pointer/keyboard events on the interactive canvas (`pointerdown/move/up`, tool shortcuts) | ❌ only what you can see | ⚠️ can only *draw new* elements + move/resize/delete the current selection; no precise editing of an arbitrary element | ✅ yes (it's real UI input) | Low–Medium | Needs exact viewport math (§1.4) and a focused container; `setPointerCapture` on fake `pointerId`s is a hazard. |
| 4 | Dispatch a synthetic `drop` with an `.excalidraw` `File` (or `paste` with `application/vnd.excalidraw.clipboard+json`) | ❌ | ⚠️ replaces the scene / inserts a copy at the cursor | ❌ typically resets history | Low | The drop handler is `handleAppOnDrop` bound on `.excalidraw` (`App.tsx#L2425`). Whole-scene semantics, plus overwrite-confirm dialogs on the web app. |
| 5 | Write `localStorage` then `location.reload()` | ✅ | ⚠️ | ❌ | **Low** | *Actively hostile:* `beforeunload` → `LocalData.flushSave()` writes the in-memory state and clobbers your edit. Only safe if written while the page is gone/another tab. |
| 6 | `#json=` / `#url=` scene links | ✅ | ❌ | ❌ | — | `#json=<id>,<key>` requires the Excalidraw+ backend; `#url=` fetches and **replaces** the scene (`initializeScene`, `excalidraw-app/App.tsx`). Not a patch mechanism. |

**Bottom line: do the fiber probe.** One DOM node (`canvas.excalidraw__canvas.interactive`) has the `App` instance one property away (`fiber.return.memoizedProps.app`), and `App` exposes `.api`, `.scene`, `.state`, `.files`, `.history`, `.actionManager`, `.setState`.

---

## 1. Quick reference

### 1.1 Storage keys (current `master`)

`localStorage` (all in `excalidraw-app/app_constants.ts#L44-L56`, `STORAGE_KEYS`):

| Key | Written by | Value |
|---|---|---|
| `excalidraw` | `LocalData.save()` → `saveDataStateToLocalStorage` | JSON **array** of elements, **deleted elements filtered out** (`getNonDeletedElements`) |
| `excalidraw-state` | same | JSON object: `clearAppStateForLocalStorage(appState)` — the `browser: true` subset of `AppState` |
| `version-dataState` | `updateBrowserStateVersion()` | JSON **number** (`Date.now()`), used for cross-tab freshness |
| `version-files` | `LocalData.fileStorage.saveFiles()` | JSON number timestamp |
| `excalidraw-collab` | `saveUsernameToLocalStorage` | `{"username": "..."}` |
| `excalidraw-theme` | `useHandleAppTheme` | `"light" \| "dark" \| "system"` (also read by the inline bootstrap script in `index.html`) |
| `excalidraw-debug` | `excalidraw-app/components/DebugCanvas.tsx` | debug-renderer state |
| `excalidraw-feature-flags` | `getFeatureFlag`/`setFeatureFlag` (`packages/common/src/utils.ts`) | `{"COMPLEX_BINDINGS":false}` |
| `excalidraw-oai-api-key`, `mermaid-to-excalidraw`, `publish-library-data` | `EDITOR_LS_KEYS` (`packages/common/src/constants.ts`) | misc editor prefs |

There is **no** `excalidraw-image-cache` key (nothing by that name exists on `master`). Images live in IndexedDB:

| IDB | Store | Key | Value |
|---|---|---|---|
| `files-db` | `files-store` | `fileId` | `BinaryFileData` `{id, mimeType, data: "data:image/png;base64,…", created, lastRetrieved, version?, versionNonce?}` (`LocalData.ts`, `idb-keyval`) |
| `excalidraw-library-db` | `excalidraw-library-store` | `libraryData` | library items |
| `excalidraw-ttd-chats` (db) | — | — | text-to-diagram chats |

### 1.2 DOM anchors (stable, from source)

```html
<div id="root">                                   <!-- React root; has __reactContainer$… -->
  <div class="excalidraw excalidraw-container notranslate" tabindex="0">   <!-- App.tsx#L2388 -->
    <div class="excalidraw__canvas-wrapper">      <!-- StaticCanvas.tsx -->
      <canvas class="excalidraw__canvas static">  <!-- created by App (new Image-free canvas), inserted via replaceChildren -->
    </div>
    <canvas class="excalidraw__canvas">           <!-- NewElementCanvas.tsx (only while a preview exists) -->
    <canvas class="excalidraw__canvas interactive">  <!-- InteractiveCanvas.tsx: pointer handlers live here -->
    …UI (LayerUI), .excalidraw-textEditorContainer, .excalidraw-contextMenuContainer, SVG layer…
  </div>
</div>
```

* `App.tsx#L2388` — container class string `"excalidraw excalidraw-container notranslate"`.
* `App.tsx#L2424-L2425` — `ref={this.excalidrawContainerRef}` and `onDrop={…this.handleAppOnDrop}` (file drop target).
* `StaticCanvas.tsx` — `props.canvas.classList.add("excalidraw__canvas", "static")`; the static canvas is **not** React-rendered, so **it has no `__reactFiber$` key**.
* `InteractiveCanvas.tsx` — `className="excalidraw__canvas interactive"`, `ref={props.handleCanvasRef}`, and it receives `app={props.app}` (the `App` instance) as a **prop**.

### 1.3 Fiber probe (copy-paste, MAIN world)

```js
// Returns the live ExcalidrawImperativeAPI (master), or the App instance.
function getExcalidrawApp() {
  const host =
    document.querySelector("canvas.excalidraw__canvas.interactive") ||
    document.querySelector(".excalidraw");
  if (!host) return null;

  const isApi = (o) => !!o && typeof o.getSceneElements === "function";
  const isApiLike = (o) => isApi(o) || (!!o && typeof o.updateScene === "function");

  const fk = Object.keys(host).find((k) => k.startsWith("__reactFiber$"));
  const ck = Object.keys(host).find((k) => k.startsWith("__reactContainer$"));
  let fiber = fk ? host[fk] : ck ? host[ck].child : null;   // fallback: React root container

  for (let f = fiber, i = 0; f && i < 300; f = f.return, i++) {
    const p = f.memoizedProps;
    // 1) <InteractiveCanvas app={App}> — one hop from the canvas
    if (p && p.app && typeof p.app.getSceneElements === "function") return p.app;
    // 2) <ExcalidrawAPIProvider> / App.render(): <ExcalidrawAPIContext.Provider value={api}>
    if (p && p.value && isApiLike(p.value)) return p.value;
    // 3) components that take the api as a prop
    if (p && isApiLike(p.excalidrawAPI)) return p.excalidrawAPI;
    // 4) the App class component instance itself (class App extends React.Component, App.tsx#L587)
    if (f.stateNode && typeof f.stateNode.getSceneElements === "function") return f.stateNode;
  }
  return null;
}

const app = getExcalidrawApp();        // App instance (has .api, .scene, .state, .files, .history)
const api = app.api ?? app;            // ExcalidrawImperativeAPI (App.tsx#L793 createExcalidrawAPI)
```

Why this survives minification: terser mangles **local identifiers**, not properties, and we only touch object properties (`memoizedProps`, `stateNode`, `.app`, `.value`, `.api`) and Excalidraw's own **public method names** (`getSceneElements`, `updateScene`, …), which are part of the documented API surface.

### 1.4 Coordinate formulas (exact, from source)

`packages/common/src/utils.ts`:

```ts
export const viewportCoordsToSceneCoords = (
  { clientX, clientY },
  { zoom, offsetLeft, offsetTop, scrollX, scrollY },
) => {
  const x = (clientX - offsetLeft) / zoom.value - scrollX;
  const y = (clientY - offsetTop) / zoom.value - scrollY;
  return { x, y };
};

export const sceneCoordsToViewportCoords = (
  { sceneX, sceneY },
  { zoom, offsetLeft, offsetTop, scrollX, scrollY },
) => {
  const x = (sceneX + scrollX) * zoom.value + offsetLeft;
  const y = (sceneY + scrollY) * zoom.value + offsetTop;
  return { x, y };
};
```

Practical readings:

* `clientX/clientY` are **viewport (CSS pixel)** coordinates — i.e. what `PointerEvent.clientX` and `getBoundingClientRect()` give you. So:
  `screen = (scene + scroll) * zoom.value + offset`, `scene = (screen − offset) / zoom.value − scroll`.
* `appState.offsetLeft/offsetTop` = the canvas origin in client coordinates (computed by `App.getCanvasOffsets()` and seeded into state via `...this.getCanvasOffsets()` at `App.tsx#L872`). **Do not recompute it**: read it from `appState`, or equivalently use
  `document.querySelector('canvas.excalidraw__canvas.interactive').getBoundingClientRect()`.
* `appState.zoom` is an object: `{ value: 0.1 … 30 }` — always `zoom.value`.
* Canvas pixel coordinates (for `drawImage` cropping) are client coords minus the canvas rect, times `devicePixelRatio`:
  `px = (clientX − rect.left) * dpr`, `dpr = canvas.width / rect.width`.

### 1.5 Synthetic input recipe (last-resort path)

```js
const canvas = document.querySelector("canvas.excalidraw__canvas.interactive");
const app = getExcalidrawApp();
const s = app.state;                                  // AppState
const s2c = (sx, sy) => ({
  x: (sx + s.scrollX) * s.zoom.value + s.offsetLeft,
  y: (sy + s.scrollY) * s.zoom.value + s.offsetTop,
});

// keyboard: the web app mounts <Excalidraw handleKeyboardGlobally={true}> (excalidraw-app/App.tsx),
// so shortcuts are listened for on `window`; keys are matched via `KEYS`/`matchKey` (packages/common/src/keys.ts)
window.dispatchEvent(new KeyboardEvent("keydown", { key: "r", code: "KeyR", bubbles: true }));
// ("v"=selection, "r"=rectangle, "d"=diamond, "o"=ellipse, "a"=arrow, "l"=line,
//  "p"=freedraw, "t"=text, "e"=eraser, "h"=hand, "f"=frame …; the exact map lives in
//  components/Tools.tsx `findShapeByKey` — probe it live, it changed with the new tools)

const p0 = s2c(100, 100), p1 = s2c(300, 220);
const base = {
  bubbles: true, cancelable: true, composed: true,
  pointerId: 1, pointerType: "mouse", isPrimary: true, button: 0, buttons: 1,
  clientX: p0.x, clientY: p0.y,
};
canvas.dispatchEvent(new PointerEvent("pointerdown", base));
canvas.dispatchEvent(new PointerEvent("pointermove", { ...base, clientX: p1.x, clientY: p1.y }));
canvas.dispatchEvent(new PointerEvent("pointerup", { ...base, buttons: 0, clientX: p1.x, clientY: p1.y }));
```

Caveats (see §5 risks): Excalidraw uses `setPointerCapture`/`releasePointerCapture` on real pointers in several paths; a fabricated `pointerId` may throw `NotFoundError` (guard with try/catch **inside** the page, you cannot patch Excalidraw). `DRAGGING_THRESHOLD = 10px` means a real drag needs >10px of movement (`packages/common/src/constants.ts`).

### 1.6 Selection API

```js
// READ (always available)
const st   = app.state;                                    // AppState
const ids  = Object.keys(st.selectedElementIds);           // { [elementId]: true }
const els  = app.scene.getSelectedElements(st);            // NonDeletedExcalidrawElement[]
const grps = Object.keys(st.selectedGroupIds || {});       // groups expanded by the selection

// WRITE (master): ExcalidrawImperativeAPI.selection  —  App.tsx#L808 `selection: this.selection`
app.api.selection.select(["id1", "id2"]);                  // replaces selection (group-aware)
app.api.selection.select(["id1"], { deep: true });         // Ctrl+click semantics (skip groups)
app.api.selection.add(["id3"]);
app.api.selection.remove(["id1"]);
app.api.selection.clear();

// WRITE (fallback, works on any version): set the state directly
app.setState((prev) => ({
  selectedElementIds: { id1: true, id2: true },
  selectedGroupIds: {},
  editingGroupId: null,
  previousSelectedElementIds: prev.selectedElementIds,
}));
app.focusContainer?.();          // so keyboard actions target the canvas
```

### 1.7 Snapshot recipe

```js
// full visible canvas, exactly as rendered (no selection UI, no in-progress element)
const staticCanvas = document.querySelector("canvas.excalidraw__canvas.static");
const pngDataUrl  = staticCanvas.toDataURL("image/png");
const pngBlob     = await new Promise((r) => staticCanvas.toBlob(r, "image/png"));

// scene-space region → crop
const s = app.state, rect = staticCanvas.getBoundingClientRect();
const dpr = staticCanvas.width / rect.width;               // = devicePixelRatio (renderer scale)
const sx = (sceneX + s.scrollX) * s.zoom.value * dpr;
const sy = (sceneY + s.scrollY) * s.zoom.value * dpr;
const sw = w * s.zoom.value * dpr, sh = h * s.zoom.value * dpr;
const out = document.createElement("canvas");
out.width = Math.max(1, Math.round(sw)); out.height = Math.max(1, Math.round(sh));
out.getContext("2d").drawImage(staticCanvas, sx, sy, sw, sh, 0, 0, sw, sh);
const regionUrl = out.toDataURL("image/png");
```

### 1.8 Runtime probes to run first on the live page

```js
({
  version: document.querySelector('meta[name="version"]')?.content,  // packages/common/src/utils.ts getVersion()
  sha: window.__EXCALIDRAW_SHA__,                                    // excalidraw-app/index.tsx
  flags: "EXCALIDRAW_THROTTLE_RENDER" in window,                     // excalidraw-app/App.tsx
  hasApp: !!getExcalidrawApp(),
  apiMethods: Object.keys((getExcalidrawApp()?.api) ?? {}).sort(),
  hasSelectionApi: typeof getExcalidrawApp()?.api?.selection?.select,
  canvasClasses: [...document.querySelectorAll("canvas")].map((c) => c.className),
  bindingShape: JSON.parse(localStorage.getItem("excalidraw") || "[]")
    .find((e) => e.startBinding)?.startBinding,                      // {elementId,fixedPoint,mode} vs {elementId,focus,gap}
});
```

---

## 2. Q1 — which globals does excalidraw.com expose?

**Answer: none that hand you the app.** There is deliberately no `window.ExcalidrawApp` / `window.excalidrawAPI`. The complete set of `window` writes in the app shell is:

| Global | Written where | Purpose |
|---|---|---|
| `window.__EXCALIDRAW_SHA__` | `excalidraw-app/index.tsx`: `window.__EXCALIDRAW_SHA__ = import.meta.env.VITE_APP_GIT_SHA` | build SHA, for bug reports |
| `window.EXCALIDRAW_THROTTLE_RENDER = true` | `excalidraw-app/App.tsx` (module scope, first statement after imports) | perf flag |
| `window.visualDebug = {data: []}` *(dev only)* | `excalidraw-app/App.tsx`, inside `if (isDevEnv())` | debug canvas |
| `window.name = "_excalidraw"` | `excalidraw-app/index.html` (inline script) | makes library installs reuse the tab |
| `window.EXCALIDRAW_ASSET_PATH` | **dev only** in `index.html`; in prod it's a *host-supplied input* for embedders | font/asset base URL |
| `window.EXCALIDRAW_EXPORT_SOURCE` | read by `getExportSource()` in `packages/common/src/constants.ts` | stamped into exported JSON (`source`) |
| `window.gtag`, `window.sa_event`, `window.fathom` | analytics | not app state |

Evidence: `packages/excalidraw/global.d.ts` declares exactly the `Window` additions (`ClipboardItem`, `__EXCALIDRAW_SHA__`, `EXCALIDRAW_ASSET_PATH`, `EXCALIDRAW_THROTTLE_RENDER`, `DEBUG_FRACTIONAL_INDICES`, `EXCALIDRAW_EXPORT_SOURCE`, `gtag`, `sa_event`, `fathom`) — that is the whole list the project acknowledges.

**React root:** yes, reachable. `excalidraw-app/index.tsx` does `createRoot(document.getElementById("root")!)`, so `#root` carries `__reactContainer$<random>` and the fiber tree hangs off it. But the *component* tree is:

```
#root (HTMLDivElement; __reactContainer$…)
└─ TopErrorBoundary → Provider(appJotaiStore) → ExcalidrawAPIProvider
   └─ ExcalidrawWrapper
      └─ div.excalidraw-app
         └─ Excalidraw (React.memo(ExcalidrawBase), packages/excalidraw/index.tsx)
            └─ EditorJotaiProvider → InitializeApp
               └─ App  (class App extends React.Component<AppProps, AppState>, App.tsx#L587)
                  └─ div.excalidraw.excalidraw-container.notranslate   (App.tsx#L2388)
                     └─ ExcalidrawAPIContext.Provider value={this.api}  (App.tsx#L2443)
                        └─ AppContext.Provider value={this}             (App.tsx#L2444)
                           └─ … LayerUI, StaticCanvas, InteractiveCanvas …
```

So: **the app instance is one `.return` walk away from any canvas/container DOM node**, and `App.api` is the documented `ExcalidrawImperativeAPI`.

---

## 3. Q2 — reaching the running component reliably (React fiber)

### 3.1 What the exported component accepts (the props we look for)

`packages/excalidraw/index.tsx` — `ExcalidrawBase(props: ExcalidrawProps)` destructures (relevant subset): `onExcalidrawAPI`, `onMount`, `onUnmount`, `onInitialize`, `initialData`, `initialState`, `onChange`, `onPointerUpdate`, `onScrollChange`, `viewModeEnabled`, `interaction`, `ui`, `activeTool`, `UIOptions`, `children`, … It **does not** accept an `excalidrawAPI` prop (that was the pre‑0.17 `ref` API). Instead:

* `ExcalidrawAPIContext` / `ExcalidrawAPISetContext` are created in `App.tsx#L527` and re-exported from `packages/excalidraw/index.tsx`;
* `ExcalidrawAPIProvider` holds `const [api, setApi] = useState(null)` and publishes it through `ExcalidrawAPIContext.Provider`;
* `ExcalidrawBase` calls `handleExcalidrawAPI(api) → setExcalidrawAPI?.(api); onExcalidrawAPIRef.current?.(api)`;
* the **`App` class itself builds the API object** in `createExcalidrawAPI()` (`App.tsx#L793-L838`) and stores it as `this.api` (`App.tsx#L924`), then provides it to the tree at `App.tsx#L2443`.

Full `ExcalidrawImperativeAPI` surface as built on `master` (`App.tsx#L793-L838`) — this is exactly what the fiber probe hands you:

```
isDestroyed, updateScene, applyDeltas, mutateElement, updateLibrary, addFiles, resetScene,
getSceneElementsIncludingDeleted, getSceneElementsMapIncludingDeleted,
history: { clear },                 // note: only `clear` is exposed on the api object
selection,                          // AppSelection: select/add/remove/clear
setViewport, getViewportOffsets, setElementRenderOverrides,
getSceneElements, getAppState, getFiles, getName,
registerAction, refresh, setToast, id,
setActiveTool, setCursor, resetCursor, getEditorInterface, updateFrameRendering,
toggleSidebar,
onChange, onIncrement, onPointerDown, onPointerUp, onScrollChange, onUserFollow,
onStateChange, onEvent
```

The **`App` instance** (what `stateNode` gives you) is much richer than `api`:

```js
app.state                  // AppState (React state) — scrollX/scrollY/zoom/selectedElementIds/...
app.props                  // AppProps
app.scene                  // Scene: getElementsIncludingDeleted(), getNonDeletedElements(),
                           //        getNonDeletedElementsMap(), getElement(id), mutateElement(el, updates)
app.api                    // ExcalidrawImperativeAPI
app.files                  // BinaryFiles (image data URLs, keyed by fileId)
app.history                // History (undo/redo stack; api only exposes history.clear)
app.actionManager          // ActionManager (executeAction / registered actions)
app.store                  // Store (scene increments, undo scheduling)
app.setAppState            // (state) => void  (App.tsx#L2464 value={this.setAppState})
app.setState               // React setState (partial AppState)
app.getSceneElements(), app.getSceneElementsIncludingDeleted(),
app.mutateElement(el, updates, opts), app.updateScene({...}),
app.resetScene(), app.refresh(), app.focusContainer(),
app.getCanvasOffsets(), app.isInteractionEnabled(),
app.text / app.viewport / app.wheel / app.selection / app.cursor / app.clipboard / ...
```

### 3.2 Why start from the interactive canvas

`InteractiveCanvas` is a **function component** that receives `app={props.app}` (`App.tsx#L2698`, `InteractiveCanvas.tsx` props `app: AppClassProperties`). The `<canvas>` it renders is a host fiber whose `.return` is that function-component fiber. Therefore:

```js
const canvas = document.querySelector('canvas.excalidraw__canvas.interactive');
const fiber  = canvas[Object.keys(canvas).find(k => k.startsWith('__reactFiber$'))];
fiber.return.memoizedProps.app      // === App instance   ← one hop, no walking
fiber.return.memoizedProps.appState // the AppState snapshot used for that render
fiber.return.memoizedProps.handleCanvasRef
```

Bonus: `fiber.return.memoizedProps.appState` is a *render-consistent* snapshot (useful if you want the state the pixels were painted from, rather than `app.state` which may be newer).

### 3.3 Concrete search strategy for the live page

Probe in this order, on `canvas.excalidraw__canvas.interactive`, then `.excalidraw`, then `#root`, then `document.body`:

1. `Object.keys(node).filter(k => k.startsWith('__reactFiber$'))` → host fiber.
2. `Object.keys(node).filter(k => k.startsWith('__reactContainer$'))` → HostRoot fiber; use `.child` (React 18/19 `createRoot`).
3. Walk `.return` up to ~300 levels; at each fiber test, in this order:
   * `f.memoizedProps.app` — has `getSceneElements`? → **App instance** (InteractiveCanvas).
   * `f.memoizedProps.value` — has `getSceneElements`/`updateScene`? → **the API** (`ExcalidrawAPIContext.Provider`).
   * `f.memoizedProps.excalidrawAPI` → API passed as prop (some components do this).
   * `f.stateNode` — has `getSceneElements`? → **App class instance** (`class App extends React.Component`).
4. Cache the result in a module-level variable; invalidate on `popstate`/`hashchange`/canvas replacement (Excalidraw re-mounts on some flows — StrictMode double-mounts in dev only).
5. If you also need to survive a reloaded React tree, park the reference on `window.__myExt = {app}` from the MAIN world.

Also useful downward probes (for state without the app): `AppContext.Provider value={this}` (`App.tsx#L2444`), `ExcalidrawAppStateContext.Provider value={this.state}`, `ExcalidrawElementsContext.Provider value={this.scene.getNonDeletedElements()}` — all are providers *inside* the `.excalidraw` subtree, so a **downward** `fiber.child` walk from the container fiber can also find them.

### 3.4 Fallbacks if the fiber probe fails

| Fallback | Mechanism | When to use |
|---|---|---|
| React DevTools hook | Read `window.__REACT_DEVTOOLS_GLOBAL_HOOK__?.renderers` → `renderer.findFiberByHostInstance(node)` — Excalidraw ships no DevTools hook, so this only works if the user has React DevTools installed | never rely on it |
| DOM-only read | `localStorage["excalidraw"]` + `localStorage["excalidraw-state"]` | read-only, always works |
| DOM-only write | `localStorage` + synthetic `focus` (see §5.1) | when the fiber path is blocked |
| Input synthesis | §4.3 | when you only need "draw something new" |
| `#url=` link | navigate with `#url=<encoded https url to .excalidraw>`; `initializeScene()` fetches it (`excalidraw-app/App.tsx`) | full-scene loads only, destroys the current scene |

---

## 4. Q3 — what exactly is persisted

### 4.1 Elements (`localStorage["excalidraw"]`)

Written by `saveDataStateToLocalStorage()` in `excalidraw-app/data/LocalData.ts`:

```ts
localStorage.setItem(STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS, JSON.stringify(getNonDeletedElements(elements)));
localStorage.setItem(STORAGE_KEYS.LOCAL_STORAGE_APP_STATE, JSON.stringify(_appState));
updateBrowserStateVersion(STORAGE_KEYS.VERSION_DATA_STATE);
```

Two consequences that matter a lot for us:

* **Deleted elements are not persisted** (`getNonDeletedElements`). A "delete" is therefore not recoverable from localStorage, and writing back a list without an element *is* a delete.
* Saving is **debounced 300 ms** (`SAVE_TO_LOCAL_STORAGE_TIMEOUT = 300`) and happens through `LocalData.save()`, called from `onChange` in `excalidraw-app/App.tsx`; it also flushes on `blur`/`hidden`/`beforeunload` (`LocalData.flushSave`).

### 4.2 `localStorage["excalidraw-state"]`

`clearAppStateForLocalStorage(appState)` keeps only keys flagged `browser: true` in `APP_STATE_STORAGE_CONF` (`packages/excalidraw/appState.ts`). Persisted group (exact flag list, `browser: true`):

`showWelcomeScreen, theme, currentItemBackgroundColor, currentItemEndArrowhead, currentItemFillStyle, currentItemFontFamily, currentItemFontSize, currentItemRoundness, currentItemArrowType, currentItemOpacity, currentItemRoughness, currentItemStrokeVariability, currentItemStartArrowhead, currentItemStrokeColor, currentItemStickynoteStrokeColor, currentItemStickynoteBackgroundColor, currentItemStrokeStyle, currentItemStrokeWidthKey, currentItemTextAlign, cursorButton, editingGroupId, activeTool, preferredSelectionTool, penMode, penDetected, exportBackground, exportEmbedScene, exportScale, exportWithDarkMode, gridSize, gridStep, gridModeEnabled, isBindingEnabled, boxSelectionMode, bindingPreference, isMidpointSnappingEnabled, showHints, inputDevice, defaultSidebarDockedPreference, lastPointerDownWith, name, openMenu, openSidebar, previousSelectedElementIds, scrolledOutside, scrollX, scrollY, selectedElementIds, selectedGroupIds, shouldCacheIgnoreZoom, stats, viewBackgroundColor, zenModeEnabled, zoom, selectedLinearElement, objectsSnapModeEnabled, lockedMultiSelections, bindMode, colorTopPicks, fontTopPicks`

**Not** persisted (read them from the live app): `width, height, offsetLeft, offsetTop, collaborators, newElement, selectionElement, editingTextElement, resizingElement, hoveredElementIds, frameRendering, snapLines, originSnapOffset, searchMatches, contextMenu, openDialog, activeEmbeddable, toast, isCropping, croppingElementId, activeLockedId, viewModeEnabled, multiElement, suggestedBinding, elementsToHighlight, frameToHighlight, editingFrame, isLoading, isResizing, isRotating, textToolHover, currentHoveredFontFamily, fileHandle, scrollConstraints, selectedElementsAreBeingDragged, errorMessage, showHyperlinkPopup`

Notable shape details:

```jsonc
{
  "scrollX": -123.5, "scrollY": 44,          // scene offset of the viewport top-left
  "zoom": { "value": 1 },                    // NormalizedZoomValue object, 0.1 … 30
  "selectedElementIds": { "<id>": true },
  "selectedGroupIds":   { "<groupId>": true },
  "previousSelectedElementIds": { "<id>": true },
  "activeTool": { "type": "selection", "customType": null, "locked": false, "fromSelection": false, "lastActiveTool": null },
  "preferredSelectionTool": { "type": "selection", "initialized": false },
  "stats": { "open": false, "panels": 3 },
  "frameRendering": … /* not stored */
}
```

`appState` in `localStorage` is re-hydrated through `restoreAppState(parsed, null)` merged over `getDefaultAppState()` on load (`excalidraw-app/App.tsx#initializeScene`, `data/localStorage.ts#importFromLocalStorage`), so missing keys are fine and `zoom` must be `{value}` (a bare number is repaired by `restoreAppState`).

### 4.3 Element schema (`packages/element/src/types.ts`, `master`)

```ts
type _ExcalidrawElementBase = Readonly<{
  id: string;
  x: number; y: number; strokeColor: string; backgroundColor: string;
  fillStyle: "hachure" | "cross-hatch" | "solid" | "zigzag";
  strokeWidth: number;                       // 0.5/1/2 for freedraw, 1/2/4 otherwise
  strokeStyle: "solid" | "dashed" | "dotted";
  roundness: null | { type: 1|2|3; value?: number };   // ROUNDNESS LEGACY|PROPORTIONAL_RADIUS|ADAPTIVE_RADIUS
  roughness: number;                          // 0 architect, 1 artist, 2 cartoonist
  opacity: number;                            // 0..100
  width: number; height: number;
  angle: Radians;                             // radians, not degrees
  seed: number; version: number; versionNonce: number;
  index: FractionalIndex | null;              // fractional-indexing string; ordering primitive
  isDeleted: boolean;
  groupIds: readonly GroupId[];               // deepest → shallowest
  frameId: string | null;
  boundElements: readonly {id, type: "arrow"|"text"}[] | null;
  updated: number;                            // epoch ms
  created: number | null;                     // epoch ms; new on master
  link: string | null; locked: boolean;
  customData?: Record<string, any>;
}>;
```

Per-type extras:

| `type` | extra fields |
|---|---|
| `selection` (transient) | — |
| `rectangle` / `diamond` / `ellipse` | — |
| `stickynote` | `baseHeight: number` *(new)* |
| `text` | `fontSize, fontFamily (1..10), baseFontSize: number|null, text, originalText, textAlign ("left"\|"center"\|"right"), verticalAlign ("top"\|"middle"\|"bottom"), containerId, autoResize, lineHeight (unitless, branded), labelPosition?: number|null` |
| `line` / `arrow` | `points: readonly LocalPoint[]` (relative to `x,y`), `startBinding, endBinding: FixedPointBinding \| null`, `startArrowhead, endArrowhead` (`"arrow"\|"bar"\|"circle"\|"circle_outline"\|"triangle"\|"triangle_outline"\|"diamond"\|"diamond_outline"\|"cardinality_*"` + legacy), plus `polygon: boolean` for `line`, `elbowed: boolean` for `arrow` (elbow arrows also `fixedSegments`, `startIsSpecial`, `endIsSpecial`) |
| `freedraw` | `points, pressures, simulatePressure, strokeOptions: {variability, streamline}` |
| `image` | `fileId, status ("pending"\|"saved"\|"error"), scale: [number, number], crop: ImageCrop \| null` |
| `frame` / `magicframe` | `name: string \| null` |
| `iframe` | `customData?: { generationData?: MagicGenerationData }` |
| `embeddable` | — |

Family: `FONT_FAMILY = { Virgil: 1, Helvetica: 2, Cascadia: 3, Excalifont: 5, Nunito: 6, "Lilita One": 7, "Comic Shanns": 8, "Liberation Sans": 9, Assistant: 10 }` (4 unused). `DEFAULT_FONT_FAMILY = Excalifont (5)`, `DEFAULT_FONT_SIZE = 20`.

**Binding shape changed on `master`** — `FixedPointBinding` is now:

```ts
{ elementId: string; fixedPoint: [number, number]; mode: "inside" | "orbit" | "skip" }
```

not the old `{ elementId, focus, gap }` from ≤0.18 docs. If you author arrows yourself, prefer cloning an existing arrow and only changing `points`/`x`/`y`/`startBinding.elementId`, or call `restoreElements()` (unreachable from the page) / let the app repair it.

**Ordering:** rely on array order for z-order, but keep `index` (fractional index) consistent. `syncInvalidIndices`/`syncMovedIndices` repair them; hand-written elements without `index` are likely to be re-indexed, which is fine as long as you don't splice two elements with the same index.

### 4.4 File/JSON envelope (for the drop/`#url=` paths)

`serializeAsJSON()` (`packages/excalidraw/data/json.ts`):

```jsonc
{
  "type": "excalidraw",            // EXPORT_DATA_TYPES.excalidraw
  "version": 2,                    // VERSIONS.excalidraw
  "source": "https://excalidraw.com",   // getExportSource() → window.EXCALIDRAW_EXPORT_SOURCE || location.origin
  "elements": [ … ],
  "appState": { …cleanAppStateForExport… },   // viewBackgroundColor, gridSize, gridStep, gridModeEnabled only(ish)
  "files": { "<fileId>": { id, mimeType, data, created, lastRetrieved } }
}
```

MIME types (`packages/common/src/constants.ts`): `application/vnd.excalidraw+json` (`.excalidraw`), `application/vnd.excalidraw.clipboard+json` (clipboard payload), `application/vnd.excalidrawlib+json` (library); the app also accepts `.excalidraw.png` / `.excalidraw.svg` with an embedded payload.

---

## 5. Q4 — applying modifications without the component API

### 5.1 (i) localStorage + reload **or** + synthesized `focus`

*Write path*: `excalidraw-app/App.tsx` registers, inside a `useEffect`:

```ts
window.addEventListener(EVENT.FOCUS, visibilityChange, false);
document.addEventListener(EVENT.VISIBILITY_CHANGE, visibilityChange, false);
window.addEventListener(EVENT.BLUR, visibilityChange, false);
window.addEventListener(EVENT.BEFORE_UNLOAD, unloadHandler);   // → LocalData.flushSave()
```

and `visibilityChange` calls `syncData()` (debounced `SYNC_BROWSER_TABS_TIMEOUT = 50`), which does:

```ts
if (!document.hidden && ((collabAPI && !collabAPI.isCollaborating()) || isCollabDisabled)) {
  if (isBrowserStorageStateNewer(STORAGE_KEYS.VERSION_DATA_STATE)) {
    const localDataState = importFromLocalStorage();
    …
    excalidrawAPI.updateScene({ ...localDataState, captureUpdate: CaptureUpdateAction.NEVER });
  }
}
```

`isBrowserStorageStateNewer()` (`excalidraw-app/data/tabSync.ts`) is just `JSON.parse(localStorage.getItem("version-dataState")) > lastKnownVersion`.

**So the in-page write recipe works, no reload:**

```js
const ELS = "excalidraw", ST = "excalidraw-state", VER = "version-dataState";
await new Promise(r => setTimeout(r, 400));            // let the app's 300 ms save settle
const elements = JSON.parse(localStorage.getItem(ELS) || "[]");
/* mutate the array: push new elements, replace objects, splice out deletions */
localStorage.setItem(ELS, JSON.stringify(elements.filter(e => !e.isDeleted)));
localStorage.setItem(VER, JSON.stringify(Date.now())); // must exceed the app's last save ts
window.dispatchEvent(new Event("focus"));              // triggers syncData() → updateScene()
```

Trade-offs: **no undo entry** (`CaptureUpdateAction.NEVER`), whole-scene replace, you lose everything not persisted (deleted elements, `frameRendering`, in-flight edits, per-element `isDeleted`), the app's own debounced save can overwrite you (mitigate with the 400 ms settle), and any `updateScene` of yours must carry a *complete* element array.

*Reload variant is worse*: `beforeunload` → `LocalData.flushSave()` writes the app's in-memory state over your edit. Only viable if you write from another tab/document while the tab is gone, or if you write and then reload from a *new* tab.

### 5.2 (ii) Synthetic `drop` / `paste`

* Drop: the container `.excalidraw` has `onDrop={this.isFileDropEnabled() ? this.handleAppOnDrop : undefined}` (`App.tsx#L2425`). A `DataTransfer` with a `File` named `x.excalidraw` and `type: "application/vnd.excalidraw+json"` is handed to `loadSceneOrLibraryFromBlob()` → the **whole scene is replaced** (with overwrite-confirm UI in the web app), and files are imported from `data.files`.
* Paste: `ALLOWED_PASTE_MIME_TYPES = ["text/plain", "text/html", …images…]` (`constants.ts`); Excalidraw's own clipboard format is `application/vnd.excalidraw.clipboard+json` (`{ type: "excalidraw/clipboard", elements, files }`), produced by `copyToClipboard`. Programmatic `navigator.clipboard.write` + synthesized `paste` is possible but the app's paste handler is a document/`window` listener that also consults `parseDataTransferEvent` — fragile and permission-gated.

Verdict: useful only for "load a whole scene" / "insert a copy", never for surgical edits, and generally loses undo.

### 5.3 (iii) Synthetic pointer events

Feasible for *creating* geometry and for operating on the existing selection (move/delete/resize via keyboard), because all pointer handlers are React props on the interactive canvas (`InteractiveCanvas.tsx`: `onPointerDown/Move/Up/Cancel/DoubleClick/ContextMenu`) and the keyboard handler is on `window` (`handleKeyboardGlobally={true}` in `excalidraw-app/App.tsx`).

Recipe and math: §1.5 / §1.4. Necessary ingredients:

* Convert scene → client with `sceneCoordsToViewportCoords` semantics (`(scene + scroll) * zoom.value + offset`);
* `pointerType: "mouse"`, stable `pointerId`, `button: 0`, `buttons: 1` → `0` on up, `bubbles: true`;
* dispatch on the **interactive canvas**, in order, with at least one `pointermove` > `DRAGGING_THRESHOLD` (10 px) for drag gestures;
* `KeyboardEvent` on `window` with both `key` and `code` (`matchKey()` prefers `key`, falls back to `code` for non-latin layouts);
* the container must be focused (`app.focusContainer()` / `container.focus()`), otherwise `handleKeyboardGlobally` still catches it on `window`, but text editing etc. won't.

Risks: `setPointerCapture` on a fabricated id can throw; hit-testing/`POINTER_BUTTON` constants (`MAIN: 0, WHEEL: 1, SECONDARY: 2, TOUCH: -1, ERASER: 5`) must match; snapping, grid, multi-touch gestures and `interaction` gates can silently swallow the gesture.

### 5.4 (iv) `#json=` / `#url=` links

`initializeScene()` in `excalidraw-app/App.tsx` matches `^#json=([a-zA-Z0-9_-]+),([a-zA-Z0-9_-]+)$` (Excalidraw+ backend, encryption key → `importFromBackend`) and `^#url=(.*)$` (plain fetch → `loadFromBlob`). Both **replace** the current scene and `window.history.replaceState` the hash away. No use for patching.

### 5.5 The recommended way (uses the API you already reached)

```js
const app = getExcalidrawApp();
const api = app.api ?? app;

// ADD — build a complete element (or better: clone one and mutate it)
const el = {
  id: crypto.randomUUID().replace(/-/g, "").slice(0, 20),
  type: "rectangle", x: 100, y: 100, width: 200, height: 120, angle: 0,
  strokeColor: "#1e1e1e", backgroundColor: "transparent", fillStyle: "solid",
  strokeWidth: 2, strokeStyle: "solid", roundness: { type: 3 }, roughness: 1,
  opacity: 100, seed: (Math.random() * 2 ** 31) | 0,
  version: 1, versionNonce: (Math.random() * 2 ** 31) | 0,
  index: null, isDeleted: false, groupIds: [], frameId: null,
  boundElements: [], updated: Date.now(), created: Date.now(),
  link: null, locked: false,
};
api.updateScene({
  elements: [...api.getSceneElementsIncludingDeleted(), el],
  captureUpdate: "IMMEDIATELY",          // CaptureUpdateAction.IMMEDIATELY → own undo entry
});

// UPDATE — mutateElement handles version/versionNonce/bindings/re-render
const target = api.getSceneElements().find(e => e.id === id);
app.mutateElement(target, { x: 300, y: 250 });       // or { strokeColor: "#e03131" }

// DELETE — deleted elements stay in the array with isDeleted: true
api.updateScene({
  elements: api.getSceneElementsIncludingDeleted().map(e =>
    e.id === id ? { ...e, isDeleted: true, version: e.version + 1,
                    versionNonce: (Math.random() * 2 ** 31) | 0, updated: Date.now() } : e),
  captureUpdate: "IMMEDIATELY",
});

// SELECT
api.selection?.select([id]);            // master; else app.setState({selectedElementIds:{[id]:true}})
```

`CaptureUpdateAction` is a string enum (`IMMEDIATELY | EVENTUALLY | NEVER`); `updateScene`'s default is `EVENTUALLY` (batched into the next undo step). Passing `"IMMEDIATELY"` is what makes each call its own undo entry.

---

## 6. Q5 — selection and region scoping

**Model.** Selection is *ids in app state*, not a separate object:

* `appState.selectedElementIds: Record<elementId, true>`
* `appState.selectedGroupIds: Record<groupId, true>` — filled in by `selectGroupsForSelectedElements()` (`components/App.selection.ts`), which expands a selected element to its **whole innermost group** unless `editingGroupId` covers it
* `appState.previousSelectedElementIds` (for restoring selection after e.g. undo)
* `appState.editingGroupId` (group you've "entered")
* `appState.selectedLinearElement` (line editor state for a lone line/arrow)
* `appState.hoveredElementIds`, `appState.elementsToHighlight` — hover/highlight, not selection

**Reading it:** `app.scene.getSelectedElements(app.state)` (`packages/element/src/selection.ts#getSelectedElements`, options `{ includeBoundTextElement, includeElementsInFrames }`). It skips deleted ids and logs an invariant error if a deleted element is selected. `getTargetElements()` additionally folds in `editingTextElement` / `newElement`.

**Writing it:** `api.selection` (`AppSelection` class, `components/App.selection.ts`):

| method | semantics |
|---|---|
| `select(elementsOrIds, { captureUpdate?, includeLocked?, deep? })` | replaces selection; group-aware; `deep: true` = Ctrl+click (select element, not group) |
| `add(elementsOrIds, {…})` | union; a frame added deselects its children; adding a child of a selected frame is dropped |
| `remove(elementsOrIds)` | removes, plus the group it was selected through |
| `clear()` | empties selection, ends cropping, keeps text editing |

Locked elements are excluded unless `includeLocked`, and elements are resolved **from the scene by id** (missing/deleted silently skipped).

**Marquee / box selection:** there is no "marquee API"; the marquee is `appState.selectionElement` (a transient `selection` element created during the drag) plus `appState.boxSelectionMode: "contain" | "overlap"` (`APP_STATE_STORAGE_CONF`). The geometry helper is exported:

```ts
getElementsWithinSelection(elements, selectionElement, elementsMap, excludeElementsInFrames = true, boxSelectionMode = "contain")
```

so region scoping = build a synthetic `selection`-type rect + call that, or simply filter yourself with `elementsOverlappingBBox({ elements, bounds, elementsMap, type: boxSelectionMode, shouldIgnoreElementFromSelection, excludeElementsInFrames })`.

**Frames as scope primitive:** frames are elements of `type: "frame" | "magicframe"` with `name`; children carry `frameId`. Selection rules are explicit (`excludeElementsInFramesFromSelection`, `getFramesSelectedViaGroups`): *a frame and its children are never selected together.* For "operate on the diagram in this region", a frame is a much better anchor than a marquee — stable id, `frameId` gives you the members, `appState.frameRendering` decides clipping/labels.

**Bounding box of a selection:**

```js
const els = api.getSceneElements().filter(e => app.state.selectedElementIds[e.id]);
const [x1, y1, x2, y2] = window.__exc_getCommonBounds
  ? window.__exc_getCommonBounds(els)                   // if you exported it
  : els.reduce(([ax, ay, bx, by], e) => {               // fallback: axis-aligned, ignores rotation
      return [Math.min(ax, e.x), Math.min(ay, e.y),
              Math.max(bx, e.x + e.width), Math.max(by, e.y + e.height)];
    }, [Infinity, Infinity, -Infinity, -Infinity]);
const bbox = { x: x1, y: y1, width: x2 - x1, height: y2 - y1, cx: (x1 + x2) / 2, cy: (y1 + y2) / 2 };
```

`getCommonBounds(elements)` (`packages/element/src/bounds.ts`, re-exported from `packages/excalidraw/index.tsx`) returns `[minX, minY, maxX, maxY]` and accounts for rotation via `getElementAbsoluteCoords`. It is **not** on `window` — reach it only if you can get a module reference (you can't without an import map), so prefer the fallback loop or `app.scene.getSelectedElements(...)` + your own math (rotation-aware version: use `getElementAbsoluteCoords` semantics: rotate the four corners around the element centre).

---

## 7. Q6 — snapshots (PNG/SVG) from injected JS

**Which canvases exist** (all inside `.excalidraw`):

| canvas | class | who draws | contents | readable? |
|---|---|---|---|---|
| static | `excalidraw__canvas static` | `renderStaticScene()` into the canvas created in `App`'s constructor (`App.tsx#L900`) and inserted by `StaticCanvas`'s `wrapper.replaceChildren(canvas)` | **the drawing**: background, grid, frames, all committed elements | ✅ `toDataURL`/`toBlob` |
| new-element | `excalidraw__canvas` | `renderNewElementScene()` (`NewElementCanvas.tsx`) | the element currently being drawn (preview), only while it exists | ✅ |
| interactive | `excalidraw__canvas interactive` | `renderInteractiveScene()` | selection outlines/handles, marquee, snap lines, collaborator cursors, **no** committed element pixels | ✅ (but transparent where nothing is drawn) |

So: **the drawing lives on the static canvas only**, and the interactive overlay is a separate canvas — which is great news: `static.toDataURL()` gives you a clean image *without* selection handles.

**Why this is the right snapshot path:** `exportToBlob` is *not* public API on `master` (see §9); `exportToCanvas`/`exportToSvg`/`exportToBlob` are internal to `packages/excalidraw/scene/export.ts` and only reachable via the exported `exportScene({type, data, config})` — a **module export**, i.e. unreachable from page JS unless you can import the bundle. Pixel copy needs nothing.

**Taint:** Excalidraw draws images from `BinaryFileData.data`, which is a **data URL** loaded from IndexedDB (`files-db`) — data URLs are same-origin and do **not** taint the canvas. Cross-origin embeds (`iframe`/`embeddable`) are DOM elements, not canvas pixels. The realistic taint risks are: (a) an image element whose `fileId` resolves to a remote `http(s)` URL (not how the app stores files), and (b) a browser extension or the app itself drawing a cross-origin image. Probe once:

```js
try { staticCanvas.getContext("2d").getImageData(0, 0, 1, 1); /* not tainted */ }
catch (e) { /* SecurityError → tainted */ }
```

**Resolution:** canvas backing store is `appState.width * devicePixelRatio` (`StaticCanvas.tsx`: `canvas.width = appState.width * scale`, CSS width = `appState.width`), so `toDataURL` already gives a DPR-quality image. For a 2× export, scale your crop canvas (no re-render available without the app).

**Region:** §1.7. Use scene coords → CSS px relative to the canvas (drop `offsetLeft/offsetTop`), multiply by `dpr`.

**SVG:** not obtainable from pixels. Options: (i) reconstruct SVG yourself from the elements (`renderSceneToSvg` is unreachable); (ii) if you reached `app`, note that `exportScene` is not exposed on the instance either — `app.onExportImage("svg", …)` exists (`App.tsx#L~2900`+) but goes through `exportCanvas()` from `../data` which triggers a **file save / clipboard** flow, i.e. a download or permission prompt, not a return value. So: PNG from the static canvas, SVG by your own renderer or not at all.

---

## 8. Q7 — CSP and injection mechanics

**CSP: none from the app.** `vercel.json` (repo root) defines only:

```
Access-Control-Allow-Origin: https://excalidraw.com
X-Content-Type-Options: nosniff
Feature-Policy: *
Referrer-Policy: origin
```

No `Content-Security-Policy`, no `Cross-Origin-Opener-Policy`/`Cross-Origin-Embedder-Policy`, no `Cross-Origin-Resource-Policy` — hence **no cross-origin isolation** and **no `script-src` restrictions from the app's own deployment config**. Corroborating evidence: `excalidraw-app/index.html` ships **inline `<script>` blocks in production** (theme bootstrap from `localStorage["excalidraw-theme"]`, the `excplus-autoredirect` cookie redirect, `window.name = "_excalidraw"`, and the dynamically-injected simpleanalytics loader). Inline scripts shipping in prod ⇒ inline execution is allowed on excalidraw.com.

Caveats to verify on the wire (server/CDN may add headers that aren't in `vercel.json`): check
`document.querySelector('meta[http-equiv="Content-Security-Policy"]')` and the `Content-Security-Policy` **response header** in the extension's `chrome.webRequest`/devtools. If a CSP were added later, `chrome.scripting.executeScript({world:"MAIN"})` is **not** subject to the page's CSP (it's an extension-world injection), whereas injecting a `<script src=chrome.runtime.getURL(...)>` **is** subject to `script-src` and requires `web_accessible_resources`.

**Service worker:** yes, one is registered — `excalidraw-app/index.tsx` calls `registerSW()` from `virtual:pwa-register` (vite-plugin-pwa). It's a caching SW (`Cache-Control`/precache), not a proxy: it does not interfere with extension injection, but it *can* serve a stale bundle right after a deploy, which slightly widens the "which version am I looking at" uncertainty (§9). No `crossOriginIsolated`, so `SharedArrayBuffer`-style tricks aren't relevant.

**Injection route (recommended, MV3, Chrome ≥ 111):** declare a second content script entry in the MAIN world. No `scripting` permission, no `web_accessible_resources`, and it runs before the app boots:

```json
{
  "manifest_version": 3,
  "name": "Excalidraw bridge",
  "version": "1.0.0",
  "host_permissions": ["https://excalidraw.com/*"],
  "content_scripts": [
    { "matches": ["https://excalidraw.com/*"], "js": ["isolated.js"],  "run_at": "document_idle",   "world": "ISOLATED" },
    { "matches": ["https://excalidraw.com/*"], "js": ["main-world.js"], "run_at": "document_start", "world": "MAIN" }
  ]
}
```

**Alternative A — `chrome.scripting.executeScript` with `world: "MAIN"`** (needs `"permissions": ["scripting"]` + host permission; Chrome ≥ 102):

```js
// from the isolated content script / service worker
const [{ result }] = await chrome.scripting.executeScript({
  target: { tabId },
  world: "MAIN",
  func: () => { /* fiber probe; return JSON-serializable data */ },
  args: [],
});
```

The function is serialized, so it must be self-contained (no closures over extension globals) and its **return value must be JSON-serializable** — you cannot return the `App` object; stash it on `window.__excBridge` in the MAIN world instead.

**Alternative B — `<script src=chrome.runtime.getURL("main.js")>`** from the isolated content script: requires
`"web_accessible_resources": [{ "resources": ["main.js"], "matches": ["https://excalidraw.com/*"] }]`, and works today because there is no CSP; it would break if a `script-src` CSP ever appears.

**Main ↔ isolated bridge:** MAIN world has no `chrome.*` APIs; ISOLATED world cannot see React fibers. Use `window.postMessage` / `CustomEvent` + a request-id protocol, or `window.dispatchEvent(new CustomEvent("ext:req", {detail}))` with a `detail` payload of plain JSON. Keep everything JSON-serializable (element arrays are, by design: "ExcalidrawElement should be JSON serializable").

**Timing:** `document_start` is fine for *installing* the bridge, but the fiber tree only exists after React mounts — poll for `canvas.excalidraw__canvas.interactive` (`MutationObserver` on `#root`, then a `requestAnimationFrame` retry loop), with a `MAX ~10 s` budget.

---

## 9. Q8 — version facts and recent API changes

* **Newest npm release:** `@excalidraw/excalidraw@0.18.1`, published **2026‑04‑20** (release notes: security patch for the Mermaid XSS CVE‑2025‑54881). `latest` on the registry is still 0.18.1.
* **excalidraw.com** is deployed from the repo (Vercel; `vercel.json` `outputDirectory: "excalidraw-app/build"`), i.e. it tracks `master` + a PWA service worker that may serve a slightly stale bundle.
* **Read the version at runtime, don't guess:**

```js
document.querySelector('meta[name="version"]')?.content       // "<meta name=\"version\" content=\"{version}\">" in excalidraw-app/index.html
window.__EXCALIDRAW_SHA__                                     // excalidraw-app/index.tsx
```

(**Note:** `https://excalidraw.com/` fetched as text strips tags, so the `meta[version]` value could not be read in this research; the two expressions above are what the app itself uses — `getVersion()` in `packages/common/src/utils.ts`.)

### Changes to watch (all present on `master`, absent from ≤0.18 docs)

| Change | Consequence for us |
|---|---|
| `exportToBlob` / `exportToSvg` are **no longer public**; public surface is `exportScene({type:"canvas"\|"png"\|"jpeg"\|"svg", data, config})` + `exportToClipboard` | don't plan on calling them from the page; use canvas pixels |
| New context plumbing: `ExcalidrawAPIProvider`, `ExcalidrawAPIContext`, `useExcalidrawAPI()`, `onExcalidrawAPI` prop; **no `excalidrawAPI`/`ref` prop** | fiber probe targets `.provider.memoizedProps.value` and `InteractiveCanvas.props.app` |
| `ExcalidrawImperativeAPI.selection` (`AppSelection`: `select/add/remove/clear`) | the sanctioned programmatic selection API |
| `startBinding/endBinding` → `FixedPointBinding {elementId, fixedPoint, mode}` | don't author bindings by hand; clone existing |
| Element gained `created`, `index` (fractional index) became a first-class field; `stickynote.baseHeight`; text `baseFontSize`, `labelPosition` | your hand-built elements must at least carry `index: null` and `created` |
| Tools/`TOOL_TYPE` grew `lasso`, `laser`, `autoshape`, `bucketfill`, `stickynote`, `magicframe` | shortcut keys and element types changed |
| `appState`: `boxSelectionMode: "contain"\|"overlap"`, `bindMode`, `lockedMultiSelections`, `activeLockedId`, `interaction`/`ui` props replacing parts of `UIOptions`, `stats` object | persisted-state shape differs from old blog posts |
| `selectedElementIds` **is still** a `Record<id, true>` — there is **no** `selectedElements` field (grep of `appState.ts` + `App.selection.ts`) | ignore rumours; the id-record is stable |
| Scene/Store/History refactor (`packages/element/src/{Scene,store}.ts`, `history.ts`) | `app.scene.*` replaces older direct `elements` arrays; `api.history` only exposes `clear` |
| `frameRendering` is *not* persisted (`browser: false`) despite being user-visible | after a reload frames render with defaults; read it live |

---

## 10. Risks & unknowns

1. **Minification/rename risk (low but real).** Everything above depends on *public* property names surviving the build (`memoizedProps`, `stateNode`, `app`, `value`, `api`, `getSceneElements`, `updateScene`, `mutateElement`, `selection`). Excalidraw's build does not mangle properties today, and these names are in the published API/types; still, probe defensively (`typeof x === "function"`) and fail soft.
2. **Version drift.** excalidraw.com tracks `master`; a deploy can rename things between your tests. Feature-detect (`api.selection?.select`) and keep the fallbacks in §5.1/§5.3.
3. **React internals drift.** Fiber key prefixes (`__reactFiber$`, `__reactContainer$`) are React-version-dependent. `__reactContainer$` exists in React 18/19; if React changes again the `.child` hop may need adjusting. Root fallback: `document.getElementById("root")` then BFS for a fiber whose `memoizedProps.value` is API-like.
4. **`offsetLeft/offsetTop` freshness.** They are captured on mount/resize (`getCanvasOffsets()`), so they can be stale during scroll-animations/layout changes. Prefer the canvas `getBoundingClientRect()` for pointer math (it is identical when layout is settled) or recompute `offset = rect.left/top` yourself.
5. **Undo semantics.** Only `captureUpdate: "IMMEDIATELY"` gives per-call undo; the localStorage path gives none; synthetic events give one entry per gesture. `app.history` is reachable but its `undo()/redo()` API is *not* in the public typings — verify before relying on it.
6. **Save races.** The app's `LocalData.save` is debounced (300 ms) and flushes on blur/hidden/unload; anything you write to localStorage can be clobbered within ~300 ms. The fiber path avoids this entirely because you mutate the live state (the app then saves *your* state).
7. **`isDeleted` vs. removal.** Element deletion is a soft flag in memory but deleted elements are dropped from localStorage. If you hand-write `localStorage["excalidraw"]`, omitting an element deletes it permanently (no undo, and `restoreElements` can't resurrect it).
8. **Taint / pixel read.** Data-URL images are safe; a future change to remote/blob image sources, or a browser extension that draws cross-origin content, can throw `SecurityError` on `getImageData`. `toDataURL` fails the same way — wrap in try/catch and fall back to `app.onExportImage` (which downloads) or to a DOM-based screenshot from the extension (`chrome.tabs.captureVisibleTab`).
9. **Iframe / embed views.** `.excalidraw--view-mode`, `interaction.enabled = false`, `viewModeEnabled` are all possible states; `focusContainer()`/keyboard will no-op. Check `app.isInteractionEnabled()`.
10. **Collaboration rooms.** If the user is in a collab session (`#room=<id>,<key>`), `LocalData.save` is *not* the source of truth (Firebase/collab socket is), so the localStorage path silently does nothing useful, while the fiber path works (it also broadcasts).
11. **Unknowns to confirm on the live page:** `meta[name="version"]` value; whether `CaptureUpdateAction`'s values are the string literals assumed; whether `api.selection` exists in the deployed bundle; whether `getCanvasOffsets()` really is `getBoundingClientRect().left/top` (defined beyond the first ~2 870 lines of `App.tsx`, i.e. not directly read in this research — the *usage* is verified at `App.tsx#L872`, `#L2182`, `#L2344`); the exact CSP response headers as served today.

---

## Appendix A — file map (things worth re-reading)

| Path (branch `master`) | Why |
|---|---|
| `excalidraw-app/index.tsx` | `createRoot`, `registerSW()`, `__EXCALIDRAW_SHA__` |
| `excalidraw-app/index.html` | inline scripts, `meta[name=version]`, `window.name` |
| `excalidraw-app/App.tsx` | `ExcalidrawAPIProvider` usage, `initializeScene`, `onChange`→`LocalData.save`, focus/blur/hashchange wiring, `handleKeyboardGlobally={true}` |
| `excalidraw-app/app_constants.ts` | `STORAGE_KEYS`, timeouts, WS events |
| `excalidraw-app/data/localStorage.ts` | `importFromLocalStorage` |
| `excalidraw-app/data/LocalData.ts` | save payload, debounce, IDB `files-db`, library adapters |
| `excalidraw-app/data/tabSync.ts` | `version-dataState` comparison |
| `packages/excalidraw/index.tsx` | `Excalidraw` props, `ExcalidrawAPIProvider`, public exports |
| `packages/excalidraw/components/App.tsx` | `class App` (L587), `createExcalidrawAPI` (L793), `this.api` (L924), render/container (L2329–2425), `ExcalidrawAPIContext.Provider` (L2443) |
| `packages/excalidraw/components/App.selection.ts` | `AppSelection` (`select/add/remove/clear`), `getSelectionStateForElements` |
| `packages/excalidraw/components/canvases/{InteractiveCanvas,StaticCanvas,NewElementCanvas}.tsx` | canvas classes, `app`/`handleCanvasRef` props, DPR sizing |
| `packages/excalidraw/appState.ts` | `getDefaultAppState`, `APP_STATE_STORAGE_CONF` (what is persisted) |
| `packages/excalidraw/data/{json.ts,blob.ts,restore.ts,library.ts}` | file envelope, `loadFromBlob`, repair |
| `packages/excalidraw/scene/export.ts` | `exportScene`, internal `exportToCanvas/Blob/Svg` |
| `packages/element/src/types.ts` | element schema |
| `packages/element/src/selection.ts` | `getSelectedElements`, `getElementsWithinSelection`, `excludeElementsInFramesFromSelection` |
| `packages/common/src/utils.ts` | `sceneCoordsToViewportCoords`, `viewportCoordsToSceneCoords`, `getVersion`, feature flags |
| `packages/common/src/constants.ts` | MIME types, `VERSIONS`, `FONT_FAMILY`, `POINTER_BUTTON`, `DRAGGING_THRESHOLD`, `ROUNDNESS`, `STROKE_WIDTH` |
| `packages/common/src/keys.ts` | `KEYS`, `CODES`, `matchKey` |
| `packages/excalidraw/global.d.ts` | the complete list of `window.*` the app touches |
| `vercel.json` | the (non-)CSP header set |
