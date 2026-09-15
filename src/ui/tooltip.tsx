import { Tooltip as TooltipPrimitive } from '@base-ui/react/tooltip';
import type { ReactNode } from 'react';
import './ui.css';

export function TooltipProvider({ delay = 0, children }: { delay?: number; children: ReactNode }) {
  return <TooltipPrimitive.Provider delay={delay}>{children}</TooltipPrimitive.Provider>;
}

export function Tooltip(props: TooltipPrimitive.Root.Props) {
  return <TooltipPrimitive.Root {...props} />;
}

export function TooltipTrigger(props: TooltipPrimitive.Trigger.Props) {
  return <TooltipPrimitive.Trigger {...props} />;
}

export function TooltipContent({
  className = '',
  side = 'top',
  sideOffset = 4,
  align = 'center',
  alignOffset = 0,
  children,
  ...props
}: TooltipPrimitive.Popup.Props &
  Pick<TooltipPrimitive.Positioner.Props, 'align' | 'alignOffset' | 'side' | 'sideOffset'>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
        className="tooltip__positioner"
      >
        <TooltipPrimitive.Popup className={`tooltip__content ${className}`.trim()} {...props}>
          {children}
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  );
}
