import { useState, type ComponentProps } from 'react';
import { ChevronDown, EllipsisVertical, FileKey2, Globe, Moon, Sun, Upload } from 'lucide-react';
import { Menu } from '@base-ui/react/menu';
import { Select } from '@base-ui/react/select';
import { ReceiptTools } from '../bidding/receipt-tools';
import { Button, Icon } from '../ui/primitives';
import { Modal, ModalTitle } from '../ui/modal';
import { getScheduleTimeZoneChoice, setScheduleTimeZone, type ScheduleTimeZone } from '../domain/display-timezone';
import { currentTheme, toggleTheme } from '../domain/theme';
import { syncWalletConnectTheme } from './walletconnect-provider';
import { WalletControls as WalletControlsCore } from './wallet-connection-controls';

export { UnsupportedWalletChainWarning } from './wallet-connection-controls';

const TIMEZONE_OPTIONS = [
  { value: 'local', label: 'Local (your device)' },
  { value: 'UTC', label: 'UTC+0' },
  { value: 'Pacific/Midway', label: 'UTC−11 Midway' },
  { value: 'Pacific/Honolulu', label: 'UTC−10 Honolulu' },
  { value: 'America/Anchorage', label: 'UTC−9 Anchorage' },
  { value: 'America/Los_Angeles', label: 'UTC−8 Los Angeles' },
  { value: 'America/Denver', label: 'UTC−7 Denver' },
  { value: 'America/Chicago', label: 'UTC−6 Chicago' },
  { value: 'America/New_York', label: 'UTC−5 New York' },
  { value: 'America/Caracas', label: 'UTC−4 Caracas' },
  { value: 'America/Sao_Paulo', label: 'UTC−3 São Paulo' },
  { value: 'Atlantic/South_Georgia', label: 'UTC−2 South Georgia' },
  { value: 'Atlantic/Azores', label: 'UTC−1 Azores' },
  { value: 'Europe/London', label: 'UTC+0 London' },
  { value: 'Europe/Berlin', label: 'UTC+1 Berlin' },
  { value: 'Europe/Bucharest', label: 'UTC+2 Bucharest' },
  { value: 'Europe/Moscow', label: 'UTC+3 Moscow' },
  { value: 'Asia/Dubai', label: 'UTC+4 Dubai' },
  { value: 'Asia/Karachi', label: 'UTC+5 Karachi' },
  { value: 'Asia/Kolkata', label: 'UTC+5:30 Mumbai' },
  { value: 'Asia/Dhaka', label: 'UTC+6 Dhaka' },
  { value: 'Asia/Bangkok', label: 'UTC+7 Bangkok' },
  { value: 'Asia/Shanghai', label: 'UTC+8 Shanghai' },
  { value: 'Asia/Singapore', label: 'UTC+8 Singapore' },
  { value: 'Asia/Tokyo', label: 'UTC+9 Tokyo' },
  { value: 'Australia/Sydney', label: 'UTC+10 Sydney' },
  { value: 'Pacific/Noumea', label: 'UTC+11 Noumea' },
  { value: 'Pacific/Auckland', label: 'UTC+12 Auckland' },
  { value: 'Pacific/Tongatapu', label: 'UTC+13 Tongatapu' },
] as const;

