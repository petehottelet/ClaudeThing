import { useEffect, useRef } from "react";

/**
 * Buttons arrive as key events. The production compositor delivers dial
 * rotation as a horizontal wheel event; ArrowLeft/ArrowRight remain useful
 * for desktop and keyboard testing.
 * Preset 4 short-press = Overview, long-press (>600ms) = System.
 * Touch swipes are handled with pointer events on the stage.
 */
export interface HardwareHandlers {
  onRotate: (delta: 1 | -1) => void;
  onPress: () => void;
  onBack: () => void;
  onPreset: (n: 1 | 2 | 3) => void;
  onPreset4Short: () => void;
  onPreset4Long: () => void;
}

const LONG_PRESS_MS = 600;
const SWIPE_PX = 60;

export function useHardwareInput(stage: HTMLElement | null, h: HardwareHandlers): void {
  const handlers = useRef(h);
  handlers.current = h;

  useEffect(() => {
    let preset4DownAt = 0;
    let preset4LongFired = false;
    let preset4Timer = 0;

    const onKeyDown = (ev: KeyboardEvent) => {
      const handled = ["ArrowRight", "ArrowLeft", "Enter", "Escape", "Backspace", "1", "2", "3", "4"].includes(ev.key);
      if (handled) ev.preventDefault();
      switch (ev.key) {
        case "ArrowRight":
          handlers.current.onRotate(1);
          break;
        case "ArrowLeft":
          handlers.current.onRotate(-1);
          break;
        case "Enter":
          handlers.current.onPress();
          break;
        case "Escape":
        case "Backspace":
          handlers.current.onBack();
          break;
        case "1":
          handlers.current.onPreset(1);
          break;
        case "2":
          handlers.current.onPreset(2);
          break;
        case "3":
          handlers.current.onPreset(3);
          break;
        case "4":
          if (ev.repeat) return;
          preset4DownAt = Date.now();
          preset4LongFired = false;
          preset4Timer = window.setTimeout(() => {
            preset4LongFired = true;
            handlers.current.onPreset4Long();
          }, LONG_PRESS_MS);
          break;
        default:
          break;
      }
    };

    const onKeyUp = (ev: KeyboardEvent) => {
      if (ev.key === "4") {
        window.clearTimeout(preset4Timer);
        if (!preset4LongFired && preset4DownAt > 0) handlers.current.onPreset4Short();
        preset4DownAt = 0;
      }
    };

    const onWheel = (ev: WheelEvent) => {
      if (!Number.isFinite(ev.deltaX) || ev.deltaX === 0) return;
      ev.preventDefault();
      handlers.current.onRotate(ev.deltaX > 0 ? 1 : -1);
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("wheel", onWheel);
      window.clearTimeout(preset4Timer);
    };
  }, []);

  useEffect(() => {
    if (!stage) return;
    let downX: number | null = null;
    let downY: number | null = null;
    let lastSwipeAt = 0;

    const onPointerDown = (ev: PointerEvent) => {
      downX = ev.clientX;
      downY = ev.clientY;
    };
    const onPointerUp = (ev: PointerEvent) => {
      if (downX === null || downY === null) return;
      const dx = ev.clientX - downX;
      const dy = ev.clientY - downY;
      downX = null;
      downY = null;
      if (Math.abs(dx) < SWIPE_PX || Math.abs(dx) <= Math.abs(dy)) return;
      lastSwipeAt = Date.now();
      ev.preventDefault();
      if (dx < 0) handlers.current.onRotate(1);
      else handlers.current.onRotate(-1);
    };
    const onPointerCancel = () => {
      downX = null;
      downY = null;
    };
    const onClickCapture = (ev: MouseEvent) => {
      if (Date.now() - lastSwipeAt > 400) return;
      ev.preventDefault();
      ev.stopPropagation();
    };

    stage.addEventListener("pointerdown", onPointerDown);
    stage.addEventListener("pointerup", onPointerUp);
    stage.addEventListener("pointercancel", onPointerCancel);
    stage.addEventListener("click", onClickCapture, true);
    return () => {
      stage.removeEventListener("pointerdown", onPointerDown);
      stage.removeEventListener("pointerup", onPointerUp);
      stage.removeEventListener("pointercancel", onPointerCancel);
      stage.removeEventListener("click", onClickCapture, true);
    };
  }, [stage]);
}
