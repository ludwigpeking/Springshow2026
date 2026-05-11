// HUD wiring — all DOM event listeners for buttons, sliders, tooltips,
// and the day/night cycle controls.
//
// Loaded as a classic script before `sim/main.js`; the module script in
// main.js builds an `app` context object (refs to renderer, scenes,
// state getters/setters, simulation functions) and calls
// `window.setupHud(app)` at the right point in init.
//
// Window globals from the other classic-script sim files (vertices,
// tiles, settlements, routes, habitable, spawnProbs, modeChangeCost,
// waterTransportFactor, calculateMovementCosts, saveSimulation,
// restoreSimulation, createRandomRoute, lastSigByTileId) are read
// directly — they live on `window`, accessible from classic scripts.

window.setupHud = function setupHud(app) {
    const {
        renderer,
        waterMesh, tilesGroup, routesGroup,
        lightParams, lightAnchors, lightCycle,
        tileObjects, lastSigByTileId,
        spawnProbs,
        AUTO_RESTART_FRACTION,
        // sim functions
        simStepN, syncSettlements, syncRoutes, syncTiles,
        refreshDebugColors, buildCityLights,
        restartSimulation, exportSceneOBJ,
        _updateReflectionTransforms, rebuildGeometryAfterElevChange,
        clearAllTileEdges, clearAllTileReflections,
        applyLightParams, setAdvancedMode, setDemoMode,
        setDebugLayer,
        setEdgesEnabled, setMonoEnabled, setReflectionsEnabled,
        clearInspectOverlay,
    } = app;

    const $ = (id) => document.getElementById(id);
    const counts = $('counts');

    // Scene sliders living in the settings panel — initial values from the
    // module's state so the UI matches reality on first paint.
    const lE = $('lE'), iE = $('iE'); iE.value = app.elevScale;  lE.textContent = app.elevScale.toFixed(2);
    const lW = $('lW'), iW = $('iW'); iW.value = app.waterLevel; lW.textContent = app.waterLevel.toFixed(1);

    function refresh() {
        counts.textContent = 'verts ' + vertices.length
            + ' · tiles ' + tiles.length
            + ' · settlements ' + settlements.length
            + ' · routes ' + routes.length
            + ' · habitable ' + habitable.length
            + (app.mouseMode ? '  · mode: ' + app.mouseMode : '')
            + (app.pendingRoadStart ? '  · road from ' + app.pendingRoadStart.index : '');
    }
    refresh();
    window.__hudRefresh = refresh;

    function spawn(n) {
        const t0 = performance.now();
        simStepN(n);
        const t1 = performance.now();
        syncSettlements();
        syncRoutes();
        const r = syncTiles();
        refreshDebugColors();
        buildCityLights();
        refresh();
        // Tile assets may have changed (different signatures, new geometry);
        // tell the cached shadow map to redraw next frame.
        if (app.advancedMode && lightParams.rotationSpeed === 0) renderer.shadowMap.needsUpdate = true;
        console.log(`spawn ${n}: sim ${(t1-t0).toFixed(0)}ms, tiles +${r?.placed||0} placed, ${r?.missing||0} missing`);

        // Capture the initial habitable pool the first time it's populated,
        // then trigger an auto-restart once the city has filled ≥ 60%
        // of it. Only fires while auto-spawn is running — manual spawns
        // never auto-restart.
        if (app.initialHabitableCount === 0 && habitable && habitable.length > 0) {
            app.initialHabitableCount = habitable.length;
        }
        if (app.autoRestartEnabled && autoTimer && app.initialHabitableCount > 0) {
            const used = 1 - habitable.length / app.initialHabitableCount;
            if (used >= AUTO_RESTART_FRACTION) {
                console.log(`[sim] habitable used ${(used*100).toFixed(0)}% — auto restart`);
                restartSimulation();
            }
        }
    }

    $('bSpawn1').onclick  = () => spawn(1);
    $('bSpawn10').onclick = () => spawn(10);
    $('bSpawn50').onclick = () => spawn(50);
    $('bRoute').onclick   = () => {
        const before = routes.length;
        const t0 = performance.now();
        createRandomRoute();
        const t1 = performance.now();
        const added = routes.length > before;
        const route = added ? routes[routes.length - 1] : null;
        const pathLen = route ? route.path.length : 0;
        // Count how many vertices the route's traffic flip changed.
        let occChanged = 0;
        for (const v of vertices) if (v.occupiedByRoute) occChanged++;
        const t2 = performance.now();
        syncRoutes();
        const t3 = performance.now();
        const r = syncTiles();
        const t4 = performance.now();
        if (added && !routesGroup.visible) {
            routesGroup.visible = true;
            $('bToggleRoutes')?.classList.add('armed');
        }
        refresh();
        const t5 = performance.now();
        console.log(`[route] pathfinding ${(t1-t0).toFixed(0)} ms | path ${pathLen} verts, occupiedByRoute total ${occChanged}`
            + ` | syncRoutes ${(t3-t2).toFixed(0)} ms`
            + ` | syncTiles ${(t4-t3).toFixed(0)} ms (placed ${r?.placed||0}, missing ${r?.missing||0})`
            + ` | refresh ${(t5-t4).toFixed(0)} ms | total ${(t5-t0).toFixed(0)} ms`);
    };
    $('bClear').onclick = () => restartSimulation();

    let autoTimer = null;
    let autoMs    = 100;
    const lAutoMs = $('lAutoMs'), iAutoMs = $('iAutoMs');
    iAutoMs.value = autoMs; lAutoMs.textContent = autoMs;
    function startAuto() {
        if (autoTimer) clearInterval(autoTimer);
        autoTimer = setInterval(() => spawn(1), autoMs);
    }
    $('bAuto').onclick = (e) => {
        if (autoTimer) {
            clearInterval(autoTimer); autoTimer = null;
            e.currentTarget.textContent = '▶️';
            e.currentTarget.classList.remove('armed');
        } else {
            e.currentTarget.textContent = '⏸';
            e.currentTarget.classList.add('armed');
            startAuto();
        }
    };
    iAutoMs.oninput = e => {
        autoMs = parseInt(e.target.value, 10);
        lAutoMs.textContent = autoMs;
        if (autoTimer) startAuto();
    };

    // --- Save / load -----------------------------------------------------
    $('bSave').onclick = () => {
        try { saveSimulation(); }
        catch (e) { console.error(e); alert('save failed: ' + e.message); }
    };
    const loadInput = $('iLoadFile');
    $('bLoad').onclick = () => loadInput.click();
    $('bExport').onclick = () => {
        try { exportSceneOBJ(); }
        catch (e) { console.error(e); alert('export failed: ' + e.message); }
    };
    loadInput.onchange = async (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        try {
            const text = await file.text();
            const json = JSON.parse(text);
            await restoreSimulation(json);
            // Rebuild the visual state from the loaded sim.
            app.recomputeCenter();
            rebuildGeometryAfterElevChange();   // rebuilds topo + tiles + everything
            refresh();
        } catch (err) {
            console.error(err);
            alert('load failed: ' + err.message);
        } finally {
            loadInput.value = '';   // allow reloading the same file later
        }
    };

    iE.oninput = e => {
        app.elevScale = parseFloat(e.target.value);
        lE.textContent = app.elevScale.toFixed(2);
        rebuildGeometryAfterElevChange();
    };
    iW.oninput = e => {
        app.waterLevel = parseFloat(e.target.value);
        lW.textContent = app.waterLevel.toFixed(1);
        if (waterMesh) waterMesh.position.y = app.waterLevel * app.elevScale;
        // Mirror to the hidden #waterLevel input the sim reads via select().
        document.getElementById('waterLevel').value = app.waterLevel;
        // Re-anchor the water-reflection plane to the new level.
        _updateReflectionTransforms();
    };
    // When the user releases the slider, re-evaluate which tiles are now
    // fully underwater (their signature doesn't change, so syncTiles would
    // otherwise skip them) — clear the cache so placeTileAsset re-runs.
    iW.onchange = () => {
        lastSigByTileId.clear();
        for (const obj of tileObjects.values()) tilesGroup.remove(obj);
        tileObjects.clear();
        clearAllTileEdges();
        clearAllTileReflections();
        syncTiles();
    };

    // ---- Parameters panel -------------------------------------------------
    // Spawn probabilities
    const ipL = $('ipL'), lpL = $('lpL');
    const ipF = $('ipF'), lpF = $('lpF');
    const ipM = $('ipM'), lpM = $('lpM');
    function showProbs() {
        const total = spawnProbs.Lord + spawnProbs.Farmer + spawnProbs.Merchant;
        const pct = (k) => total > 0 ? (spawnProbs[k] / total * 100).toFixed(0) : '0';
        ipL.value = spawnProbs.Lord;     lpL.textContent = pct('Lord')     + '% (' + spawnProbs.Lord     + ')';
        ipF.value = spawnProbs.Farmer;   lpF.textContent = pct('Farmer')   + '% (' + spawnProbs.Farmer   + ')';
        ipM.value = spawnProbs.Merchant; lpM.textContent = pct('Merchant') + '% (' + spawnProbs.Merchant + ')';
    }
    showProbs();
    ipL.oninput = e => { spawnProbs.Lord     = parseInt(e.target.value, 10); showProbs(); };
    ipF.oninput = e => { spawnProbs.Farmer   = parseInt(e.target.value, 10); showProbs(); };
    ipM.oninput = e => { spawnProbs.Merchant = parseInt(e.target.value, 10); showProbs(); };

    // Pathfinding cost: write into the hidden inputs the sim reads via select().
    const iDown = $('iDown'), lDown = $('lDown');
    const iFlat = $('iFlat'), lFlat = $('lFlat');
    const iTraf = $('iTraf'), lTraf = $('lTraf');
    function bindHidden(slider, label, hiddenId, fmt) {
        const hidden = document.getElementById(hiddenId);
        slider.value = parseFloat(hidden.value);
        label.textContent = fmt(slider.value);
        slider.oninput = (e) => {
            hidden.value = e.target.value;
            label.textContent = fmt(e.target.value);
        };
    }
    bindHidden(iDown, lDown, 'downhillFactor',  v => parseFloat(v).toFixed(2));
    bindHidden(iFlat, lFlat, 'flatTerrainCost', v => parseFloat(v).toFixed(1));
    bindHidden(iTraf, lTraf, 'trafficWeight',   v => parseInt(v, 10));

    // Movement cost: window globals + recompute edge costs immediately.
    const iMode = $('iMode'), lMode = $('lMode');
    const iWtr  = $('iWtr'),  lWtr  = $('lWtr');
    iMode.value = modeChangeCost;       lMode.textContent = modeChangeCost;
    iWtr.value  = waterTransportFactor; lWtr.textContent  = waterTransportFactor.toFixed(3);
    iMode.oninput = e => {
        window.modeChangeCost = parseFloat(e.target.value);
        lMode.textContent = window.modeChangeCost.toFixed(0);
        if (typeof calculateMovementCosts === 'function') calculateMovementCosts();
    };
    iWtr.oninput = e => {
        window.waterTransportFactor = parseFloat(e.target.value);
        lWtr.textContent = window.waterTransportFactor.toFixed(3);
        if (typeof calculateMovementCosts === 'function') calculateMovementCosts();
    };

    // Influence ranges: SHORT_RANGE / MIDDLE_RANGE live as `let` in the sim;
    // bridge through window.setSimRange (see _paramBridge.js).
    const iShort = $('iShort'), lShort = $('lShort');
    const iMid   = $('iMid'),   lMid   = $('lMid');
    if (typeof window.getSimRange === 'function') {
        iShort.value = window.getSimRange('short');  lShort.textContent = iShort.value;
        iMid.value   = window.getSimRange('middle'); lMid.textContent   = iMid.value;
    }
    iShort.oninput = e => {
        const v = parseFloat(e.target.value);
        window.setSimRange?.('short', v);
        lShort.textContent = v;
    };
    iMid.oninput = e => {
        const v = parseFloat(e.target.value);
        window.setSimRange?.('middle', v);
        lMid.textContent = v;
    };

    // Lighting sliders. setAdvancedMode() resets the underlying state and
    // expects to refresh the slider displays — exposed via __hudSyncLighting.
    const lExp = $('lExp'), iExp = $('iExp');
    const lEnv = $('lEnv'), iEnv = $('iEnv');
    const lSun = $('lSun'), iSun = $('iSun');
    const lAmb = $('lAmb'), iAmb = $('iAmb');
    const lSr  = $('lSr'),  iSr  = $('iSr');
    const lShI = $('lShI'), iShI = $('iShI');
    const lSb  = $('lSb'),  iSb  = $('iSb');
    const lAz  = $('lAz'),  iAz  = $('iAz');
    const lAl  = $('lAl'),  iAl  = $('iAl');
    const lRot = $('lRot'), iRot = $('iRot');
    function syncLightingHud() {
        iExp.value = lightParams.exposure;        lExp.textContent = lightParams.exposure.toFixed(2);
        iEnv.value = lightParams.envIntensity;    lEnv.textContent = lightParams.envIntensity.toFixed(2);
        iSun.value = lightParams.sun;             lSun.textContent = lightParams.sun.toFixed(2);
        iAmb.value = lightParams.ambient;         lAmb.textContent = lightParams.ambient.toFixed(2);
        iSr.value  = lightParams.shadowRadius;    lSr.textContent  = lightParams.shadowRadius.toFixed(1);
        iShI.value = lightParams.shadowIntensity; lShI.textContent = lightParams.shadowIntensity.toFixed(2);
        iSb.value  = lightParams.shadowBias;      lSb.textContent  = lightParams.shadowBias.toFixed(4);
        iAz.value  = lightParams.sunAzimuth;      lAz.textContent  = lightParams.sunAzimuth.toFixed(0) + '°';
        iAl.value  = lightParams.sunAltitude;     lAl.textContent  = lightParams.sunAltitude.toFixed(0) + '°';
        iRot.value = lightParams.rotationSpeed;   lRot.textContent = lightParams.rotationSpeed.toFixed(2) + '°/f';
    }
    syncLightingHud();
    window.__hudSyncLighting = syncLightingHud;
    function bindLight(slider, label, key, fmt) {
        slider.oninput = e => {
            lightParams[key] = parseFloat(e.target.value);
            label.textContent = fmt(lightParams[key]);
            applyLightParams();
        };
    }
    bindLight(iExp, lExp, 'exposure',     v => v.toFixed(2));
    bindLight(iEnv, lEnv, 'envIntensity', v => v.toFixed(2));
    bindLight(iSun, lSun, 'sun',          v => v.toFixed(2));
    bindLight(iAmb, lAmb, 'ambient',      v => v.toFixed(2));
    bindLight(iSr,  lSr,  'shadowRadius',    v => v.toFixed(1));
    bindLight(iShI, lShI, 'shadowIntensity', v => v.toFixed(2));
    bindLight(iSb,  lSb,  'shadowBias',      v => v.toFixed(4));
    bindLight(iAz,  lAz,  'sunAzimuth',      v => v.toFixed(0) + '°');
    bindLight(iAl,  lAl,  'sunAltitude',     v => v.toFixed(0) + '°');
    bindLight(iRot, lRot, 'rotationSpeed',   v => v.toFixed(2) + '°/f');

    // City-lights brightness slider (lives on lightCycle, not lightParams,
    // because it's a per-cycle constant rather than a per-frame param).
    const lCity = $('lCity'), iCity = $('iCity');
    if (iCity) {
        iCity.value = lightCycle.cityLightsBrightness;
        lCity.textContent = lightCycle.cityLightsBrightness.toFixed(1);
        iCity.oninput = e => {
            lightCycle.cityLightsBrightness = parseFloat(e.target.value);
            lCity.textContent = lightCycle.cityLightsBrightness.toFixed(1);
        };
    }

    // Day/night anchor colour pickers — 6 of them. Each writes its hex
    // back into the matching THREE.Color in lightAnchors; the per-frame
    // applyPhaseLighting() picks up the change on the very next frame.
    function bindAnchor(elId, anchorKey) {
        const el = $(elId);
        if (!el) return;
        el.value = '#' + lightAnchors[anchorKey].getHexString();
        el.oninput = () => lightAnchors[anchorKey].set(el.value);
    }
    bindAnchor('cDaySun',   'daySun');
    bindAnchor('cDuskSun',  'duskSun');
    bindAnchor('cNightSun', 'nightSun');
    bindAnchor('cDayEnv',   'dayEnv');
    bindAnchor('cDuskEnv',  'duskEnv');
    bindAnchor('cNightEnv', 'nightEnv');

    // Visibility toggles: each button's `armed` class always reflects the
    // current visible state, so it's clear whether the layer is on or off.
    function bindVisibility(buttonId, getter, setter) {
        const b = $(buttonId);
        const sync = () => b.classList.toggle('armed', getter());
        sync();
        b.onclick = () => { setter(!getter()); sync(); };
    }
    bindVisibility('bToggleTiles',  () => tilesGroup.visible,       v => tilesGroup.visible       = v);
    bindVisibility('bToggleRoutes', () => routesGroup.visible,      v => routesGroup.visible      = v);
    bindVisibility('bToggleWater',  () => waterMesh.visible,        v => waterMesh.visible        = v);
    bindVisibility('bEdges',        () => app.edgesEnabled,
                                    v => setEdgesEnabled(v));
    bindVisibility('bMono',         () => app.monoEnabled,
                                    v => setMonoEnabled(v));
    bindVisibility('bRefl',         () => app.reflEnabled,
                                    v => setReflectionsEnabled(v));
    bindVisibility('bAutoRestart',  () => app.autoRestartEnabled,
                                    v => { app.autoRestartEnabled = v; });
    bindVisibility('bAdvanced',     () => app.advancedMode,         v => setAdvancedMode(v));
    bindVisibility('bDemo',         () => app.demoMode,             v => setDemoMode(v));
    // Back-to-menu: full page reload returns the title screen and lets the
    // user pick another city. Cleanest way to drop all sim/scene state.
    $('bHome').onclick = () => location.reload();

    // Debug-layer buttons (left column, statically rendered with data-layer).
    // Mutually exclusive — clicking the active layer turns it off.
    const layerBtns = document.querySelectorAll('button[data-layer]');
    for (const b of layerBtns) {
        b.onclick = () => {
            const now = setDebugLayer(b.dataset.layer);
            for (const c of layerBtns) c.classList.toggle('armed', c.dataset.layer === now);
        };
    }

    // Mouse-mode buttons (mixed across left + right columns: inspect on left,
    // castle/farmer/merchant/road/delete on right). Mutually exclusive.
    const modeBtns = document.querySelectorAll('button[data-mode]');
    for (const b of modeBtns) {
        b.onclick = () => {
            const m = b.dataset.mode || null;
            app.mouseMode = (app.mouseMode === m) ? null : m;
            app.pendingRoadStart = null;
            for (const c of modeBtns) c.classList.toggle('armed', (c.dataset.mode || null) === app.mouseMode);
            if (!app.mouseMode && app.hoverMarker) app.hoverMarker.visible = false;
            // Leaving inspect mode: drop the info panel and the close/far
            // influence overlay.
            if (app.mouseMode !== 'inspect') {
                const ii = $('inspectInfo'); if (ii) ii.style.display = 'none';
                clearInspectOverlay();
            }
            refresh();
        };
    }

    // Settings popup (⚙ in right column toggles it).
    const panel = $('settingsPanel');
    $('bSettings').onclick = () => {
        panel.classList.toggle('hidden');
        $('bSettings').classList.toggle('armed', !panel.classList.contains('hidden'));
    };
    $('bSettingsClose').onclick = () => {
        panel.classList.add('hidden');
        $('bSettings').classList.remove('armed');
    };

    // Custom tooltips: hint appears immediately on mouseenter, stays
    // while the cursor moves over the button, hides on mouseleave.
    // Replaces the browser's native `title` tooltip (which only shows
    // after ~700 ms of stillness and re-hides on any movement).
    const tooltip = document.createElement('div');
    tooltip.id = 'btnTooltip';
    document.body.appendChild(tooltip);
    document.querySelectorAll('.ui-btn[title]').forEach(b => {
        const text = b.getAttribute('title');
        b.removeAttribute('title');     // suppress native tooltip
        b.dataset.tooltip = text;
        b.addEventListener('mouseenter', () => {
            tooltip.textContent = b.dataset.tooltip;
            const r = b.getBoundingClientRect();
            tooltip.style.top = (r.top + r.height / 2) + 'px';
            // Anchor on whichever side faces the screen interior.
            if (r.left + r.width / 2 < window.innerWidth / 2) {
                tooltip.style.right = '';
                tooltip.style.left  = (r.right + 8) + 'px';
            } else {
                tooltip.style.left  = '';
                tooltip.style.right = (window.innerWidth - r.left + 8) + 'px';
            }
            tooltip.classList.add('show');
        });
        b.addEventListener('mouseleave', () => {
            tooltip.classList.remove('show');
        });
    });
};
