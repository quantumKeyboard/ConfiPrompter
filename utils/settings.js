const Store = require('electron-store');

const store = new Store({
  defaults: {
    speed: 50,
    fontSize: 32,
    opacity: 0.85,
    textColor: '#ffffff',
    mirrorMode: false,
    highlightLine: true,
    overlayMovable: false,
    lastInlineText: '',
    windowBounds: { x: 100, y: 50, width: 420, height: 300 }
  }
});

module.exports = store;
