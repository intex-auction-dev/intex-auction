import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ERROR_TOAST_DURATION_MS,
  SUCCESS_TOAST_DURATION_MS,
  Toaster,
  WARNING_TOAST_DURATION_MS,
  showErrorToast,
  showSuccessToast,
  showWarningToast,
  toast,
} from '@/ui/toast';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('global Sonner toast', () => {
  it('routes error, success and warning notifications through Sonner', () => {
    const error = vi.spyOn(toast, 'error').mockReturnValue('error-id');
    const success = vi.spyOn(toast, 'success').mockReturnValue('success-id');
    const warning = vi.spyOn(toast, 'warning').mockReturnValue('warning-id');

    expect(showErrorToast('RPC endpoint returned too many errors.', 'Transaction failed')).toBe('error-id');
    expect(error).toHaveBeenCalledWith('Transaction failed', {
      description: 'RPC endpoint returned too many errors.',
      duration: ERROR_TOAST_DURATION_MS,
    });

    expect(showSuccessToast('Your commitment is confirmed.', 'Commit confirmed')).toBe('success-id');
    expect(success).toHaveBeenCalledWith('Commit confirmed', {
      description: 'Your commitment is confirmed.',
      duration: SUCCESS_TOAST_DURATION_MS,
    });

    expect(showWarningToast('State is still reconciling.', 'Transaction confirmed')).toBe('warning-id');
    expect(warning).toHaveBeenCalledWith('Transaction confirmed', {
      description: 'State is still reconciling.',
      duration: WARNING_TOAST_DURATION_MS,
    });
  });

  it('renders the global Sonner accessibility container', () => {
    const html = renderToStaticMarkup(<Toaster />);
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-relevant="additions text"');
  });
});
