import { CircleAlert, CircleCheck, TriangleAlert, X } from 'lucide-react';
import { Toaster as SonnerToaster, toast as sonnerToast } from 'sonner';

export const toast = sonnerToast;

export const ERROR_TOAST_DURATION_MS = 8_000;
export const SUCCESS_TOAST_DURATION_MS = 5_000;
export const WARNING_TOAST_DURATION_MS = 7_000;
const VISIBLE_TOASTS = 4;
const TOAST_GAP_PX = 12;
const TOAST_OFFSET_PX = 24;

export const showErrorToast = (description: string, title = 'Something went wrong'): string | number =>
  toast.error(title, { description, duration: ERROR_TOAST_DURATION_MS });

export const showSuccessToast = (description: string, title: string): string | number =>
  toast.success(title, { description, duration: SUCCESS_TOAST_DURATION_MS });

export const showWarningToast = (description: string, title: string): string | number =>
  toast.warning(title, { description, duration: WARNING_TOAST_DURATION_MS });

export function Toaster() {
  return (
    <SonnerToaster
      position="bottom-right"
      visibleToasts={VISIBLE_TOASTS}
      expand={false}
      gap={TOAST_GAP_PX}
      offset={TOAST_OFFSET_PX}
      closeButton
      className="toast-viewport"
      toastOptions={{
        closeButtonAriaLabel: 'Dismiss notification',
        classNames: {
          toast: 'toast-root',
          title: 'toast-title',
          description: 'toast-description',
          content: 'toast-copy',
          icon: 'toast-icon',
          closeButton: 'toast-close',
        },
      }}
      icons={{
        success: <CircleCheck aria-hidden="true" size={20} />,
        warning: <TriangleAlert aria-hidden="true" size={20} />,
        error: <CircleAlert aria-hidden="true" size={20} />,
        close: <X aria-hidden="true" size={16} />,
      }}
    />
  );
}
