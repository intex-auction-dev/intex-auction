import { useId, useMemo, useState } from 'react';
import { Select } from '@base-ui/react/select';
import { ChevronDown, Minus, Plus } from 'lucide-react';
import { formatIso4217CurrencyCode, searchIso4217Currencies } from '../../domain/iso-4217';
import { currencyCode } from '../../ui/display-format';
import { Icon } from '../../ui/primitives';

export const currencyPickerItems = (
  allowed: readonly number[],
): ReadonlyArray<{ readonly label: string; readonly value: number }> =>
  searchIso4217Currencies('', allowed).map((currency) => ({
    label: `${formatIso4217CurrencyCode(currency.numericCode)} — ${currency.name}`,
    value: currency.numericCode,
  }));

export const steppedValue = (value: string, step: number, minimum: number, maximum?: number): string => {
  const current = Number(value);
  const next = Number.isFinite(current) ? current + step : minimum;
  const bounded = Math.min(maximum ?? Number.POSITIVE_INFINITY, Math.max(minimum, next));
  return String(Number(bounded.toFixed(4)));
};

export function CommitStepper({
  label,
  value,
  minimum,
  step,
  prefix,
  suffix,
  hint,
  disabled,
  inputMode,
  onChange,
  maximum,
  onDecrease,
  onIncrease,
}: {
  readonly label: string;
  readonly value: string;
  readonly minimum: number;
  readonly step: number;
  readonly prefix?: string;
  readonly suffix?: string;
  readonly hint: string;
  readonly disabled: boolean;
  readonly inputMode: 'numeric' | 'decimal';
  readonly onChange: (value: string) => void;
  readonly maximum?: number;
  readonly onDecrease?: () => void;
  readonly onIncrease?: () => void;
}) {
  const inputId = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const shownValue = draft ?? value;
  const adjust = (direction: -1 | 1) => {
    setDraft(null);
    const override = direction < 0 ? onDecrease : onIncrease;
    if (override) override();
    else onChange(steppedValue(value, direction * step, minimum, maximum));
  };

  return (
    <div className="commit-panel__field">
      <label htmlFor={inputId}>{label}</label>
      <span className="commit-panel__stepper">
        <button type="button" aria-label="Decrease" disabled={disabled} onClick={() => adjust(-1)}>
          <Icon icon={Minus} size={16} />
        </button>
        <span>
          {prefix && <i>{prefix}</i>}
          <input
            id={inputId}
            type="text"
            inputMode={inputMode}
            value={shownValue}
            disabled={disabled}
            aria-label={label}
            style={{ width: `${Math.max(1, shownValue.length)}ch` }}
            onFocus={(event) => {
              setDraft(value);
              event.currentTarget.select();
            }}
            onChange={(event) => {
              setDraft(event.currentTarget.value);
              onChange(event.currentTarget.value);
            }}
            onBlur={() => setDraft(null)}
          />
          {suffix && <i>{suffix}</i>}
        </span>
        <button type="button" aria-label="Increase" disabled={disabled} onClick={() => adjust(1)}>
          <Icon icon={Plus} size={16} />
        </button>
      </span>
      <small>{hint}</small>
    </div>
  );
}

export function IssuanceCurrencyField({
  allowed,
  selected,
  disabled,
  onSelect,
}: {
  readonly allowed: readonly number[];
  readonly selected: number | null;
  readonly disabled: boolean;
  readonly onSelect: (numericCode: number) => void;
}) {
  const items = useMemo(() => currencyPickerItems(allowed), [allowed]);
  return (
    <div className="commit-panel__currency-selector">
      <span>Issuance currency</span>
      <Select.Root
        items={items}
        value={selected}
        onValueChange={(value) => onSelect(Number(value))}
        disabled={disabled}
      >
        <Select.Trigger className="commit-panel__currency-trigger" aria-label="Issuance currency">
          <Select.Value>
            {(value) => (
              <span className="commit-panel__currency-trigger__code">
                {value === null ? 'Currency' : currencyCode(Number(value))}
              </span>
            )}
          </Select.Value>
          <Select.Icon className="commit-panel__currency-trigger__icon">
            <Icon icon={ChevronDown} size={16} />
          </Select.Icon>
        </Select.Trigger>
        <Select.Portal>
          <Select.Positioner className="commit-panel__currency-anchor" sideOffset={4}>
            <Select.Popup className="commit-panel__currency-popup">
              <Select.List className="commit-panel__currency-list">
                {items.map((item) => (
                  <Select.Item key={item.value} value={item.value} className="commit-panel__currency-item">
                    <Select.ItemText>{item.label}</Select.ItemText>
                  </Select.Item>
                ))}
              </Select.List>
            </Select.Popup>
          </Select.Positioner>
        </Select.Portal>
      </Select.Root>
    </div>
  );
}

export function ReferenceCurrencyField({
  allowed,
  selected,
  disabled,
  onSelect,
}: {
  readonly allowed: readonly number[];
  readonly selected: number | null;
  readonly disabled: boolean;
  readonly onSelect: (numericCode: number) => void;
}) {
  const items = useMemo(() => currencyPickerItems(allowed), [allowed]);
  const singleCurrency = allowed.length <= 1;
  return (
    <div className="commit-panel__currency-selector">
      <span>Reference currency</span>
      <Select.Root
        items={items}
        value={selected}
        onValueChange={(value) => onSelect(Number(value))}
        disabled={disabled || singleCurrency}
      >
        <Select.Trigger className="commit-panel__currency-trigger" aria-label="Reference currency">
          <Select.Value>
            {(value) => (
              <span className="commit-panel__currency-trigger__code">
                {value === null ? 'Currency' : currencyCode(Number(value))}
              </span>
            )}
          </Select.Value>
          {!singleCurrency && (
            <Select.Icon className="commit-panel__currency-trigger__icon">
              <Icon icon={ChevronDown} size={16} />
            </Select.Icon>
          )}
        </Select.Trigger>
        {!singleCurrency && (
          <Select.Portal>
            <Select.Positioner className="commit-panel__currency-anchor" sideOffset={4}>
              <Select.Popup className="commit-panel__currency-popup">
                <Select.List className="commit-panel__currency-list">
                  {items.map((item) => (
                    <Select.Item key={item.value} value={item.value} className="commit-panel__currency-item">
                      <Select.ItemText>{item.label}</Select.ItemText>
                    </Select.Item>
                  ))}
                </Select.List>
              </Select.Popup>
            </Select.Positioner>
          </Select.Portal>
        )}
      </Select.Root>
    </div>
  );
}
