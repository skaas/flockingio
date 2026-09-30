// Presentation-only frame. Every display sees the same 1280x720 slice of the battlefield;
// a larger screen scales the picture instead of revealing more of the field. DOM-free so
// the fit and pointer mapping stay testable.
export const VIEWPORT = Object.freeze({ width: 1280, height: 720 });

const positive = value => Number.isFinite(value) && value > 0;

// Largest frame of the reference ratio inside the available area: no crop, no stretch.
// The limiting side is taken exactly so the frame never overflows by a rounding error.
export function fitViewport(availableWidth, availableHeight, reference = VIEWPORT) {
  if (!positive(availableWidth) || !positive(availableHeight)) return { width: 0, height: 0, scale: 0 };
  if (availableWidth * reference.height <= availableHeight * reference.width) {
    return { width: availableWidth, height: availableWidth * reference.height / reference.width, scale: availableWidth / reference.width };
  }
  return { width: availableHeight * reference.width / reference.height, height: availableHeight, scale: availableHeight / reference.height };
}

// Maps client coordinates through the shell's on-screen rectangle into logical pixels.
// A captured drag can leave the rectangle, so points past the edge are not clamped.
export function clientToLogical(clientX, clientY, bounds, reference = VIEWPORT) {
  if (!bounds || !positive(bounds.width) || !positive(bounds.height)) return null;
  if (![clientX, clientY, bounds.left, bounds.top].every(Number.isFinite)) return null;
  return {
    x: (clientX - bounds.left) * reference.width / bounds.width,
    y: (clientY - bounds.top) * reference.height / bounds.height,
  };
}