function TimezoneDialog({
  choice,
  onChoice,
  onCancel,
  onApply,
}: {
  choice: ScheduleTimeZone;
  onChoice: (choice: ScheduleTimeZone) => void;
  onCancel: () => void;
  onApply: () => void;
}) {
  const selectedLabel = TIMEZONE_OPTIONS.find((opt) => opt.value === choice)?.label ?? choice;
  return (
    <>
      <div className="timezone-panel__body">
        <span className="timezone-panel__label">Display timezone</span>
        <Select.Root
          items={TIMEZONE_OPTIONS}
          value={choice}
          onValueChange={(value) => onChoice(value as ScheduleTimeZone)}
        >
          <Select.Trigger className="timezone-panel__trigger" aria-label="Display timezone">
            <Select.Value>{() => <span>{selectedLabel}</span>}</Select.Value>
            <Select.Icon className="timezone-panel__trigger__icon">
              <Icon icon={ChevronDown} size={16} />
            </Select.Icon>
          </Select.Trigger>
          <Select.Portal>
            <Select.Positioner className="timezone-panel__positioner" sideOffset={4}>
              <Select.Popup className="timezone-panel__popup">
                <Select.List className="timezone-panel__list">
                  {TIMEZONE_OPTIONS.map((opt) => (
                    <Select.Item key={opt.value} value={opt.value} className="timezone-panel__item">
                      <Select.ItemText>{opt.label}</Select.ItemText>
                    </Select.Item>
                  ))}
                </Select.List>
              </Select.Popup>
            </Select.Positioner>
          </Select.Portal>
        </Select.Root>
        <small>Defaults to your device&apos;s local timezone.</small>
      </div>
      <div className="timezone-panel__actions">
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="default" onClick={onApply}>
          Apply
        </Button>
      </div>
    </>
  );
}

function HeaderUtilityMenu() {
  const [timezoneOpen, setTimezoneOpen] = useState(false);
  const [timezoneChoice, setTimezoneChoice] = useState<ScheduleTimeZone>(() => getScheduleTimeZoneChoice());
  const [theme, setTheme] = useState(() => currentTheme());

  return (
    <>
      <Menu.Root>
        <Menu.Trigger
          render={
            <Button variant="outline" size="icon" aria-label="More options">
              <Icon icon={EllipsisVertical} size={16} />
            </Button>
          }
        />
        <Menu.Portal>
          <Menu.Positioner sideOffset={8} className="header-utility-menu__positioner">
            <Menu.Popup className="header-utility-menu__popover">
              <Menu.Item
                onClick={() => {
                  setTheme(toggleTheme());
                  syncWalletConnectTheme();
                }}
              >
                <Icon icon={theme === 'dark' ? Sun : Moon} size={15} />
                {theme === 'dark' ? 'Light mode' : 'Dark mode'}
              </Menu.Item>
              <Menu.Item
                onClick={() => {
                  setTimezoneChoice(getScheduleTimeZoneChoice());
                  setTimezoneOpen(true);
                }}
              >
                <Icon icon={Globe} size={15} />
                Override timezone
              </Menu.Item>
              <Menu.Item onClick={() => globalThis.dispatchEvent(new Event('itx-acn:manage-receipts'))}>
                <Icon icon={FileKey2} size={15} />
                Bid receipts
              </Menu.Item>
              <Menu.Item onClick={() => globalThis.dispatchEvent(new Event('itx-acn:import-receipt'))}>
                <Icon icon={Upload} size={15} />
                Import bid receipt
              </Menu.Item>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
      <Modal open={timezoneOpen} onClose={() => setTimezoneOpen(false)} panelClassName="timezone-panel">
        <ModalTitle
          title="Override timezone"
          subtitle="Auction schedule times are delivered in UTC — choose how they display."
          closeLabel="Close timezone controls"
        />
        <TimezoneDialog
          choice={timezoneChoice}
          onChoice={setTimezoneChoice}
          onCancel={() => setTimezoneOpen(false)}
          onApply={() => {
            setScheduleTimeZone(timezoneChoice);
            globalThis.location.reload();
          }}
        />
      </Modal>
    </>
  );
}

export function WalletControls(props: ComponentProps<typeof WalletControlsCore>) {
  const state = props.state;
  const profile = state.kind === 'connected-supported' ? state.activeVenue : undefined;
  const activeContext =
    state.kind === 'connected-supported'
      ? {
          chainId: state.connection.chainId,
          deploymentId: state.activeVenue.deploymentId,
          auctionProxy: state.activeVenue.addresses.intexAuction,
          bidder: state.connection.address,
        }
      : undefined;

  return (
    <div className="wallet-receipt-controls">
      <WalletControlsCore {...props} />
      <HeaderUtilityMenu />
      <ReceiptTools
        {...(activeContext === undefined ? {} : { activeContext })}
        {...(profile === undefined ? {} : { profile })}
        showTrigger={false}
      />
    </div>
  );
}
