import { useCallback, useEffect, useRef, useState } from "react";

export function useMapFullscreen() {
  const meetingRef = useRef<HTMLElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const wanted = useRef(false);
  const [expanded, setExpanded] = useState(false);

  const leave = useCallback(() => {
    if (!wanted.current) return;
    wanted.current = false;
    setExpanded(false);
    if (document.fullscreenElement === meetingRef.current && meetingRef.current)
      void document.exitFullscreen().catch(() => {});
    requestAnimationFrame(() => buttonRef.current?.focus());
  }, []);

  useEffect(() => {
    const root = meetingRef.current;
    let wasNative = false;
    function sync() {
      if (document.fullscreenElement === root) wasNative = true;
      else if (wasNative) {
        wasNative = false;
        leave();
      }
    }
    function escape(event: KeyboardEvent) {
      if (event.key === "Escape" && wanted.current) leave();
    }
    document.addEventListener("fullscreenchange", sync);
    document.addEventListener("keydown", escape);
    return () => {
      wanted.current = false;
      document.removeEventListener("fullscreenchange", sync);
      document.removeEventListener("keydown", escape);
    };
  }, [leave]);

  function toggle() {
    if (wanted.current) return leave();
    const root = meetingRef.current;
    if (!root) return;
    wanted.current = true;
    setExpanded(true);
    // Keep the same in-page layout on browsers that disallow native fullscreen.
    if (document.fullscreenEnabled && root.requestFullscreen)
      void root.requestFullscreen().then(
        () => {
          if (!wanted.current && document.fullscreenElement === root)
            void document.exitFullscreen().catch(() => {});
        },
        () => {},
      );
  }
  return { meetingRef, buttonRef, expanded, toggle };
}
