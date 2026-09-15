import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { usePresence } from '@/ui/use-presence';

function PresenceProbe({ open }: { open: boolean }) {
  const presence = usePresence(open);
  return (
    <div
      data-mounted={presence.mounted ? 'true' : 'false'}
      data-state={presence.state}
      {...(presence.state === 'starting'
        ? { 'data-starting-style': '' }
        : presence.state === 'ending'
          ? { 'data-ending-style': '' }
          : {})}
    >
      {presence.mounted ? 'visible' : 'hidden'}
    </div>
  );
}

describe('usePresence', () => {
  it('stays unmounted while closed', () => {
    const markup = renderToStaticMarkup(<PresenceProbe open={false} />);
    expect(markup).toContain('data-mounted="false"');
    expect(markup).toContain('hidden');
  });

  it('mounts and renders the entered state when initially open', () => {
    const markup = renderToStaticMarkup(<PresenceProbe open />);
    expect(markup).toContain('data-mounted="true"');
    expect(markup).toContain('data-state="entered"');
    expect(markup).toContain('visible');
    expect(markup).not.toContain('data-starting-style');
    expect(markup).not.toContain('data-ending-style');
  });
});
