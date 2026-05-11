// Per-frame render loop. Pulled out of main.js so the rendering
// orchestration is in its own file.
//
// Classic script, loaded before `sim/main.js`; main.js's module script
// calls `window.startRenderLoop(app)` after the scene is fully built.

window.startRenderLoop = function startRenderLoop(app) {
    const {
        renderer, scene, camera, controls, composer,
        lightParams,
        updateSunPosition, applyPhaseLighting,
        tickDemoMode, _tickWater,
    } = app;

    (function loop() {
        controls.update();
        // Continuous day/night cycle — only when advanced is on. The sun
        // rotates by `rotationSpeed`°/frame; setting it to 0 pauses.
        if (app.advancedMode) {
            if (lightParams.rotationSpeed > 0) {
                lightParams.sunAzimuth = (lightParams.sunAzimuth + lightParams.rotationSpeed) % 360;
                updateSunPosition();
            }
            applyPhaseLighting();
        }
        tickDemoMode();
        _tickWater();
        if (app.advancedMode) composer.render();
        else                  renderer.render(scene, camera);
        requestAnimationFrame(loop);
    })();
};
