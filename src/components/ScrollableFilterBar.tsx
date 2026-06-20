import { type ReactNode, useCallback, useRef } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface ScrollableFilterBarProps {
  children: ReactNode;
  className?: string;
  contentClassName?: string;
  ariaLabel?: string;
}

export function ScrollableFilterBar({
  children,
  className,
  contentClassName,
  ariaLabel = "Filters",
}: ScrollableFilterBarProps) {
  const stripRef = useRef<HTMLDivElement | null>(null);

  const scrollByDirection = useCallback((direction: "left" | "right") => {
    const strip = stripRef.current;
    if (!strip) return;

    const delta = Math.max(220, Math.floor(strip.clientWidth * 0.75));
    strip.scrollBy({ left: direction === "left" ? -delta : delta, behavior: "smooth" });
  }, []);

  return (
    <div className={cn("flex items-center gap-2", className)}>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={() => scrollByDirection("left")}
        className="h-9 w-9 shrink-0 rounded-full border border-slate-200 bg-white text-slate-800 shadow-sm hover:bg-slate-50 sm:hidden"
        aria-label="Scroll filters left"
      >
        <ChevronLeft className="h-5 w-5" />
      </Button>

      <div className="min-w-0 flex-1 overflow-hidden rounded-2xl">
        <div
          ref={stripRef}
          className="w-full overflow-x-auto [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
          aria-label={ariaLabel}
        >
          <div className={cn("flex min-w-max flex-nowrap items-start gap-3 p-1 sm:grid sm:min-w-0 sm:grid-cols-1", contentClassName)}>
            {children}
          </div>
        </div>
      </div>

      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={() => scrollByDirection("right")}
        className="h-9 w-9 shrink-0 rounded-full border border-slate-200 bg-white text-slate-800 shadow-sm hover:bg-slate-50 sm:hidden"
        aria-label="Scroll filters right"
      >
        <ChevronRight className="h-5 w-5" />
      </Button>
    </div>
  );
}
