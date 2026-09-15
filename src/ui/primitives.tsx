import { forwardRef, type ComponentPropsWithoutRef, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Info, Wallet } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from './tooltip';
import './ui.css';

const buttonVariantClasses = {
  default: 'button--default',
  secondary: 'button--secondary',
  outline: 'button--outline',
  ghost: 'button--ghost',
  destructive: 'button--destructive',
} as const;

const buttonSizeClasses = {
  default: 'button--size-default',
  sm: 'button--size-sm',
  icon: 'button--size-icon',
} as const;

export type PresentationTone = 'neutral' | 'info' | 'success' | 'danger' | 'warning' | 'purple';

export type ButtonVariant = keyof typeof buttonVariantClasses;
export type ButtonSize = keyof typeof buttonSizeClasses;

const buttonClassName = ({
  variant = 'default',
  size = 'default',
}: {
  variant?: ButtonVariant | undefined;
  size?: ButtonSize | undefined;
}) => `button ${buttonVariantClasses[variant]} ${buttonSizeClasses[size]}`;

interface AppShellProps {
  activePage?: 'auctions' | 'portfolio';
  auctionHref?: string;
  children?: ReactNode;
  contextLabel: string;
  status?: ReactNode;
  walletControl?: ReactNode;
}

export function Icon({ icon: IconComponent, size = 16 }: { icon: LucideIcon; size?: number }) {
  return <IconComponent aria-hidden="true" focusable="false" size={size} strokeWidth={2} />;
}

export function AppShell({
  activePage = 'auctions',
  auctionHref = '/',
  children,
  contextLabel,
  status,
  walletControl,
}: AppShellProps) {
  return (
    <div className="app-shell">
      <header className="app-shell__header">
        <div className="app-shell__header-inner">
          <div className="app-shell__header-left">
            <a className="app-shell__brand" href="/" aria-label="Intex auctions home">
              <span className="app-shell__brand-mark" aria-hidden="true">
                ◆
              </span>
              <span>INTEX</span>
            </a>
            <nav className="app-shell__navigation" aria-label="Primary navigation">
              <a
                className={`app-shell__nav-item${activePage === 'auctions' ? ' app-shell__nav-item--active' : ''}`}
                href={auctionHref}
                aria-current={activePage === 'auctions' ? 'page' : undefined}
              >
                Auctions
              </a>
              <a
                className={`app-shell__nav-item${activePage === 'portfolio' ? ' app-shell__nav-item--active' : ''}`}
                href="#portfolio"
                aria-current={activePage === 'portfolio' ? 'page' : undefined}
              >
                Portfolio
              </a>
            </nav>
          </div>
          <div className="app-shell__header-right">
            <span className="app-shell__network-pill">{contextLabel}</span>
            {walletControl ?? (
              <Button className="app-shell__wallet" disabled title="Wallet runtime is unavailable.">
                <Icon icon={Wallet} size={14} />
                Connect Wallet
              </Button>
            )}
          </div>
        </div>
      </header>
      <main className="app-shell__main" id="main-content">
        <div className="app-shell__frame">
          {status && <div className="app-shell__status">{status}</div>}
          <div className="app-shell__content">{children}</div>
        </div>
      </main>
    </div>
  );
}

export function Card({ className = '', ...props }: ComponentPropsWithoutRef<'section'>) {
  return <section className={`card ${className}`.trim()} {...props} />;
}

type ButtonProps = ComponentPropsWithoutRef<'button'> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className = '', type = 'button', variant, size, ...props }, ref) => (
    <button {...props} ref={ref} type={type} className={`${buttonClassName({ variant, size })} ${className}`.trim()} />
  ),
);
Button.displayName = 'Button';

interface BannerProps {
  children: ReactNode;
  eyebrow: string;
  icon: ReactNode;
  live: 'polite' | 'assertive';
  title: string;
  tone?: PresentationTone;
}

export function Banner({ children, eyebrow, icon, live, title, tone = 'neutral' }: BannerProps) {
  return (
    <section
      className={`banner banner--${tone}`}
      role={live === 'assertive' ? 'alert' : 'status'}
      aria-live={live}
      aria-atomic="true"
    >
      <div className="banner__icon" aria-hidden="true">
        {icon}
      </div>
      <div>
        <p className="banner__eyebrow">{eyebrow}</p>
        <h1 className="banner__title">{title}</h1>
        <div className="banner__body">{children}</div>
      </div>
    </section>
  );
}

interface BadgeProps extends ComponentPropsWithoutRef<'span'> {
  tone?: PresentationTone;
  dot?: boolean;
}

export function Badge({ className = '', tone = 'neutral', dot = false, children, ...props }: BadgeProps) {
  return (
    <span className={`badge badge--${tone} ${className}`.trim()} {...props}>
      {dot && <span className="badge__dot" aria-hidden="true" />}
      {children}
    </span>
  );
}

export type NoticeTone = Exclude<PresentationTone, 'purple'>;

export function Notice({
  children,
  className = '',
  live,
  tone = 'neutral',
}: {
  children: ReactNode;
  className?: string;
  live?: 'polite' | 'assertive';
  tone?: NoticeTone;
}) {
  return (
    <div
      className={`notice notice--${tone} ${className}`.trim()}
      {...(live === undefined
        ? {}
        : {
            role: live === 'assertive' ? 'alert' : 'status',
            'aria-live': live,
          })}
    >
      {children}
    </div>
  );
}

export function InfoTip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger className="info-tip" aria-label={label}>
        <Info aria-hidden="true" size={13} />
      </TooltipTrigger>
      <TooltipContent>{children}</TooltipContent>
    </Tooltip>
  );
}

export function Metric({ label, value, detail }: { label: ReactNode; value: ReactNode; detail?: ReactNode }) {
  return (
    <div className="metric">
      <dt>{label}</dt>
      <dd>{value}</dd>
      {detail && <span>{detail}</span>}
    </div>
  );
}

export function MetricGrid({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <dl className={`metric-grid ${className}`.trim()}>{children}</dl>;
}

export function ViewToggle({
  value,
  items,
  onChange,
  label,
}: {
  value: string;
  items: readonly { value: string; label: string }[];
  onChange: (value: string) => void;
  label: string;
}) {
  return (
    <div className="view-toggle" role="tablist" aria-label={label}>
      {items.map((item) => (
        <button
          key={item.value}
          type="button"
          aria-pressed={item.value === value}
          className={item.value === value ? 'view-toggle__item view-toggle__item--active' : 'view-toggle__item'}
          onClick={() => onChange(item.value)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
