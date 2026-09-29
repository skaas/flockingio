// Pointer events expose the full button mask, including a second button pressed
// during an existing drag. Only a gesture begun on the battlefield can accelerate.
export class MouseFlightInput {
  constructor(canvas, { enabled, point }) {
    this.canvas = canvas;
    this.enabled = enabled;
    this.point = point;
    this.aim = null;
    this.buttons = 0;
    this.pointerId = null;
    canvas.addEventListener('pointerdown', event => {
      if (event.pointerType !== 'mouse' || !enabled() || !(event.buttons & 3)) return;
      event.preventDefault();
      canvas.focus({ preventScroll: true });
      this.pointerId = event.pointerId;
      canvas.setPointerCapture(event.pointerId);
      this.update(event);
    });
    canvas.addEventListener('pointermove', event => {
      if (event.pointerType !== 'mouse' || !enabled()) return;
      // A button held while leaving a menu must be released before steering.
      if (event.buttons && this.pointerId !== event.pointerId) return;
      this.update(event);
    });
    canvas.addEventListener('pointerleave', () => {
      if (this.pointerId === null) this.aim = null;
    });
    canvas.addEventListener('lostpointercapture', event => {
      if (this.pointerId === event.pointerId) this.reset();
    });
    canvas.addEventListener('contextmenu', event => {
      if (enabled() || this.pointerId !== null) event.preventDefault();
    });
    canvas.ownerDocument.defaultView.addEventListener('pointerup', event => {
      if (this.pointerId !== event.pointerId) return;
      this.buttons = event.buttons & 3;
      if (!event.buttons) this.releaseCapture();
    });
    canvas.ownerDocument.defaultView.addEventListener('pointercancel', event => {
      if (this.pointerId === event.pointerId) this.reset();
    });
  }
  update(event) {
    this.aim = this.point(event);
    this.buttons = this.pointerId === event.pointerId ? event.buttons & 3 : 0;
  }
  releaseCapture() {
    const pointerId = this.pointerId;
    this.pointerId = null;
    if (pointerId !== null && this.canvas.hasPointerCapture(pointerId)) this.canvas.releasePointerCapture(pointerId);
  }
  reset() {
    this.buttons = 0;
    this.aim = null;
    this.releaseCapture();
  }
  get boost() { return Boolean(this.buttons & 1); }
  get gather() { return Boolean(this.buttons & 2); }
}
