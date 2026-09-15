import { useEffect, useRef, useState } from 'react';

export interface FlowingNumberTextPart {
  readonly key: string;
  readonly text: string;
  readonly digit: boolean;
  readonly group?: number;
  readonly position?: number;
}

const NUMBER_PATTERN = /\d[\d,]*(?:\.\d+)?/g;
const isDigit = (value: string): boolean => /\d/.test(value);

export const flowingNumberTextParts = (value: string): readonly FlowingNumberTextPart[] => {
  const parts: FlowingNumberTextPart[] = [];
  let cursor = 0;
  let group = 0;

  for (const match of value.matchAll(NUMBER_PATTERN)) {
    const start = match.index ?? 0;
    if (start > cursor) {
      parts.push({
        key: `text:${group}:${value.slice(cursor, start)}`,
        text: value.slice(cursor, start),
        digit: false,
      });
    }

    const number = match[0];
    const decimalIndex = number.indexOf('.');
    const integerEnd = decimalIndex === -1 ? number.length : decimalIndex;
    const integerDigits = [...number.slice(0, integerEnd)].filter(isDigit).length;
    let integerSeen = 0;
    let fractionPosition = -1;

    [...number].forEach((text, index) => {
      if (isDigit(text)) {
        const position = index < integerEnd ? integerDigits - integerSeen++ - 1 : fractionPosition--;
        parts.push({ key: `number:${group}:digit:${position}`, text, digit: true, group, position });
        return;
      }

      if (text === '.') {
        parts.push({ key: `number:${group}:decimal`, text, digit: false, group });
        return;
      }

      const digitsRight = [...number.slice(index + 1, integerEnd)].filter(isDigit).length;
      parts.push({ key: `number:${group}:separator:${text}:${digitsRight}`, text, digit: false, group });
    });

    cursor = start + number.length;
    group += 1;
  }

  if (cursor < value.length || parts.length === 0) {
    parts.push({ key: `text:${group}:${value.slice(cursor)}`, text: value.slice(cursor), digit: false });
  }

  return parts;
};

const numberValues = (value: string): readonly number[] =>
  [...value.matchAll(NUMBER_PATTERN)].map((match) => Number(match[0].replaceAll(',', '')));

export const motionDurationMs = (value: string, fallback = 280): number => {
  const match = /^(\d*\.?\d+)\s*(ms|s)$/.exec(value.trim());
  if (!match) return fallback;
  const duration = Number(match[1]);
  return Number.isFinite(duration) ? duration * (match[2] === 's' ? 1_000 : 1) : fallback;
};

interface FlowDigitProps {
  readonly digit: string;
  readonly direction: 1 | -1;
  readonly group: number;
  readonly position: number;
}

function FlowDigit({ digit, direction, group, position }: FlowDigitProps) {
  const [settledDigit, setSettledDigit] = useState(digit);
  const incomingRef = useRef<HTMLSpanElement>(null);
  const outgoingRef = useRef<HTMLSpanElement>(null);
  const changed = settledDigit !== digit;
  const incomingOffset = direction > 0 ? '100%' : '-100%';
  const outgoingOffset = direction > 0 ? '-100%' : '100%';

  useEffect(() => {
    if (!changed) return undefined;
    const incoming = incomingRef.current;
    const outgoing = outgoingRef.current;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!incoming || !outgoing || reducedMotion || typeof incoming.animate !== 'function') {
      setSettledDigit(digit);
      return undefined;
    }

    const rootStyle = typeof getComputedStyle !== 'undefined' ? getComputedStyle(document.documentElement) : null;
    const configuredDuration = motionDurationMs(rootStyle?.getPropertyValue('--motion-slow') ?? '');
    const configuredEasing = rootStyle?.getPropertyValue('--ease-out')?.trim() ?? '';
    const timing: KeyframeAnimationOptions = {
      duration: Number.isFinite(configuredDuration) ? configuredDuration : 280,
      easing: configuredEasing || 'cubic-bezier(0.22, 1, 0.36, 1)',
      fill: 'both',
    };
    const animations = [
      incoming.animate(
        [
          { opacity: 0.35, transform: `translateY(${incomingOffset})` },
          { opacity: 1, transform: 'translateY(0)' },
        ],
        timing,
      ),
      outgoing.animate(
        [
          { opacity: 1, transform: 'translateY(0)' },
          { opacity: 0.35, transform: `translateY(${outgoingOffset})` },
        ],
        timing,
      ),
    ];
    let cancelled = false;
    void Promise.all(animations.map((animation) => animation.finished.catch(() => undefined))).then(() => {
      if (!cancelled) setSettledDigit(digit);
    });
    return () => {
      cancelled = true;
      animations.forEach((animation) => {
        animation.cancel();
      });
    };
  }, [changed, digit, incomingOffset, outgoingOffset]);

  return (
    <span
      data-flow-group={group}
      data-flow-position={position}
      aria-hidden="true"
      style={{
        position: 'relative',
        display: 'inline-block',
        overflow: 'hidden',
        verticalAlign: 'bottom',
        fontVariantNumeric: 'tabular-nums',
      }}
    >
      {changed && (
        <span ref={outgoingRef} style={{ position: 'absolute', inset: 0 }}>
          {settledDigit}
        </span>
      )}
      <span
        ref={changed ? incomingRef : undefined}
        style={{ display: 'inline-block', transform: changed ? `translateY(${incomingOffset})` : undefined }}
      >
        {digit}
      </span>
    </span>
  );
}

export function FlowingNumberText({ value, direction }: { readonly value: string; readonly direction?: 1 | -1 }) {
  const previousValueRef = useRef(value);
  const previousNumbers = numberValues(previousValueRef.current);
  const currentNumbers = numberValues(value);
  const parts = flowingNumberTextParts(value);

  useEffect(() => {
    previousValueRef.current = value;
  }, [value]);

  return (
    <>
      {parts.map((part) => {
        if (!part.digit)
          return (
            <span key={part.key} aria-hidden="true">
              {part.text}
            </span>
          );
        const group = part.group ?? 0;
        const inferredDirection: 1 | -1 =
          (currentNumbers[group] ?? 0) >= (previousNumbers[group] ?? currentNumbers[group] ?? 0) ? 1 : -1;
        return (
          <FlowDigit
            key={part.key}
            digit={part.text}
            direction={direction ?? inferredDirection}
            group={group}
            position={part.position ?? 0}
          />
        );
      })}
    </>
  );
}
