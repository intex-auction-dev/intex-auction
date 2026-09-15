import type { ReactNode } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { X } from 'lucide-react';
import { Button, Icon } from './primitives';

interface ModalProps {
  children: ReactNode;
  onClose: () => void;
  onCloseComplete?: () => void;
  open: boolean;
  panelClassName?: string;
}

export function Modal({ children, onClose, onCloseComplete, open, panelClassName = '' }: ModalProps) {
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
      onOpenChangeComplete={(nextOpen) => {
        if (!nextOpen) onCloseComplete?.();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="dialog-backdrop" />
        <Dialog.Viewport className="dialog-viewport">
          <Dialog.Popup className={`dialog-panel ${panelClassName}`.trim()}>{children}</Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

interface ModalTitleProps {
  closeLabel: string;
  subtitle?: ReactNode;
  title: string;
  titleId?: string;
}

export function ModalTitle({ closeLabel, subtitle, title, titleId }: ModalTitleProps) {
  return (
    <div className="dialog-title">
      <Dialog.Title className="dialog-title__heading" id={titleId}>
        {title}
        {subtitle !== undefined && <span>{subtitle}</span>}
      </Dialog.Title>
      <Dialog.Close
        render={
          <Button variant="ghost" size="icon" className="dialog-title__close" aria-label={closeLabel}>
            <Icon icon={X} size={18} />
          </Button>
        }
      />
    </div>
  );
}
