// Bridge from the ES-module HUD code to the Script-scope `let` bindings in
// the sim files. `let SHORT_RANGE = 100` in 15_settlement.js lives in the
// classic-script "Script" scope which is invisible to <script type="module">,
// so the module can't write to it directly. This classic script can.
//
// Loaded AFTER 15_settlement.js. Call from anywhere via window.setSimRange.

window.setSimRange = function setSimRange(which, value) {
    if (which === 'short')  SHORT_RANGE  = value;   // close-influence cost budget
    if (which === 'middle') MIDDLE_RANGE = value;   // far-influence cost budget
};

window.getSimRange = function getSimRange(which) {
    if (which === 'short')  return SHORT_RANGE;
    if (which === 'middle') return MIDDLE_RANGE;
};
